const assert = require('node:assert/strict');
const test = require('node:test');
const R = require('../wc_rules.js');

const formatOf = source => (/pdf/i.test(source) ? 'pdf' : /docx?\b|word/i.test(source) ? 'word' : /xlsx?\b|excel/i.test(source) ? 'excel' : 'other');

test('defaults reproduce the built-in PII / MG / PS classification', () => {
  const rules = R.defaults();
  assert.equal(R.classify(rules, { text: 'PII-1234 检验规程' }), 'quality');
  assert.equal(R.classify(rules, { text: 'MG-001 工艺' }), 'engineering');
  assert.equal(R.classify(rules, { text: 'PS_9 作业指导' }), 'engineering');
  assert.equal(R.classify(rules, { text: '12345 装配图' }), '');
  assert.equal(R.prefixOf(rules, 'xx PII-7'), 'PII');
});

test('normalize repairs invalid input and clamps numbers', () => {
  const rules = R.normalize({
    categories: { quality: { prefixes: ['pii', 'bad prefix!', 'qa-'], nameIncludes: ['  检验  ', ''] }, drawing: { formats: ['pdf', 'exe'] } },
    signed: { formats: 'pdf', fallback: 'weird' },
    download: { folder: '..\\a/b:c', concurrency: 99, maxFiles: -3 }
  });
  assert.deepEqual(rules.categories.quality.prefixes, ['PII', 'QA-']);
  assert.deepEqual(rules.categories.quality.nameIncludes, ['检验']);
  assert.deepEqual(rules.categories.drawing.formats, ['pdf']);
  assert.deepEqual(rules.signed.formats, ['pdf']);
  assert.equal(rules.signed.fallback, 'primary');
  assert.equal(rules.download.concurrency, 4);
  assert.equal(rules.download.maxFiles, 1);
  assert.ok(!/[\\/:]/.test(rules.download.folder));
  assert.deepEqual(R.normalize(null), R.defaults());
});

test('custom prefixes, name keywords and excludes drive classification', () => {
  const rules = R.normalize({ categories: {
    quality: { prefixes: ['QA'], nameIncludes: ['检验'], nameExcludes: ['草稿'] },
    engineering: { prefixes: [] }
  } });
  assert.equal(R.classify(rules, { text: 'PII-1 x' }), '');
  assert.equal(R.classify(rules, { text: 'QA-9' }), 'quality');
  assert.equal(R.classify(rules, { text: '10086 进料检验规程', name: '进料检验规程' }), 'quality');
  assert.equal(R.classify(rules, { text: 'QA-9 草稿', name: 'QA-9 草稿' }), '');
  assert.equal(R.prefixAlternation(R.normalize({ categories: { quality: { prefixes: [] }, engineering: { prefixes: [] } } })), '(?!)');
});

test('odata filter combines prefixes and name keywords', () => {
  const rules = R.normalize({ categories: { quality: { prefixes: ['PII'], nameIncludes: ["o'k"] } } });
  const escape = value => value.replace(/'/g, "''");
  assert.equal(R.odataCategoryFilter(rules, ['quality'], escape), "startswith(Number,'PII') or contains(Name,'o''k')");
  assert.equal(R.odataCategoryFilter(rules, [], escape), '');
});

test('drawing rule honours formats and leading prefix switch', () => {
  const rules = R.normalize({ categories: { drawing: { formats: ['pdf', 'word'], excludeLeadingPrefix: false } } });
  assert.ok(R.drawingAccepts(rules, 'word', true));
  assert.ok(!R.drawingAccepts(rules, 'excel', false));
  assert.ok(!R.hasLeadingPrefix(rules, 'AB-123'));
  assert.ok(R.hasLeadingPrefix(R.defaults(), 'AB-123'));
});

test('extractContents merges primary, all-primary and attachments without duplicates', () => {
  const contents = R.extractContents({
    PrimaryContent: { ID: 'OR:wt.content.ApplicationData:1', FileName: '图纸.docx', FileSize: 10, ContentURL: '/x/1' },
    Attachments: [{ ID: 'OR:wt.content.ApplicationData:2', FileName: '图纸-签名版.pdf', MimeType: 'application/pdf' }, { ID: 'OR:wt.content.ApplicationData:2', FileName: '图纸-签名版.pdf' }]
  }, formatOf);
  assert.equal(contents.length, 2);
  assert.deepEqual(contents.map(c => [c.role, c.format]), [['primary', 'word'], ['attachment', 'pdf']]);
  assert.deepEqual(contents[0].urls, ['/x/1']);
});

test('planSigned prefers a signed-named PDF over the primary file', () => {
  const rules = R.defaults();
  const record = { number: 'D1', format: 'word', contents: R.extractContents({
    PrimaryContent: { FileName: 'D1.pdf' },
    Attachments: [{ FileName: 'D1_signed.pdf' }, { FileName: 'D1.docx' }]
  }, formatOf) };
  const plan = R.planSigned(rules, record);
  assert.equal(plan.status, 'ok');
  assert.equal(plan.pick.fileName, 'D1_signed.pdf');
  assert.equal(plan.confidence, 'high');
});

test('planSigned fallback modes', () => {
  const record = { number: 'D2', format: 'pdf', contents: R.extractContents({ PrimaryContent: { FileName: 'D2.pdf' } }, formatOf) };
  assert.equal(R.planSigned(R.defaults(), record).confidence, 'medium');
  const strict = R.normalize({ signed: { fallback: 'none' } });
  assert.equal(R.planSigned(strict, record).status, 'none');
  const wordOnly = { number: 'D3', format: 'word', contents: R.extractContents({ PrimaryContent: { FileName: 'D3.docx' } }, formatOf) };
  assert.equal(R.planSigned(R.defaults(), wordOnly).status, 'none');
  const attachmentOnly = { number: 'D4', format: 'word', contents: R.extractContents({ PrimaryContent: { FileName: 'D4.docx' }, Attachments: [{ FileName: 'D4.pdf' }] }, formatOf) };
  assert.equal(R.planSigned(R.normalize({ signed: { fallback: 'any' } }), attachmentOnly).pick.fileName, 'D4.pdf');
  const unknown = { number: 'D5', format: 'pdf', contents: [] };
  assert.equal(R.planSigned(R.defaults(), unknown).status, 'ok');
  assert.equal(R.planSigned(R.defaults(), { number: 'D6', format: 'word', contents: [] }).status, 'nocontent');
});

test('real Windchill shape: nested Content.URL and version-matched (R).pdf attachment', () => {
  const item = {
    ID: 'OR:wt.doc.WTDocument:1', Number: 'MWI-040', Version: 'F.3',
    PrimaryContent: { ID: 'OR:wt.content.ApplicationData:1', FileName: 'MWI-040标签.docx', MimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Content: { URL: 'https://h.example/dl/p' } },
    Attachments: ['D.2', 'E.4', 'F.3'].map((v, i) => ({ ID: `OR:wt.content.ApplicationData:${i + 2}`, FileName: `MWI-040_${v}(R).pdf`, Content: { URL: `https://h.example/dl/${v}` } }))
  };
  const record = { number: 'MWI-040', version: 'F.3', oid: item.ID, format: 'word', contents: R.extractContents(item, formatOf) };
  const plan = R.planSigned(R.defaults(), record);
  assert.equal(plan.pick.fileName, 'MWI-040_F.3(R).pdf');
  assert.equal(plan.confidence, 'high');
  assert.deepEqual(plan.pick.urls, ['https://h.example/dl/F.3']);
});

test('multi-version: fileIsSigned picks every (R).pdf and filenames stay distinct', () => {
  const rules = R.defaults();
  const files = ['MWI-040_D.2(R).pdf', 'MWI-040_F.3(R).pdf', 'MWI-040.docx'].map(fileName => ({ fileName, format: formatOf(fileName) }));
  assert.deepEqual(files.map(file => R.fileIsSigned(rules, file)), [true, true, false]);
  const record = { number: 'MWI-040', title: '标签', version: 'F.3' };
  const names = files.slice(0, 2).map(file => R.buildFilename(rules, record, file, 'b', undefined, { useFileName: true }));
  assert.deepEqual(names, ['Windchill/b/MWI-040_D.2(R).pdf', 'Windchill/b/MWI-040_F.3(R).pdf']);
  assert.equal(R.buildFilename(rules, record, files[1], 'b'), 'Windchill/b/MWI-040_标签_VF.3.pdf');
});

test('filenames are sanitized and urls stay same-origin', () => {
  const rules = R.defaults();
  const record = { number: 'MG/001', title: 'a:b*c', version: 'A.1', oid: 'OR:wt.doc.WTDocument:9' };
  const name = R.buildFilename(rules, record, { fileName: 'x.PDF', format: 'pdf' }, '20260101_关键词');
  assert.equal(name, 'Windchill/20260101_关键词/MG_001_a_b_c_VA.1.pdf');
  const urls = R.contentUrls('https://h.example', record, {
    role: 'primary', id: 'OR:wt.content.ApplicationData:5', fileName: 'x.pdf', urls: ['/dl/1', 'https://evil.example/x']
  });
  assert.ok(urls.every(url => url.startsWith('https://h.example/')));
  assert.equal(urls[0], 'https://h.example/dl/1');
  assert.ok(urls.some(url => url.includes('AttachmentsDownloadDirectionServlet/primary')));
});
