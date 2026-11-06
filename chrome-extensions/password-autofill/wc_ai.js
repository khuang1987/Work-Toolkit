// Windchill AI 提示词与解析：纯逻辑，可在 Node 中单元测试。
// 两个用途：1) 判断哪个文件是签名文件（规则无法确定时兜底）；2) 根据最近检索样本建议规则库调整。
((root) => {
  'use strict';

  const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  function buildPickMessages(items, signedRules) {
    const system = [
      '你是 Windchill 文档管理助手。任务：对每份文档的文件列表，判断哪个是「已签名 / 已批准的最终版文件」。',
      '判断依据：文件名含签名、签字、会签、signed、approved、final 等字样；格式在允许范围内；可编辑源文件（docx / xlsx / dwg 等）通常不是签名文件；没有把握时返回 null，不要猜。',
      `允许的格式：${(signedRules.formats || []).join(' / ') || 'pdf'}。`,
      '只输出一个 JSON 对象：{"picks":[{"n":文档序号,"file":文件序号或null,"reason":"一句话理由"}]}。'
    ].join('\n');
    const user = JSON.stringify(items.map((item, index) => ({
      n: index,
      number: clip(item.number, 60),
      name: clip(item.title, 100),
      files: (item.files || []).slice(0, 12).map((file, fileIndex) => ({
        i: fileIndex, name: clip(file.fileName, 120), role: file.role, format: file.format
      }))
    })));
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  function parsePick(text, items) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('不是有效的 JSON'); }
    if (!data || !Array.isArray(data.picks)) throw new Error('缺少 picks 数组');
    const picks = new Map();
    for (const pick of data.picks) {
      const n = Number(pick && pick.n);
      if (!Number.isInteger(n) || n < 0 || n >= items.length) throw new Error(`文档序号 ${pick && pick.n} 超出范围`);
      if (pick.file === null || pick.file === undefined) continue;
      const file = Number(pick.file);
      if (!Number.isInteger(file) || file < 0 || file >= (items[n].files || []).length) throw new Error(`文档 ${n} 的文件序号 ${pick.file} 超出范围`);
      picks.set(n, { file, reason: clip(pick.reason, 80) });
    }
    return picks;
  }

  function buildSuggestMessages(samples, rules) {
    const system = [
      '你是 Windchill 文档分类规则顾问。用户把文档按编号前缀 / 名称关键词分为：图纸、工程文件、质量文件。',
      '规则：工程文件与质量文件按编号前缀（prefixes）或名称关键词（nameIncludes）识别，nameExcludes 用来排除误判；图纸为无业务前缀、主文件为指定格式（pdf 等）的文档。',
      '请根据样本数据，指出当前规则漏掉或误判的情况，并给出对规则的增补建议。只建议有样本依据的改动，不要凭空猜测。',
      '只输出一个 JSON 对象：{"engineering":{"prefixes":[],"nameIncludes":[],"nameExcludes":[]},"quality":{"prefixes":[],"nameIncludes":[],"nameExcludes":[]},"signedNamePatterns":[],"notes":"不超过 120 字的说明"}。',
      '数组里只放「需要新增」的项；没有建议就留空数组。前缀用大写字母数字，不超过 12 个字符。'
    ].join('\n');
    const user = JSON.stringify({
      currentRules: {
        engineering: { prefixes: rules.categories.engineering.prefixes, nameIncludes: rules.categories.engineering.nameIncludes },
        quality: { prefixes: rules.categories.quality.prefixes, nameIncludes: rules.categories.quality.nameIncludes },
        signedNamePatterns: rules.signed.namePatterns
      },
      samples: samples.slice(0, 60).map(sample => ({
        number: clip(sample.number, 60), name: clip(sample.title, 100), format: sample.format, category: sample.category,
        files: (sample.files || []).slice(0, 6).map(file => clip(file, 80))
      }))
    });
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  const list = (value, max, pattern) => (Array.isArray(value) ? value : [])
    .map(item => clip(item, max + 1)).filter(item => item && item.length <= max && (!pattern || pattern.test(item))).slice(0, 15);

  function parseSuggest(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('不是有效的 JSON'); }
    if (!data || typeof data !== 'object') throw new Error('不是 JSON 对象');
    const category = value => ({
      prefixes: list(value && value.prefixes, 12, /^[A-Za-z0-9_-]+$/).map(item => item.toUpperCase()),
      nameIncludes: list(value && value.nameIncludes, 40),
      nameExcludes: list(value && value.nameExcludes, 40)
    });
    return {
      engineering: category(data.engineering),
      quality: category(data.quality),
      signedNamePatterns: list(data.signedNamePatterns, 40),
      notes: clip(data.notes, 200)
    };
  }

  const api = { buildPickMessages, parsePick, buildSuggestMessages, parseSuggest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WcAi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
