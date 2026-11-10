// 导入中心核心逻辑（纯函数，无 DOM / chrome 依赖，可在 Node 中测试）：
// CSV 解析、财年日历、模板 v1 校验、与线上现有数据对比。规范见 Obsidian《Fabriq 导入 CSV 模板 v1》。
((root) => {
  'use strict';

  const MAX_ROWS = 600;
  const REQUIRED = ['indicator_id', 'end_date', 'value', 'target'];
  const IGNORED = ['start_date', 'target_met', 'note'];
  const FORBIDDEN = ['allow_target_only', 'override_default_target'];

  // ───── CSV ─────
  // 支持 BOM、CRLF / LF、双引号字段（含逗号、换行、"" 转义）、空行。
  function parseCsv(text) {
    const src = String(text ?? '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((c) => c.trim() !== '')) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    if (!rows.length) return { headers: [], rows: [] };
    const headers = rows[0].map((h) => h.trim());
    return { headers, rows: rows.slice(1).map((cells, index) => ({ line: index + 1, cells })) };
  }

  // ───── 财年日历（与 CZ_Digital_Central dim_calendar 一致）─────
  // 周六起算、周五结束；每个财年 52 周（月 = 4-5-4 周），FY27 为 53 周（首季 5-5-4）；FY27 起点 2026-04-25。
  const DAY = 86400000;
  const utc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const PATTERN_52 = [4, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5, 4];
  const PATTERN_FY27 = [5, 5, 4, 4, 5, 4, 4, 5, 4, 4, 5, 4];
  const FY27_START = utc('2026-04-25');

  function fiscalYears() {
    // 以 FY27 为锚向前后展开：FY26、FY25 为 52 周；FY27 为 53 周；之后每年 52 周（到 FY40）。
    const list = [];
    let start = FY27_START;
    for (let fy = 26, s = FY27_START; fy >= 25; fy--) { s -= 52 * 7 * DAY; list.unshift({ fy, start: s, weeks: 52, pattern: PATTERN_52 }); }
    list.push({ fy: 27, start, weeks: 53, pattern: PATTERN_FY27 });
    start += 53 * 7 * DAY;
    for (let fy = 28; fy <= 40; fy++) { list.push({ fy, start, weeks: 52, pattern: PATTERN_52 }); start += 52 * 7 * DAY; }
    return list;
  }
  const YEARS = fiscalYears();
  const FIRST_SUPPORTED = iso(YEARS[0].start); // FY25 起点（2024-04-27）

  function fiscalInfo(isoDate) {
    const t = utc(isoDate);
    const year = YEARS.find((y) => t >= y.start && t < y.start + y.weeks * 7 * DAY);
    if (!year) return null;
    const week = Math.floor((t - year.start) / (7 * DAY)) + 1;
    let acc = 0;
    let month = 1;
    let monthStartWeek = 1;
    for (let i = 0; i < year.pattern.length; i++) {
      if (week <= acc + year.pattern[i]) { month = i + 1; monthStartWeek = acc + 1; break; }
      acc += year.pattern[i];
    }
    const monthWeeks = year.pattern[month - 1];
    return {
      fy: year.fy, week, month,
      weekEnd: iso(year.start + week * 7 * DAY - DAY),
      monthEnd: iso(year.start + (monthStartWeek - 1 + monthWeeks) * 7 * DAY - DAY),
    };
  }

  const isIsoDate = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  };
  const weekday = (s) => new Date(utc(s)).getUTCDay(); // 0=周日 … 5=周五 6=周六

  // ───── 校验 ─────
  // kpis: { [id]: {id, name, frequency, indicator_type, is_dynamic, unit_type, teams:[...], choices:[...]} }
  // options: { teamId, today:'YYYY-MM-DD', meta, sha256, seenHashes:Set }
  function validate(parsed, kpis, options = {}) {
    const issues = [];
    const add = (level, line, column, message) => issues.push({ level, line, column, message });
    const today = options.today || iso(Date.now());
    const headers = parsed.headers;

    if (!headers.length) { add('error', 0, '', '文件为空'); return { issues, rows: [], ok: false }; }
    for (const col of REQUIRED) if (!headers.includes(col)) add('error', 0, col, `缺少表头「${col}」（target 列必须存在，可留空）`);
    for (const col of FORBIDDEN) if (headers.includes(col)) add('error', 0, col, `v1 模板不使用「${col}」`);
    const extra = headers.filter((h) => h && !REQUIRED.includes(h) && !IGNORED.includes(h) && !FORBIDDEN.includes(h));
    if (extra.length) add('warning', 0, '', `未知列将被忽略：${extra.join('、')}`);
    if (new Set(headers).size !== headers.length) add('error', 0, '', '表头有重复列');
    if (parsed.rows.length === 0) add('error', 0, '', '没有数据行');
    if (parsed.rows.length > MAX_ROWS) add('error', 0, '', `行数 ${parsed.rows.length} 超过上限 ${MAX_ROWS}，请拆分文件`);
    if (issues.some((i) => i.level === 'error' && i.line === 0 && REQUIRED.includes(i.column))) return { issues, rows: [], ok: false };

    const col = (name) => headers.indexOf(name);
    const rows = [];
    const seen = new Map();
    for (const raw of parsed.rows) {
      const cell = (name) => (raw.cells[col(name)] ?? '').trim();
      const line = raw.line;
      const rowIssues = [];
      const err = (c, m) => { add('error', line, c, m); rowIssues.push('error'); };
      const warn = (c, m) => { add('warning', line, c, m); };

      const idText = cell('indicator_id');
      const id = /^\d+$/.test(idText) ? Number(idText) : NaN;
      const kpi = Number.isNaN(id) ? null : kpis[id];
      if (Number.isNaN(id)) err('indicator_id', `KPI ID「${idText}」不是整数`);
      else if (!kpi) err('indicator_id', `KPI ${id} 不在目标团队 / 线上不存在`);
      else {
        if (kpi.is_dynamic) err('indicator_id', `「${kpi.name}」是 Dynamic KPI，不能直接导入数据`);
        if (options.teamId && !(kpi.teams || []).includes(Number(options.teamId))) err('indicator_id', `「${kpi.name}」不属于团队 ${options.teamId}`);
        if (options.scopeIds && !options.scopeIds.has(id)) err('indicator_id', `「${kpi.name}」不在本页（本页只允许导入本页上的 KPI）`);
      }

      const date = cell('end_date');
      let key = date;
      if (!isIsoDate(date)) err('end_date', `日期「${date}」必须是 ISO 格式 YYYY-MM-DD`);
      else if (kpi) {
        const info = fiscalInfo(date);
        if (kpi.frequency === 'weekly') {
          if (weekday(date) !== 5) err('end_date', `周度 KPI 的日期必须是周五（周六至周五为一周）；${date} 会被并入 ${info ? info.weekEnd : '下一个周五'} 并可能覆盖该周数据`);
        } else if (kpi.frequency === 'monthly') {
          if (!info) err('end_date', `${date} 超出财年日历范围，无法校验月度日期`);
          else if (info.monthEnd !== date) err('end_date', `月度 KPI 的日期必须是财年月末（${info.monthEnd}）；${date} 会被并入该月`);
        }
        if (date > today) warn('end_date', `${date} 是未来日期`);
        else if ((utc(today) - utc(date)) / DAY > 62) warn('end_date', `${date} 距今超过 62 天，会覆盖历史数据`);
      }

      const value = cell('value');
      if (value === '') err('value', '值为空');
      else if (!/^-?\d+(\.\d+)?$/.test(value)) err('value', `值「${value}」必须是纯数字（不带 %、千分位或文字）`);
      else if (kpi) {
        const n = Number(value);
        if (kpi.indicator_type === 'status') {
          const choices = (kpi.choices || []).map(Number);
          if (choices.length && !choices.includes(n)) err('value', `状态型 KPI 只接受 ${choices.join('、')}`);
        } else if (kpi.unit_type === 'percentage' && Math.abs(n) > 1.5) warn('value', `百分比 KPI 应使用小数（0.85 表示 85%），当前值 ${n}`);
      }

      if (cell('target') !== '') err('target', 'v1 模板的 target 必须留空（沿用 KPI 默认目标）');
      for (const c of ['start_date', 'target_met']) if (headers.includes(c) && cell(c) !== '') err(c, `「${c}」必须留空`);

      if (Number.isNaN(id) === false && isIsoDate(date)) {
        const k = `${id}|${date}`;
        if (seen.has(k)) err('end_date', `与第 ${seen.get(k)} 行重复（Fabriq 会静默覆盖前一行）`);
        else seen.set(k, line);
        key = k;
      }
      rows.push({ line, id, kpi: kpi ? kpi.name : null, frequency: kpi ? kpi.frequency : null, date, value: value === '' ? null : Number(value), valid: rowIssues.length === 0, key });
    }

    const meta = options.meta;
    if (meta) {
      if (typeof meta.rows === 'number' && meta.rows !== parsed.rows.length) add('error', 0, '', `meta 声明 ${meta.rows} 行，文件实际 ${parsed.rows.length} 行`);
      if (meta.sha256 && /^[0-9a-f]{64}$/i.test(meta.sha256) && options.sha256 && meta.sha256.toLowerCase() !== options.sha256.toLowerCase()) add('error', 0, '', 'meta 的 sha256 与文件不一致，文件可能被改动');
      if (meta.team_id && options.teamId && Number(meta.team_id) !== Number(options.teamId)) add('error', 0, '', `meta 团队 ${meta.team_id} 与所选团队 ${options.teamId} 不一致`);
    }
    if (options.sha256 && options.seenHashes && options.seenHashes.has(options.sha256)) add('warning', 0, '', '该文件（相同哈希）已经导入过');

    return { issues, rows, ok: !issues.some((i) => i.level === 'error') };
  }

  // ───── 与线上对比 ─────
  // existing: { [id]: [{end_date, value, target, target_met}] }
  function compare(rows, existing) {
    const out = rows.filter((r) => r.valid).map((r) => {
      const current = (existing[r.id] || []).find((d) => d.end_date === r.date);
      const old = current && current.value !== null && current.value !== undefined ? Number(current.value) : null;
      let status = 'new';
      if (current) status = old !== null && Math.abs(old - r.value) < 1e-9 ? 'same' : 'overwrite';
      return { ...r, status, old };
    });
    const count = (s) => out.filter((r) => r.status === s).length;
    return { rows: out, new: count('new'), overwrite: count('overwrite'), same: count('same') };
  }

  async function sha256Hex(text, subtle = (globalThis.crypto || {}).subtle) {
    const bytes = new TextEncoder().encode(text);
    const digest = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ───── 写入流程的纯函数 ─────
  // 金丝雀：先导最多 n 行，尽量覆盖不同 KPI，其余用前面的行补足。
  function pickCanary(rows, n = 3) {
    const picked = [];
    const seen = new Set();
    for (const r of rows) if (picked.length < n && !seen.has(r.id)) { picked.push(r); seen.add(r.id); }
    for (const r of rows) if (picked.length < n && !picked.includes(r)) picked.push(r);
    return picked;
  }

  // 导入用 CSV（模板 v1：target 留空）。
  const buildCsv = (rows) => ['indicator_id,end_date,value,target', ...rows.map((r) => `${r.id},${r.date},${r.value},`)].join('\r\n') + '\r\n';

  // 读回核对：expected 的每一行在线上必须存在同一 end_date 且值一致。existing: { [id]: [{id, end_date, value}] }
  function diffReadback(expected, existing) {
    const missing = [];
    const mismatched = [];
    for (const r of expected) {
      const cur = (existing[r.id] || []).find((d) => d.end_date === r.date);
      if (!cur) missing.push(r);
      else if (cur.value === null || cur.value === undefined || Math.abs(Number(cur.value) - r.value) > 1e-9) mismatched.push({ ...r, actual: cur.value });
    }
    return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
  }

  // 撤销计划：只处理“线上当前值仍等于本次导入值”的行（之后被别人改过的不动）。
  // 覆盖的行 → 用原值重新导入；新增的行 → 按数据点 ID 删除。
  function planUndo(entryRows, current) {
    const restore = [];
    const remove = [];
    const skipped = [];
    for (const r of entryRows) {
      const cur = (current[r.id] || []).find((d) => d.end_date === r.date);
      if (!cur) { skipped.push({ row: r, reason: '线上已不存在' }); continue; }
      if (cur.value === null || Math.abs(Number(cur.value) - r.value) > 1e-9) { skipped.push({ row: r, reason: `线上当前值 ${cur.value} 已不是导入值 ${r.value}（之后被修改过）` }); continue; }
      if (r.status === 'overwrite') {
        if (r.old === null || r.old === undefined) skipped.push({ row: r, reason: '原值为空，无法还原' });
        else restore.push({ ...r, value: r.old });
      } else if (r.status === 'new') {
        if (!cur.id) skipped.push({ row: r, reason: '读不到数据点 ID，无法删除' });
        else remove.push({ row: r, datapointId: String(cur.id) });
      }
    }
    return { restore, remove, skipped };
  }

  const core = { MAX_ROWS, REQUIRED, parseCsv, fiscalInfo, isIsoDate, validate, compare, sha256Hex, FIRST_SUPPORTED, pickCanary, buildCsv, diffReadback, planUndo };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else root.MwaImportCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
