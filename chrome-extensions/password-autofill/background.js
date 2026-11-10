// Background script for handling new tab monitoring and closing
importScripts('pending_sync.js', 'ai_store.js', 'mwa_activity.js', 'mwa_export.js', 'import_core.js');

let monitoredUrls = new Set();
let mainTabId = null;
chrome.storage.session.get('mainTabId').then(r => { if (mainTabId === null && r.mainTabId != null) mainTabId = r.mainTabId; });
function setMainTabId(id) { mainTabId = id; chrome.storage.session.set({ mainTabId: id }); }
let cornerstonePopupCandidateTabIds = new Set();

// 记录所有 SCORM 相关 tab
let scormTabIds = new Set();

// ── 注入视频控制到指定 tab ──
function injectVideoControl(tabId, action) {
  const code = action === 'skip'
    ? `(function(){
        function skipAll(doc){
          try{
            doc.querySelectorAll('video').forEach(v=>{
              if(v.duration&&isFinite(v.duration)){v.currentTime=v.duration-0.1;}
            });
          }catch(e){}
          try{
            Array.from(doc.querySelectorAll('iframe')).forEach(f=>{
              try{skipAll(f.contentDocument||f.contentWindow.document);}catch(e){}
            });
          }catch(e){}
        }
        skipAll(document);
      })()`
    : `(function(speed){
        function applyAll(doc){
          try{
            doc.querySelectorAll('video').forEach(v=>{
              try{v.playbackRate=speed;}catch(e){}
            });
          }catch(e){}
          try{
            Array.from(doc.querySelectorAll('iframe')).forEach(f=>{
              try{applyAll(f.contentDocument||f.contentWindow.document);}catch(e){}
            });
          }catch(e){}
        }
        applyAll(document);
      })(${action})`;

  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: action === 'skip'
      ? function() {
          document.querySelectorAll('video').forEach(v => {
            if (v.duration && isFinite(v.duration)) v.currentTime = v.duration - 0.1;
          });
        }
      : new Function(`document.querySelectorAll('video').forEach(v=>{try{v.playbackRate=${action};}catch(e){}});`)
  }).catch(() => {});
}

function fabriqAiProvider(config, provider = config.provider || 'openai') {
  if (!['openai', 'anthropic'].includes(provider)) throw new Error('不支持的 AI 接口类型');
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('AI 接口需为不含账号、查询参数或片段的 HTTPS 地址');
  }
  const baseUrl = url.href.replace(/\/$/, '');
  if (url.origin === 'https://api.gpt.medtronic.com' &&
      /^\/providers\/(?:openai|anthropic)\/v1\/?$/.test(url.pathname)) {
    return { ...config, provider, baseUrl: `${url.origin}/providers/${provider}/v1` };
  }
  if (provider !== (config.provider || 'openai')) throw new Error('请先在插件设置中配置该接口类型');
  return { ...config, provider, baseUrl };
}

async function fabriqAiRequest(config, path, body) {
  if (!config.baseUrl || !config.key) {
    throw new Error('请先在插件后台的隐蔽页面配置 AI 接口和 Key，并在弹窗设置里选择模型');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}`,
        ...(config.provider === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
      const hint = { 401: 'Token 无效或过期', 403: 'Token 权限不足', 402: '请检查额度',
        429: '请求过于频繁，请稍后重试' }[response.status];
      throw new Error(`AI 接口返回 ${response.status}${hint ? `（${hint}）` : ''}`);
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error('AI 请求超时，请重试或选择其他模型');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fabriqAiModels(config) {
  config = fabriqAiProvider(config);
  const models = [];
  const cursors = new Set();
  let path = '/models';
  while (path) {
    const json = await fabriqAiRequest(config, path);
    if (!Array.isArray(json.data)) throw new Error('模型列表格式无效');
    for (const model of json.data) {
      if (typeof model.id !== 'string' || !model.id ||
          /^(text-embedding|whisper|tts|dall-e|gpt-image|sora)|-(audio|realtime|transcribe)/i.test(model.id)) continue;
      models.push({ id: model.id, name: typeof model.display_name === 'string' ? model.display_name : model.id,
        provider: config.provider });
    }
    path = '';
    if (json.has_more) {
      if (typeof json.last_id !== 'string' || !json.last_id || cursors.has(json.last_id)) {
        throw new Error('模型列表分页游标无效');
      }
      cursors.add(json.last_id);
      path = `/models?after_id=${encodeURIComponent(json.last_id)}`;
    }
  }
  if (!models.length) throw new Error('该接口未返回可用的文本模型');
  return models;
}

// 设置页刷新模型列表：Key 留空表示沿用已保存的 Key，且只在接口地址来源不变时才使用，避免把 Key 发往新地址。
async function fabriqAiModelsFromPopup(config) {
  if (!config?.key) {
    const saved = await MwaAiStore.getConfig();
    if (!saved?.key || new URL(saved.baseUrl).origin !== new URL(config.baseUrl).origin) {
      throw new Error('请填写 API Key');
    }
    config = { ...config, key: saved.key };
  }
  return fabriqAiModels(config);
}

async function fabriqAiOptions() {
  const fabriqAi = await MwaAiStore.getConfig();
  if (!fabriqAi?.baseUrl || !fabriqAi.key) throw new Error('请先在插件后台的隐蔽页面配置 AI 接口和 Key');
  const config = fabriqAiProvider(fabriqAi);
  const company = /^https:\/\/api\.gpt\.medtronic\.com\/providers\/(?:openai|anthropic)\/v1$/.test(config.baseUrl);
  const providers = company ? ['openai', 'anthropic'] : [config.provider];
  const results = await Promise.allSettled(providers.map(p => fabriqAiModels(fabriqAiProvider(config, p))));
  const models = [];
  const warnings = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') models.push(...result.value);
    else warnings.push(`${providers[index]}：${result.reason.message}`);
  });
  if (!models.length) throw new Error(warnings.join('；'));
  return { models, warnings, model: config.model, provider: config.provider };
}

async function fabriqAiGenerateRaw(messages, selection = {}) {
  const fabriqAi = await MwaAiStore.getConfig();
  if (!fabriqAi?.baseUrl || !fabriqAi.key || !fabriqAi.model) {
    throw new Error('请先在插件后台的隐蔽页面配置 AI 接口和 Key，并在弹窗设置里选择模型');
  }
  if (!Array.isArray(messages) || !messages.length ||
      messages.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) {
    throw new Error('AI 消息格式无效');
  }
  const config = fabriqAiProvider(fabriqAi, selection.provider || fabriqAi.provider || 'openai');
  const model = selection.model || config.model;
  if (typeof model !== 'string' || !model.trim()) throw new Error('请选择模型');
  const anthropic = config.provider === 'anthropic';
  const body = anthropic ? {
    model,
    system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
    messages: messages.filter(m => m.role !== 'system'),
    max_tokens: 4096,
    stream: false
  } : { model, messages, response_format: { type: 'json_object' }, stream: false };
  const json = await fabriqAiRequest(config, anthropic ? '/messages' : '/chat/completions', body);
  if (json.stop_reason === 'max_tokens' || json.choices?.[0]?.finish_reason === 'length') {
    throw new Error('模型输出被截断，请缩短输入或选择其他模型');
  }
  const content = anthropic
    ? json.content?.filter(block => block.type === 'text').map(block => block.text).join('\n')
    : json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI 未返回文本内容');
  return { content, model, provider: config.provider, usage: json.usage || null };
}

// 带记录的生成：每次请求（含自动纠正重试）都写入对话记录，便于在插件后台查看和下载。
async function fabriqAiGenerate(messages, selection = {}, meta = {}) {
  const started = Date.now();
  const base = {
    purpose: String(meta.purpose || 'unknown').slice(0, 60),
    attempt: Number(meta.attempt) || 1,
    ticket: String(meta.ticket || '').slice(0, 120),
    masked: Number(meta.masked) || 0,
    messages
  };
  try {
    const out = await fabriqAiGenerateRaw(messages, selection);
    MwaAiStore.logAi({ ...base, ok: true, model: out.model, provider: out.provider, ms: Date.now() - started,
      response: out.content, usage: out.usage });
    return out.content;
  } catch (error) {
    MwaAiStore.logAi({ ...base, ok: false, ms: Date.now() - started, error: String(error?.message || error) });
    throw error;
  }
}

// Windchill 批量下载：只接受来自 Windchill 页面、同源地址、相对路径文件名的请求。
const WC_DOWNLOAD_ORIGIN = 'https://khplm.medtronic.com.cn';

function wcDownloadFile(request, sender) {
  let pageOrigin = '';
  try { pageOrigin = new URL(sender.tab?.url || '').origin; } catch { /* 非页面来源 */ }
  if (sender.id !== chrome.runtime.id || pageOrigin !== WC_DOWNLOAD_ORIGIN) throw new Error('只允许 Windchill 页面发起下载');
  const url = new URL(String(request.url || ''));
  if (url.origin !== WC_DOWNLOAD_ORIGIN) throw new Error('拒绝下载非 Windchill 同源地址');
  const filename = String(request.filename || '');
  if (!filename || /^[\\/]|^[A-Za-z]:|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(filename)) throw new Error('下载文件名无效');
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url: url.href, filename, conflictAction: 'uniquify', saveAs: false }, id => {
      if (chrome.runtime.lastError || id === undefined) return reject(new Error(chrome.runtime.lastError?.message || '无法开始下载'));
      let finished = false;
      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        chrome.downloads.onChanged.removeListener(listener);
        clearTimeout(timer);
        fn(value);
      };
      const listener = delta => {
        if (delta.id !== id) return;
        if (delta.state?.current === 'complete') {
          chrome.downloads.search({ id }, ([item]) => finish(resolve, { id, bytes: item?.fileSize || 0 }));
        } else if (delta.state?.current === 'interrupted') {
          finish(reject, new Error(`下载中断：${delta.error?.current || '未知原因'}`));
        }
      };
      const timer = setTimeout(() => finish(reject, new Error('下载超时（3 分钟）')), 180000);
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

// ───── 导入中心：只读读取桥 ─────
const FABRIQ_READ_ALLOWED = [
  /^\/backend\/kpi\/v2\/indicator\/\d+$/,
  /^\/legacy\/api\/api\/v1\/indicator\/\d+\/datapoints\/$/,
  /^\/legacy\/api\/api\/v1\/team\/\d+\/$/,
];
// ───── 导入中心：受限写入通道 ─────
// 只允许两种操作：导入 CSV（POST import-datapoints）和删除一条数据点（撤销用）。
// 门禁（全部在后台强制，页面无法绕过）：仅插件后台页可调用；团队必须在「允许导入的团队」名单内（默认只有测试团队 28671）；
// 导入前在后台重新读取 KPI 并按模板 v1 校验，有任何错误即拒绝；删除只允许名单内团队的 KPI。
async function fabriqWriteTab(func, args) {
  const tabs = await chrome.tabs.query({ url: 'https://medtronic.fabriq.tech/*' });
  if (!tabs.length) throw new Error('请先在浏览器中打开一个已登录的 Fabriq 页面');
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, args, func });
  return result && result.result;
}

async function fabriqWrite(op) {
  const { mwaImportWriteTeams = [28671] } = await chrome.storage.local.get('mwaImportWriteTeams');
  const teamId = Number(op.teamId);
  if (!Number.isInteger(teamId) || !mwaImportWriteTeams.map(Number).includes(teamId)) {
    throw new Error(`团队 ${op.teamId} 不在「允许导入的团队」名单内（当前：${mwaImportWriteTeams.join('、') || '空'}）`);
  }
  const kpiInfo = async id => {
    const k = await fabriqRead(`/backend/kpi/v2/indicator/${id}`);
    return { id, name: k.name, frequency: k.frequency, indicator_type: k.indicator_type, is_dynamic: !!k.is_dynamic,
      unit_type: k.unit_type, teams: (k.teams && k.teams.ids) || [], choices: ((k.choices && k.choices.options) || []).map(o => o.value) };
  };

  if (op.type === 'import') {
    if (typeof op.csv !== 'string' || !op.csv.trim()) throw new Error('导入内容为空');
    const parsed = MwaImportCore.parseCsv(op.csv);
    const col = parsed.headers.indexOf('indicator_id');
    const ids = col < 0 ? [] : [...new Set(parsed.rows.map(r => (r.cells[col] || '').trim()).filter(v => /^\d+$/.test(v)).map(Number))];
    if (!ids.length || ids.length > 40) throw new Error('KPI 数量不合法');
    const kpis = {};
    for (const id of ids) kpis[id] = await kpiInfo(id);
    const check = MwaImportCore.validate(parsed, kpis, { teamId, today: op.today });
    const errors = check.issues.filter(i => i.level === 'error');
    if (errors.length) throw new Error(`后台校验未通过（${errors.length} 个错误），已拒绝写入：${errors[0].message}`);
    const out = await fabriqWriteTab(async csv => {
      try {
        const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
        const form = new FormData();
        form.append('import_file', new Blob([csv], { type: 'text/csv' }), 'import.csv');
        form.append('format', 'csv');
        const response = await fetch('/backend/kpi/v2/import-datapoints', { method: 'POST', credentials: 'include', body: form,
          headers: csrf ? { 'X-CSRFToken': csrf } : {}, signal: AbortSignal.timeout(120000) });
        const text = await response.text();
        let body = null;
        try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
        return { status: response.status, body };
      } catch (error) {
        return { status: 0, body: String(error) };
      }
    }, [op.csv]);
    MwaActivity.log({ app: 'Fabriq', title: 'KPI 数据导入', ok: !!out && out.status === 200 && !(out.body && out.body.errors_count),
      detail: `团队 ${teamId}；${parsed.rows.length} 行 / ${ids.length} 个 KPI；${op.note || ''}；结果 ${out ? out.status : '无响应'} ${out && out.body && out.body.success_count !== undefined ? `成功 ${out.body.success_count}，错误 ${out.body.errors_count}` : ''}` });
    return out;
  }

  if (op.type === 'delete') {
    const indicatorId = Number(op.indicatorId);
    const datapointId = String(op.datapointId || '');
    if (!Number.isInteger(indicatorId) || !/^[\w.:-]{1,80}$/.test(datapointId)) throw new Error('删除参数不合法');
    const kpi = await kpiInfo(indicatorId);
    if (kpi.is_dynamic || !kpi.teams.includes(teamId)) throw new Error('该 KPI 不属于允许的团队，或是 Dynamic KPI');
    const out = await fabriqWriteTab(async (kid, dpId) => {
      try {
        const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
        const response = await fetch(`/backend/kpi/v1/indicator/${kid}/datapoint/${encodeURIComponent(dpId)}`, { method: 'DELETE',
          credentials: 'include', headers: csrf ? { 'X-CSRFToken': csrf } : {}, signal: AbortSignal.timeout(60000) });
        return { status: response.status };
      } catch (error) {
        return { status: 0, body: String(error) };
      }
    }, [indicatorId, datapointId]);
    MwaActivity.log({ app: 'Fabriq', title: 'KPI 数据撤销（删除新增数据点）', ok: !!out && out.status >= 200 && out.status < 300,
      detail: `团队 ${teamId}；KPI ${indicatorId}；数据点 ${datapointId}；${op.note || ''}；结果 ${out ? out.status : '无响应'}` });
    return out;
  }
  throw new Error('不支持的写入类型');
}

async function fabriqRead(endpoint) {
  if (typeof endpoint !== 'string' || !FABRIQ_READ_ALLOWED.some(re => re.test(endpoint))) throw new Error('不允许的读取路径');
  const tabs = await chrome.tabs.query({ url: 'https://medtronic.fabriq.tech/*' });
  if (!tabs.length) throw new Error('请先在浏览器中打开一个已登录的 Fabriq 页面');
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    args: [endpoint],
    func: async url => {
      try {
        const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(45000) });
        const text = await response.text();
        let body = null;
        try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
        return { status: response.status, body };
      } catch (error) {
        return { status: 0, body: String(error) };
      }
    }
  });
  const out = result && result.result;
  if (!out || out.status !== 200) throw new Error(`Fabriq 返回 ${out ? out.status : '无响应'}：${out && typeof out.body === 'string' ? out.body : ''}`);
  return out.body;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background script received action:', request.action);

  if (request.action === 'fabriqAiGenerate') {
    fabriqAiGenerate(request.messages, request.selection, request.meta).then(
      data => sendResponse({ ok: true, data }),
      err => sendResponse({ ok: false, error: String(err && err.message || err) })
    );
    return true;
  }

  // 导入中心（只读）：通过已打开的 Fabriq 页面（带登录态）发起 GET，仅限白名单路径，仅限插件后台页调用。
  const fromOptions = sender.id === chrome.runtime.id && (sender.url || '').startsWith(chrome.runtime.getURL('options.html'));
  const fromFabriqTab = sender.id === chrome.runtime.id && (sender.tab?.url || '').startsWith('https://medtronic.fabriq.tech/');
  if (request.action === 'fabriqRead') {
    if (!fromOptions && !fromFabriqTab) {
      sendResponse({ ok: false, error: '仅限插件后台使用' });
      return;
    }
    fabriqRead(request.endpoint).then(
      data => sendResponse({ ok: true, data }),
      err => sendResponse({ ok: false, error: String(err && err.message || err) })
    );
    return true;
  }

  // 导入中心（写入）：同样仅限插件后台页；门禁在 fabriqWrite 内强制。
  if (request.action === 'fabriqWrite') {
    if (!fromOptions && !fromFabriqTab) {
      sendResponse({ ok: false, error: '仅限插件后台使用' });
      return;
    }
    fabriqWrite(request.op).then(
      data => sendResponse({ ok: true, data }),
      err => sendResponse({ ok: false, error: String(err && err.message || err) })
    );
    return true;
  }

  // AI 配置只允许扩展自己的设置页（弹窗 / 插件后台）读写；明文 Key 只有插件后台可以查看。
  const settingsPageUrls = ['popup.html', 'options.html'].map(page => chrome.runtime.getURL(page));
  const fromSettingsPage = sender.id === chrome.runtime.id && settingsPageUrls.some(url => (sender.url || '').startsWith(url));

  if (request.action === 'mwaExportLogsNow') {
    if (!fromSettingsPage) { sendResponse({ ok: false, error: '只能在插件后台使用' }); return; }
    MwaExport.exportAll().then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.action === 'fabriqAiRevealKey') {
    if (!fromSettingsPage || !(sender.url || '').startsWith(chrome.runtime.getURL('options.html'))) {
      sendResponse({ ok: false, error: '只能在插件后台查看 Key' });
      return;
    }
    MwaAiStore.getConfig().then(config => sendResponse({ ok: true, data: config?.key || '' }),
      error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.action === 'fabriqAiGetConfig' || request.action === 'fabriqAiSaveConfig') {
    if (!fromSettingsPage) {
      sendResponse({ ok: false, error: '请通过插件设置修改 AI 配置' });
      return;
    }
    const task = request.action === 'fabriqAiGetConfig'
      ? MwaAiStore.getPublicConfig()
      : MwaAiStore.saveConfig(request.config).then(() => true);
    task.then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.action === 'fabriqAiOptions' || request.action === 'fabriqAiModels') {
    if (request.action === 'fabriqAiModels' && !fromSettingsPage) {
      sendResponse({ ok: false, error: '请通过插件设置刷新模型列表' });
      return;
    }
    const result = request.action === 'fabriqAiOptions'
      ? fabriqAiOptions() : fabriqAiModelsFromPopup(request.config);
    result.then(data => sendResponse({ ok: true, data }),
      error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (request.action === 'wcDownloadFile') {
    wcDownloadFile(request, sender).then(
      data => sendResponse({ ok: true, ...data }),
      error => sendResponse({ ok: false, error: String(error && error.message || error) })
    );
    return true;
  }

  if (request.action === 'mwaLogActivity') {
    if (sender.id === chrome.runtime.id) MwaActivity.log(request);
    sendResponse({ ok: true });
    return;
  }

  if (request.action === 'wcOpenDownloader') {
    const tabId = sender.tab?.id;
    if (sender.id !== chrome.runtime.id || tabId === undefined) {
      sendResponse({ ok: false, error: '只允许 Windchill 页面发起' });
      return;
    }
    chrome.storage.session.set({ [`wcJob:${tabId}`]: { ...request.job, tabId, createdAt: Date.now() } })
      .then(async () => {
        const url = chrome.runtime.getURL(`wc_download.html?tab=${tabId}`);
        // 只保留一个下载标签页：已存在就更新任务并切过去，不再新开。
        const [existing] = await chrome.tabs.query({ url: chrome.runtime.getURL('wc_download.html*') });
        if (existing) {
          await chrome.tabs.update(existing.id, { url, active: true });
          await chrome.windows.update(existing.windowId, { focused: true });
        } else {
          await chrome.tabs.create({ url, active: true });
        }
      })
      .then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (request.action === 'wcOpenBatch') {
    const tabId = sender.tab?.id;
    if (sender.id !== chrome.runtime.id || tabId === undefined) {
      sendResponse({ ok: false, error: '只允许 Windchill 页面发起' });
      return;
    }
    (async () => {
      const url = chrome.runtime.getURL(`wc_batch.html?tab=${tabId}`);
      const [existing] = await chrome.tabs.query({ url: chrome.runtime.getURL('wc_batch.html*') });
      if (existing) {
        await chrome.tabs.update(existing.id, { url, active: true });
        await chrome.windows.update(existing.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url, active: true });
      }
    })().then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  if (request.action === 'openOptions') {
    if (sender.id === chrome.runtime.id) chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }

  if (request.action === 'monitorNewTab') {
    const url = request.url;
    if (sender && sender.tab && sender.tab.id) {
      setMainTabId(sender.tab.id);
    }
    monitoredUrls.add(url);
    sendResponse({ success: true });
  }

  if (request.action === 'cornerstoneAutoClickStarted') {
    // 课程弹出页里的 content script 也会发此消息，若被当成主页签，弹出页就永远不会被关闭
    const t = sender && sender.tab;
    const isPopup = t && (t.openerTabId != null || cornerstonePopupCandidateTabIds.has(t.id) || !/lms-learner-home|\/home/i.test(t.url || ''));
    if (t && t.id && !isPopup) {
      setMainTabId(t.id);
    }
    sendResponse({ success: true });
  }

  // 视频跳过：注入到所有 SCORM tab
  if (request.action === 'videoSkip') {
    const targets = scormTabIds.size > 0 ? [...scormTabIds] : [];
    // 也包含发送方 tab
    if (sender && sender.tab && sender.tab.id) targets.push(sender.tab.id);
    const unique = [...new Set(targets)];
    unique.forEach(tabId => {
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          document.querySelectorAll('video').forEach(v => {
            try { if (v.duration && isFinite(v.duration)) v.currentTime = v.duration - 0.1; } catch(e) {}
          });
        }
      }).catch(() => {});
    });
    sendResponse({ success: true, tabs: unique.length });
  }

  // 视频变速：注入到所有 SCORM tab
  if (request.action === 'videoSpeed') {
    const speed = request.speed || 1;
    const targets = scormTabIds.size > 0 ? [...scormTabIds] : [];
    if (sender && sender.tab && sender.tab.id) targets.push(sender.tab.id);
    const unique = [...new Set(targets)];
    unique.forEach(tabId => {
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (s) => {
          document.querySelectorAll('video').forEach(v => {
            try { v.playbackRate = s; } catch(e) {}
          });
        },
        args: [speed]
      }).catch(() => {});
    });
    sendResponse({ success: true, tabs: unique.length });
  }

  // Workday 职务申请批量：按序号打开新标签页，由 content_workday_req.js 认领任务并填写
  if (request.action === 'wdReqBatchOpen') {
    (async () => {
      const { wdReqJobs = {} } = await chrome.storage.session.get('wdReqJobs');
      let opened = 0;
      for (const index of request.indexes || []) {
        const tab = await chrome.tabs.create({ url: request.url, active: false });
        wdReqJobs[tab.id] = { index };
        opened++;
      }
      await chrome.storage.session.set({ wdReqJobs });
      sendResponse({ success: true, opened });
    })();
    return true;
  }

  if (request.action === 'wdReqGetJob') {
    (async () => {
      const { wdReqJobs = {} } = await chrome.storage.session.get('wdReqJobs');
      sendResponse(sender?.tab?.id != null ? wdReqJobs[sender.tab.id] || null : null);
    })();
    return true;
  }

  return true;
});

function shouldCloseCornerstonePopup(tab) {
  if (!tab || !tab.id || mainTabId === null || tab.id === mainTabId) return false;

  const url = tab.url || '';
  const pendingUrl = tab.pendingUrl || '';
  const combinedUrl = `${url} ${pendingUrl}`;
  const openedFromMainTab = tab.openerTabId === mainTabId || cornerstonePopupCandidateTabIds.has(tab.id);

  if (openedFromMainTab) return true;

  if (combinedUrl.includes('medtronic.csod.com') && cornerstonePopupCandidateTabIds.has(tab.id)) {
    return true;
  }

  return false;
}

function closeCornerstonePopupTab(tabId, reason, delay = 2000) {
  if (!tabId || tabId === mainTabId) return;
  setTimeout(() => {
    chrome.storage.local.get(['isAutoClickRunning'], (r) => {
      if (!r.isAutoClickRunning) { cornerstonePopupCandidateTabIds.delete(tabId); return; }
      closeNow();
    });
    function closeNow() {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || !tab || tab.id === mainTabId) return;
      console.log(`Closing Cornerstone popup tab (${reason}):`, tab.url || tab.pendingUrl || tab.id);
      chrome.tabs.remove(tabId, () => {
        cornerstonePopupCandidateTabIds.delete(tabId);
        if (chrome.runtime.lastError) {
          console.log('Close Cornerstone popup failed:', chrome.runtime.lastError.message);
        }
      });
    });
    }
  }, delay);
}

// 只关闭新建且不是主tabId的标签页
chrome.tabs.onCreated.addListener((tab) => {
  console.log('New tab created:', tab.url, 'tabId:', tab.id);
  // 记录 SCORM tab
  if (tab.url && tab.url.includes('medtronic.csod.com')) {
    scormTabIds.add(tab.id);
  }

  // 只有自动点击运行期间才关闭弹出页；用户手动打开/点击 Cornerstone 链接不能被误关
  if (mainTabId !== null && tab.id !== mainTabId &&
      (tab.openerTabId === mainTabId || /medtronic\.csod\.com/.test(`${tab.url || ''} ${tab.pendingUrl || ''}`))) {
    chrome.storage.local.get(['isAutoClickRunning'], (r) => {
      if (!r.isAutoClickRunning) return;
      cornerstonePopupCandidateTabIds.add(tab.id);
      closeCornerstonePopupTab(tab.id, 'opened from Cornerstone main tab');
    });
  }

  for (const monitoredUrl of monitoredUrls) {
    if (tab.url && (tab.url.includes(monitoredUrl) || tab.url.includes(monitoredUrl.replace('javascript:void(0);', '')))) {
      if (mainTabId !== null && tab.id !== mainTabId) {
        console.log('Found monitored URL in new tab, closing:', tab.url);
        setTimeout(() => {
          chrome.tabs.remove(tab.id, () => {
            console.log('New tab closed:', tab.id);
          });
        }, 2000);
        monitoredUrls.delete(monitoredUrl);
      }
      break;
    }
  }
});

// 只关闭新建且不是主tabId的标签页
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 记录 SCORM tab
  if (tab.url && tab.url.includes('medtronic.csod.com')) {
    scormTabIds.add(tabId);
  }

  if (shouldCloseCornerstonePopup(tab)) {
    closeCornerstonePopupTab(tabId, 'Cornerstone popup updated');
    return;
  }

  if (changeInfo.status === 'complete' && tab.url) {
    for (const monitoredUrl of monitoredUrls) {
      if (tab.url.includes(monitoredUrl) || tab.url.includes(monitoredUrl.replace('javascript:void(0);', ''))) {
        if (mainTabId !== null && tabId !== mainTabId) {
          console.log('Found monitored URL, closing tab:', tab.url);
          setTimeout(() => {
            chrome.tabs.remove(tabId, () => {
              console.log('Tab closed:', tabId);
            });
          }, 2000);
          monitoredUrls.delete(monitoredUrl);
        }
        break;
      }
    }
  }
});

// tab 关闭时清理 scormTabIds
chrome.tabs.onRemoved.addListener((tabId) => {
  scormTabIds.delete(tabId);
  cornerstonePopupCandidateTabIds.delete(tabId);
});

console.log('Background script loaded');

// 右键菜单只保留“中止所有指令”；其余配置都在左键弹窗里
function updateContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'stopAllActions',
      title: '中止所有插件指令',
      contexts: ['action']
    });
  });
}

function stopAllActions() {
  MwaActivity.log({ app: '插件', title: '中止所有指令', detail: '来自工具栏弹窗或右键菜单' });
  chrome.storage.local.set({
    isAutoClickRunning: false,
    currentClickCount: 0,
    targetClickCount: 0,
    markCompleteCount: 0,
    clickedLaunchHrefs: [],
    launchAttempts: {},
    noButtonRefreshAttempts: 0,
    ehrLoginAttempts: 0
  }, () => {
    const targets = [
      ['*://medtronic.csod.com/*', 'stopAllActions'],
      ['*://ehr.medtronic.com.cn/*', 'stopAllActions'],
      ['https://khplm.medtronic.com.cn/*', 'stopWindchillActions']
    ];
    targets.forEach(([pattern, action]) => {
      chrome.tabs.query({ url: pattern }, (tabs) => {
        tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { action }, () => { void chrome.runtime.lastError; }));
      });
    });
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.png',
      title: 'Medtronic Work Assistant',
      message: '所有插件指令已中止',
      priority: 2
    });
  });
}

function reloadCornerstoneTabs() {
  chrome.tabs.query({ url: '*://medtronic.csod.com/*' }, (tabs) => tabs.forEach(tab => chrome.tabs.reload(tab.id)));
}

chrome.runtime.onInstalled.addListener(updateContextMenu);
chrome.runtime.onStartup.addListener(updateContextMenu);

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'stopAllActions') stopAllActions();
});

chrome.runtime.onMessage.addListener((request) => {
  if (request && request.action === 'stopAllFromPopup') stopAllActions();
});
// 监听设置变化，动态更新菜单和定时任务
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.autoClickEnabled || changes.autoClosePopup) {
      reloadCornerstoneTabs();
    }
    if (changes.dailyOpenEnabled || changes.dailyOpenTime) {
      updateDailyAlarm();
    }
    if (changes.windchillDailyOpenEnabled || changes.windchillDailyOpenTime) {
      updateWindchillDailyAlarm();
    }
  }
});

// 计算下一个运行时间
function getNextRunTime(targetTimeStr = "09:00") {
  const [hours, minutes] = targetTimeStr.split(':').map(Number);
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(hours, minutes, 0, 0);

  // 如果今天已经过了设定时间，则设为明天
  if (now > nextRun) {
    nextRun.setDate(now.getDate() + 1);
  }
  return nextRun.getTime();
}

// 更新定时任务
function updateDailyAlarm() {
  chrome.storage.local.get(['dailyOpenEnabled', 'dailyOpenTime'], (result) => {
    if (result.dailyOpenEnabled) {
      // 默认 09:00
      const timeStr = result.dailyOpenTime || "09:00";
      chrome.alarms.create('dailyOpenPages', {
        when: getNextRunTime(timeStr),
        periodInMinutes: 1440 // 24小时
      });
      console.log(`Daily alarm set for: ${new Date(getNextRunTime(timeStr)).toLocaleString()} (Target: ${timeStr})`);
    } else {
      chrome.alarms.clear('dailyOpenPages');
      console.log('Daily alarm cleared');
    }
  });
}

// 监听定时任务触发
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dailyOpenPages') {
    console.log('Daily alarm triggered, opening pages...');
    MwaActivity.log({ app: 'EHR', title: '每日自动打开', detail: 'http://ehr.medtronic.com.cn/' });
    const urls = [
      'http://ehr.medtronic.com.cn/'
    ];

    urls.forEach(url => {
      chrome.tabs.create({ url: url });
    });
  }
});

// 初始化或更新定时器
updateDailyAlarm();

// ── Windchill：Basic Auth 凭据与每日打开 ──
function getWindchillCredentials(callback) {
  chrome.storage.local.get(['windchillUsername', 'windchillPassword', 'Login1', 'Password1'], (result) => {
    const own = result.windchillUsername && result.windchillPassword;
    callback({
      username: (own ? result.windchillUsername : result.Login1) || '',
      password: (own ? result.windchillPassword : result.Password1) || ''
    });
  });
}

// 同一请求只提交一次凭据，密码错误时不让 Chrome 反复重试导致账号锁定
const windchillAuthTried = new Set();

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (windchillAuthTried.has(details.requestId)) {
      callback({});
      return;
    }
    getWindchillCredentials((credentials) => {
      if (!credentials.username || !credentials.password) {
        callback({});
        return;
      }
      windchillAuthTried.add(details.requestId);
      if (windchillAuthTried.size > 200) windchillAuthTried.delete(windchillAuthTried.values().next().value);
      callback({ authCredentials: credentials });
    });
  },
  { urls: ['https://khplm.medtronic.com.cn/*'] },
  ['asyncBlocking']
);

function updateWindchillDailyAlarm() {
  chrome.storage.local.get(['windchillDailyOpenEnabled', 'windchillDailyOpenTime'], (result) => {
    if (!result.windchillDailyOpenEnabled) {
      chrome.alarms.clear('windchillDailyOpen');
      return;
    }
    chrome.alarms.create('windchillDailyOpen', {
      when: getNextRunTime(result.windchillDailyOpenTime || '09:00'),
      periodInMinutes: 1440
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'windchillDailyOpen') {
    MwaActivity.log({ app: 'Windchill', title: '每日自动打开', detail: 'Windchill 首页' });
    chrome.tabs.create({ url: 'https://khplm.medtronic.com.cn/Windchill/app/#ptc1/homepage' });
  }
});

updateWindchillDailyAlarm();
