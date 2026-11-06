const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const adapter = source.slice(source.indexOf('function fabriqAiProvider('),
  source.indexOf('chrome.runtime.onMessage.addListener('));
const companyBase = 'https://api.gpt.medtronic.com/providers/openai/v1';
const messages = [{ role: 'system', content: 'Return JSON' }, { role: 'user', content: 'Synthetic test' }];

function harness(fetch, config = {}) {
  const saved = { baseUrl: companyBase, key: 'synthetic-not-a-real-key', model: 'gpt-4.1', ...config };
  const logs = [];
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout, fetch,
    MwaAiStore: { getConfig: async () => ({ ...saved }), logAi: entry => logs.push(entry) },
    chrome: { storage: { local: { get: async () => ({ fabriqAi: saved }) } } }
  });
  context.logs = logs;
  vm.runInContext(adapter, context);
  return context;
}

test('legacy OpenAI config and reasoning models use chat completions without temperature', async () => {
  const context = harness(async (url, options) => {
    assert.equal(url, companyBase + '/chat/completions');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-5.4');
    assert.equal(body.stream, false);
    assert.equal(body.temperature, undefined);
    assert.deepEqual(body.messages, messages);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"description":"ok","tasks":[]}' } }] }) };
  });
  assert.equal(await context.fabriqAiGenerate(messages, { model: 'gpt-5.4' }), '{"description":"ok","tasks":[]}');
});

test('Claude selection uses company Anthropic route and native message format', async () => {
  const context = harness(async (url, options) => {
    assert.equal(url, 'https://api.gpt.medtronic.com/providers/anthropic/v1/messages');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(options.body);
    assert.equal(body.system, 'Return JSON');
    assert.deepEqual(body.messages, [messages[1]]);
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.response_format, undefined);
    return { ok: true, json: async () => ({ content: [
      { type: 'thinking', thinking: 'not output' },
      { type: 'text', text: '{"description":"ok","tasks":[]}' }
    ] }) };
  });
  assert.equal(await context.fabriqAiGenerate(messages,
    { provider: 'anthropic', model: 'anthropic.claude-opus-5-5' }), '{"description":"ok","tasks":[]}');
});

test('third-party endpoints cannot be silently switched to another provider', () => {
  const context = harness(() => {});
  assert.throws(() => context.fabriqAiProvider({
    baseUrl: 'https://example.test/v1', provider: 'openai'
  }, 'anthropic'), /请先/);
});

test('Luna selection routes to OpenAI while the saved default remains Claude', async () => {
  const context = harness(async (url, options) => {
    assert.equal(url, companyBase + '/chat/completions');
    assert.equal(JSON.parse(options.body).model, 'gpt-5.6-luna');
    assert.equal(options.headers['anthropic-version'], undefined);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"description":"ok","tasks":[]}' } }] }) };
  }, {
    provider: 'anthropic', model: 'anthropic.claude-opus-5-5',
    baseUrl: 'https://api.gpt.medtronic.com/providers/anthropic/v1'
  });
  assert.equal(await context.fabriqAiGenerate(messages,
    { provider: 'openai', model: 'gpt-5.6-luna' }), '{"description":"ok","tasks":[]}');
  assert.equal((await context.chrome.storage.local.get('fabriqAi')).fabriqAi.model, 'anthropic.claude-opus-5-5');
});

test('invalid URLs and malformed messages fail before any request', async () => {
  const context = harness(() => assert.fail('Unexpected network request'));
  for (const baseUrl of ['http://example.test', 'https://user:pass@example.test', 'https://example.test?q=1']) {
    assert.throws(() => context.fabriqAiProvider({ baseUrl }), /HTTPS/);
  }
  await assert.rejects(context.fabriqAiGenerate([{ role: 'tool', content: 'invalid' }]), /消息格式无效/);
});

test('model discovery follows Anthropic pagination and removes non-text models', async () => {
  const urls = [];
  const context = harness(async url => {
    urls.push(url);
    return { ok: true, json: async () => urls.length === 1 ? {
      data: [{ id: 'anthropic.claude-opus-5-5', display_name: 'Claude Opus 5.5' }],
      has_more: true, last_id: 'cursor/one'
    } : { data: [{ id: 'text-embedding-3-small' }, { id: 'anthropic.claude-sonnet-4-6' }] } };
  });
  const result = await context.fabriqAiModels({
    baseUrl: 'https://api.gpt.medtronic.com/providers/anthropic/v1', provider: 'anthropic', key: 'fake'
  });
  assert.equal(urls[1].endsWith('?after_id=cursor%2Fone'), true);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Claude Opus 5.5');
});

test('missing or repeated model cursors fail instead of looping', async () => {
  const context = harness(async () => ({
    ok: true, json: async () => ({ data: [], has_more: true, last_id: 'repeated' })
  }));
  await assert.rejects(context.fabriqAiModels({ baseUrl: companyBase, key: 'fake' }), /分页游标无效/);
});

test('one inaccessible provider is explicitly reported without hiding usable models', async () => {
  const context = harness(async url => url.includes('/anthropic/')
    ? { ok: false, status: 403 }
    : { ok: true, json: async () => ({ data: [{ id: 'gpt-4.1' }] }) });
  const options = await context.fabriqAiOptions();
  assert.equal(options.models.length, 1);
  assert.match(options.warnings[0], /anthropic.*403.*权限不足/);
  assert.equal(JSON.stringify(options).includes('synthetic-not-a-real-key'), false);
});

test('HTTP errors, truncated output, empty content and request timeouts remain explicit', async () => {
  for (const status of [401, 403, 429]) {
    const context = harness(async () => ({ ok: false, status }));
    await assert.rejects(context.fabriqAiGenerate(messages), new RegExp(String(status)));
  }
  for (const json of [{ choices: [{ finish_reason: 'length' }] }, { choices: [] }]) {
    const context = harness(async () => ({ ok: true, json: async () => json }));
    await assert.rejects(context.fabriqAiGenerate(messages), /截断|未返回文本/);
  }
  const context = harness(async (_url, options) => {
    await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  context.setTimeout = callback => setTimeout(callback, 1);
  await assert.rejects(context.fabriqAiGenerate(messages), /请求超时/);
});

test('every generation is logged with purpose and never contains the API key', async () => {
  const context = harness(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":1}' } }], usage: { total_tokens: 9 } }) }));
  await context.fabriqAiGenerate(messages, {}, { purpose: 'progress', ticket: 'T-1', attempt: 2, masked: 1 });
  await assert.rejects(context.fabriqAiGenerate([{ role: 'tool', content: 'x' }], {}, { purpose: 'bad' }));
  assert.equal(context.logs.length, 2);
  assert.equal(context.logs.find(entry => entry.purpose === 'bad').ok, false);
  const ok = context.logs.find(entry => entry.purpose === 'progress');
  assert.equal(ok.ok, true);
  assert.equal(ok.attempt, 2);
  assert.equal(ok.ticket, 'T-1');
  assert.equal(ok.response, '{"ok":1}');
  assert.ok(!JSON.stringify(context.logs).includes('synthetic-not-a-real-key'));
});