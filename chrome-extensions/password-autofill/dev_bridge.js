// MAIN world 调试入口：仅在开发者模式开启时 content.js 才会响应。
// CDP 用法: await window.__mwaDev.diagnose()
(function () {
  let seq = 0;
  function call(cmd, extra) {
    return new Promise(resolve => {
      const id = ++seq;
      const timer = setTimeout(() => resolve('timeout: 开发者模式未开启或扩展未加载'), 3000);
      function onMsg(e) {
        if (e.source !== window || !e.data || e.data.source !== 'mwa-dev-res' || e.data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(e.data.result);
      }
      window.addEventListener('message', onMsg);
      window.postMessage(Object.assign({ source: 'mwa-dev-req', id, cmd }, extra), '*');
    });
  }
  window.__mwaDev = {
    diagnose: () => call('diagnose'),
    start: () => call('start'),
    step: () => call('step'),
    click: kind => call('click', { kind }),
    log: () => call('log'),
    reloadExtension: () => call('reload')
  };
})();
