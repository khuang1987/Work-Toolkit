const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../wc_xlsx.js');
const R = require('../wc_rules.js');

(async () => {
  const file = path.join(__dirname, '../../../Rawdata/List of all products exported for 2 years 20261103.xlsx');
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    const { sheets } = await T.readXlsx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const first = sheets[0];
    assert.strictEqual(first.name, 'OLO Products');
    assert.strictEqual(first.rows[0][1], 'CFN');
    assert.strictEqual(T.guessColumn(first.rows), 1);
    assert.strictEqual(first.rows[1][1], '75454010-03');
    assert.ok(first.rows.length > 1000);
    assert.ok(sheets.length >= 2);
    console.log('xlsx ok', sheets.map(s => `${s.name}:${s.rows.length}`).join(' '));
  }
  assert.deepStrictEqual(T.readCsv('a,b\n"x,1",2\n').sheets[0].rows, [['a', 'b'], ['x,1', '2']]);

  const rules = R.normalize({});
  assert.deepStrictEqual(rules.batch.types, ['MG', 'PS', 'BOM']);
  assert.strictEqual(R.normalize({ batch: { types: ['dmf1', 'bad type!'], limit: 99999 } }).batch.limit, 5000);
  assert.deepStrictEqual(R.normalize({ batch: { types: ['dmf1', 'bad type!'] } }).batch.types, ['DMF1']);
  const esc = s => s.replace(/'/g, "''");
  assert.strictEqual(R.batchFilter(['MG', 'PS'], '6550006', esc),
    "startswith(Number,'MG-6550006') or startswith(Name,'MG-6550006') or startswith(Number,'PS-6550006') or startswith(Name,'PS-6550006')");
  const rec = (number, title) => ({ number, title });
  assert.strictEqual(R.matchBatch(rec('DMR-00005392', 'PS-6550006'), ['MG', 'PS', 'BOM'], '6550006', true), 'PS');
  assert.strictEqual(R.matchBatch(rec('BOM-6550006-02', 'x'), ['BOM'], '6550006', true), 'BOM');
  assert.strictEqual(R.matchBatch(rec('BOM-6550006-02', 'x'), ['BOM'], '6550006', false), '');
  assert.strictEqual(R.matchBatch(rec('PS-65500061', 'x'), ['PS'], '6550006', true), '');
  assert.strictEqual(R.matchBatch(rec('x', 'MG-6550006-02-07-10-L20E'), ['MG'], '6550006', true), 'MG');
  assert.strictEqual(R.matchBatch(rec('MPS-6550006', 'x'), ['PS'], '6550006', true), '');
  assert.strictEqual(R.matchBatch(rec('PS-6550006', ''), ['PS'], 6550006, true), 'PS');
  assert.deepStrictEqual(R.parseNumberList('WI-155, WI-128\nwi-155；??'), ['WI-155', 'WI-128']);
  assert.ok(R.buildFilename(rules, { number: 'PS-1', title: 'a', version: 'A.1' }, { fileName: 'x.pdf', format: 'pdf' }, '20261110/6550006', 'pdf')
    .startsWith('Windchill/20261110/6550006/'));
  console.log('batch ok');
})().catch(e => { console.error(e); process.exit(1); });
