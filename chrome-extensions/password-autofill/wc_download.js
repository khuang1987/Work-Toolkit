// Windchill 签名文件下载：验证下载地址（防止保存成登录页 / 报错页）→ 交给后台 chrome.downloads 落盘。
// 在 Windchill 页面（content script）里运行以复用登录态；下载窗口 wc_download.html 逐份请求它，AI 判断也复用这里的 aiPick。
(() => {
  'use strict';
  if (globalThis.WcDownload) return;

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function dispositionName(header) {
    const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header || '');
    if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* 回退普通 filename */ } }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header || '');
    return plain ? plain[1].trim() : '';
  }
  const snippetOf = text => String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

  // 返回 { ok, reason, status, type, size, name, snippet, retryable }；任何异常都转成 ok=false，不向外抛。
  async function probe(url, expectFormat, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
    const timer = setTimeout(abort, 20000);
    try {
      const response = await fetch(url, { credentials: 'include', headers: { Range: 'bytes=0-2047' }, signal: controller.signal });
      const type = response.headers.get('content-type') || '';
      const reader = response.body.getReader();
      const { value } = await reader.read();
      const head = decoder.decode(value || new Uint8Array());
      controller.abort();
      if (!response.ok) {
        return { ok: false, status: response.status, type, snippet: snippetOf(head), retryable: response.status >= 500,
          reason: `HTTP ${response.status}${/html/i.test(type) || /<html|<!doctype/i.test(head) ? '（返回的是网页）' : ''}${snippetOf(head) ? `：${snippetOf(head)}` : ''}` };
      }
      const range = /\/(\d+)$/.exec(response.headers.get('content-range') || '');
      const size = Number(range ? range[1] : response.headers.get('content-length')) || 0;
      const name = dispositionName(response.headers.get('content-disposition'));
      if (!value || !value.length) return { ok: false, status: response.status, type, reason: '内容为空', retryable: true };
      const isHtml = /^\s*(?:<!doctype|<html)/i.test(head) || /text\/html/i.test(type);
      if (expectFormat === 'pdf' ? !head.includes('%PDF') : isHtml) {
        return { ok: false, status: response.status, type, snippet: snippetOf(head), retryable: false,
          reason: isHtml ? `返回的是网页（可能未登录或无权限）：${snippetOf(head)}` : `内容不是 ${expectFormat || '预期'} 文件（${type || '未知类型'}）` };
      }
      return { ok: true, status: response.status, type, size, name };
    } catch (error) {
      const cancelled = signal?.aborted;
      return { ok: false, retryable: !cancelled, reason: cancelled ? '已取消' : controller.signal.aborted ? '验证超时或被中断' : String(error.message || error) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  function saveFile(url, filename) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ action: 'wcDownloadFile', url, filename }, response => {
          if (chrome.runtime.lastError) return resolve({ ok: false, error: '扩展已重载，请刷新页面' });
          resolve(response || { ok: false, error: '后台无响应' });
        });
      } catch { resolve({ ok: false, error: '扩展已重载，请刷新页面' }); }
    });
  }

  // 下载一份文件。服务端 5xx / 网络抖动自动重试（最多 3 次），所有候选地址都失败才算失败。
  async function downloadOne({ record, content, rules, origin, batch, signal, useFileName }) {
    const R = globalThis.WcRules;
    const result = { status: 'failed', reason: '', filename: '', path: '', httpStatus: 0, contentType: '', attempts: [] };
    try {
      const urls = R.contentUrls(origin, record, content);
      if (!urls.length) throw new Error('没有可用的下载地址');
      let chosen = '';
      let info = {};
      for (const url of urls) {
        if (!rules.download.verify) { chosen = url; break; }
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          if (signal?.aborted) throw new Error('已取消');
          info = await probe(url, content.format, signal);
          result.attempts.push({ path: url.replace(origin, '').slice(0, 160), attempt, status: info.status || 0, ok: info.ok, reason: info.reason || '' });
          if (info.ok || !info.retryable) break;
          await sleep(700 * attempt);
        }
        if (info.ok) { chosen = url; break; }
      }
      if (!chosen) {
        const last = result.attempts[result.attempts.length - 1] || {};
        result.httpStatus = last.status || 0;
        throw new Error(`下载地址均不可用：${[...new Set(result.attempts.map(item => item.reason))].join('；')}`);
      }
      result.path = chosen.replace(origin, '').slice(0, 160);
      result.contentType = info.type || '';
      const ext = R.extOf(info.name) || R.extOf(content.fileName) || undefined;
      result.filename = R.buildFilename(rules, record, content, batch, ext, { useFileName });
      const saved = await saveFile(chosen, result.filename);
      if (!saved.ok) throw new Error(saved.error || '下载失败');
      result.status = 'done';
      result.bytes = saved.bytes || 0;
    } catch (error) {
      result.reason = String(error.message || error);
    }
    return result;
  }

  // 规则无法确定的记录交给 AI 判断；返回 Map(记录序号 → { file, reason })。可在扩展页或 content script 中调用。
  async function aiPick(candidates, rules) {
    const { buildPickMessages, parsePick } = globalThis.WcAi;
    const { requestAi } = globalThis.MwaFabriqAiClient;
    const guarded = await globalThis.MwaFabriqAiGuard.generateGuarded({
      messages: buildPickMessages(candidates, rules.signed),
      parse: text => parsePick(text, candidates),
      call: (messages, info) => requestAi('fabriqAiGenerate', {
        messages, meta: { purpose: 'windchill-signed-pick', attempt: info.attempt, masked: info.masked, ticket: `${candidates.length} 份文档` }
      })
    });
    return guarded.result;
  }

  globalThis.WcDownload = { probe, downloadOne, aiPick };
})();
