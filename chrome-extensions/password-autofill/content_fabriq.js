// Fabriq 页面：若站点把访问令牌存在 localStorage，则转交后台用于读取未读通知（网页版通常走 Cookie，无令牌也可工作）
(() => {
  let token = '';
  try {
    const raw = localStorage.getItem('future-tokens');
    if (raw && raw !== 'connected') {
      const parsed = JSON.parse(raw);
      token = (parsed && parsed.access && parsed.access.token) || '';
    }
  } catch (error) {
    token = '';
  }
  try {
    chrome.runtime.sendMessage({ action: 'fabriqToken', token });
  } catch (error) {
    // 扩展已重载
  }
})();
