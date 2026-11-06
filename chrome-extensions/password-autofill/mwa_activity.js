// 统一操作记录（后台 service worker 通过 importScripts 加载）：各插件功能的关键操作都写到这里，
// 在插件后台「操作记录」按日期时间倒序显示。只记录动作摘要，不记录账号、密码、页面内容。
(() => {
  'use strict';
  const KEY = 'mwaActivityLog';
  const MAX = 500;
  const APPS = ['Windchill', 'Fabriq', 'EHR', 'Cornerstone', 'Workday', '插件'];
  let chain = Promise.resolve();
  const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

  function log({ app, title, detail = '', ok = true }) {
    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      time: new Date().toISOString(),
      app: APPS.includes(app) ? app : '插件',
      title: clip(title, 60),
      detail: clip(detail, 400),
      ok: ok !== false
    };
    chain = chain.then(async () => {
      const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
      list.unshift(entry);
      await chrome.storage.local.set({ [KEY]: list.slice(0, MAX) });
      globalThis.MwaExport?.schedule();
    }).catch(() => {});
    return chain;
  }

  globalThis.MwaActivity = { KEY, APPS, log };
})();
