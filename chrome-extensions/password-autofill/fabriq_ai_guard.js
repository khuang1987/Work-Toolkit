// AI 可靠性层：统一管理「输入清洗」和「输出校验 + 自动纠正重试」，业务代码只关心提示词和解析函数。
// 纯逻辑、无 DOM / chrome 依赖，可在 Node 中单元测试。
((root) => {
  const MAX_USER_CHARS = 12000;

  // 发给模型前，隐藏明显的凭据字样（密钥、Bearer 令牌、「密码：xxx」），避免随工单内容外发。
  const SECRET_PATTERNS = [
    [/\b(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, '[已隐藏密钥]'],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [已隐藏]'],
    [/((?:password|passwd|pwd|api[_-]?key|secret|token|密码|口令|密钥)\s*[:=：]\s*)\S+/gi, '$1[已隐藏]']
  ];

  function sanitizeText(text, maxChars = MAX_USER_CHARS) {
    let masked = 0;
    let out = String(text ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      out = out.replace(pattern, (...args) => {
        masked++;
        return replacement.replace(/\$(\d)/g, (_, index) => args[Number(index)] ?? '');
      });
    }
    let truncated = false;
    if (Array.from(out).length > maxChars) {
      out = Array.from(out).slice(0, maxChars).join('');
      truncated = true;
    }
    return { text: out, masked, truncated };
  }

  // 只清洗 user 消息；system 提示词是我们自己写的，不动。
  function sanitizeMessages(messages, maxChars = MAX_USER_CHARS) {
    let masked = 0;
    let truncated = false;
    const cleaned = messages.map(message => {
      if (message.role !== 'user') return message;
      const result = sanitizeText(message.content, maxChars);
      masked += result.masked;
      truncated = truncated || result.truncated;
      return { ...message, content: result.text };
    });
    return { messages: cleaned, masked, truncated };
  }

  // 容错提取 JSON：去掉代码围栏、前后多余文字、对象 / 数组里的尾随逗号。
  function normalizeAiOutput(raw) {
    let text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { JSON.parse(text); return text; } catch { /* 继续尝试修复 */ }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    const repaired = text.replace(/,\s*([}\]])/g, '$1');
    try { JSON.parse(repaired); return repaired; } catch { return String(raw ?? '').trim(); }
  }

  // 网络抖动 / 超时 / 5xx 可以重试；鉴权、权限、配置类错误不重试。
  const isTransient = error => /超时|timeout|timed out|network|网络|fetch|ECONN|\b5\d\d\b|temporar|rate|限流|繁忙|overload/i.test(String(error?.message || error))
    && !/\b40[1-3]\b|key|鉴权|权限|未授权|配置/i.test(String(error?.message || error));

  // 调用 → 清洗输出 → 解析；解析不合规时把错误反馈给模型自动纠正一次，瞬时错误也重试一次。
  async function generateGuarded({ call, parse, messages, retries = 1, onAttempt = () => {} }) {
    const sanitized = sanitizeMessages(messages);
    let conversation = sanitized.messages;
    let lastError = null;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      let raw;
      try {
        onAttempt({ attempt, kind: 'call', masked: sanitized.masked, truncated: sanitized.truncated });
        raw = await call(conversation, { attempt, masked: sanitized.masked, truncated: sanitized.truncated });
      } catch (error) {
        lastError = error;
        if (attempt <= retries && isTransient(error)) continue;
        throw error;
      }
      try {
        return { result: parse(normalizeAiOutput(raw)), raw, attempts: attempt, masked: sanitized.masked, truncated: sanitized.truncated };
      } catch (error) {
        lastError = error;
        if (attempt > retries) break;
        conversation = [...sanitized.messages,
          { role: 'assistant', content: String(raw).slice(0, 4000) },
          { role: 'user', content: `上一次输出不合规：${error.message}。请严格按要求只输出一个 JSON 对象，不要输出其他文字，并修正这个问题。` }];
      }
    }
    throw lastError;
  }

  const guard = { MAX_USER_CHARS, sanitizeText, sanitizeMessages, normalizeAiOutput, isTransient, generateGuarded };
  if (typeof module !== 'undefined' && module.exports) module.exports = guard;
  else root.MwaFabriqAiGuard = guard;
})(typeof globalThis !== 'undefined' ? globalThis : this);
