// 轻量 xlsx / csv 读取：只取单元格文本，不依赖第三方库。浏览器和 Node 18+ 都用 DecompressionStream 解压。
// 返回 { sheets: [{ name, rows: string[][] }] }；公式单元格取缓存值。
((root) => {
  'use strict';

  const decoder = new TextDecoder('utf-8');

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // 读取 zip 中央目录，返回 { 文件名: () => Promise<Uint8Array> }
  function openZip(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 xlsx 文件');
    const count = view.getUint16(eocd + 10, true);
    let pos = view.getUint32(eocd + 16, true);
    const files = {};
    for (let n = 0; n < count; n += 1) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;
      const method = view.getUint16(pos + 10, true);
      const compressed = view.getUint32(pos + 20, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const local = view.getUint32(pos + 42, true);
      const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
      files[name] = async () => {
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + compressed);
        if (method === 0) return data;
        if (method === 8) return inflateRaw(data);
        throw new Error(`不支持的压缩方式 ${method}`);
      };
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  const unescapeXml = text => text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (all, code) => {
    const lower = code.toLowerCase();
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    return String.fromCodePoint(lower[1] === 'x' ? parseInt(lower.slice(2), 16) : Number(lower.slice(1)));
  });
  const textOf = xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => unescapeXml(match[1])).join('');
  const columnIndex = ref => [...ref.replace(/\d+/g, '')].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;

  function parseSheet(xml, shared) {
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const row = [];
      for (const cell of (rowMatch[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1];
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
        if (!ref) continue;
        const type = (/\bt="(\w+)"/.exec(attrs) || [])[1] || '';
        const body = cell[2] || '';
        let value = '';
        if (type === 'inlineStr') value = textOf(body);
        else {
          const raw = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
          if (raw !== undefined) value = type === 's' ? shared[Number(raw)] ?? '' : unescapeXml(raw);
        }
        row[columnIndex(ref[1])] = value;
      }
      rows.push(Array.from(row, cell => cell ?? ''));
    }
    return rows;
  }

  async function readXlsx(buffer) {
    const zip = openZip(buffer);
    const read = async name => (zip[name] ? decoder.decode(await zip[name]()) : '');
    const shared = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => textOf(match[1]));
    const workbook = await read('xl/workbook.xml');
    const rels = await read('xl/_rels/workbook.xml.rels');
    const targets = {};
    for (const match of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      const id = /\bId="([^"]+)"/.exec(match[1]);
      const target = /\bTarget="([^"]+)"/.exec(match[1]);
      if (id && target) targets[id[1]] = target[1].replace(/^\/?(?:xl\/)?/, 'xl/');
    }
    const sheets = [];
    for (const match of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
      const name = /\bname="([^"]*)"/.exec(match[1]);
      const rid = /\br:id="([^"]+)"/.exec(match[1]);
      const path = rid && targets[rid[1]];
      if (!name || !path) continue;
      sheets.push({ name: unescapeXml(name[1]), rows: parseSheet(await read(path), shared) });
    }
    return { sheets };
  }

  // CSV / TXT：逗号、制表符或分号分隔，支持引号。
  function readCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const delimiter = /\t/.test(text.split('\n', 1)[0]) ? '\t' : /;/.test(text.split('\n', 1)[0]) && !/,/.test(text.split('\n', 1)[0]) ? ';' : ',';
    const source = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (quoted) {
        if (char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; } else if (char === '"') quoted = false; else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === delimiter) { row.push(cell); cell = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && source[i + 1] === '\n') i += 1;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else cell += char;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return { sheets: [{ name: 'CSV', rows: rows.filter(items => items.some(item => String(item).trim())) }] };
  }

  // 按文件扩展名读取；.xls（旧格式）不支持。
  async function readTable(name, buffer) {
    if (/\.xlsx$/i.test(name) || /\.xlsm$/i.test(name)) return readXlsx(buffer);
    if (/\.xls$/i.test(name)) throw new Error('不支持旧版 .xls，请另存为 .xlsx 或 .csv');
    return readCsv(decoder.decode(buffer));
  }

  // 在表头里找最像「编号」的列：优先 CFN，其次 文件号 / 编号 / Number。
  function guessColumn(rows) {
    const header = rows[0] || [];
    const order = [/^cfn$/i, /cfn/i, /文件号|文档号|文件编号/, /编号|number|^no\.?$/i];
    for (const pattern of order) {
      const index = header.findIndex(cell => pattern.test(String(cell).trim()));
      if (index >= 0) return index;
    }
    return 0;
  }

  const api = { readXlsx, readCsv, readTable, guessColumn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WcTable = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
