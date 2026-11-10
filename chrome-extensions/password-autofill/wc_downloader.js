// 下载页：选择文档与文件（可多选，含多版本签名文件）→ 逐份请求 Windchill 页面验证并下载 → 记录结果。
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, props, ...children) => {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    children.forEach(child => node.append(child));
    return node;
  };
  const CATEGORY = { drawing: '图纸', engineering: '工程', quality: '质量', other: '其他' };
  const LOG_KEY = 'windchillDownloadLog';
  const MAX_LOG = 300;
  const tabId = Number(new URLSearchParams(location.search).get('tab'));
  const LABEL = { primary: '主文件', attachment: '附件' };
  const sizeText = size => (size ? (size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`) : '');

  let job = null;
  const sel = new Map();     // 文档 key → 选中的文件序号集合
  const results = new Map(); // `${key}:${序号}` → 下载结果
  let running = false;
  let cancelled = false;

  const selOf = item => sel.get(item.key) || new Set();
  const totalFiles = () => job.items.reduce((sum, item) => sum + selOf(item).size, 0);
  function note(text, bad) { $('note').textContent = text; $('note').className = bad ? 'bad' : ''; }

  function visibleItems() {
    const q = $('filter').value.trim().toLowerCase();
    const cat = $('catFilter').value;
    return job.items.filter(item => (!cat || item.category === cat)
      && (!$('onlyReady').checked || item.pickIndex >= 0 || selOf(item).size)
      && (!q || `${item.number} ${item.title}`.toLowerCase().includes(q)));
  }

  // 默认是规则选出的当前版本；下拉里按「当前版本 → 其他签名文件 → 其余文件」排序。
  function defaultSet(item) {
    return item.pickIndex >= 0 ? new Set([item.pickIndex]) : new Set();
  }
  function orderedFiles(item) {
    const rank = i => (i === item.pickIndex ? 0 : item.files[i].signed ? 1 : 2);
    return item.files.map((_, i) => i).sort((a, b) => rank(a) - rank(b) || a - b);
  }

  function updateCounts() {
    const ready = job.items.filter(item => item.pickIndex >= 0).length;
    $('count').textContent = `· 共 ${job.items.length} 份 · 可下载 ${ready}`;
    const count = totalFiles();
    $('start').textContent = `开始下载 (${count})`;
    $('start').disabled = running || !count;
  }

  function fileSelect(item) {
    const select = el('select', { disabled: running || !item.files.length });
    select.append(el('option', { value: '-1', textContent: item.files.length ? '（不下载）' : '（无文件信息）' }));
    orderedFiles(item).forEach(i => {
      const file = item.files[i];
      const tag = i === item.pickIndex ? '★ 当前版本 · ' : '';
      select.append(el('option', { value: String(i), textContent:
        `${tag}${file.fileName || '（主文件）'} · ${(file.format || '').toUpperCase()} ${sizeText(file.size)}`.trim() }));
    });
    const [current] = [...selOf(item)];
    select.value = String(current ?? -1);
    select.onchange = () => {
      sel.set(item.key, Number(select.value) >= 0 ? new Set([Number(select.value)]) : new Set());
      render();
    };
    return select;
  }

  function render() {
    const items = visibleItems();
    if (!items.length) { $('list').replaceChildren(el('div', { className: 'empty', textContent: '没有符合条件的文档' })); updateCounts(); return; }
    const body = el('tbody');
    items.forEach(item => {
      const set = selOf(item);
      const box = el('input', { type: 'checkbox', checked: set.size > 0, disabled: running || !item.files.length });
      box.onchange = () => { sel.set(item.key, box.checked ? defaultSet(item) : new Set()); render(); };
      const [index] = [...set];
      const result = index === undefined ? null : results.get(`${item.key}:${index}`);
      body.append(el('tr', { className: set.size ? '' : 'off' },
        el('td', {}, box),
        el('td', { textContent: item.number || '—' }),
        el('td', { textContent: item.title }),
        el('td', { textContent: item.version || '' }),
        el('td', {}, el('span', { className: 'tag', textContent: CATEGORY[item.category] || '其他' })),
        el('td', {}, fileSelect(item)),
        el('td', { className: 'muted', textContent: item.reason }),
        el('td', { className: result ? (result.status === 'done' ? 'ok' : 'bad') : 'muted',
          textContent: result ? (result.status === 'done' ? '✓ 已下载' : `✗ ${result.reason}`) : '' })));
    });
    $('list').replaceChildren(el('table', {}, el('thead', {}, el('tr', {},
      ...['', '编号', '名称', '当前版本', '分类', '下载哪个文件（可切换版本）', '选择依据', '结果'].map(text => el('th', { textContent: text })))), body));
    updateCounts();
  }

  const sendToTab = message => new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError || !response) {
        resolve({ status: 'failed', reason: 'Windchill 页面已关闭、刷新或扩展已重载：请回到 Windchill 页面重新点「下载」' });
      } else resolve(response);
    });
  });

  async function appendLog(entries) {
    const { [LOG_KEY]: old = [] } = await chrome.storage.local.get(LOG_KEY);
    await chrome.storage.local.set({ [LOG_KEY]: [...entries, ...old].slice(0, MAX_LOG) });
  }

  async function start() {
    const queue = [];
    job.items.forEach(item => selOf(item).forEach(index => queue.push({ item, index, many: selOf(item).size > 1 })));
    if (!queue.length || running) return;
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const batch = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}_${job.keyword.replace(/[\\/]/g, '_')}`;
    running = true;
    cancelled = false;
    results.clear();
    $('cancel').hidden = false;
    $('progress').hidden = false;
    $('progress').max = queue.length;
    $('progress').value = 0;
    render();
    let done = 0;
    let next = 0;
    const log = [];
    async function worker() {
      while (next < queue.length && !cancelled) {
        const { item, index, many } = queue[next++];
        const file = item.files[index];
        const result = await sendToTab({ action: 'wcDownloadItem', key: item.key, fileIndex: index, batch, useFileName: index !== item.pickIndex });
        results.set(`${item.key}:${index}`, result);
        done += 1;
        log.push({ time: new Date().toISOString(), batch, number: item.number, title: item.title, version: item.version,
          file: file.fileName, status: result.status, reason: result.reason || '', httpStatus: result.httpStatus || 0,
          contentType: result.contentType || '', path: result.path || '', saveAs: result.filename || '', attempts: result.attempts || [] });
        $('progress').value = done;
        $('progressText').textContent = `${done} / ${queue.length}`;
        render();
      }
    }
    await Promise.all(Array.from({ length: Math.min(job.rules.download.concurrency, queue.length) }, worker));
    await appendLog(log.reverse());
    const ok = log.filter(entry => entry.status === 'done').length;
    running = false;
    $('cancel').hidden = true;
    note(`${cancelled ? '已取消。' : '完成。'}成功 ${ok} · 失败 ${log.length - ok}；文件在浏览器下载目录的 ${job.rules.download.folder}\\${batch.replace(/[\\/:*?"<>|]/g, '_')} 中。失败原因见文件后面，也可点「下载记录」。`, ok < log.length);
    render();
  }

  async function aiAssist() {
    const targets = job.items.filter(item => (item.status !== 'ok' || item.confidence === 'low') && item.files.some(file => file.fileName)).slice(0, 30);
    if (!targets.length) { note('没有需要 AI 判断的文档。'); return; }
    $('aiBtn').disabled = true;
    note(`AI 正在判断 ${targets.length} 份文档…`);
    try {
      const picks = await WcDownload.aiPick(targets.map(item => ({ number: item.number, title: item.title, files: item.files })), job.rules);
      picks.forEach((pick, index) => {
        const item = targets[index];
        item.reason = `AI：${pick.reason || '判断为签名文件'}`;
        item.pickIndex = pick.file;
        item.files[pick.file].signed = true;
        sel.set(item.key, new Set([pick.file]));
      });
      note(`AI 为 ${picks.size} / ${targets.length} 份文档选出签名文件，其余未找到。`);
      render();
    } catch (error) {
      note(`AI 判断失败：${error.message}（接口和 Key 在后台隐蔽页面「AI 接口」配置，模型在后台「设置」页选择）`, true);
    } finally { $('aiBtn').disabled = false; }
  }

  function exportAnalysis() {
    const report = { time: new Date().toISOString(), keyword: job.keyword, rules: job.rules, items: job.items.map(item => ({
      number: item.number, title: item.title, version: item.version, category: item.category, status: item.status,
      confidence: item.confidence, reason: item.reason, picked: [...selOf(item)].map(i => item.files[i]?.fileName), files: item.files })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = el('a', { href: url, download: `windchill-signed-analysis-${Date.now()}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function init() {
    const stored = (await chrome.storage.session.get(`wcJob:${tabId}`))[`wcJob:${tabId}`];
    if (!stored) { $('list').replaceChildren(el('div', { className: 'empty', textContent: '没有下载任务：请在 Windchill 页面检索后点「下载」' })); $('start').disabled = true; return; }
    job = stored;
    $('sub').textContent = `检索「${job.keyword}」· 每份文档默认下载当前版本（★）；可在下拉里切换到其他版本或文件，勾选文档后点「开始下载」。`;
    job.items.forEach(item => sel.set(item.key, item.pickIndex >= 0 && item.confidence !== 'low' ? new Set([item.pickIndex]) : new Set()));
    render();
  }

  ['filter', 'catFilter', 'onlyReady'].forEach(id => $(id).addEventListener(id === 'filter' ? 'input' : 'change', () => job && render()));
  $('selectAll').onclick = () => { visibleItems().forEach(item => { if (item.pickIndex >= 0 && !selOf(item).size) sel.set(item.key, defaultSet(item)); }); render(); };
  $('selectNone').onclick = () => { visibleItems().forEach(item => sel.set(item.key, new Set())); render(); };
  $('start').onclick = start;
  $('cancel').onclick = () => { cancelled = true; sendToTab({ action: 'wcDownloadCancel' }); note('正在取消…'); };
  $('aiBtn').onclick = aiAssist;
  $('exportBtn').onclick = exportAnalysis;
  $('openFolder').onclick = () => chrome.downloads.showDefaultFolder();
  $('openLog').onclick = () => chrome.storage.local.set({ mwaOptionsTab: 'windchill' }, () => chrome.runtime.openOptionsPage());
  init();
})();
