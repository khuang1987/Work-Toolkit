// AI 请求客户端：content script 与 background 之间的消息封装。
(() => {
  'use strict';
  function requestAi(action, data = {}) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ action, ...data }, res => {
          if (chrome.runtime.lastError) return reject(new Error('扩展已重载，请刷新页面'));
          if (!res || !res.ok) return reject(new Error((res && res.error) || '请求失败'));
          resolve(res.data);
        });
      } catch (e) {
        reject(new Error('扩展已重载，请刷新页面'));
      }
    });
  }

  globalThis.MwaFabriqAiClient = { requestAi };
})();
