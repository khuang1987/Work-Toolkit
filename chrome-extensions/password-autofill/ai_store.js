// 后台存储层（service worker 通过 importScripts 加载）：
// 1) AI 对话记录：每次请求的提示词、返回、耗时、模型，供「插件后台」页面查看 / 下载，用于后续调优；
// 2) AI Key 加密存储：AES-GCM，密钥为不可导出的 CryptoKey，保存在 service worker 的 IndexedDB 中，
//    不会以明文落在 chrome.storage，也不会暴露给网页里的 content script。
(() => {
  'use strict';
  const LOG_KEY = 'mwaAiLog';
  const MAX_LOG_ENTRIES = 500;
  const MAX_FIELD_CHARS = 30000;

  // ───── 对话记录 ─────
  let chain = Promise.resolve();
  const trim = text => {
    const value = String(text ?? '');
    return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}\n…（已截断，原长 ${value.length} 字符）` : value;
  };

  function logAi(entry) {
    chain = chain.then(async () => {
      const { [LOG_KEY]: list = [] } = await chrome.storage.local.get(LOG_KEY);
      list.unshift({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        time: new Date().toISOString(),
        ...entry,
        messages: (entry.messages || []).map(m => ({ role: m.role, content: trim(m.content) })),
        response: entry.response === undefined ? undefined : trim(entry.response)
      });
      await chrome.storage.local.set({ [LOG_KEY]: list.slice(0, MAX_LOG_ENTRIES) });
      globalThis.MwaExport?.schedule();
    }).catch(() => {});
    return chain;
  }

  // ───── 密钥加密 ─────
  const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const unb64 = text => Uint8Array.from(atob(text), ch => ch.charCodeAt(0));

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('mwa-secrets', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  const dbRequest = (db, mode, fn) => new Promise((resolve, reject) => {
    const tx = db.transaction('keys', mode);
    const request = fn(tx.objectStore('keys'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
  });

  async function cryptoKey() {
    const db = await openDb();
    let key = await dbRequest(db, 'readonly', store => store.get('aes'));
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await dbRequest(db, 'readwrite', store => store.put(key, 'aes'));
    }
    db.close();
    return key;
  }

  async function encryptSecret(plain) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(), new TextEncoder().encode(plain));
    return { iv: b64(iv), data: b64(data) };
  }

  async function decryptSecret(box) {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, await cryptoKey(), unb64(box.data));
    return new TextDecoder().decode(plain);
  }

  // 读取配置（解密 Key）；发现旧版明文 Key 时自动迁移为加密存储。
  async function getConfig() {
    const { fabriqAi } = await chrome.storage.local.get('fabriqAi');
    if (!fabriqAi) return null;
    if (fabriqAi.key && !fabriqAi.keyEnc) {
      const { key, ...rest } = fabriqAi;
      const migrated = { ...rest, keyEnc: await encryptSecret(key) };
      await chrome.storage.local.set({ fabriqAi: migrated });
      return { ...rest, key };
    }
    const { keyEnc, ...rest } = fabriqAi;
    if (!keyEnc) return { ...rest, key: '' };
    try {
      return { ...rest, key: await decryptSecret(keyEnc) };
    } catch {
      return { ...rest, key: '' };
    }
  }

  // 保存配置：Key 为空表示沿用已保存的 Key。
  async function saveConfig(config) {
    const { fabriqAi: previous } = await chrome.storage.local.get('fabriqAi');
    const { key, ...rest } = config;
    const keyEnc = key ? await encryptSecret(key) : previous?.keyEnc;
    if (!keyEnc) throw new Error('请填写 API Key');
    await chrome.storage.local.set({ fabriqAi: { ...rest, keyEnc } });
  }

  // 返回给设置页的配置：不含 Key，只告诉是否已保存。
  async function getPublicConfig() {
    const config = await getConfig();
    if (!config) return null;
    const { key, ...rest } = config;
    return { ...rest, hasKey: !!key };
  }

  globalThis.MwaAiStore = { LOG_KEY, logAi, getConfig, saveConfig, getPublicConfig };
})();
