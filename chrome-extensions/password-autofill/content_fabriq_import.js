// Fabriq 页面悬浮窗（默认收起）：仅在 /team/{团队}/dashboard/{看板} 页面出现。
// 现阶段内容：本页信息、KPI 数据导入（校验 → 与线上对比 → 金丝雀导入 → 读回对账 → 可撤销）。
// 导入范围 = 本页上的 KPI（scopeIds）；写入仍由后台按「允许导入的团队」名单强制门禁。
(() => {
  'use strict';
  const core = globalThis.MwaImportCore;
  if (!core || !globalThis.MwaDock || !globalThis.MwaImportFlow) return;

  const DOCK_ID = 'mwa-fabriq-dock';
  // 页面别名（可在悬浮窗里改）；测试看板默认当作「CZ Milling Tier 1 沈俊杰」
  const SEED_ALIAS = { '28671/95982': 'CZ Milling Tier 2（测试页）' };
  const el = (tag, props, ...children) => {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    children.forEach(child => node.append(child));
    return node;
  };
  const route = () => {
    const m = location.pathname.match(/^\/team\/(\d+)\/dashboard\/(\d+)/);
    return m ? { teamId: Number(m[1]), dashboardId: Number(m[2]) } : null;
  };

  const send = (action, payload) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...payload }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.ok) return reject(new Error((response && response.error) || '失败'));
      resolve(response.data);
    });
  });
  const read = endpoint => send('fabriqRead', { endpoint });

  let dock = null;
  let current = null;
  let pageKpis = null; // { dashboardId, ids:Set }
  let compared = null;

  async function loadPageKpis(r) {
    if (pageKpis && pageKpis.dashboardId === r.dashboardId) return pageKpis;
    const response = await fetch(`/legacy/api/api/v1/dashboards/${r.dashboardId}/widgets/`, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) throw new Error(`读取本页组件失败（${response.status}）`);
    const json = await response.json();
    const widgets = Array.isArray(json) ? json : (json.results || []);
    const ids = new Set();
    widgets.filter(w => w._type === 'kpiPanel').forEach(w => (w.object_ids || []).forEach(id => ids.add(Number(id))));
    pageKpis = { dashboardId: r.dashboardId, ids, panels: widgets.filter(w => w._type === 'kpiPanel').length };
    return pageKpis;
  }

  function build() {
    dock = MwaDock.create({ id: DOCK_ID, title: 'Fabriq 助手', icon: 'icons/fabriq.png' });
    const alias = el('input', { className: 'mwa-inp', placeholder: '页面别名' });
    const info = el('div', { className: 'mwa-hint' });
    const pick = el('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
    const pickBtn = el('button', { className: 'mwa-btn indigo block', textContent: '选择 CSV 并校验' });
    const result = el('div', { className: 'mwa-hint' });
    const go = el('button', { className: 'mwa-btn green block', textContent: '导入', hidden: true });
    const prog = el('div', { className: 'mwa-hint' });
    const hist = el('div', { className: 'mwa-list' });
    const center = el('button', { className: 'mwa-btn gray block', textContent: '打开导入中心（后台）', onclick: () => send('openOptions', {}).catch(() => {}) });
    const field = (label, ...nodes) => el('div', { style: 'display:flex;flex-direction:column;gap:6px;margin-bottom:12px' }, el('div', { className: 'mwa-hint', textContent: label, style: 'font-weight:600' }), ...nodes);
    dock.body.append(field('本页', alias, info), field('KPI 数据导入（仅限本页上的 KPI）', pickBtn, pick, result, go, prog), field('最近导入（本团队）', hist), center);
    document.documentElement.append(dock.root);

    alias.addEventListener('change', async () => {
      const key = `${current.teamId}/${current.dashboardId}`;
      const { mwaFabriqAlias = {} } = await chrome.storage.local.get('mwaFabriqAlias');
      mwaFabriqAlias[key] = alias.value.trim();
      await chrome.storage.local.set({ mwaFabriqAlias });
    });

    const flow = MwaImportFlow.create({ read, send, confirm: t => window.confirm(t), progress: t => { prog.textContent = t || ''; },
      lock: on => { go.disabled = on; pickBtn.disabled = on; hist.querySelectorAll('button').forEach(b => { b.disabled = on; }); }, onSaved: () => renderHistory() });

    const STATUS = { running: '进行中', ok: '已导入并核对', unverified: '已写入，读回待确认', failed: '失败/已停止', undone: '已撤销' };
    async function renderHistory() {
      const list = (await flow.loadLog()).filter(e => e.teamId === current.teamId).slice(0, 5);
      hist.replaceChildren(...(list.length ? list.map(e => {
        const undoable = (['ok', 'unverified'].includes(e.status) || (e.status === 'failed' && e.wrote)) && e.rows.length;
        return el('div', { className: 'mwa-row' },
          el('span', { textContent: `${new Date(e.time).toLocaleString('zh-CN', { hour12: false })} ${e.file} · ${e.rows.length} 行 · ${STATUS[e.status] || e.status}`, title: e.note || '' }),
          ...(undoable ? [el('button', { className: 'mwa-btn danger', textContent: '撤销', onclick: () => flow.undoEntry(e) })] : []));
      }) : [el('div', { className: 'mwa-hint', textContent: '暂无记录' })]));
    }

    async function preview(file) {
      go.hidden = true; compared = null;
      const status = t => { result.textContent = t; };
      try {
        status('读取文件…');
        const text = await file.text();
        const sha256 = await core.sha256Hex(text);
        const parsed = core.parseCsv(text);
        const col = parsed.headers.indexOf('indicator_id');
        const ids = col < 0 ? [] : [...new Set(parsed.rows.map(r => (r.cells[col] || '').trim()).filter(v => /^\d+$/.test(v)).map(Number))];
        if (ids.length > 40) throw new Error(`文件里有 ${ids.length} 个不同的 KPI，超过单次 40 个的上限`);
        status('读取本页 KPI…');
        const page = await loadPageKpis(current);
        const kpis = {};
        for (let i = 0; i < ids.length; i++) {
          status(`读取 KPI 信息 ${i + 1}/${ids.length}…`);
          try {
            const k = await read(`/backend/kpi/v2/indicator/${ids[i]}`);
            kpis[ids[i]] = { id: ids[i], name: k.name, frequency: k.frequency, indicator_type: k.indicator_type, is_dynamic: !!k.is_dynamic,
              unit_type: k.unit_type, teams: (k.teams && k.teams.ids) || [], choices: ((k.choices && k.choices.options) || []).map(o => o.value) };
          } catch { /* 读不到的 KPI 由校验报错 */ }
        }
        const { mwaImportLog = [] } = await chrome.storage.local.get('mwaImportLog');
        const validated = core.validate(parsed, kpis, { teamId: current.teamId, scopeIds: page.ids, sha256,
          seenHashes: new Set(mwaImportLog.filter(e => ['ok', 'unverified'].includes(e.status)).map(e => e.sha256)) });
        const existing = {};
        const validIds = [...new Set(validated.rows.filter(r => r.valid).map(r => r.id))];
        for (let i = 0; i < validIds.length; i++) {
          status(`读取线上现有数据 ${i + 1}/${validIds.length}…`);
          const rows = await read(`/legacy/api/api/v1/indicator/${validIds[i]}/datapoints/`);
          existing[validIds[i]] = Array.isArray(rows) ? rows : [];
        }
        const cmp = core.compare(validated.rows, existing);
        const errors = validated.issues.filter(i => i.level === 'error');
        const warnings = validated.issues.filter(i => i.level === 'warning');
        const writable = cmp.rows.filter(r => r.status !== 'same').length;
        const lines = [el('div', { textContent: `${file.name}：${parsed.rows.length} 行 / ${ids.length} 个 KPI；新增 ${cmp.new}、覆盖 ${cmp.overwrite}、相同 ${cmp.same}；${errors.length} 个错误、${warnings.length} 个警告` })];
        validated.issues.slice(0, 8).forEach(i => lines.push(el('div', { style: `color:${i.level === 'error' ? '#d70015' : '#b25000'}`, textContent: `${i.level === 'error' ? '错误' : '警告'}${i.line ? ` 第${i.line}行` : ''}：${i.message}` })));
        if (validated.issues.length > 8) lines.push(el('div', { textContent: `…另有 ${validated.issues.length - 8} 条，请到导入中心查看完整列表` }));
        if (errors.length) lines.push(el('div', { textContent: '有错误，整个文件都不会上传' }));
        result.replaceChildren(...lines);
        if (!errors.length && writable) {
          compared = { file, sha256, compared: cmp, kpis, teamId: current.teamId };
          go.textContent = `导入 ${writable} 行…`; go.hidden = false;
        }
      } catch (error) {
        result.textContent = `无法完成校验：${error.message}`;
      }
    }

    pickBtn.onclick = () => pick.click();
    pick.onchange = () => { const f = pick.files[0]; pick.value = ''; if (f) { prog.textContent = ''; preview(f); } };
    go.onclick = () => { if (compared) flow.runImport(compared); };

    dock.refresh = async () => {
      const key = `${current.teamId}/${current.dashboardId}`;
      const { mwaFabriqAlias = {} } = await chrome.storage.local.get('mwaFabriqAlias');
      const name = mwaFabriqAlias[key] ?? SEED_ALIAS[key] ?? '';
      alias.value = name;
      dock.status.textContent = name || `看板 ${current.dashboardId}`;
      info.textContent = `团队 ${current.teamId} · 看板 ${current.dashboardId}`;
      result.textContent = ''; go.hidden = true; prog.textContent = ''; compared = null;
      renderHistory();
      loadPageKpis(current).then(p => { info.textContent = `团队 ${current.teamId} · 看板 ${current.dashboardId} · 本页 ${p.ids.size} 个 KPI（${p.panels} 个面板）`; },
        e => { info.textContent += `（${e.message}）`; });
    };
  }

  function sync() {
    const r = route();
    if (!r) { if (dock) dock.root.hidden = true; current = null; return; }
    const changed = !current || current.teamId !== r.teamId || current.dashboardId !== r.dashboardId;
    current = r;
    if (!dock) build();
    dock.root.hidden = false;
    if (changed || !dock.root.isConnected) { if (!dock.root.isConnected) document.documentElement.append(dock.root); dock.refresh(); }
  }
  sync();
  setInterval(sync, 1000);
})();
