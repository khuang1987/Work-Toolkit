const assert = require('node:assert/strict');
const test = require('node:test');
const { DESCRIPTION_TEMPLATE, MAX_QA_ROUNDS, MAX_TITLE_LENGTH, buildMessages, parseResult, diffText,
  normalizeDescription, descriptionToBlocks, descriptionToHtml, isValidIsoDate, buildProgressMessages, parseProgress, mergeDescription } = require('../fabriq_ai_helpers.js');

const description = DESCRIPTION_TEMPLATE.map(title => `【${title}】\n已知内容`).join('\n\n');
const normalized = DESCRIPTION_TEMPLATE.map(title => `${title}\n已知内容`).join('\n');

test('prompt preserves all six daily questions in order and missing-data boundaries', () => {
  const messages = buildMessages({
    team: '虚构团队', title: '虚构问题', description: '设备停机20分钟', tasks: ['记录现象']
  }, { direction: '更简洁', previous: { description: '用户已编辑的预览', tasks: ['收集数据'] } });
  let position = -1;
  for (const title of DESCRIPTION_TEMPLATE) {
    const next = messages[0].content.indexOf(title);
    assert.ok(next > position);
    position = next;
  }
  assert.match(messages[0].content, /没有数据就不写，不能当作零或无影响/);
  assert.match(messages[0].content, /不要写「待确认」/);
  assert.match(messages[0].content, /不能声称已查看附件或已收到回复/);
  assert.match(messages[1].content, /设备停机20分钟/);
  assert.match(messages[1].content, /用户已编辑的预览/);
  assert.match(messages[1].content, /更简洁/);
});

test('title optimization and question modes are explicit in the prompt', () => {
  const context = { team: '虚构团队', title: '设备异常', description: '', tasks: [] };
  const plain = buildMessages(context, { scope: { title: false } })[0].content;
  assert.doesNotMatch(plain, /"title":/);
  assert.match(plain, /资料已足够写出有意义的描述时直接返回 result/);
  const titled = buildMessages(context, { mode: 'ask' })[0].content;
  assert.match(titled, /"title":"优化后的任务标题"/);
  assert.match(titled, /用户主动进入问答补充/);
  assert.match(buildMessages(context, { mode: 'generate' })[0].content, /不得再提问/);
});

test('question history is sent as facts and the fifth answered round forces a result', () => {
  const context = { team: '虚构团队', title: '设备异常', description: '停机', tasks: [] };
  const qa = [{ questions: ['哪台设备？'], answers: ['DEV-7'] }, { questions: ['几点发现？'], answers: [''] }];
  const user = buildMessages(context, { qa })[1].content;
  assert.match(user, /第1轮\n问：哪台设备？\n答：DEV-7/);
  assert.match(user, /答：（未回答）/);
  const rounds = Array.from({ length: MAX_QA_ROUNDS }, (_, i) => ({ questions: [`问题${i}`], answers: ['答'] }));
  const system = buildMessages(context, { qa: rounds, mode: 'ask' })[0].content;
  assert.match(system, /不得再提问/);
  assert.match(system, new RegExp(`已完成 ${MAX_QA_ROUNDS}/${MAX_QA_ROUNDS} 轮问答`));
});

test('progress prompt carries the spoken update, today, existing tasks with owners and the people hint format', () => {
  const messages = buildProgressMessages({ team: 't', title: '设备异常', description: '正文', tasks: ['A'],
    taskDetails: [{ text: '统计批次', assignee: 'Daping He', due: 'Dec 31' }, { text: '验证', assignee: '', due: '' }] },
  { progressText: '大平周五前完成统计，我来跟进验证', today: '2026-11-04', direction: '更简洁' });
  assert.match(messages[0].content, /"comment"/);
  assert.match(messages[0].content, /"taskUpdates"/);
  assert.match(messages[0].content, /pinyin/);
  assert.match(messages[0].content, /「发生了什么？」/);
  assert.match(messages[1].content, /统计批次｜负责人：Daping He｜截止：Dec 31/);
  assert.match(messages[1].content, /验证｜负责人：无｜截止：无/);
  assert.match(messages[1].content, /今天：2026-11-04（周三）/);
  assert.match(messages[1].content, /大平周五前完成统计，我来跟进验证/);
  assert.match(messages[1].content, /更简洁/);
});

test('progress result is validated, deduplicated and refuses empty or past-dated output', () => {
  const today = '2026-11-04';
  const ok = parseProgress(JSON.stringify({
    comment: ' 统计已完成 ',
    descriptionAdditions: [{ heading: DESCRIPTION_TEMPLATE[3], text: '已联系PE\n已调整参数' }],
    tasks: [{ title: '验证参数', due: '2026-11-06', assignee: { text: '大平', pinyin: 'Daping He' } }, { title: '验证参数', due: null, assignee: null },
      { title: '复盘', due: null, assignee: 'me' }],
    taskUpdates: [{ task: '统计批次', due: '2026-11-05', assignee: null }, { task: '无变化', due: null, assignee: null }]
  }), { today });
  assert.equal(ok.type, 'progress');
  assert.equal(ok.comment, '统计已完成');
  assert.deepEqual(ok.tasks.map(t => t.title), ['验证参数', '复盘']);
  assert.deepEqual(ok.tasks[0].assignee, { text: '大平', pinyin: 'Daping He' });
  assert.deepEqual(ok.tasks[1].assignee, { me: true });
  assert.deepEqual(ok.updates, [{ task: '统计批次', due: '2026-11-05', assignee: null }]);
  for (const bad of [
    { comment: null }, { comment: 5 }, { descriptionAdditions: [{ heading: '随便', text: 'x' }] }, { descriptionAdditions: [{ heading: DESCRIPTION_TEMPLATE[0], text: '' }] },
    { tasks: [{ title: '' }] }, { tasks: [{ title: 'a', due: '2026-11-03' }] }, { tasks: [{ title: 'a', due: '2026-02-30' }] },
    { tasks: [{ title: 'a', assignee: { name: 'x' } }] }, { tasks: Array.from({ length: 9 }, (_, i) => ({ title: `t${i}` })) }
  ]) assert.throws(() => parseProgress(JSON.stringify({ comment: 'c', ...bad }), { today }), /无效|早于今天|没有从这段进展/);
  assert.throws(() => parseProgress(JSON.stringify({ comment: null, tasks: [], taskUpdates: [] }), { today }), /没有从这段进展/);
  assert.throws(() => parseProgress('not json', { today }), /JSON 无效/);
});

test('merging progress keeps existing text, fills the right template item and adds a dated prefix', () => {
  const [q1, q2, q3, q4] = DESCRIPTION_TEMPLATE;
  const existing = `前言\n【${q1}】\n设备停机\n${q3}\n停机20分钟`;
  const merged = mergeDescription(existing, [{ heading: q3, text: '新增报废2件' }, { heading: q4, text: '已联系PE\n已调整参数' }], '11/4');
  assert.equal(merged, ['前言', q1, '设备停机', q3, '停机20分钟', '11/4 新增报废2件', q4, '11/4 已联系PE', '11/4 已调整参数'].join('\n'));
  const inserted = mergeDescription(`${q1}\nA\n${q4}\nD`, [{ heading: q2, text: '工序：数控铣' }]);
  assert.deepEqual(descriptionToBlocks(inserted).items.map(i => i.heading), [q1, q2, q4]);
  assert.equal(mergeDescription('', [{ heading: q1, text: 'x' }]), `${q1}\nx`);
});

test('valid JSON and fenced JSON parse without inventing task fields', () => {
  const scope = { title: false };
  const raw = JSON.stringify({ description, tasks: ['收集数据', '收集数据', '确认影响'] });
  assert.deepEqual(parseResult('```json\n' + raw + '\n```', { scope }), {
    type: 'result', title: null, description: normalized, tasks: ['收集数据', '确认影响'], schedule: null
  });
  assert.deepEqual(parseResult(JSON.stringify({ status: 'result', description, tasks: [] }), { scope }).tasks, []);
});

test('each scope only requires and returns the requested fields', () => {
  const only = scope => ({ scope: { title: false, description: false, tasks: false, schedule: false, ...scope } });
  assert.deepEqual(parseResult('{"title":" 新标题 "}', only({ title: true })),
    { type: 'result', title: '新标题', description: null, tasks: null, schedule: null });
  assert.deepEqual(parseResult(JSON.stringify({ description }), only({ description: true })).description, normalized);
  assert.deepEqual(parseResult('{"tasks":["a","b"],"description":42}', only({ tasks: true })).tasks, ['a', 'b']);
  assert.throws(() => parseResult('{"tasks":"a"}', only({ tasks: true })), /任务格式无效/);
  assert.throws(() => parseResult('{}', only({ title: true })), /标题无效/);
});

test('schedule needs real dates, not before today, matching the requested shape', () => {
  const scope = { scope: { title: false, description: false, tasks: false, schedule: true }, today: '2026-11-04' };
  const raw = schedule => JSON.stringify({ schedule });
  assert.deepEqual(parseResult(raw([{ task: ' 统计批次 ', due: '2026-11-05' }, { task: '统计批次', due: '2026-11-06' }, { task: '验证', due: '2026-11-04' }]), scope).schedule,
    [{ task: '统计批次', due: '2026-11-05' }, { task: '验证', due: '2026-11-04' }]);
  for (const bad of ['x', [{ task: 'a', due: '2026-02-30' }], [{ task: 'a', due: '11/05/2026' }], [{ task: '', due: '2026-11-05' }], [{ due: '2026-11-05' }], [null]]) {
    assert.throws(() => parseResult(raw(bad), scope), /排期格式无效/);
  }
  assert.throws(() => parseResult(raw([{ task: 'a', due: '2026-11-03' }]), scope), /早于今天/);
  assert.ok(isValidIsoDate('2028-02-29') && !isValidIsoDate('2027-02-29'));
});

test('schedule prompt carries today, the undated tasks and never allows questions', () => {
  const context = { team: 't', title: '设备异常', description: '', tasks: ['A', 'B'], undatedTasks: ['B'] };
  const messages = buildMessages(context, { scope: { title: false, description: false, tasks: false, schedule: true }, mode: 'ask', today: '2026-11-04' });
  assert.match(messages[1].content, /今天：2026-11-04（周三）\n待排期任务：B/);
  assert.match(messages[0].content, /"schedule":\[/);
  assert.doesNotMatch(messages[0].content, /"questions"|六项模板|"title":|"tasks":\[/);
});

test('placeholder wording is dropped but real content and 暂无 answers are kept', () => {
  const raw = [
    '【发生了什么？】', 'DEV-1 停机。',
    '【在什么工序，哪台设备，什么时间，哪个批次，谁发现的？】', '工序：数控铣', '设备：A机床，具体设备编号待确认', '时间：待确认', '批次：待确认',
    '【影响是什么？（停机，报废，交付，NCMR，OEE）请在下面描述具体影响。】', '报废、交付、NCMR、OEE：待确认', '待确认',
    '【当前已采取了什么措施？（需要提供正确的数据，图纸或照片）】', '已联系PE，待确认是否增加上道车削尺寸。',
    '【期望解决什么问题？】',
    '【升级前是否得到了反馈或回复，是什么？】', '暂无'
  ].join('\n');
  const result = parseResult(JSON.stringify({ description: raw, tasks: [] }), { scope: { title: false } }).description;
  assert.doesNotMatch(result, /【|】|时间：|批次：|OEE：/);
  assert.match(result, /工序：数控铣/);
  assert.match(result, /设备：A机床。/);
  assert.match(result, /已联系PE，待确认是否增加上道车削尺寸。/);
  assert.match(result, /期望解决什么问题？\n升级前/);
  assert.match(result, /升级前是否得到了反馈或回复，是什么？\n暂无$/);
});

test('template questions become list items and answers stay unbulleted plain paragraphs', () => {
  const [q1, q2, q3] = DESCRIPTION_TEMPLATE;
  const blocks = descriptionToBlocks(`前言\n• ${q1}\n答案一\n第二行\n${q2}\n- ${q3}\n- 不是模板的短横线`);
  assert.deepEqual(blocks.preamble, ['前言']);
  assert.deepEqual(blocks.items, [
    { heading: q1, answers: ['答案一', '第二行'] },
    { heading: q2, answers: [] },
    { heading: q3, answers: ['- 不是模板的短横线'] }]);
  assert.equal(descriptionToHtml(`${q1}\n<b>答案</b> & 更多\n${q2}`),
    `<ul><li><p>${q1}</p><p>&lt;b&gt;答案&lt;/b&gt; &amp; 更多</p></li><li><p>${q2}</p></li></ul>`);
  assert.equal(descriptionToHtml(normalized).match(/<li>/g).length, DESCRIPTION_TEMPLATE.length);
  assert.equal(normalizeDescription('【发生了什么？】\n\n\n答案'), '发生了什么？\n答案');
});

test('titles are required only when requested and must be a short single line', () => {
  const raw = title => JSON.stringify({ status: 'result', title, description, tasks: [] });
  assert.equal(parseResult(raw('  设备 DEV-1\n停机  ')).title, '设备 DEV-1 停机');
  assert.equal(parseResult(raw('不需要'), { scope: { title: false } }).title, null);
  for (const bad of ['', '   ', 5, '长'.repeat(MAX_TITLE_LENGTH + 1)]) {
    assert.throws(() => parseResult(raw(bad)), /标题无效/);
  }
  assert.equal(parseResult(raw('长'.repeat(MAX_TITLE_LENGTH))).title.length, MAX_TITLE_LENGTH);
});

test('questions are accepted only when allowed and are bounded and deduplicated', () => {
  const raw = questions => JSON.stringify({ status: 'questions', questions });
  assert.deepEqual(parseResult(raw([' 哪台设备？ ', '哪台设备？', '几点？', '批次？', '谁发现？']), { allowQuestions: true }),
    { type: 'questions', questions: ['哪台设备？', '几点？', '批次？'] });
  assert.throws(() => parseResult(raw(['哪台设备？'])), /仍在提问/);
  for (const bad of [[], [''], [3], '设备', ['长'.repeat(121)]]) {
    assert.throws(() => parseResult(raw(bad), { allowQuestions: true }), /问题格式无效/);
  }
  assert.throws(() => parseResult('{"status":"done"}'), /状态无效/);
});

test('malformed, incomplete or reordered descriptions are rejected explicitly', () => {
  for (const raw of ['not json', 'null', '{"description":"发生了什么？","tasks":[]}',
    JSON.stringify({ description, tasks: [42] }),
    JSON.stringify({ description, tasks: [''] }),
    JSON.stringify({ description, tasks: Array.from({ length: 9 }, (_, i) => `动作${i}`) }),
    JSON.stringify({ description: DESCRIPTION_TEMPLATE.toReversed().join('\n'), tasks: [] })]) {
    assert.throws(() => parseResult(raw), /无效|六项模板|超过8条/);
  }
});

function assertDiff(before, after) {
  const parts = diffText(before, after);
  assert.equal(parts.filter(p => p.type !== 'insert').map(p => p.text).join(''), before);
  assert.equal(parts.filter(p => p.type !== 'delete').map(p => p.text).join(''), after);
  assert.ok(parts.every(p => ['equal', 'insert', 'delete'].includes(p.type)));
  return parts;
}

test('Chinese text changes highlight the changed number, not unchanged facts', () => {
  const parts = assertDiff('设备A停机20分钟，批次B。', '设备A停机30分钟，批次B。');
  assert.equal(parts.filter(p => p.type === 'delete').map(p => p.text).join(''), '2');
  assert.equal(parts.filter(p => p.type === 'insert').map(p => p.text).join(''), '3');
});

test('diff handles empty, unchanged, multiline, emoji and literal HTML safely', () => {
  for (const [before, after] of [
    ['', '新增描述'], ['删除描述', ''], ['相同描述', '相同描述'],
    ['第一行\n第二行', '第一行\n新增行\n第二行'], ['设备😀异常', '设备😀已恢复'],
    ['<script>before</script>', '<img src=x onerror=alert(1)>']
  ]) assertDiff(before, after);
});

test('large descriptions retain exact content using bounded-memory paragraph alignment', () => {
  const before = '原始信息甲。'.repeat(1000) + '\n共同段落\n' + '第一批次'.repeat(300);
  const after = '新增信息乙。'.repeat(1000) + '\n共同段落\n' + '第二批次'.repeat(300);
  const parts = assertDiff(before, after);
  assert.ok(parts.some(p => p.type === 'equal' && p.text.includes('共同段落')));
  assertDiff('甲\n'.repeat(1200), '乙\n'.repeat(1200));
});

test('diff reconstructs every deterministic randomized Chinese edit', () => {
  let seed = 41;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const alphabet = Array.from('设备AB019，。停机😀\n');
  for (let run = 0; run < 150; run++) {
    const before = Array.from({ length: random() % 35 }, () => alphabet[random() % alphabet.length]).join('');
    const after = Array.from({ length: random() % 35 }, () => alphabet[random() % alphabet.length]).join('');
    assertDiff(before, after);
  }
});

test('translation helpers: english headings stay a list, language detection, validation', () => {
  const h = require('../fabriq_ai_helpers.js');
  assert.equal(h.detectLanguage('换刀序号异常 SF'), 'zh');
  assert.equal(h.detectLanguage('Tool change sequence error'), 'en');
  const html = h.descriptionToHtml('What happened?\nScrap found\nWhat problem is expected to be solved?\nStable machining');
  assert.match(html, /^<ul><li><p>What happened\?<\/p><p>Scrap found<\/p><\/li><li>/);
  const messages = h.buildTranslateMessages({ title: '标题', description: '发生了什么？\n报废', tasks: ['确认夹具'] }, { target: 'en', direction: '更正式' });
  assert.match(messages[0].content, /What happened\?/);
  assert.match(messages[1].content, /1\. 确认夹具/);
  assert.match(messages[1].content, /更正式/);
  const ok = JSON.stringify({ title: 'Title', description: 'What happened?\nScrap', tasks: ['Check fixture'] });
  assert.deepEqual(h.parseTranslate(ok, { title: true, description: true, tasks: 1 }).tasks, ['Check fixture']);
  assert.throws(() => h.parseTranslate(ok, { tasks: 2 }), /数量不一致/);
  assert.throws(() => h.parseTranslate('{"comment":""}', { comment: true }), /不完整/);
});
test('task similarity flags reworded duplicates and ignores unrelated tasks; taskMeta is lenient', () => {
  const h = require('../fabriq_ai_helpers.js');
  assert.equal(h.taskSimilarity('确认夹具方案', '确认夹具方案。'), 1);
  assert.ok(h.taskSimilarity('验证夹具夹紧力', '验证夹具夹紧力是否足够') >= 0.8);
  assert.ok(h.taskSimilarity('更新客户邮件', '确认钳口夹紧干涉位置') < 0.3);
  assert.equal(h.findSimilarTask('复核夹具夹紧力', ['确认钳口夹紧，干涉的位置', '复核夹具夹紧力数据'])?.task, '复核夹具夹紧力数据');
  assert.equal(h.findSimilarTask('完全不同的事情', ['确认钳口夹紧']), null);
  const raw = JSON.stringify({ status: 'result', tasks: ['A任务', 'B任务'],
    taskMeta: [{ task: 'A任务', duplicateOf: '已有A', due: '2099-01-01', assignee: 'Kai' }, { task: 'B任务', due: 'bad' }, { nope: 1 }] });
  const parsed = h.parseResult(raw, { scope: { title: false, description: false, tasks: true, schedule: false } });
  assert.deepEqual(parsed.taskMeta, [{ task: 'A任务', due: parsed.taskMeta[0].due, assignee: null, duplicateOf: '已有A' },
    { task: 'B任务', due: null, assignee: null, duplicateOf: null }]);
});
test('schedule and suggested due dates are clamped to two weeks; new tasks never get suggested assignees', () => {
  const h = require('../fabriq_ai_helpers.js');
  const scope = { title: false, description: false, tasks: false, schedule: true };
  const parsed = h.parseResult(JSON.stringify({ status: 'result', schedule: [{ task: 'A', due: '2026-11-06' }, { task: 'B', due: '2026-12-30' }] }),
    { scope, today: '2026-11-05' });
  assert.deepEqual(parsed.schedule, [{ task: 'A', due: '2026-11-06' }, { task: 'B', due: '2026-11-19' }]);
  const tasks = h.parseResult(JSON.stringify({ status: 'result', tasks: ['X'], taskMeta: [{ task: 'X', due: '2027-01-01', assignee: 'Kai' }] }),
    { scope: { title: false, description: false, tasks: true, schedule: false }, today: '2026-11-05' });
  assert.deepEqual(tasks.taskMeta, [{ task: 'X', due: '2026-11-19', assignee: null, duplicateOf: null }]);
  const messages = h.buildMessages({ team: 'T', title: 't', description: '', tasks: [], undatedTasks: ['A'] }, { scope, today: '2026-11-05' });
  assert.match(messages[0].content, /ECN/);
  assert.match(messages[0].content, /1-2 个工作日/);
});
test('guard: masks credentials, repairs fenced / trailing-comma JSON, retries parse errors once and transient errors once', async () => {
  const g = require('../fabriq_ai_guard.js');
  const masked = g.sanitizeText('密码：abc123 token=xyz sk-abcdefghijklmnop1234 Bearer abcdefghijklmnop12345 批次K26J5044');
  assert.equal(masked.masked, 4);
  assert.ok(!/abc123|xyz|sk-abcdef|abcdefghijklmnop12345/.test(masked.text));
  assert.ok(masked.text.includes('批次K26J5044'));
  assert.deepEqual(JSON.parse(g.normalizeAiOutput('好的：\n```json\n{"a":[1,2,],}\n```')), { a: [1, 2] });
  const sys = { role: 'system', content: 'S' };
  const calls = [];
  const parse = raw => { const v = JSON.parse(raw); if (!v.ok) throw new Error('字段缺失'); return v; };
  const out = await g.generateGuarded({ messages: [sys, { role: 'user', content: 'u' }], parse,
    call: async conv => { calls.push(conv); return calls.length === 1 ? '{"nope":1}' : '{"ok":true}'; } });
  assert.equal(out.attempts, 2);
  assert.match(calls[1].at(-1).content, /字段缺失/);
  await assert.rejects(g.generateGuarded({ messages: [sys], parse, call: async () => '{"nope":1}' }), /字段缺失/);
  let n = 0;
  const transient = await g.generateGuarded({ messages: [sys], parse, call: async () => { if (++n === 1) throw new Error('AI 请求超时'); return '{"ok":1}'; } });
  assert.equal(transient.attempts, 2);
  let m = 0;
  await assert.rejects(g.generateGuarded({ messages: [sys], parse, call: async () => { m++; throw new Error('AI 接口返回 401（Token 无效或过期）'); } }), /401/);
  assert.equal(m, 1);
});