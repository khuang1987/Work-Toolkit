// 清单批量下载页：识别清单（xlsx / csv / 粘贴）→ 逐个编号让 Windchill 页面检索 → 逐份下载并记录。
// 检索、下载验证都在 Windchill 页面的 content script 里执行（复用登录态），本页只负责编排和展示。
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, props, ...children) => {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    children.forEach(child => node.append(child));
    return node;
  };
  const LOG_KEY = 'windchillDownloadLog';
  const MAX_LOG = 300;
  const sizeText = size => (size ? (size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`) : '');
  const splitList = text => String(text || '').split(/[,，、;；\s]+/).map(item => item.trim()).filter(Boolean);
  const VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

  let rules = WcRules.normalize(null);
  let tabId = Number(new URLSearchParams(location.search).get('tab')) || 0;
  let table = null; // { name, sheets }
  let groups = [];
  const sel = new Map();
  const results = new Map();
  let running = false;
  let cancelled = false;

  const mode = () => document.querySelector('input[name=mode]:checked').value;
  function note(text, bad) { $('note').textContent = text; $('note').className = bad ? 'bad' : ''; }

  // ───── 清单识别 ─────
  function currentRows() {
    if (!table) return [];
    const sheet = table.sheets[Number($('sheet').value) || 0];
    return sheet ? sheet.rows : [];
  }
  function readValues() {
    let raw = [];
    const pasted = $('paste').value.trim();
    if (pasted) raw = splitList(pasted);
    else if (table) {
      const rows = currentRows();
      const column = Number($('column').value) || 0;
      raw = rows.slice($('header').checked ? 1 : 0).map(row => WcRules.cleanCfn(row[column]));
    }
    const seen = new Set();
    return raw.map(WcRules.cleanCfn).filter(value => VALUE_PATTERN.test(value))
      .filter(value => { const key = value.toUpperCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  function refreshFound() {
    const values = readValues();
    const start = Math.max(1, Number($('start').value) || 1);
    const limit = Math.max(1, Number($('limit').value) || 1);
    const from = Math.min(start, values.length + 1);
    const to = Math.min(values.length, start - 1 + limit);
    $('found').textContent = values.length
      ? `识别到 ${values.length} 个${mode() === 'cfn' ? ' CFN' : '文件号'}（已去重），本次处理第 ${from}–${to} 个，共 ${Math.max(0, to - from + 1)} 个`
      : '还没有识别到编号';
    $('run').disabled = $('dry').disabled = running || !values.length;
  }

  function fillSheets() {
    $('sheet').replaceChildren(...table.sheets.map((sheet, index) => el('option', { value: String(index), textContent: `${sheet.name}（${sheet.rows.length} 行）` })));
    fillColumns();
    $('sheetRow').hidden = false;
  }
  function fillColumns() {
    const rows = currentRows();
    const header = rows[0] || [];
    const width = Math.max(header.length, ...rows.slice(0, 20).map(row => row.length), 1);
    $('column').replaceChildren(...Array.from({ length: width }, (_, index) => {
      const name = String(header[index] ?? '').trim();
      const letter = String.fromCharCode(65 + (index % 26));
      return el('option', { value: String(index), textContent: `${letter} 列${name ? ` · ${name}` : ''}` });
    }));
    $('column').value = String(WcTable.guessColumn(rows));
    refreshFound();
  }

  async function loadFile(file) {
    try {
      table = await WcTable.readTable(file.name, await file.arrayBuffer());
      $('fileName').textContent = file.name;
      $('paste').value = '';
      fillSheets();
      note(`已读取「${file.name}」：${table.sheets.length} 个工作表。请确认编号所在列。`);
    } catch (error) {
      table = null;
      $('sheetRow').hidden = true;
      note(`读取失败：${error.message}`, true);
    }
    refreshFound();
  }

  // ───── 与 Windchill 页面通信 ─────
  function send(id, message) {
    return new Promise(resolve => {
      chrome.tabs.sendMessage(id, message, response => resolve(chrome.runtime.lastError ? null : response));
    });
  }
  async function ensureTab() {
    if (tabId && (await send(tabId, { action: 'wcPing' }))?.ok) return true;
    const tabs = await chrome.tabs.query({ url: 'https://khplm.medtronic.com.cn/*' });
    for (const tab of tabs) {
      if ((await send(tab.id, { action: 'wcPing' }))?.ok) { tabId = tab.id; return true; }
    }
    return false;
  }
  const sendToTab = message => send(tabId, message);

  async function appendLog(entries) {
    const { [LOG_KEY]: old = [] } = await chrome.storage.local.get(LOG_KEY);
    await chrome.storage.local.set({ [LOG_KEY]: [...entries, ...old].slice(0, MAX_LOG) });
  }

  // ───── 展示 ─────
  function render() {
    if (!groups.length) { $('list').replaceChildren(el('div', { className: 'empty', textContent: '选择清单文件后，点「检索并下载」' })); return; }
    const body = el('tbody');
    groups.forEach(group => {
      const stateText = { wait: '等待', search: '检索中…', done: '', error: `检索失败：${group.error}` }[group.state];
      const found = group.items.length;
      const missing = group.missing.length ? ` · 缺：${group.missing.join('、')}` : '';
      body.append(el('tr', { className: 'group' }, el('td', { colSpan: 7, textContent:
        `${group.value}${group.state === 'done' ? ` · 共 ${found} 份${missing}` : ''}${stateText ? ` · ${stateText}` : ''}${group.state === 'done' && !found ? ' · 未找到文档' : ''}` })));
      group.items.forEach(item => {
        const index = sel.get(item.key);
        const result = results.get(item.key);
        const select = el('select', { disabled: running || !item.files.length });
        select.append(el('option', { value: '-1', textContent: '（不下载）' }));
        item.files.forEach((file, i) => select.append(el('option', { value: String(i),
          textContent: `${i === item.pickIndex ? '★ ' : ''}${file.fileName || '（主文件）'} · ${(file.format || '').toUpperCase()} ${sizeText(file.size)}`.trim() })));
        select.value = String(index ?? -1);
        select.onchange = () => { sel.set(item.key, Number(select.value)); render(); };
        body.append(el('tr', { className: index >= 0 ? '' : 'off' },
          el('td', {}, item.type ? el('span', { className: 'tag', textContent: item.type }) : ''),
          el('td', { textContent: item.number || '—' }),
          el('td', { textContent: item.title }),
          el('td', { textContent: item.version || '' }),
          el('td', {}, select),
          el('td', { className: 'muted', textContent: item.reason }),
          el('td', { className: result ? (result.status === 'done' ? 'ok' : 'bad') : 'muted',
            textContent: result ? (result.status === 'done' ? '✓ 已下载' : `✗ ${result.reason}`) : '' })));
      });
    });
    $('list').replaceChildren(el('table', {}, el('thead', {}, el('tr', {},
      ...['类型', '文件号', '名称', '当前版本', '下载哪个文件（可切换）', '选择依据', '结果'].map(text => el('th', { textContent: text })))), body));
  }

  // ───── 执行 ─────
  async function downloadGroup(group, batchId, log) {
    const folder = mode() === 'cfn' ? `${batchId}/${group.value}` : batchId;
    const queue = group.items.filter(item => (sel.get(item.key) ?? -1) >= 0);
    let next = 0;
    async function worker() {
      while (next < queue.length && !cancelled) {
        const item = queue[next++];
        const index = sel.get(item.key);
        const result = (await sendToTab({ action: 'wcDownloadItem', key: item.key, fileIndex: index, batch: folder, useFileName: index !== item.pickIndex }))
          || { status: 'failed', reason: 'Windchill 页面已关闭、刷新或扩展已重载：请回到 Windchill 页面再试' };
        results.set(item.key, result);
        log.push({ time: new Date().toISOString(), batch: folder, cfn: group.value, number: item.number, title: item.title, version: item.version,
          file: item.files[index]?.fileName || '', status: result.status, reason: result.reason || '', httpStatus: result.httpStatus || 0,
          contentType: result.contentType || '', path: result.path || '', saveAs: result.filename || '', attempts: result.attempts || [] });
        render();
      }
    }
    await Promise.all(Array.from({ length: Math.min(rules.download.concurrency, queue.length) }, worker));
  }

  async function run(download) {
    if (running) return;
    const values = readValues();
    const start = Math.max(1, Number($('start').value) || 1);
    const limit = Math.max(1, Number($('limit').value) || 1);
    const picked = values.slice(start - 1, start - 1 + limit);
    if (!picked.length) { note('范围内没有编号。', true); return; }
    if (!(await ensureTab())) { note('没有找到已登录的 Windchill 页面：请先打开 Windchill 并刷新一次页面（扩展更新后需要刷新），再回来重试。', true); return; }
    const types = splitList($('types').value.toUpperCase());
    if (mode() === 'cfn' && !types.length) { note('请至少填写一个文件类型，如 MG, PS, BOM。', true); return; }
    await saveBatchRules();

    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    const batchId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}_清单`;
    running = true; cancelled = false;
    groups = picked.map(value => ({ value, state: 'wait', items: [], missing: [], error: '' }));
    sel.clear(); results.clear();
    $('cancel').hidden = false; $('progress').hidden = false; $('progress').max = picked.length; $('progress').value = 0;
    $('run').disabled = $('dry').disabled = $('exportBtn').disabled = true;
    render();
    const log = [];
    for (const group of groups) {
      if (cancelled) break;
      group.state = 'search';
      note(`检索 ${group.value}（${groups.indexOf(group) + 1} / ${groups.length}）…`);
      render();
      const response = await sendToTab({ action: 'wcBatchSearch', mode: mode(), value: group.value, types, includeSub: $('includeSub').checked });
      if (!response?.ok) {
        group.state = 'error';
        group.error = response ? response.error : 'Windchill 页面无响应（已关闭、刷新或扩展已重载）';
      } else {
        group.state = 'done';
        group.items = response.items;
        group.missing = mode() === 'cfn' ? types.filter(type => !response.items.some(item => item.type === type)) : [];
        response.items.forEach(item => sel.set(item.key, item.pickIndex >= 0 ? item.pickIndex : -1));
      }
      render();
      if (download && group.state === 'done') {
        note(`下载 ${group.value}（${group.items.length} 份）…`);
        await downloadGroup(group, batchId, log);
      }
      $('progress').value = groups.filter(item => item.state === 'done' || item.state === 'error').length;
    }
    if (log.length) await appendLog(log.slice().reverse());
    running = false;
    $('cancel').hidden = true;
    $('exportBtn').disabled = false;
    refreshFound();
    const done = groups.filter(group => group.state === 'done');
    const docs = done.reduce((sum, group) => sum + group.items.length, 0);
    const ok = log.filter(entry => entry.status === 'done').length;
    const empty = done.filter(group => !group.items.length).map(group => group.value);
    const parts = [`处理 ${done.length}/${groups.length} 个编号，找到 ${docs} 份文档`];
    if (download) parts.push(`下载成功 ${ok} · 失败 ${log.length - ok}，目录：${rules.download.folder}\\${batchId}`);
    else parts.push('（未下载，确认无误后点「检索并下载」）');
    if (empty.length) parts.push(`无文档：${empty.join('、')}`);
    note(`${cancelled ? '已取消。' : '完成。'}${parts.join('；')}`, download && ok < log.length);
    render();
  }

  function exportCsv() {
    const header = ['编号', '类型', '文件号', '名称', '版本', '文件', '状态', '原因', '保存路径'];
    const rows = [];
    groups.forEach(group => {
      if (!group.items.length) rows.push([group.value, '', '', '', '', '', group.state === 'error' ? '检索失败' : '未找到', group.error, '']);
      group.items.forEach(item => {
        const result = results.get(item.key);
        const index = sel.get(item.key);
        rows.push([group.value, item.type, item.number, item.title, item.version, item.files[index]?.fileName || '',
          result ? (result.status === 'done' ? '已下载' : '失败') : (index >= 0 ? '未下载' : '无文件'), result?.reason || '', result?.filename || '']);
      });
    });
    const quote = cell => `"${String(cell ?? '').replace(/"/g, '""')}"`;
    const text = `\uFEFF${[header, ...rows].map(row => row.map(quote).join(',')).join('\r\n')}`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = el('a', { href: url, download: `windchill-batch-${Date.now()}.csv` });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // ───── 规则（类型 / 含下级 / 数量）与初始化 ─────
  async function saveBatchRules() {
    const { [WcRules.STORAGE_KEY]: stored } = await chrome.storage.local.get(WcRules.STORAGE_KEY);
    const next = WcRules.normalize(stored);
    next.batch = { types: splitList($('types').value), includeSub: $('includeSub').checked, limit: Number($('limit').value) || next.batch.limit };
    rules = WcRules.normalize(next);
    await chrome.storage.local.set({ [WcRules.STORAGE_KEY]: rules });
  }

  async function init() {
    const { [WcRules.STORAGE_KEY]: stored } = await chrome.storage.local.get(WcRules.STORAGE_KEY);
    rules = WcRules.normalize(stored);
    $('types').value = rules.batch.types.join(', ');
    $('includeSub').checked = rules.batch.includeSub;
    $('limit').value = rules.batch.limit;
    refreshFound();
  }

  $('pick').onclick = () => $('file').click();
  $('file').onchange = () => { if ($('file').files[0]) loadFile($('file').files[0]); $('file').value = ''; };
  $('sheet').onchange = fillColumns;
  ['column', 'header', 'start', 'limit'].forEach(id => $(id).addEventListener('change', refreshFound));
  $('paste').addEventListener('input', refreshFound);
  document.querySelectorAll('input[name=mode]').forEach(input => input.addEventListener('change', () => {
    $('typeRow').hidden = mode() !== 'cfn';
    refreshFound();
  }));
  ['types', 'includeSub'].forEach(id => $(id).addEventListener('change', () => saveBatchRules()));
  $('run').onclick = () => run(true);
  $('dry').onclick = () => run(false);
  $('cancel').onclick = () => { cancelled = true; sendToTab({ action: 'wcDownloadCancel' }); note('正在取消…'); };
  $('exportBtn').onclick = exportCsv;
  $('openFolder').onclick = () => chrome.downloads.showDefaultFolder();
  $('openLog').onclick = () => chrome.storage.local.set({ mwaOptionsTab: 'windchill' }, () => chrome.runtime.openOptionsPage());
  document.addEventListener('dragover', event => event.preventDefault());
  document.addEventListener('drop', event => { event.preventDefault(); if (event.dataTransfer.files[0]) loadFile(event.dataTransfer.files[0]); });
  init();
})();
