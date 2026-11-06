// 操作记录与撤销：每次「应用」前保存工单快照（标题 / 描述 / 任务文字），应用后记录改了什么。
// 记录保存在 chrome.storage.local（只含工单文字，不含密钥），可在插件后台查看。
(() => {
  'use strict';
  const KEY = 'mwaOpLog';
  const MAX_ENTRIES = 100;

  let chain = Promise.resolve();
  const mutate = fn => (chain = chain.then(async () => {
    const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
    const next = await fn(list);
    if (next) await chrome.storage.local.set({ [KEY]: next.slice(0, MAX_ENTRIES) });
    return next;
  }).catch(() => null));

  const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  // 取页面当前状态作为快照（描述保存 HTML，撤销时可原样写回）。
  function snapshot(page, modal) {
    return {
      title: (page.getTitleEl(modal)?.innerText || '').trim(),
      descriptionHtml: page.getDescEl(modal)?.innerHTML || '',
      descriptionText: (page.getDescEl(modal)?.innerText || '').trim(),
      tasks: page.getTaskEls(modal).map(editor => editor.innerText.trim()).filter(Boolean)
    };
  }

  async function record(entry) {
    const full = { id: newId(), time: new Date().toISOString(), undone: false, ...entry };
    await mutate(list => [full, ...list]);
    return full;
  }

  async function latestFor(titles) {
    const { [KEY]: list = [] } = await chrome.storage.local.get(KEY);
    const wanted = new Set(titles.filter(Boolean));
    return list.find(item => !item.undone && item.reversible && (wanted.has(item.ticket) || wanted.has(item.afterTitle))) || null;
  }

  const markUndone = id => mutate(list => list.map(item => (item.id === id ? { ...item, undone: true, undoneAt: new Date().toISOString() } : item)));

  globalThis.MwaFabriqUndo = { KEY, snapshot, record, latestFor, markUndone };
})();
