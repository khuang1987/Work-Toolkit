const assert = require('node:assert/strict');
const test = require('node:test');
const core = require('../import_core.js');

const kpis = {
  1: { id: 1, name: 'WIP', frequency: 'daily', indicator_type: 'time-series', is_dynamic: false, unit_type: 'number', teams: [28671] },
  2: { id: 2, name: 'OEE', frequency: 'daily', indicator_type: 'time-series', is_dynamic: false, unit_type: 'percentage', teams: [28671] },
  3: { id: 3, name: 'EH_Weekly', frequency: 'weekly', indicator_type: 'time-series', is_dynamic: false, unit_type: 'number', teams: [28671] },
  4: { id: 4, name: 'OIP', frequency: 'monthly', indicator_type: 'time-series', is_dynamic: false, unit_type: 'percentage', teams: [28671] },
  5: { id: 5, name: 'Mood', frequency: 'daily', indicator_type: 'status', is_dynamic: false, unit_type: 'number', teams: [28671], choices: [1, 0, -1] },
  6: { id: 6, name: 'Dyn', frequency: 'daily', indicator_type: 'time-series', is_dynamic: true, unit_type: 'number', teams: [28671] },
  7: { id: 7, name: 'Other team', frequency: 'daily', indicator_type: 'time-series', is_dynamic: false, unit_type: 'number', teams: [28728] },
};
const run = (csv, options = {}) => core.validate(core.parseCsv(csv), kpis, { teamId: 28671, today: '2026-11-09', ...options });
const errs = (r) => r.issues.filter((i) => i.level === 'error').map((i) => `${i.line}:${i.column}`);

test('fiscal calendar matches Fabriq normalisation observed on 2026-11-09 and the FY27 53-week rule', () => {
  assert.equal(core.fiscalInfo('2026-10-17').weekEnd, '2026-10-23'); // 周六并入下一个周五
  assert.equal(core.fiscalInfo('2026-10-19').weekEnd, '2026-10-23');
  assert.equal(core.fiscalInfo('2026-10-16').weekEnd, '2026-10-16');
  assert.equal(core.fiscalInfo('2026-09-02').monthEnd, '2026-10-02'); // 实测 09-02 → 10-02
  assert.equal(core.fiscalInfo('2026-10-20').monthEnd, '2026-10-30'); // 实测 10-20 → 10-30
  assert.equal(core.fiscalInfo('2027-04-24').fy, 27); // FY27 为 53 周
  assert.equal(core.fiscalInfo('2027-04-30').week, 53);
  assert.equal(core.fiscalInfo('2027-05-01').fy, 28);
  assert.equal(core.fiscalInfo('2027-05-01').week, 1);
  assert.equal(core.fiscalInfo('2026-04-25').fy, 27);
  assert.equal(core.fiscalInfo('2026-04-24').fy, 26);
  assert.equal(core.fiscalInfo('2026-04-24').week, 52);
  assert.equal(core.fiscalInfo('2000-01-01'), null);
});

test('parseCsv handles BOM, CRLF, quotes, blank lines and column order', () => {
  const p = core.parseCsv('\uFEFFvalue,note,indicator_id\r\n"1,200","a ""b""",1\r\n\r\n2,x,1\r\n');
  assert.deepEqual(p.headers, ['value', 'note', 'indicator_id']);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows[0].cells, ['1,200', 'a "b"', '1']);
});

test('a clean file passes, with ignored extra columns only warned', () => {
  const r = run('indicator_id,end_date,value,target,note\n1,2026-11-06,101,,x\n3,2026-11-06,100,,\n');
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 2);
  assert.ok(r.rows.every((row) => row.valid));
});

test('template v1 hard rules are enforced', () => {
  assert.deepEqual(errs(run('indicator_id,end_date,value\n1,2026-11-06,1\n')), ['0:target']);
  assert.ok(errs(run('indicator_id,end_date,value,target\n1,2026/11/06,1,\n')).includes('1:end_date')); // 斜杠日期
  assert.ok(errs(run('indicator_id,end_date,value,target\n1,14/10/2026,1,\n')).includes('1:end_date'));
  assert.ok(errs(run('indicator_id,end_date,value,target\n1,2026-11-06,85%,\n')).includes('1:value'));
  assert.ok(errs(run('indicator_id,end_date,value,target\n1,2026-11-06,"1,200",\n')).includes('1:value'));
  assert.ok(errs(run('indicator_id,end_date,value,target\n1,2026-11-06,,\n')).includes('1:value'));
  assert.ok(errs(run('indicator_id,end_date,value,target\n1,2026-11-06,5,8\n')).includes('1:target'));
  assert.ok(errs(run('indicator_id,end_date,value,target,override_default_target\n1,2026-11-06,5,,true\n')).includes('0:override_default_target'));
  assert.ok(errs(run('indicator_id,end_date,value,target\n999,2026-11-06,5,\n')).includes('1:indicator_id'));
  assert.ok(errs(run('indicator_id,end_date,value,target\n6,2026-11-06,5,\n')).includes('1:indicator_id')); // Dynamic
  assert.ok(errs(run('indicator_id,end_date,value,target\n7,2026-11-06,5,\n')).includes('1:indicator_id')); // 其他团队
});

test('weekly must be Friday, monthly must be the fiscal month end, duplicates are rejected', () => {
  assert.ok(errs(run('indicator_id,end_date,value,target\n3,2026-11-07,1,\n')).includes('1:end_date')); // 周六
  assert.ok(errs(run('indicator_id,end_date,value,target\n3,2026-11-09,1,\n')).includes('1:end_date')); // 周一
  assert.equal(run('indicator_id,end_date,value,target\n3,2026-11-06,1,\n').ok, true);
  assert.ok(errs(run('indicator_id,end_date,value,target\n4,2026-10-20,1,\n')).includes('1:end_date'));
  assert.equal(run('indicator_id,end_date,value,target\n4,2026-10-30,0.9,\n').ok, true);
  const dup = run('indicator_id,end_date,value,target\n1,2026-11-06,1,\n1,2026-11-06,2,\n');
  assert.deepEqual(errs(dup), ['2:end_date']);
});

test('status and percentage values, future and old dates, row cap, meta and seen hash', () => {
  assert.ok(errs(run('indicator_id,end_date,value,target\n5,2026-11-06,5,\n')).includes('1:value'));
  assert.equal(run('indicator_id,end_date,value,target\n5,2026-11-06,-1,\n').ok, true);
  const pct = run('indicator_id,end_date,value,target\n2,2026-11-06,85,\n');
  assert.equal(pct.ok, true);
  assert.ok(pct.issues.some((i) => i.level === 'warning' && i.column === 'value'));
  assert.ok(run('indicator_id,end_date,value,target\n1,2026-12-01,1,\n').issues.some((i) => i.message.includes('未来')));
  assert.ok(run('indicator_id,end_date,value,target\n1,2026-08-01,1,\n').issues.some((i) => i.message.includes('62')));
  const many = 'indicator_id,end_date,value,target\n' + Array.from({ length: 601 }, (_, i) => `1,${new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10)},1,`).join('\n');
  assert.ok(run(many).issues.some((i) => i.message.includes('上限')));
  const meta = run('indicator_id,end_date,value,target\n1,2026-11-06,1,\n', { meta: { rows: 3, team_id: 99 } });
  assert.equal(meta.ok, false);
  const seen = run('indicator_id,end_date,value,target\n1,2026-11-06,1,\n', { sha256: 'a'.repeat(64), seenHashes: new Set(['a'.repeat(64)]) });
  assert.ok(seen.issues.some((i) => i.message.includes('已经导入过')));
});

test('compare classifies new / overwrite / same against existing datapoints', () => {
  const r = run('indicator_id,end_date,value,target\n1,2026-11-04,1,\n1,2026-11-05,2,\n1,2026-11-06,3,\n');
  const c = core.compare(r.rows, { 1: [{ end_date: '2026-11-04', value: '1' }, { end_date: '2026-11-05', value: '9' }] });
  assert.deepEqual([c.new, c.overwrite, c.same], [1, 1, 1]);
  assert.equal(c.rows.find((x) => x.status === 'overwrite').old, 9);
});

test('sha256Hex matches node crypto', async () => {
  const { createHash, webcrypto } = require('node:crypto');
  assert.equal(await core.sha256Hex('abc', webcrypto.subtle), createHash('sha256').update('abc').digest('hex'));
});

test('canary prefers distinct KPIs; buildCsv emits template v1; readback and undo plans', () => {
  const rows = [1, 1, 2, 2, 3].map((id, i) => ({ id, date: `2026-11-0${i + 1}`, value: i + 1, status: 'new' }));
  assert.deepEqual(core.pickCanary(rows, 3).map((r) => r.id), [1, 2, 3]);
  assert.equal(core.pickCanary(rows.slice(0, 2), 3).length, 2);
  assert.equal(core.buildCsv([{ id: 1, date: '2026-11-06', value: 101 }]), 'indicator_id,end_date,value,target\r\n1,2026-11-06,101,\r\n');
  const rb = core.diffReadback(rows.slice(0, 2), { 1: [{ end_date: '2026-11-01', value: '1' }] });
  assert.equal(rb.ok, false);
  assert.equal(rb.missing.length, 1);
  assert.equal(core.diffReadback(rows.slice(0, 1), { 1: [{ end_date: '2026-11-01', value: '1' }] }).ok, true);
  assert.equal(core.diffReadback(rows.slice(0, 1), { 1: [{ end_date: '2026-11-01', value: '9' }] }).mismatched.length, 1);
  const entry = [
    { id: 1, date: '2026-11-01', value: 5, status: 'overwrite', old: 3 },
    { id: 1, date: '2026-11-02', value: 6, status: 'new' },
    { id: 1, date: '2026-11-03', value: 7, status: 'new' },
    { id: 1, date: '2026-11-04', value: 8, status: 'overwrite', old: null },
    { id: 1, date: '2026-11-05', value: 9, status: 'new' },
  ];
  const plan = core.planUndo(entry, { 1: [
    { id: 'a', end_date: '2026-11-01', value: '5' }, { id: 'b', end_date: '2026-11-02', value: '6' },
    { id: 'c', end_date: '2026-11-03', value: '70' }, { id: 'd', end_date: '2026-11-04', value: '8' } ] });
  assert.deepEqual(plan.restore.map((r) => [r.date, r.value]), [['2026-11-01', 3]]);
  assert.deepEqual(plan.remove.map((r) => r.datapointId), ['b']);
  assert.equal(plan.skipped.length, 3); // 被改过、原值为空、已不存在
});
test('scopeIds restricts import to KPIs on the current page', () => {
  const csv = 'indicator_id,end_date,value,target\n1,2026-11-06,1,\n3,2026-11-06,1,\n';
  const r = core.validate(core.parseCsv(csv), kpis, { teamId: 28671, today: '2026-11-09', scopeIds: new Set([1]) });
  assert.deepEqual(r.issues.filter((i) => i.level === 'error').map((i) => `${i.line}:${i.message.includes('不在本页')}`), ['2:true']);
});