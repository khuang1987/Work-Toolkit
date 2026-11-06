// 日志自动备份（后台 service worker 通过 importScripts 加载）：
// 浏览器扩展不能直接写任意磁盘位置或插件目录，所以用 chrome.downloads 把日志覆盖保存到
// 「下载目录\MWA-Logs\」下的固定文件名，便于随时查看 / 版本管理。
(() => {
  'use strict';
  const ALARM = 'mwaExportLogs';
  const FOLDER = 'MWA-Logs';
  const DELAY_MINUTES = 10;
  const MAX_DATA_URL_CHARS = 1900000; // Chrome 对 data: URL 约 2MB 上限

  const toBase64 = text => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };

  // 内容过大时从最旧的记录开始丢弃，直到放得进一个文件。
  function fit(list, render) {
    let items = list.slice();
    let text = render(items);
    while (toBase64(text).length > MAX_DATA_URL_CHARS && items.length > 1) {
      items = items.slice(0, Math.ceil(items.length * 0.8));
      text = render(items);
    }
    return text;
  }

  function saveFile(name, text, type) {
    const url = `data:${type};charset=utf-8;base64,${toBase64(text)}`;
    return new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename: `${FOLDER}/${name}`, conflictAction: 'overwrite', saveAs: false }, id => {
        if (chrome.runtime.lastError || id === undefined) return reject(new Error(chrome.runtime.lastError?.message || '无法保存'));
        const done = delta => {
          if (delta.id !== id || !delta.state) return;
          if (delta.state.current === 'complete') { chrome.downloads.onChanged.removeListener(done); chrome.downloads.erase({ id }, () => resolve()); }
          else if (delta.state.current === 'interrupted') { chrome.downloads.onChanged.removeListener(done); reject(new Error('保存被中断')); }
        };
        chrome.downloads.onChanged.addListener(done);
      });
    });
  }

  const fmt = iso => new Date(iso).toLocaleString('zh-CN', { hour12: false });
  const aiMarkdown = list => list.map(entry => [
    `## ${fmt(entry.time)} · ${entry.purpose || '—'} · ${entry.ok ? '成功' : '失败'}`,
    `- 工单：${entry.ticket || '—'}；模型：${entry.model || '—'}（${entry.provider || '—'}）；第 ${entry.attempt || 1} 次；耗时 ${entry.ms ?? '—'} ms`,
    ...(entry.messages || []).map(m => `\n### ${m.role}\n\n\`\`\`text\n${m.content}\n\`\`\``),
    `\n### ${entry.ok ? 'response' : 'error'}\n\n\`\`\`text\n${entry.ok ? entry.response : entry.error}\n\`\`\``
  ].join('\n')).join('\n\n---\n\n');

  async function exportAll() {
    const data = await chrome.storage.local.get(['mwaAiLog', 'mwaActivityLog', 'mwaOpLog', 'windchillDownloadLog']);
    const files = [];
    const ai = data.mwaAiLog || [];
    if (ai.length) {
      await saveFile('ai-log.json', fit(ai, items => JSON.stringify(items, null, 1)), 'application/json');
      await saveFile('ai-log.md', fit(ai, aiMarkdown), 'text/markdown');
      files.push('ai-log.json', 'ai-log.md');
    }
    const ops = { activity: data.mwaActivityLog || [], fabriqOps: data.mwaOpLog || [], windchillDownloads: data.windchillDownloadLog || [] };
    if (ops.activity.length || ops.fabriqOps.length || ops.windchillDownloads.length) {
      await saveFile('ops-log.json', JSON.stringify(ops, null, 1), 'application/json');
      files.push('ops-log.json');
    }
    const info = { time: new Date().toISOString(), files };
    await chrome.storage.local.set({ mwaLastExport: info });
    return info;
  }

  // 有新记录后 10 分钟内合并成一次保存，避免每次 AI 调用都弹下载提示。
  async function schedule() {
    const { mwaAutoExport = true } = await chrome.storage.local.get('mwaAutoExport');
    if (!mwaAutoExport) return;
    chrome.alarms.get(ALARM, alarm => { if (!alarm) chrome.alarms.create(ALARM, { delayInMinutes: DELAY_MINUTES }); });
  }

  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) exportAll().catch(() => {}); });

  globalThis.MwaExport = { schedule, exportAll };
})();
