// 导入中心（第一期，只读）：选导出文件夹 → 列出 CSV → 校验（模板 v1）→ 与线上现有数据对比 → 预览。
// 不向 Fabriq 写入任何数据；读取通过后台桥 fabriqRead（白名单 GET，借用已打开的 Fabriq 页面的登录态）。
(() => {
  'use strict';
  const core = globalThis.MwaImportCore;
  const $ = id => document.getElementById(id);
  if (!core || !$('tab-import')) return;
  const el = (tag, props, ...children) => {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    children.forEach(child => node.append(child));
    return node;
  };
  const fmtTime = ms => new Date(ms).toLocaleString('zh-CN', { hour12: false });

  // ───── 文件夹句柄（保存在本扩展的 IndexedDB，浏览器重启后需重新点一次「允许」）─────
  const db = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('mwa-import', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('h');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const idb = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('h', mode);
      const req = fn(tx.objectStore('h'));
      tx.oncomplete = () => { d.close(); resolve(req.result); };
      tx.onerror = () => reject(tx.error);
    });
  };
  const saveHandle = handle => idb('readwrite', s => s.put(handle, 'dir'));
  const loadHandle = () => idb('readonly', s => s.get('dir'));

  const teamId = () => Number($('imTeam').value) || 0;
  let dirHandle = null;

  const read = endpoint => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'fabriqRead', endpoint }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.ok) return reject(new Error((response && response.error) || '读取失败'));
      resolve(response.data);
    });
  });

  // ───── 文件列表 ─────
  async function listFiles() {
    const box = $('imFiles');
    if (!dirHandle) { box.replaceChildren(el('div', { className: 'empty', textContent: '请先选择导出文件夹（只读授权，不会修改里面的文件）' })); return; }
    const files = [];
    const names = new Set();
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== 'file') continue;
      names.add(name);
      if (/\.csv$/i.test(name)) files.push({ name, handle, file: await handle.getFile() });
    }
    files.sort((a, b) => b.file.lastModified - a.file.lastModified);
    if (!files.length) { box.replaceChildren(el('div', { className: 'empty', textContent: '文件夹里没有 .csv 文件' })); return; }
    const body = el('tbody');
    files.slice(0, 30).forEach(({ name, handle, file }) => {
      const metaName = name.replace(/\.csv$/i, '.meta.json');
      body.append(el('tr', {},
        el('td', { textContent: name }),
        el('td', { textContent: fmtTime(file.lastModified) }),
        el('td', { textContent: `${(file.size / 1024).toFixed(1)} KB` }),
        el('td', { className: names.has(metaName) ? 'ok' : 'muted', textContent: names.has(metaName) ? '有 meta' : '无 meta' }),
        el('td', {}, el('button', { className: 'btn', textContent: '校验并预览', onclick: () => preview(file, names.has(metaName) ? dirHandle.getFileHandle(metaName).then(h => h.getFile()) : null) }))));
    });
    box.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, ...['文件', '修改时间', '大小', '元数据', ''].map(t => el('th', { textContent: t })))), body));
  }

  async function initFolder() {
    try { dirHandle = await loadHandle(); } catch { dirHandle = null; }
    $('imResume').hidden = true;
    if (dirHandle) {
      const permission = await dirHandle.queryPermission({ mode: 'read' });
      if (permission === 'granted') { $('imFolder').textContent = `文件夹：${dirHandle.name}`; await listFiles(); return; }
      $('imFolder').textContent = `文件夹：${dirHandle.name}（需要重新授权）`;
      $('imResume').hidden = false;
      dirHandle = null;
    }
    await listFiles();
  }
  $('imPick').onclick = async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      await saveHandle(handle);
      dirHandle = handle;
      $('imFolder').textContent = `文件夹：${handle.name}`;
      $('imResume').hidden = true;
      await listFiles();
    } catch (error) { if (error.name !== 'AbortError') $('imFiles').replaceChildren(el('div', { className: 'bad', textContent: error.message })); }
  };
  $('imResume').onclick = async () => {
    const saved = await loadHandle();
    if (saved && (await saved.requestPermission({ mode: 'read' })) === 'granted') { dirHandle = saved; $('imFolder').textContent = `文件夹：${saved.name}`; $('imResume').hidden = true; await listFiles(); }
  };
  $('imRefresh').onclick = initFolder;
  $('imFilePick').onclick = async () => {
    try {
      const [handle] = await window.showOpenFilePicker({ types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }] });
      await preview(await handle.getFile(), null);
    } catch (error) { if (error.name !== 'AbortError') $('imResult').replaceChildren(el('div', { className: 'bad', textContent: error.message })); }
  };

  // ───── 校验并预览 ─────
  const chip = (text, cls) => el('span', { className: `tag ${cls || ''}`, textContent: text });
  const levelText = { error: '错误', warning: '警告' };

  async function preview(file, metaPromise) {
    const out = $('imResult');
    const status = text => out.replaceChildren(el('div', { className: 'note', textContent: text }));
    try {
      status('读取文件…');
      const text = await file.text();
      const sha256 = await core.sha256Hex(text);
      let meta = null;
      if (metaPromise) { try { meta = JSON.parse(await (await metaPromise).text()); } catch { meta = null; } }
      const parsed = core.parseCsv(text);
      const col = parsed.headers.indexOf('indicator_id');
      const ids = col < 0 ? [] : [...new Set(parsed.rows.map(r => (r.cells[col] || '').trim()).filter(v => /^\d+$/.test(v)).map(Number))];
      if (ids.length > 40) throw new Error(`文件里有 ${ids.length} 个不同的 KPI，超过单次 40 个的预览上限`);

      const kpis = {};
      for (let i = 0; i < ids.length; i++) {
        status(`从 Fabriq 读取 KPI 信息 ${i + 1}/${ids.length}…`);
        try {
          const k = await read(`/backend/kpi/v2/indicator/${ids[i]}`);
          kpis[ids[i]] = { id: ids[i], name: k.name, frequency: k.frequency, indicator_type: k.indicator_type, is_dynamic: !!k.is_dynamic,
            unit_type: k.unit_type, teams: (k.teams && k.teams.ids) || [], choices: ((k.choices && k.choices.options) || []).map(o => o.value) };
        } catch (error) {
          if (/请先/.test(error.message) || /仅限/.test(error.message)) throw error;
          /* 其他读不到的 KPI 在校验里会报「不在目标团队 / 线上不存在」 */
        }
      }
      const { mwaImportLog = [] } = await chrome.storage.local.get('mwaImportLog');
      const result = core.validate(parsed, kpis, { teamId: teamId(), meta, sha256, seenHashes: new Set(mwaImportLog.filter(e => ['ok', 'unverified'].includes(e.status)).map(e => e.sha256)) });

      const existing = {};
      const validIds = [...new Set(result.rows.filter(r => r.valid).map(r => r.id))];
      for (let i = 0; i < validIds.length; i++) {
        status(`读取线上现有数据 ${i + 1}/${validIds.length}…`);
        const rows = await read(`/legacy/api/api/v1/indicator/${validIds[i]}/datapoints/`);
        existing[validIds[i]] = Array.isArray(rows) ? rows : [];
      }
      const compared = core.compare(result.rows, existing);
      render(file, sha256, parsed, result, compared, ids.length, kpis);
    } catch (error) {
      out.replaceChildren(el('div', { className: 'bad', textContent: `无法完成预览：${error.message}` }));
    }
  }

  function render(file, sha256, parsed, result, compared, kpiCount, kpis) {
    const errors = result.issues.filter(i => i.level === 'error');
    const warnings = result.issues.filter(i => i.level === 'warning');
    const writable = compared.rows.filter(r => r.status !== 'same').length;
    const importButton = el('button', { className: 'btn primary', textContent: writable ? `导入 ${writable} 行…` : '没有需要导入的行', disabled: errors.length > 0 || writable === 0,
      title: errors.length ? '有错误，不能导入' : '先导最多 3 行金丝雀并读回核对，通过后再导其余；覆盖前已保存原值，可在导入历史里撤销' });
    importButton.onclick = () => runImport({ file, sha256, compared, kpis, teamId: teamId() });
    const head = el('div', { className: 'bar' },
      el('b', { textContent: file.name }), chip(`${parsed.rows.length} 行`), chip(`${kpiCount} 个 KPI`),
      chip(`${errors.length} 个错误`, errors.length ? 'bad' : 'ok'), chip(`${warnings.length} 个警告`, warnings.length ? 'warn' : ''),
      chip(`新增 ${compared.new}`, 'ok'), chip(`覆盖 ${compared.overwrite}`, compared.overwrite ? 'warn' : ''), chip(`相同 ${compared.same}`),
      el('span', { className: 'grow' }),
      importButton);
    const sections = [head, el('div', { className: 'muted', textContent: `SHA-256：${sha256}${errors.length ? '　有错误，整个文件都不会上传（避免 Fabriq 半导入）' : '　校验通过；与线上相同的行会跳过，不重复写入'}` })];

    if (result.issues.length) {
      const body = el('tbody');
      result.issues.forEach(i => body.append(el('tr', {},
        el('td', { className: i.level === 'error' ? 'bad' : 'muted', textContent: levelText[i.level] }),
        el('td', { textContent: i.line ? `第 ${i.line} 行` : '文件' }), el('td', { textContent: i.column || '' }), el('td', { textContent: i.message }))));
      sections.push(el('h4', { textContent: '校验结果' }), el('table', {}, el('thead', {}, el('tr', {}, ...['级别', '位置', '列', '说明'].map(t => el('th', { textContent: t })))), body));
    }
    if (compared.rows.length) {
      const body = el('tbody');
      const label = { new: '新增', overwrite: '覆盖', same: '相同' };
      compared.rows.forEach(r => body.append(el('tr', {},
        el('td', { textContent: `第 ${r.line} 行` }), el('td', { textContent: r.kpi }), el('td', { textContent: r.date }),
        el('td', { textContent: String(r.value) }), el('td', { className: 'muted', textContent: r.old === null || r.old === undefined ? '—' : String(r.old) }),
        el('td', { className: r.status === 'overwrite' ? 'bad' : (r.status === 'new' ? 'ok' : 'muted'), textContent: label[r.status] }))));
      sections.push(el('h4', { textContent: '与线上对比（仅校验通过的行）' }),
        el('table', {}, el('thead', {}, el('tr', {}, ...['行', 'KPI', '日期', '新值', '线上旧值', '结果'].map(t => el('th', { textContent: t })))), body));
    }
    $('imResult').replaceChildren(...sections);
  }


  // ───── 写入流程与撤销：与页面悬浮窗共用 import_flow.js ─────
  const progress = text => { $('imProgress').textContent = text || ''; };
  const send = (action, payload) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...payload }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.ok) return reject(new Error((response && response.error) || '失败'));
      resolve(response.data);
    });
  });
  const flow = globalThis.MwaImportFlow.create({ read, send, confirm: text => confirm(text), progress,
    lock: on => document.querySelectorAll('#imResult button').forEach(b => { b.disabled = on; }), onSaved: () => renderHistory() });
  const { runImport, undoEntry, loadLog } = flow;

  const STATUS = { running: ['进行中', 'warn'], ok: ['已导入并核对', 'ok'], unverified: ['已写入，读回待确认', 'warn'], failed: ['失败 / 已停止', 'bad'], undone: ['已撤销', ''] };
  async function renderHistory() {
    const list = await loadLog();
    const box = $('imHistory');
    if (!list.length) { box.replaceChildren(el('div', { className: 'muted', textContent: '还没有导入记录' })); return; }
    const body = el('tbody');
    list.forEach(e => {
      const [text, cls] = STATUS[e.status] || [e.status, ''];
      const nNew = e.rows.filter(r => r.status === 'new').length;
      const undoable = (['ok', 'unverified'].includes(e.status) || (e.status === 'failed' && e.wrote)) && e.rows.length;
      body.append(el('tr', {},
        el('td', { textContent: fmtTime(Date.parse(e.time)) }), el('td', { textContent: e.file }), el('td', { textContent: String(e.teamId) }),
        el('td', { textContent: `${e.rows.length} 行（新增 ${nNew}，覆盖 ${e.rows.length - nNew}）` }),
        el('td', {}, el('span', { className: `tag ${cls}`, textContent: text })),
        el('td', { className: 'muted', textContent: e.note || '' }),
        el('td', {}, undoable ? el('button', { className: 'btn', textContent: '撤销', onclick: () => undoEntry(e) }) : '')));
    });
    box.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, ...['时间', '文件', '团队', '内容', '状态', '说明', ''].map(t => el('th', { textContent: t })))), body));
  }

  // 允许写入的团队名单（后台强制校验；默认只有测试团队）
  chrome.storage.local.get('mwaImportWriteTeams').then(({ mwaImportWriteTeams = [28671] }) => { $('imAllow').value = mwaImportWriteTeams.join(','); });
  $('imAllow').addEventListener('change', () => {
    const teams = $('imAllow').value.split(/[,，\s]+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
    chrome.storage.local.set({ mwaImportWriteTeams: teams });
    $('imAllow').value = teams.join(',');
  });
  renderHistory();
  $('imTeam').value = localStorage.getItem('mwaImportTeam') || '28671';
  // 供自动化测试：直接用文本触发一次预览（只读，与点按钮等价）。
  window.__mwaImportPreviewText = (text, name = 'test.csv') => preview(new File([text], name, { type: 'text/csv' }), null);
  $('imTeam').addEventListener('change', () => localStorage.setItem('mwaImportTeam', $('imTeam').value));
  initFolder();
})();
