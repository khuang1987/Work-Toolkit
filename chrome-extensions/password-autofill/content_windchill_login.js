// Windchill 自动填充与登录保护。
(function () {
  'use strict';

  if (location.hostname !== 'khplm.medtronic.com.cn') return;

  const MAX_LOGIN_ATTEMPTS = 10;
  const RETRY_INTERVAL = 1500;
  let loginAttempts = 0;
  let stopped = false;
  let watcher = null;

  function extensionAvailable() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  function storageGet(keys, callback) {
    if (!extensionAvailable()) return;
    try { chrome.storage.local.get(keys, callback); } catch (error) {}
  }

  function storageSet(value, callback) {
    if (!extensionAvailable()) return;
    try { chrome.storage.local.set(value, callback); } catch (error) {}
  }

  const usernameSelectors = [
    'input[name*="signatureEngine_username"]',
    'input[type="text"][name*="signatureEngine_username"]',
    'input[name*="___signatureEngine_username___textbox"]',
    '//input[contains(@name, "signatureEngine_username")]',
    '//input[contains(@name, "___signatureEngine_username___textbox")]',
    'input[name="j_username"]',
    '#j_username',
    'input[name="username"]',
    'input[id="username"]'
  ];
  const passwordSelectors = [
    'input[name*="signatureEngine_password"]',
    'input[type="password"][name*="signatureEngine_password"]',
    'input[name*="___signatureEngine_password___textbox"]',
    '//input[contains(@name, "signatureEngine_password")]',
    '//input[contains(@name, "___signatureEngine_password___textbox")]',
    'input[name="j_password"]',
    '#j_password',
    'input[name="password"]',
    'input[id="password"]'
  ];

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.ownerDocument.defaultView.getComputedStyle(el).visibility !== 'hidden';
  }

  function findInDocument(doc, selectors) {
    for (const selector of selectors) {
      try {
        if (selector.startsWith('//')) {
          const result = doc.evaluate(selector, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          if (result.singleNodeValue && isVisible(result.singleNodeValue)) return result.singleNodeValue;
        } else {
          const element = Array.from(doc.querySelectorAll(selector)).find(isVisible);
          if (element) return element;
        }
      } catch (error) {}
    }
    return null;
  }

  function findInPageAndFrames(selectors) {
    const element = findInDocument(document, selectors);
    if (element) return element;
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        const frameDocument = iframe.contentDocument || iframe.contentWindow.document;
        const frameElement = findInDocument(frameDocument, selectors);
        if (frameElement) return frameElement;
      } catch (error) {}
    }
    return null;
  }

  function dispatchCredentialEvents(input) {
    ['input', 'change', 'blur', 'focus'].forEach((type) => {
      input.dispatchEvent(new Event(type, { bubbles: true }));
    });
  }

  function showToast(message, type = 'info') {
    const existing = document.getElementById('windchill-autofill-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'windchill-autofill-toast';
    toast.textContent = message;
    toast.style.cssText = [
      'position:fixed', 'top:20px', 'right:20px', 'z-index:2147483647',
      'max-width:360px', 'padding:12px 16px', 'border-radius:10px',
      'box-shadow:0 8px 24px #0004', 'font:14px system-ui,sans-serif',
      'color:#fff', `background:${type === 'error' ? '#b42318' : '#0c719f'}`
    ].join(';');
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  function loginFormPresent() {
    return Boolean(findInPageAndFrames(usernameSelectors) || findInPageAndFrames(passwordSelectors));
  }

  const CONFIRM_TEXT = /^(完成任务|ok|确定|确认|登录|登入|提交|签名|完成|sign|sign in|log in|login|submit|confirm)$/i;
  const CONFIRM_ID = /(^|[_\-.])(ok|submit|sign|login|confirm)([_\-.]|$)/i;
  let filled = false;
  let filling = false;
  const FILL_SETTLE_MS = 1500;

  const TASK_BUTTON_TEXT = /^(完成任务|complete task)$/i;

  // 优先点击任务页的“完成任务 / Complete Task”按钮（界面语言不同文字不同），其次才是对话框里的通用确认按钮
  function clickConfirm(anchor, dryRun) {
    if (stopped || !anchor || !anchor.isConnected) return false;
    const doc = anchor.ownerDocument;
    const scope = anchor.closest('[role="dialog"], .x-window, .ui-dialog, .modal, .dialog') || null;
    const textOf = (el) => (el.value || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    const usable = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    };
    const all = (root) => Array.from(root.querySelectorAll('button, input[type="submit"], input[type="button"], a, span[class*="btn"], div[role="button"]')).filter(usable);
    const rank = (el) => (el.tagName === 'BUTTON' || el.type === 'button' || el.type === 'submit' ? 0 : 1);
    let target = all(doc).filter((el) => TASK_BUTTON_TEXT.test(textOf(el))).sort((a, b) => rank(a) - rank(b))[0];
    if (!target && scope) {
      target = all(scope).find((el) => CONFIRM_TEXT.test(textOf(el)) || el.type === 'submit' || CONFIRM_ID.test(`${el.id || ''} ${el.name || ''}`));
    }
    if (!target) return false;
    if (dryRun) {
      showToast(`[dry-run] 将点击：${textOf(target)} (${target.tagName}#${target.id})`);
    } else {
      target.click();
    }
    return true;
  }

  function fillOnce() {
    if (stopped || filled || filling || !extensionAvailable()) return;
    let usernameInput = findInPageAndFrames(usernameSelectors);
    let passwordInput = findInPageAndFrames(passwordSelectors);
    if (!usernameInput && !passwordInput) return;
    filling = true;
    storageGet(['windchillUsername', 'windchillPassword', 'Login1', 'Password1', 'windchillAutoFillEnabled'], (stored) => {
      const own = stored.windchillUsername && stored.windchillPassword;
      const result = {
        windchillAutoFillEnabled: stored.windchillAutoFillEnabled,
        windchillUsername: own ? stored.windchillUsername : stored.Login1,
        windchillPassword: own ? stored.windchillPassword : stored.Password1
      };
      if (stopped || result.windchillAutoFillEnabled === false || !result.windchillUsername || !result.windchillPassword) { filling = false; return; }
      const fillFields = () => {
        if (usernameInput && usernameInput.value !== result.windchillUsername) {
          usernameInput.value = result.windchillUsername;
          dispatchCredentialEvents(usernameInput);
        }
        if (passwordInput && passwordInput.value !== result.windchillPassword) {
          passwordInput.value = result.windchillPassword;
          dispatchCredentialEvents(passwordInput);
        }
      };
      const fieldsOk = () =>
        (!usernameInput || usernameInput.value === result.windchillUsername) &&
        (!passwordInput || passwordInput.value === result.windchillPassword);

      // 填充后复核：页面脚本可能稍后重置输入框，值丢失就重填，最多 10 次，复核通过后才点确认
      const verify = (tries) => {
        if (stopped) return;
        const connected = (usernameInput?.isConnected ?? true) && (passwordInput?.isConnected ?? true);
        if (!connected) { filling = false; return; }
        if (fieldsOk()) {
          filled = true;
          if (watcher) { clearInterval(watcher); watcher = null; }
          observer.disconnect();
          confirmWhenReady(passwordInput || usernameInput, 0);
          return;
        }
        if (tries >= MAX_LOGIN_ATTEMPTS) {
          showToast('Windchill 密码填充后被页面清除，请手动输入。', 'error');
          filled = true;
          return;
        }
        fillFields();
        setTimeout(() => verify(tries + 1), 800);
      };

      // 等页面稳定后再填，并重新查找输入框（框架可能已重建原有节点）
      setTimeout(() => {
        if (stopped) { filling = false; return; }
        usernameInput = findInPageAndFrames(usernameSelectors) || usernameInput;
        passwordInput = findInPageAndFrames(passwordSelectors) || passwordInput;
        fillFields();
        setTimeout(() => verify(0), 800);
      }, FILL_SETTLE_MS);
    });
  }

  // 按钮可能稍后才出现/启用：最多等 10 次，点到一次即结束
  function confirmWhenReady(anchor, tries) {
    if (stopped || tries >= MAX_LOGIN_ATTEMPTS) return;
    storageGet(['windchillDryRun'], (s) => {
      if (clickConfirm(anchor, Boolean(s.windchillDryRun))) return;
      setTimeout(() => confirmWhenReady(anchor, tries + 1), 500);
    });
  }

  // Windchill 是单页应用：切到另一个任务页（hash 变化）后需要重新填一次
  window.addEventListener('hashchange', () => {
    if (stopped) return;
    filled = false;
    filling = false;
    observer.observe(document.documentElement, { childList: true, subtree: true });
    watcher = null;
    startWatcher();
  });

  function startWatcher() {
    if (watcher || filled) return;
    fillOnce();
    watcher = setInterval(() => {
      if (stopped || filled) return;
      fillOnce();
    }, 1000);
  }

  function resetAndFill() {
    stopped = false;
    filled = false;filling = false;
    loginAttempts = 0;
    storageSet({ loginAttempts: 0 }, startWatcher);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startWatcher, { once: true });
  } else {
    startWatcher();
  }

  const observer = new MutationObserver(() => {
    if (!stopped && !filled) fillOnce();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.windchillUsername || changes.windchillPassword || changes.Login1 || changes.Password1 || changes.windchillAutoFillEnabled)) {
      if (changes.windchillAutoFillEnabled?.newValue === false) {
        stopped = true;
        loginAttempts = 0;
        storageSet({ loginAttempts: 0 });
      } else {
        resetAndFill();
      }
    }
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fillWindchillCredentials') {
      stopped = false;
      filled = false;filling = false;
      loginAttempts = 0;
      storageSet({ loginAttempts: 0 }, () => {
        fillOnce();
        sendResponse({ success: true });
      });
      return true;
    }
    if (request.action !== 'stopWindchillActions') return true;
    stopped = true;
    loginAttempts = 0;
    storageSet({ loginAttempts: 0 });
    const toast = document.getElementById('windchill-autofill-toast');
    if (toast) toast.remove();
    sendResponse({ success: true });
    return true;
  });
})();
