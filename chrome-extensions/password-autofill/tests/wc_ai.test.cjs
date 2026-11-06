const assert = require('node:assert/strict');
const test = require('node:test');
const A = require('../wc_ai.js');
const R = require('../wc_rules.js');

test('pick messages ask for JSON and expose indexed files only', () => {
  const items = [{ number: 'D1', title: '图纸', files: [{ fileName: 'a.docx', role: 'primary', format: 'word' }, { fileName: 'b.pdf', role: 'attachment', format: 'pdf' }] }];
  const messages = A.buildPickMessages(items, R.defaults().signed);
  assert.match(messages[0].content, /JSON/);
  const user = JSON.parse(messages[1].content);
  assert.deepEqual(user[0].files.map(file => file.i), [0, 1]);
});

test('parsePick validates indexes and skips null picks', () => {
  const items = [{ files: [{}, {}] }, { files: [{}] }];
  const picks = A.parsePick('{"picks":[{"n":0,"file":1,"reason":"带签名"},{"n":1,"file":null}]}', items);
  assert.equal(picks.size, 1);
  assert.equal(picks.get(0).file, 1);
  assert.throws(() => A.parsePick('{"picks":[{"n":5,"file":0}]}', items), /超出范围/);
  assert.throws(() => A.parsePick('{"picks":[{"n":1,"file":3}]}', items), /超出范围/);
  assert.throws(() => A.parsePick('nope', items), /JSON/);
});

test('parseSuggest sanitizes prefixes and limits lists', () => {
  const result = A.parseSuggest(JSON.stringify({
    engineering: { prefixes: ['mg2', 'bad prefix', 'x'.repeat(20)], nameIncludes: ['工艺'] },
    quality: {}, signedNamePatterns: ['批准'], notes: '说明'
  }));
  assert.deepEqual(result.engineering.prefixes, ['MG2']);
  assert.deepEqual(result.engineering.nameIncludes, ['工艺']);
  assert.deepEqual(result.quality.prefixes, []);
  assert.deepEqual(result.signedNamePatterns, ['批准']);
});

test('suggest messages carry current rules and capped samples', () => {
  const samples = Array.from({ length: 100 }, (_, index) => ({ number: `N${index}`, title: 't', format: 'pdf', category: 'other', files: ['f.pdf'] }));
  const user = JSON.parse(A.buildSuggestMessages(samples, R.defaults())[1].content);
  assert.equal(user.samples.length, 60);
  assert.deepEqual(user.currentRules.quality.prefixes, ['PII']);
});
