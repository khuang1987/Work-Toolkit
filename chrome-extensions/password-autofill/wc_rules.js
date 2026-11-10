// Windchill 规则库与签名文件选择：纯逻辑、无 DOM / chrome 依赖，可在 Node 中单元测试。
// 规则库保存在 chrome.storage.local 的 windchillRules，由插件后台「Windchill 规则库」页面编辑；
// content script 读取后驱动检索分类、图纸筛选和「下载签名文件」。
((root) => {
  'use strict';

  const STORAGE_KEY = 'windchillRules';
  const FORMATS = ['pdf', 'dwg', 'word', 'excel', 'ppt', 'archive'];
  const FORMAT_EXT = { pdf: 'pdf', dwg: 'dwg', word: 'docx', excel: 'xlsx', ppt: 'pptx', archive: 'zip' };
  const PREFIX_CATEGORIES = ['quality', 'engineering'];
  const MAX_LIST = 30;

  const defaults = () => ({
    version: 1,
    categories: {
      drawing: { label: '图纸', formats: ['pdf'], excludeLeadingPrefix: true, requireNameKeyword: true },
      engineering: { label: '工程文件', prefixes: ['MG', 'PS'], nameIncludes: [], nameExcludes: [] },
      quality: { label: '质量文件', prefixes: ['PII'], nameIncludes: [], nameExcludes: [] }
    },
    // fallback：没有文件名命中签名关键词时的兜底——primary=主文件符合格式即可；any=任意符合格式的内容；none=只认文件名命中
    // (R) 是 Windchill 发布流程自动生成的已批准 PDF 命名（编号_版本(R).pdf）。
    signed: { formats: ['pdf'], namePatterns: ['(R)', '签名', '签字', '会签', 'signed'], fallback: 'primary' },
    download: { folder: 'Windchill', concurrency: 2, maxFiles: 100, verify: true, aiAssist: false },
    // 清单批量下载：types 是文档名称 / 编号的类型前缀（如 MG-、PS-、BOM-），includeSub 表示同时取 CFN 的下级编号（如 MG-6550006-02-…）。
    batch: { types: ['MG', 'PS', 'BOM'], includeSub: true, limit: 10 }
  });

  const uniq = list => [...new Set(list)];
  const strings = (value, { max = 40, upper = false, pattern } = {}) => uniq((Array.isArray(value) ? value : [])
    .map(item => String(item ?? '').trim())
    .map(item => (upper ? item.toUpperCase() : item))
    .filter(item => item && item.length <= max && (!pattern || pattern.test(item)))).slice(0, MAX_LIST);
  const formatList = value => uniq((Array.isArray(value) ? value : []).filter(item => FORMATS.includes(item)));
  const clampInt = (value, min, max, fallback) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  const safeSegment = (text, fallback) => {
    const cleaned = String(text ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
    return (cleaned || fallback || '').slice(0, 60);
  };

  // 任意输入 → 合法规则；非法 / 缺失字段回落到默认值，保证 content script 永远拿到完整结构。
  function normalize(raw) {
    const base = defaults();
    const input = raw && typeof raw === 'object' ? raw : {};
    const categories = input.categories || {};
    const prefixItem = /^[A-Za-z0-9_-]{1,12}$/;
    const out = defaults();
    for (const key of PREFIX_CATEGORIES) {
      const source = categories[key] || {};
      out.categories[key] = {
        label: base.categories[key].label,
        prefixes: Array.isArray(source.prefixes) ? strings(source.prefixes, { max: 12, upper: true, pattern: prefixItem }) : base.categories[key].prefixes,
        nameIncludes: strings(source.nameIncludes),
        nameExcludes: strings(source.nameExcludes)
      };
    }
    const drawing = categories.drawing || {};
    out.categories.drawing = {
      label: base.categories.drawing.label,
      formats: Array.isArray(drawing.formats) ? formatList(drawing.formats) : base.categories.drawing.formats,
      excludeLeadingPrefix: drawing.excludeLeadingPrefix === undefined ? true : !!drawing.excludeLeadingPrefix,
      requireNameKeyword: drawing.requireNameKeyword === undefined ? true : !!drawing.requireNameKeyword
    };
    const signed = input.signed || {};
    out.signed = {
      formats: Array.isArray(signed.formats) ? formatList(signed.formats) : base.signed.formats,
      namePatterns: Array.isArray(signed.namePatterns) ? strings(signed.namePatterns) : base.signed.namePatterns,
      fallback: ['primary', 'any', 'none'].includes(signed.fallback) ? signed.fallback : base.signed.fallback
    };
    const download = input.download || {};
    out.download = {
      folder: safeSegment(download.folder, base.download.folder),
      concurrency: clampInt(download.concurrency, 1, 4, base.download.concurrency),
      maxFiles: clampInt(download.maxFiles, 1, 200, base.download.maxFiles),
      verify: download.verify === undefined ? true : !!download.verify,
      aiAssist: !!download.aiAssist
    };
    const batch = input.batch || {};
    out.batch = {
      types: Array.isArray(batch.types) ? strings(batch.types, { max: 16, upper: true, pattern: /^[A-Za-z0-9_]{1,16}$/ }) : base.batch.types,
      includeSub: batch.includeSub === undefined ? true : !!batch.includeSub,
      limit: clampInt(batch.limit, 1, 5000, base.batch.limit)
    };
    return out;
  }

  // ───── 分类 ─────
  const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function allPrefixes(rules) {
    return uniq(PREFIX_CATEGORIES.flatMap(key => rules.categories[key].prefixes))
      .sort((a, b) => b.length - a.length);
  }
  // 供行级正则拼接使用；没有任何前缀时返回永不匹配的片段。
  function prefixAlternation(rules) {
    const prefixes = allPrefixes(rules);
    return prefixes.length ? prefixes.map(escapeRegex).join('|') : '(?!)';
  }
  function prefixOf(rules, value) {
    const match = String(value ?? '').replace(/\s+/g, ' ').trim()
      .match(new RegExp(`(?:^|[^A-Z0-9])(${prefixAlternation(rules)})(?=[A-Z0-9]|[-_ ]|$)`, 'i'));
    return match ? match[1].toUpperCase() : '';
  }
  function categoryOfPrefix(rules, prefix) {
    const upper = String(prefix || '').toUpperCase();
    return upper ? PREFIX_CATEGORIES.find(key => rules.categories[key].prefixes.includes(upper)) || '' : '';
  }
  const includesAny = (text, words) => {
    const lower = String(text ?? '').toLowerCase();
    return words.some(word => lower.includes(word.toLowerCase()));
  };
  // text：编号 / 名称 / 描述等拼接文本（用于前缀判断）；name：名称（用于关键词判断）。
  function classify(rules, { text = '', name = '' } = {}) {
    const subject = name || text;
    let category = categoryOfPrefix(rules, prefixOf(rules, text));
    if (!category) category = PREFIX_CATEGORIES.find(key => includesAny(subject, rules.categories[key].nameIncludes)) || '';
    if (category && includesAny(subject, rules.categories[category].nameExcludes)) return '';
    return category;
  }
  const hasLeadingPrefix = (rules, value) => rules.categories.drawing.excludeLeadingPrefix
    && /^[A-Z0-9]{1,12}[-_ ](?=[A-Z0-9])/i.test(String(value ?? '').replace(/\s+/g, ' ').trim());
  const drawingFormatOk = (rules, format) => rules.categories.drawing.formats.includes(format);
  const drawingAccepts = (rules, format, leading) => drawingFormatOk(rules, format) && !(rules.categories.drawing.excludeLeadingPrefix && leading);

  // 服务端 $filter 的前缀 / 名称关键词片段；两者都没有时返回空串。
  function odataCategoryFilter(rules, categories, escape) {
    const parts = [];
    for (const key of PREFIX_CATEGORIES) {
      if (!categories.includes(key)) continue;
      const { prefixes, nameIncludes } = rules.categories[key];
      prefixes.forEach(prefix => parts.push(`startswith(Number,'${escape(prefix)}')`));
      nameIncludes.forEach(word => parts.push(`contains(Name,'${escape(word)}')`));
    }
    return parts.join(' or ');
  }

  // ───── 内容（主文件 / 附件）提取与签名文件选择 ─────
  const URL_KEYS = ['ContentURL', 'ContentUrl', 'DownloadURL', 'DownloadUrl', 'URL', 'Url', 'Link', '@odata.mediaReadLink'];
  const pickText = (object, keys) => {
    for (const key of keys) {
      const value = object && object[key];
      if (value !== undefined && value !== null && typeof value !== 'object' && String(value).trim()) return String(value).trim();
    }
    return '';
  };
  function contentFrom(raw, role, formatOf) {
    if (!raw || typeof raw !== 'object') return null;
    const fileName = pickText(raw, ['FileName', 'Name', 'Title', 'name', 'title']);
    const mime = pickText(raw, ['MimeType', 'ContentType', 'Format', 'FormatName']);
    const id = pickText(raw, ['ID', 'id']);
    const urls = uniq(URL_KEYS.map(key => pickText(raw, [key])).filter(Boolean));
    if (!fileName && !id && !urls.length) return null;
    const content = {
      role, id, fileName, mime, urls,
      size: Number(raw.FileSize ?? raw.Size ?? raw.size) || 0,
      format: formatOf([fileName, mime, pickText(raw, ['FormatName', 'Format'])].filter(Boolean).join(' '))
    };
    // Windchill OData：下载地址在嵌套的 Content.URL 中（含 redirectDownload 参数）。
    const nested = raw.Content && typeof raw.Content === 'object' ? pickText(raw.Content, ['URL', 'Url']) : '';
    if (nested) content.urls = uniq([nested, ...content.urls]);
    return content;
  }
  // formatOf：把「文件名 + MIME」字符串转成 pdf / dwg / word… 的函数（由 content script 注入，避免重复一份格式识别）。
  function extractContents(item, formatOf) {
    const list = [];
    const asArray = value => (Array.isArray(value) ? value : value ? [value] : []);
    const primary = item && (item.PrimaryContent || item.primaryContent || item.PrimaryContentInfo || item.primaryContentInfo || item.Content || item.content);
    asArray(primary).forEach(raw => list.push(contentFrom(raw, 'primary', formatOf)));
    asArray(item && item.AllPrimaryContents).forEach(raw => list.push(contentFrom(raw, 'primary', formatOf)));
    asArray(item && (item.Attachments || item.attachments)).forEach(raw => list.push(contentFrom(raw, 'attachment', formatOf)));
    const seen = new Set();
    return list.filter(content => {
      if (!content) return false;
      const key = `${content.role}:${content.id || content.fileName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // 同一文档的附件里常同时挂着多个版本的已发布 PDF（如 MWI-040_D.2(R).pdf / _F.3(R).pdf），文件名带当前版本号的优先。
  const versionMatches = (record, content) => {
    const version = String(record.version || '').trim().toLowerCase();
    return version && String(content.fileName || '').toLowerCase().includes(version) ? 1 : 0;
  };

  // 为一条检索记录选出「签名文件」。返回 { status, pick, reason, confidence, candidates }：
  //  status：ok=已选出；none=有内容但没有符合规则的文件；nocontent=接口没有返回内容信息。
  function planSigned(rules, record) {
    const signed = rules.signed;
    let contents = Array.isArray(record.contents) ? record.contents : [];
    const allowed = content => signed.formats.includes(content.format);
    const patternIndex = content => signed.namePatterns.findIndex(pattern => includesAny(content.fileName, [pattern]));
    const candidates = contents.map(content => ({ role: content.role, fileName: content.fileName, format: content.format, size: content.size, named: patternIndex(content) >= 0 }));

    const named = contents.map(content => ({ content, index: patternIndex(content), version: versionMatches(record, content) }))
      .filter(entry => entry.index >= 0 && allowed(entry.content))
      .sort((a, b) => (b.version - a.version) || a.index - b.index || (a.content.role === 'primary' ? -1 : 1) - (b.content.role === 'primary' ? -1 : 1));
    if (named.length) {
      const best = named[0];
      const note = !record.version ? '' : best.version ? '，版本一致' : '，但文件名里没有当前版本号';
      return { status: 'ok', pick: best.content, confidence: best.version || !record.version ? 'high' : 'medium', candidates,
        reason: `文件名含“${signed.namePatterns[best.index]}”${note}${named.length > 1 ? `（另有 ${named.length - 1} 个同类文件）` : ''}` };
    }
    if (signed.fallback !== 'none') {
      const primary = contents.find(content => content.role === 'primary' && allowed(content));
      if (primary) return { status: 'ok', pick: primary, confidence: 'medium', candidates, reason: '主文件符合格式（文件名无签名标记）' };
      const anyContent = signed.fallback === 'any' && contents.find(allowed);
      if (anyContent) return { status: 'ok', pick: anyContent, confidence: 'low', candidates, reason: '附件中符合格式的文件' };
      // 接口没带内容信息，但检索记录的主文件格式已知符合规则：按主文件处理，下载时再验证。
      if (!contents.length && signed.formats.includes(record.format)) {
        const synthetic = { role: 'primary', id: '', fileName: '', mime: '', urls: [], size: 0, format: record.format };
        return { status: 'ok', pick: synthetic, confidence: 'low', candidates, reason: '接口未返回内容明细，按主文件尝试下载' };
      }
    }
    return { status: contents.length ? 'none' : 'nocontent', pick: null, confidence: 'none', candidates,
      reason: contents.length ? '没有符合签名规则的文件' : '接口未返回内容信息' };
  }

  // ───── 下载 ─────
  const safeName = (text, fallback = '') => safeSegment(text, fallback);
  function extOf(name) {
    const match = String(name || '').match(/\.([A-Za-z0-9]{1,5})$/);
    return match ? match[1].toLowerCase() : '';
  }
  function buildFilename(rules, record, content, batch, ext, opts = {}) {
    const number = safeName(record.number || record.title, 'document');
    const title = safeName(record.title, '');
    const stem = safeName(String(content.fileName || '').replace(/\.[A-Za-z0-9]{1,5}$/, ''), '');
    // 同一文档下载多个文件（如多个版本的签名 PDF）时用各自的文件名，避免重名。
    const base = opts.useFileName && stem
      ? (stem.toLowerCase().startsWith(number.toLowerCase()) ? stem : `${number}_${stem}`).slice(0, 140)
      : [number, title && title !== number ? title : '', record.version ? `V${safeName(record.version)}` : '']
        .filter(Boolean).join('_').slice(0, 120);
    const extension = ext || extOf(content.fileName) || FORMAT_EXT[content.format] || 'bin';
    return `${rules.download.folder}/${String(batch || '').split('/').map(part => safeName(part, 'batch')).filter(Boolean).join('/') || 'batch'}/${base}.${extension}`;
  }
  // 该文件是否符合签名文件规则（格式允许且文件名含签名关键词）。
  const fileIsSigned = (rules, content) => rules.signed.formats.includes(content.format)
    && rules.signed.namePatterns.some(pattern => includesAny(content.fileName, [pattern]));
  // 下载地址候选（按可信度排序，下载前逐个验证）：接口给出的地址 → 内容对象 ID 构造 → 主文件下载入口。
  function contentUrls(origin, record, content) {
    const urls = [];
    const same = value => {
      try { const url = new URL(value, origin); return url.origin === origin ? url.href : ''; } catch { return ''; }
    };
    (content.urls || []).map(same).filter(Boolean).forEach(url => urls.push(url));
    const holder = encodeURIComponent(record.oid || '');
    if (content.id && /^OR:/i.test(content.id) && record.oid) {
      urls.push(`${origin}/Windchill/servlet/WindchillAuthGW/wt.content.ContentHttp/viewContent/${encodeURIComponent(content.fileName || 'file')}?u8=1&HttpOperationItem=${encodeURIComponent(content.id)}&ContentHolder=${holder}`);
    }
    if (content.role === 'primary' && record.oid) {
      urls.push(`${origin}/Windchill/servlet/AttachmentsDownloadDirectionServlet/primary?oid=${holder}`);
    }
    return uniq(urls);
  }

  // ───── 清单批量下载 ─────
  const cleanCfn = value => String(value ?? '').trim().replace(/\.0+$/, '');
  // 服务端过滤：名称或编号以「类型-CFN」开头；客户端再用 matchBatch 精确判断边界（避免 PS-65500061 误中 PS-6550006）。
  function batchFilter(types, cfn, escape) {
    const parts = [];
    types.forEach(type => {
      const prefix = escape(`${type}-${cleanCfn(cfn)}`);
      parts.push(`startswith(Number,'${prefix}')`, `startswith(Name,'${prefix}')`);
    });
    return parts.join(' or ');
  }
  // 返回命中的类型（大写）；不命中返回空串。
  function matchBatch(record, types, cfn, includeSub) {
    const target = cleanCfn(cfn).toUpperCase();
    if (!target) return '';
    const fields = [record.number, record.title].map(text => String(text ?? '').trim().toUpperCase());
    for (const type of types) {
      const prefix = `${type.toUpperCase()}-${target}`;
      for (const field of fields) {
        if (!field.startsWith(prefix)) continue;
        const next = field.charAt(prefix.length);
        if (!next || /[_ (]/.test(next) || (includeSub && next === '-')) return type.toUpperCase();
      }
    }
    return '';
  }
  // 文件号清单：逗号 / 空格 / 换行 / 分号分隔。
  function parseNumberList(text) {
    const seen = new Set();
    return String(text ?? '').split(/[\s,，、;；]+/).map(item => item.trim())
      .filter(item => /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(item))
      .filter(item => { const key = item.toUpperCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  }

  const api = {
    STORAGE_KEY, FORMATS, FORMAT_EXT, defaults, normalize, allPrefixes, prefixAlternation, prefixOf, categoryOfPrefix, classify,
    hasLeadingPrefix, drawingFormatOk, drawingAccepts, odataCategoryFilter, extractContents, planSigned, safeName, extOf,
    buildFilename, contentUrls, fileIsSigned, batchFilter, matchBatch, parseNumberList, cleanCfn
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WcRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
