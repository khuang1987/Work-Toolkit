// 插件后台：AI 对话记录 / 操作记录 / 页面自检。数据来自 chrome.storage.local，仅本机可见。
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, props, ...children) => {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    children.forEach(child => node.append(child));
    return node;
  };
  const fmtTime = iso => new Date(iso).toLocaleString('zh-CN', { hour12: false });
  const PURPOSE_NAMES = { progress: '进展更新', qa: '智能问答', title: '优化标题', description: '优化描述', tasks: '拆分任务', schedule: '分配时间',
    'title+description+tasks': '完整优化', optimize: '优化', unknown: '未标注', 'windchill-signed-pick': 'Windchill 签名文件判断', 'windchill-rules': 'Windchill 规则建议' };
  const purposeName = purpose => PURPOSE_NAMES[purpose]
    || (purpose?.startsWith('translate:') ? `翻译→${purpose.endsWith('en') ? '英文' : '中文'}` : null)
    || (purpose?.startsWith('comment-translate:') ? `评论翻译→${purpose.endsWith('en') ? '英文' : '中文'}` : null) || purpose;

  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  function showTab(name) {
    if ((name === 'features' || name === 'aiconfig') && !unlocked()) name = 'ai';
    if (!$(`tab-${name}`)) name = 'ai';
    document.querySelectorAll('nav button').forEach(item => item.classList.toggle('on', item.dataset.tab === name));
    ['ai', 'ops', 'windchill', 'dllog', 'import', 'sched', 'features', 'aiconfig'].forEach(tab => { $(`tab-${tab}`).hidden = tab !== name; });
    if (name === 'ops') loadOps();
    if (name === 'windchill') loadWindchill();
    if (name === 'dllog') loadDlLog();
    if (name === 'features') renderFeatures();
    if (name === 'aiconfig') loadAiConfig();
  }
  document.querySelectorAll('nav button').forEach(button => { button.onclick = () => showTab(button.dataset.tab); });

  const download = (name, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = el('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // ───── AI 对话记录 ─────
  let aiAll = [];
  const matches = entry => {
    const q = $('aiSearch').value.trim().toLowerCase();
    const purpose = $('aiPurpose').value;
    const status = $('aiStatus').value;
    if (purpose && entry.purpose !== purpose) return false;
    if (status === 'ok' && !entry.ok) return false;
    if (status === 'fail' && entry.ok) return false;
    if (status === 'retry' && !(entry.attempt > 1)) return false;
    if (!q) return true;
    const hay = [entry.ticket, entry.purpose, entry.model, entry.response, entry.error, ...(entry.messages || []).map(m => m.content)].join('\n').toLowerCase();
    return hay.includes(q);
  };

  function toMarkdown(list) {
    return list.map(entry => [`## ${fmtTime(entry.time)} · ${purposeName(entry.purpose)} · ${entry.ok ? '成功' : '失败'}`,
      `- 工单：${entry.ticket || '—'}；模型：${entry.model || '—'}（${entry.provider || '—'}）；第 ${entry.attempt} 次；耗时 ${entry.ms ?? '—'} ms；隐藏凭据 ${entry.masked || 0} 处`,
      ...(entry.messages || []).map(m => `\n### ${m.role}\n\n\`\`\`text\n${m.content}\n\`\`\``),
      `\n### ${entry.ok ? 'response' : 'error'}\n\n\`\`\`text\n${entry.ok ? entry.response : entry.error}\n\`\`\``].join('\n')).join('\n\n---\n\n');
  }

  function renderAi() {
    const list = aiAll.filter(matches);
    $('aiCount').textContent = `${list.length} / ${aiAll.length} 条`;
    const box = $('aiList');
    if (!list.length) { box.replaceChildren(el('div', { className: 'empty', textContent: aiAll.length ? '没有符合条件的记录' : '还没有 AI 对话记录，在 Fabriq 里用一次 AI 功能后会出现在这里' })); return; }
    const body = el('tbody');
    list.forEach(entry => {
      const detail = el('tr', { className: 'detail', hidden: true }, el('td', { colSpan: 7 },
        ...(entry.messages || []).map(m => el('div', { className: 'msg' }, el('h4', { textContent: m.role }), el('pre', { textContent: m.content }))),
        el('div', { className: 'msg' }, el('h4', { textContent: entry.ok ? 'response（模型返回）' : 'error' }), el('pre', { textContent: entry.ok ? entry.response : entry.error })),
        el('button', { className: 'btn', textContent: '下载这一条', onclick: () => download(`ai-${entry.id}.md`, toMarkdown([entry]), 'text/markdown') })));
      const row = el('tr', { className: 'row' },
        el('td', { textContent: fmtTime(entry.time) }),
        el('td', {}, el('span', { className: 'tag', textContent: purposeName(entry.purpose) })),
        el('td', { textContent: entry.ticket || '—' }),
        el('td', { textContent: entry.model || '—' }),
        el('td', { textContent: entry.attempt > 1 ? `第 ${entry.attempt} 次` : '1' }),
        el('td', { className: entry.ok ? 'ok' : 'bad', textContent: entry.ok ? '成功' : '失败' }),
        el('td', { className: 'muted', textContent: entry.ms != null ? `${(entry.ms / 1000).toFixed(1)}s` : '—' }));
      row.onclick = () => { detail.hidden = !detail.hidden; };
      body.append(row, detail);
    });
    box.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, ...['时间', '用途', '工单', '模型', '尝试', '状态', '耗时'].map(text => el('th', { textContent: text })))), body));
  }

  async function loadAi() {
    const { mwaAiLog = [] } = await chrome.storage.local.get('mwaAiLog');
    aiAll = mwaAiLog;
    const purposes = [...new Set(aiAll.map(entry => entry.purpose))];
    const current = $('aiPurpose').value;
    $('aiPurpose').replaceChildren(el('option', { value: '', textContent: '全部用途' }), ...purposes.map(p => el('option', { value: p, textContent: purposeName(p) })));
    $('aiPurpose').value = purposes.includes(current) ? current : '';
    renderAi();
  }
  ['aiSearch', 'aiPurpose', 'aiStatus'].forEach(id => $(id).addEventListener(id === 'aiSearch' ? 'input' : 'change', renderAi));
  $('aiRefresh').onclick = loadAi;
  $('aiJson').onclick = () => download(`ai-log-${stamp()}.json`, JSON.stringify(aiAll.filter(matches), null, 2), 'application/json');
  $('aiMd').onclick = () => download(`ai-log-${stamp()}.md`, toMarkdown(aiAll.filter(matches)), 'text/markdown');
  $('aiClear').onclick = async () => {
    if (!confirm('清空全部 AI 对话记录？此操作不可恢复。')) return;
    await chrome.storage.local.remove('mwaAiLog');
    loadAi();
  };

  // ───── 操作记录（各插件汇总，按日期时间倒序） ─────
  let opsAll = [];
  const dayOf = iso => new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const timeOf = iso => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });

  function opsMatches(entry) {
    const q = $('opsSearch').value.trim().toLowerCase();
    const app = $('opsApp').value;
    const status = $('opsStatus').value;
    if (app && entry.app !== app) return false;
    if (status === 'ok' && !entry.ok) return false;
    if (status === 'bad' && entry.ok) return false;
    return !q || `${entry.app} ${entry.title} ${entry.detail}`.toLowerCase().includes(q);
  }

  function renderOps() {
    const list = opsAll.filter(opsMatches);
    $('opsCount').textContent = `${list.length} / ${opsAll.length} 条`;
    const box = $('opsList');
    if (!list.length) { box.replaceChildren(el('div', { className: 'empty', textContent: opsAll.length ? '没有符合条件的记录' : '还没有操作记录' })); return; }
    const body = el('tbody');
    let lastDay = '';
    list.forEach(entry => {
      const day = dayOf(entry.time);
      if (day !== lastDay) {
        lastDay = day;
        body.append(el('tr', {}, el('td', { colSpan: 5, style: 'background:#f1f5f9;font-weight:600;color:#475569', textContent: day })));
      }
      const row = el('tr', { className: entry.extra ? 'row' : '' },
        el('td', { className: 'muted', textContent: timeOf(entry.time) }),
        el('td', {}, el('span', { className: 'tag', textContent: entry.app })),
        el('td', { textContent: entry.title }),
        el('td', { textContent: entry.detail || '—' }),
        el('td', { className: entry.ok ? 'ok' : 'bad', textContent: entry.status || (entry.ok ? '成功' : '失败') }));
      body.append(row);
      if (entry.extra) {
        const detail = el('tr', { className: 'detail', hidden: true }, el('td', { colSpan: 5 }, el('pre', { className: 'muted', style: 'white-space:pre-wrap;margin:0', textContent: entry.extra })));
        row.onclick = () => { detail.hidden = !detail.hidden; };
        body.append(detail);
      }
    });
    box.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, ...['时间', '应用', '操作', '内容', '结果'].map(text => el('th', { textContent: text })))), body));
  }

  async function loadOps() {
    const data = await chrome.storage.local.get(['mwaActivityLog', 'mwaOpLog', 'windchillDownloadLog']);
    const entries = [...(data.mwaActivityLog || [])];
    (data.mwaOpLog || []).forEach(op => entries.push({
      time: op.time, app: 'Fabriq', title: '应用 AI 结果到工单', ok: true,
      detail: `${op.ticket || '—'}：${(op.applied || []).join('；')}`,
      status: op.undone ? '已撤销' : (op.reversible ? '可撤销' : '需手动还原'),
      extra: op.manual?.length ? `需手动还原：\n${op.manual.join('\n')}` : ''
    }));
    const batches = new Map();
    (data.windchillDownloadLog || []).forEach(item => {
      const batch = batches.get(item.batch) || { time: item.time, ok: 0, bad: 0, lines: [] };
      if (item.time > batch.time) batch.time = item.time;
      if (item.status === 'done') batch.ok += 1; else batch.bad += 1;
      if (item.status !== 'done') batch.lines.push(`${item.number}：${item.reason}`);
      batches.set(item.batch, batch);
    });
    batches.forEach((batch, name) => entries.push({
      time: batch.time, app: 'Windchill', title: '批量下载签名文件', ok: batch.bad === 0,
      detail: `${name}：成功 ${batch.ok} · 失败 ${batch.bad}`, extra: batch.lines.slice(0, 20).join('\n')
    }));
    opsAll = entries.filter(entry => entry.time).sort((a, b) => (a.time < b.time ? 1 : -1));
    const apps = [...new Set(opsAll.map(entry => entry.app))];
    const current = $('opsApp').value;
    $('opsApp').replaceChildren(el('option', { value: '', textContent: '全部应用' }), ...apps.map(app => el('option', { value: app, textContent: app })));
    $('opsApp').value = apps.includes(current) ? current : '';
    renderOps();
  }
  ['opsSearch', 'opsApp', 'opsStatus'].forEach(id => $(id).addEventListener(id === 'opsSearch' ? 'input' : 'change', renderOps));
  $('opsRefresh').onclick = loadOps;
  $('opsJson').onclick = () => download(`ops-log-${stamp()}.json`, JSON.stringify(opsAll.filter(opsMatches), null, 2), 'application/json');
  $('opsClear').onclick = async () => {
    if (!confirm('清空全部操作记录（含 Windchill 下载记录和 Fabriq 的撤销依据）？清空后 Fabriq 改动将无法再自动撤销。')) return;
    await chrome.storage.local.remove(['mwaActivityLog', 'mwaOpLog', 'windchillDownloadLog']);
    loadOps();
    loadDlLog();
  };

  // ───── 功能管理（隐藏入口：连点版本号 5 次并输入密码） ─────
  const FEATURES = [
    ['windchill', 'Windchill', '登录填充、审批摘要、规则库与签名文件下载'],
    ['fabriq', 'Fabriq', '工单 AI 优化与翻译'],
    ['oee', 'OEE', 'OEE 看板入口'],
    ['cornerstone', 'Cornerstone', '自动点击、自动过课'],
    ['ehr', 'EHR', '一键审批、每日自动打开'],
    ['workday', 'Workday', '绩效评估 / 提交批量'],
    ['powerbi', 'Power BI', 'Power BI 报表入口']
  ];
  const DEFAULT_FEATURES = { windchill: true, fabriq: true, oee: true };
  // 动态密码：前缀 + 当天日期（YYYYMMDD，本机时间），如 khuang20261105；每天自动失效。前缀只存哈希。
  const PREFIX_HASH = '779e394433ab6256b10879c8a31f7a38ac2c942a58478ba7f5d2b5d41c08962a';
  const todayStamp = () => {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  };
  async function passwordOk(input) {
    const text = String(input || '').trim();
    return text.endsWith(todayStamp()) && await sha256(text.slice(0, -8)) === PREFIX_HASH;
  }
  const unlocked = () => sessionStorage.getItem('mwaFeaturesUnlocked') === '1';
  const sha256 = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');

  async function renderFeatures() {
    const { mwaFeatures = {} } = await chrome.storage.local.get('mwaFeatures');
    const current = { ...DEFAULT_FEATURES, ...mwaFeatures };
    $('featureList').replaceChildren(...FEATURES.map(([key, name, desc]) => {
      const input = el('input', { type: 'checkbox', checked: !!current[key] });
      input.onchange = async () => {
        const { mwaFeatures: saved = {} } = await chrome.storage.local.get('mwaFeatures');
        await chrome.storage.local.set({ mwaFeatures: { ...DEFAULT_FEATURES, ...saved, [key]: input.checked } });
        $('featureStatus').textContent = `${name} 已${input.checked ? '显示' : '隐藏'}`;
      };
      return el('div', { className: 'rule-card' }, el('label', { className: 'inline' }, input, el('strong', { textContent: name })), el('div', { className: 'muted', textContent: desc }));
    }));
  }
  $('featureReset').onclick = async () => { await chrome.storage.local.remove('mwaFeatures'); renderFeatures(); $('featureStatus').textContent = '已恢复默认'; };

  // 密码输入框：圆角弹层，输入内容以圆点显示（不用浏览器自带 prompt，它会明文显示）。
  function askPassword() {
    return new Promise(resolve => {
      const input = el('input', { type: 'password', autocomplete: 'off', placeholder: '密码', style: 'width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:12px;font:inherit;outline:none' });
      const error = el('div', { style: 'min-height:18px;margin-top:6px;color:#dc2626;font-size:12px' });
      const ok = el('button', { type: 'button', textContent: '确定', style: 'padding:8px 18px;border:0;border-radius:12px;background:#2563eb;color:#fff;font:inherit;font-weight:600;cursor:pointer' });
      const cancel = el('button', { type: 'button', textContent: '取消', style: 'padding:8px 18px;border:0;border-radius:12px;background:#e2e8f0;color:#334155;font:inherit;cursor:pointer' });
      const card = el('div', { style: 'width:300px;padding:20px;border-radius:20px;background:#fff;box-shadow:0 20px 50px rgba(0,0,0,.25)' },
        el('div', { textContent: '请输入密码', style: 'margin-bottom:12px;font-weight:700;font-size:16px' }), input, error,
        el('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:10px' }, cancel, ok));
      const overlay = el('div', { style: 'position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(15,23,42,.35);backdrop-filter:blur(4px)' }, card);
      const close = value => { overlay.remove(); resolve(value); };
      const submit = async () => {
        if (await passwordOk(input.value)) close(true);
        else { error.textContent = '密码错误'; input.value = ''; input.focus(); }
      };
      ok.onclick = submit;
      cancel.onclick = () => close(false);
      overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(false); });
      input.addEventListener('keydown', event => { if (event.key === 'Enter') submit(); else if (event.key === 'Escape') close(false); });
      document.body.append(overlay);
      input.focus();
    });
  }

  let versionClicks = 0;
  let versionTimer = null;
  $('version').addEventListener('click', async () => {
    versionClicks += 1;
    clearTimeout(versionTimer);
    versionTimer = setTimeout(() => { versionClicks = 0; }, 2000);
    if (versionClicks < 5) return;
    versionClicks = 0;
    if (!unlocked()) {
      if (!await askPassword()) return;
      sessionStorage.setItem('mwaFeaturesUnlocked', '1');
    }
    $('featuresNav').hidden = false;
    $('aiconfigNav').hidden = false;
    showTab('aiconfig');
  });
  if (unlocked()) { $('featuresNav').hidden = false; $('aiconfigNav').hidden = false; }

  // ───── 页面右上角：AI 模型切换 + 开发者模式 ─────
  const gatewayUrl = (baseUrl, provider) => (/^https:\/\/api\.gpt\.medtronic\.com\/providers\/(?:openai|anthropic)\/v1\/?$/.test(baseUrl)
    ? `https://api.gpt.medtronic.com/providers/${provider}/v1` : baseUrl.replace(/\/$/, ''));
  let modelCfg = { baseUrl: '', provider: 'openai', model: '', hasKey: false };
  let needsGrant = false;
  const mdMsg = (text, bad) => { $('mdStatus').textContent = text; $('mdStatus').className = bad ? 'bad' : 'muted'; };

  function renderModelOptions(models) {
    const current = `${modelCfg.provider}|${modelCfg.model}`;
    const options = models.map(model => el('option', {
      value: `${model.provider}|${model.id}`,
      textContent: `${model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id} · ${model.provider}` }));
    if (modelCfg.model && !models.some(model => `${model.provider}|${model.id}` === current)) {
      options.unshift(el('option', { value: current, textContent: `${modelCfg.model} · ${modelCfg.provider}（当前）` }));
    }
    $('mdSelect').replaceChildren(...options);
    $('mdSelect').value = current;
  }

  // 模型列表有缓存：打开页面立刻可选，后台再刷新（只在列表变化时替换，避免下拉展开时被重建）。
  async function refreshModelList() {
    mdMsg('正在更新模型列表…');
    try {
      const response = await chrome.runtime.sendMessage({ action: 'fabriqAiOptions' });
      if (!response?.ok) throw new Error(response?.error || '模型列表查询失败');
      const { models } = response.data;
      const { mwaModelCache } = await chrome.storage.local.get('mwaModelCache');
      if (JSON.stringify(mwaModelCache?.models) !== JSON.stringify(models)) renderModelOptions(models);
      await chrome.storage.local.set({ mwaModelCache: { baseUrl: modelCfg.baseUrl, models } });
      mdMsg('');
    } catch (error) { mdMsg(`模型列表更新失败：${error.message}`, true); }
  }

  async function loadModelHeader() {
    const { devMode, mwaModelCache } = await chrome.storage.local.get(['devMode', 'mwaModelCache']);
    $('devMode').checked = !!devMode;
    let response;
    try { response = await chrome.runtime.sendMessage({ action: 'fabriqAiGetConfig' }); } catch (error) { response = null; }
    if (!response) {
      $('mdSelect').replaceChildren(el('option', { value: '', textContent: '后台无响应' }));
      mdMsg('后台未响应，请到 chrome://extensions 重新加载插件后刷新本页', true);
      return;
    }
    modelCfg = { baseUrl: '', provider: 'openai', model: '', hasKey: false, ...((response.ok && response.data) || {}) };
    if (!modelCfg.baseUrl || !modelCfg.hasKey) {
      $('mdSelect').replaceChildren(el('option', { value: '', textContent: '未配置 AI' }));
      mdMsg('接口和 Key 在隐蔽页面配置', true);
      return;
    }
    renderModelOptions(mwaModelCache && mwaModelCache.baseUrl === modelCfg.baseUrl ? mwaModelCache.models : []);
    needsGrant = !(await chrome.permissions.contains({ origins: [`${new URL(modelCfg.baseUrl).origin}/*`] }));
    if (needsGrant) mdMsg('点击下拉框授权并加载模型列表');
    else refreshModelList();
  }
  // 未授权访问接口时，第一次点击下拉框（用户手势）弹出授权，再加载列表。
  $('mdSelect').addEventListener('mousedown', async event => {
    if (!needsGrant) return;
    event.preventDefault();
    if (await chrome.permissions.request({ origins: [`${new URL(modelCfg.baseUrl).origin}/*`] })) { needsGrant = false; mdMsg('正在加载模型列表…'); refreshModelList(); }
    else mdMsg('未授权访问该接口地址', true);
  });
  // 选中即保存并生效；公司网关下同时切换接口类型。
  $('mdSelect').onchange = async () => {
    if (!$('mdSelect').value) return;
    const [provider, ...rest] = $('mdSelect').value.split('|');
    const model = rest.join('|');
    const response = await chrome.runtime.sendMessage({ action: 'fabriqAiSaveConfig',
      config: { baseUrl: gatewayUrl(modelCfg.baseUrl, provider), provider, model, key: '' } });
    if (!response?.ok) { mdMsg(response?.error || '保存失败', true); return; }
    modelCfg.provider = provider;
    modelCfg.model = model;
    mdMsg('已切换');
    setTimeout(() => mdMsg(''), 2000);
  };
  $('devMode').onchange = () => chrome.storage.local.set({ devMode: $('devMode').checked });
  loadModelHeader();

  // ───── AI 对话记录：自动保存到文件 ─────
  async function renderExportInfo() {
    const { mwaAutoExport = true, mwaLastExport } = await chrome.storage.local.get(['mwaAutoExport', 'mwaLastExport']);
    $('autoExport').checked = mwaAutoExport;
    $('exportInfo').textContent = mwaLastExport
      ? `上次保存：${fmtTime(mwaLastExport.time)} → 下载目录\\MWA-Logs\\（${mwaLastExport.files.join('、')}）`
      : '尚未保存过（有新记录后约 10 分钟自动保存，或点「立即保存」）';
  }
  $('autoExport').onchange = () => chrome.storage.local.set({ mwaAutoExport: $('autoExport').checked });
  $('exportNow').onclick = async () => {
    $('exportNow').disabled = true;
    $('exportInfo').textContent = '正在保存…';
    const response = await chrome.runtime.sendMessage({ action: 'mwaExportLogsNow' });
    $('exportNow').disabled = false;
    if (!response?.ok) $('exportInfo').textContent = `保存失败：${response?.error || '未知错误'}`;
    else renderExportInfo();
  };
  $('exportOpen').onclick = () => chrome.downloads.showDefaultFolder();
  renderExportInfo();

  // ───── AI 接口与 Key（隐蔽页面） ─────
  const sendBg = message => chrome.runtime.sendMessage(message);
  async function loadAiConfig() {
    const response = await sendBg({ action: 'fabriqAiGetConfig' });
    const config = (response && response.ok && response.data) || {};
    $('cfgProvider').value = config.provider || 'openai';
    $('cfgBase').value = config.baseUrl || '';
    $('cfgModel').value = config.model || '';
    $('cfgKey').value = '';
    $('cfgKeyState').textContent = config.hasKey ? '已保存 Key（点「查看已保存的 Key」显示）' : '尚未保存 Key';
  }
  $('cfgReveal').onclick = async () => {
    const response = await sendBg({ action: 'fabriqAiRevealKey' });
    if (!response?.ok) { $('cfgStatus').textContent = response?.error || '读取失败'; $('cfgStatus').className = 'bad'; return; }
    $('cfgKey').value = response.data;
    $('cfgKey').type = 'text';
    $('cfgKeyState').textContent = response.data ? '已显示已保存的 Key' : '尚未保存 Key';
  };
  $('cfgToggle').onclick = () => { $('cfgKey').type = $('cfgKey').type === 'password' ? 'text' : 'password'; };
  $('cfgCopy').onclick = async () => {
    if (!$('cfgKey').value) { $('cfgStatus').textContent = '没有可复制的内容，请先点「查看已保存的 Key」'; $('cfgStatus').className = 'bad'; return; }
    await navigator.clipboard.writeText($('cfgKey').value);
    $('cfgStatus').textContent = '已复制到剪贴板';
    $('cfgStatus').className = 'ok';
  };
  $('cfgSave').onclick = async () => {
    const fail = text => { $('cfgStatus').textContent = text; $('cfgStatus').className = 'bad'; };
    let url;
    try { url = new URL($('cfgBase').value.trim()); } catch { return fail('请填写有效的接口地址'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return fail('接口地址需为不含账号、查询参数或片段的 HTTPS 地址');
    const provider = $('cfgProvider').value;
    if (url.origin === 'https://api.gpt.medtronic.com' && /^\/providers\/(?:openai|anthropic)\/v1\/?$/.test(url.pathname)) url.pathname = `/providers/${provider}/v1`;
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) return fail('未授权访问该接口地址');
    const response = await sendBg({ action: 'fabriqAiSaveConfig', config: { baseUrl: url.href.replace(/\/$/, ''), provider, model: $('cfgModel').value.trim(), key: $('cfgKey').value.trim() } });
    if (!response?.ok) return fail(response?.error || '保存失败');
    $('cfgStatus').textContent = '已保存';
    $('cfgStatus').className = 'ok';
    loadAiConfig();
  };
  // ───── Windchill 规则库 ─────
  const FORMAT_LABELS = { pdf: 'PDF', dwg: 'DWG', word: 'Word', excel: 'Excel', ppt: 'PPT', archive: '压缩包' };
  const splitList = text => String(text || '').split(/[,，、;；\n]+/).map(item => item.trim()).filter(Boolean);
  const getPath = (object, path) => (/^(?:drawing|engineering|quality)\./.test(path) ? `categories.${path}` : path)
    .split('.').reduce((value, key) => value?.[key], object);
  let wcBuilt = false;

  function buildChecks() {
    document.querySelectorAll('.checks').forEach(box => {
      box.replaceChildren(...WcRules.FORMATS.map(format => {
        const input = el('input', { type: 'checkbox', value: format });
        return el('label', {}, input, FORMAT_LABELS[format]);
      }));
    });
    $('testFormat').replaceChildren(...WcRules.FORMATS.map(format => el('option', { value: format, textContent: FORMAT_LABELS[format] })));
  }

  function fillForm(rules) {
    document.querySelectorAll('[data-list]').forEach(area => { area.value = getPath(rules, area.dataset.list).join(', '); });
    document.querySelectorAll('.checks').forEach(box => {
      const selected = getPath(rules, box.dataset.key);
      box.querySelectorAll('input').forEach(input => { input.checked = selected.includes(input.value); });
    });
    $('drawingExcludeLeading').checked = rules.categories.drawing.excludeLeadingPrefix;
    $('drawingRequireName').checked = rules.categories.drawing.requireNameKeyword;
    $('signedFallback').value = rules.signed.fallback;
    $('dlFolder').value = rules.download.folder;
    $('dlConcurrency').value = rules.download.concurrency;
    $('dlMaxFiles').value = rules.download.maxFiles;
    $('dlVerify').checked = rules.download.verify;
    $('dlAi').checked = rules.download.aiAssist;
    $('batchIncludeSub').checked = rules.batch.includeSub;
    $('batchLimit').value = rules.batch.limit;
    runRuleTest();
  }

  function readForm() {
    const rules = WcRules.defaults();
    const list = key => splitList(document.querySelector(`[data-list="${key}"]`).value);
    const formats = key => [...document.querySelectorAll(`.checks[data-key="${key}"] input:checked`)].map(input => input.value);
    for (const key of ['engineering', 'quality']) {
      rules.categories[key] = { prefixes: list(`${key}.prefixes`), nameIncludes: list(`${key}.nameIncludes`), nameExcludes: list(`${key}.nameExcludes`) };
    }
    rules.categories.drawing = { formats: formats('drawing.formats'), excludeLeadingPrefix: $('drawingExcludeLeading').checked, requireNameKeyword: $('drawingRequireName').checked };
    rules.signed = { formats: formats('signed.formats'), namePatterns: list('signed.namePatterns'), fallback: $('signedFallback').value };
    rules.download = { folder: $('dlFolder').value, concurrency: $('dlConcurrency').value, maxFiles: $('dlMaxFiles').value, verify: $('dlVerify').checked, aiAssist: $('dlAi').checked };
    rules.batch = { types: list('batch.types'), includeSub: $('batchIncludeSub').checked, limit: $('batchLimit').value };
    return WcRules.normalize(rules);
  }

  function runRuleTest() {
    const rules = readForm();
    const number = $('testNumber').value.trim();
    const name = $('testName').value.trim();
    if (!number && !name) { $('testResult').textContent = '输入编号或名称查看会被分到哪一类。'; return; }
    const category = WcRules.classify(rules, { text: `${number} ${name}`, name });
    const leading = WcRules.hasLeadingPrefix(rules, number) || WcRules.hasLeadingPrefix(rules, name);
    let label = category ? rules.categories[category].label : '';
    if (!label) label = WcRules.drawingAccepts(rules, $('testFormat').value, leading) ? '图纸' : '其他（不属于任何快捷分类）';
    $('testResult').textContent = `分类结果：${label}`;
  }

  async function loadWindchill() {
    if (!wcBuilt) {
      buildChecks();
      ['testNumber', 'testName', 'testFormat'].forEach(id => $(id).addEventListener('input', runRuleTest));
      document.querySelector('#tab-windchill').addEventListener('change', runRuleTest);
      wcBuilt = true;
    }
    const stored = (await chrome.storage.local.get(WcRules.STORAGE_KEY))[WcRules.STORAGE_KEY];
    fillForm(WcRules.normalize(stored));
  }

  const wcStatus = (text, bad) => {
    $('wcStatus').textContent = text;
    $('wcStatus').className = bad ? 'bad' : 'ok';
  };
  $('wcSave').onclick = async () => {
    const rules = readForm();
    await chrome.storage.local.set({ [WcRules.STORAGE_KEY]: rules });
    fillForm(rules);
    wcStatus('已保存，Windchill 页面立即生效');
  };
  $('wcReset').onclick = async () => {
    if (!confirm('恢复为内置默认规则（PII / MG / PS，PDF 图纸，签名文件按文件名 + 主文件 PDF）？')) return;
    await chrome.storage.local.remove(WcRules.STORAGE_KEY);
    fillForm(WcRules.defaults());
    wcStatus('已恢复默认');
  };

  $('wcAiSuggest').onclick = async () => {
    const { windchillRuleSamples: samples = [], windchillRuleSamplesAt: at } = await chrome.storage.local.get(['windchillRuleSamples', 'windchillRuleSamplesAt']);
    if (!samples.length) { wcStatus('还没有检索样本：先在 Windchill 页面检索一次', true); return; }
    $('wcAiSuggest').disabled = true;
    wcStatus(`AI 正在分析 ${samples.length} 条样本…`);
    try {
      const rules = readForm();
      const guarded = await MwaFabriqAiGuard.generateGuarded({
        messages: WcAi.buildSuggestMessages(samples, rules),
        parse: WcAi.parseSuggest,
        call: (messages, info) => MwaFabriqAiClient.requestAi('fabriqAiGenerate', {
          messages, meta: { purpose: 'windchill-rules', attempt: info.attempt, masked: info.masked, ticket: `${samples.length} 条样本` }
        })
      });
      renderSuggestion(guarded.result, at);
      wcStatus('');
    } catch (error) {
      wcStatus(`${error.message}（接口和 Key 在后台隐蔽页面「AI 接口」配置，模型在后台「设置」页选择）`, true);
    } finally { $('wcAiSuggest').disabled = false; }
  };

  function renderSuggestion(suggestion, at) {
    const rows = [];
    const add = (label, target, values) => { if (values.length) rows.push({ label, target, values }); };
    add('工程文件 · 编号前缀', 'engineering.prefixes', suggestion.engineering.prefixes);
    add('工程文件 · 名称关键词', 'engineering.nameIncludes', suggestion.engineering.nameIncludes);
    add('工程文件 · 排除词', 'engineering.nameExcludes', suggestion.engineering.nameExcludes);
    add('质量文件 · 编号前缀', 'quality.prefixes', suggestion.quality.prefixes);
    add('质量文件 · 名称关键词', 'quality.nameIncludes', suggestion.quality.nameIncludes);
    add('质量文件 · 排除词', 'quality.nameExcludes', suggestion.quality.nameExcludes);
    add('签名文件 · 文件名关键词', 'signed.namePatterns', suggestion.signedNamePatterns);
    const box = el('div', { className: 'suggest' }, el('strong', { textContent: `AI 建议（基于 ${new Date(at).toLocaleString('zh-CN', { hour12: false })} 的检索样本）` }));
    if (suggestion.notes) box.append(el('p', { className: 'note', textContent: suggestion.notes }));
    if (!rows.length) box.append(el('p', { textContent: '没有需要新增的规则。' }));
    else {
      box.append(el('ul', {}, ...rows.map(row => el('li', { textContent: `${row.label}：${row.values.join('、')}` }))));
      box.append(el('button', { className: 'btn', textContent: '合并到上方表单（不会自动保存）', onclick: () => {
        rows.forEach(row => {
          const area = document.querySelector(`[data-list="${row.target}"]`);
          area.value = [...new Set([...splitList(area.value), ...row.values])].join(', ');
        });
        runRuleTest();
        wcStatus('已合并到表单，确认后点「保存规则」');
      } }));
    }
    $('wcSuggest').replaceChildren(box);
  }

  // ───── Windchill 下载记录 ─────
  let dlLogAll = [];
  function renderDlLog() {
    const filter = $('dlLogFilter').value;
    const list = dlLogAll.filter(entry => !filter || entry.status === filter);
    $('dlLogCount').textContent = `${list.length} / ${dlLogAll.length} 条`;
    if (!list.length) { $('dlLogList').replaceChildren(el('div', { className: 'empty', textContent: '还没有下载记录' })); return; }
    const body = el('tbody');
    list.forEach(entry => {
      const detail = el('tr', { className: 'detail', hidden: true }, el('td', { colSpan: 6 },
        el('pre', { className: 'muted', style: 'white-space:pre-wrap;margin:0', textContent:
          [`保存为：${entry.saveAs || '—'}`, `地址路径：${entry.path || '—'}`, `HTTP：${entry.httpStatus || '—'}　类型：${entry.contentType || '—'}`,
            ...(entry.attempts || []).map(a => `尝试 ${a.attempt}：${a.path}  →  ${a.ok ? '通过' : `${a.status || ''} ${a.reason}`}`)].join('\n') })));
      const row = el('tr', { className: 'row' },
        el('td', { textContent: fmtTime(entry.time) }), el('td', { textContent: entry.number || '—' }),
        el('td', { textContent: entry.file || '—' }),
        el('td', { className: entry.status === 'done' ? 'ok' : 'bad', textContent: entry.status === 'done' ? '成功' : '失败' }),
        el('td', { className: 'bad', textContent: entry.reason || '' }),
        el('td', { className: 'muted', textContent: entry.batch || '' }));
      row.onclick = () => { detail.hidden = !detail.hidden; };
      body.append(row, detail);
    });
    $('dlLogList').replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, ...['时间', '编号', '文件', '结果', '原因', '批次'].map(text => el('th', { textContent: text })))), body));
  }
  async function loadDlLog() {
    dlLogAll = (await chrome.storage.local.get('windchillDownloadLog')).windchillDownloadLog || [];
    renderDlLog();
  }
  $('dlLogFilter').onchange = renderDlLog;
  $('dlLogRefresh').onclick = loadDlLog;
  $('dlLogJson').onclick = () => download(`windchill-download-log-${stamp()}.json`, JSON.stringify(dlLogAll, null, 2), 'application/json');
  $('dlLogClear').onclick = async () => {
    if (!confirm('清空全部下载记录？')) return;
    await chrome.storage.local.remove('windchillDownloadLog');
    loadDlLog();
  };

  loadAi();
  loadOps();
  loadDlLog();
  chrome.storage.local.get('mwaOptionsTab', ({ mwaOptionsTab }) => {
    if (mwaOptionsTab) { chrome.storage.local.remove('mwaOptionsTab'); showTab(mwaOptionsTab); }
  });
})();
