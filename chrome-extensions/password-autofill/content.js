// 登录尝试计数器（按系统分别管理）

// 检查插件上下文是否仍然有效（插件更新后旧 content script 会失效）
function isExtensionContextValid() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch(e) {
    return false;
  }
}

// 安全的 chrome.storage.local.get，上下文失效时静默忽略
function safeStorageGet(keys, callback) {
  if (!isExtensionContextValid()) return;
  try { chrome.storage.local.get(keys, callback); } catch(e) {}
}

// 安全的 chrome.storage.local.set
function safeStorageSet(obj, callback) {
  if (!isExtensionContextValid()) return;
  try { chrome.storage.local.set(obj, callback); } catch(e) {}
}

let windchillLoginAttempts = 0;
let ehrLoginAttempts = 0;
const MAX_LOGIN_ATTEMPTS = 3;
const LOGIN_RETRY_INTERVAL = 500; // 重试间隔0.5秒

let windchillAutoFillInterval = null;
let windchillCompleteClickTimer = null;

function isWindchillPage() {
  return window.location.href.includes('khplm.medtronic.com.cn');
}

function findInDocument(doc, selectorList) {
  for (const selector of selectorList) {
    try {
      if (selector.startsWith('//')) {
        const element = doc.evaluate(selector, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (element) return element;
      } else {
        const element = doc.querySelector(selector);
        if (element) return element;
      }
    } catch (error) {
      console.log(`选择器 ${selector} 查找失败:`, error);
    }
  }
  return null;
}

function findInPageAndFrames(selectorList) {
  const mainElement = findInDocument(document, selectorList);
  if (mainElement) return mainElement;

  const iframes = document.getElementsByTagName('iframe');
  for (const iframe of iframes) {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      const element = findInDocument(iframeDoc, selectorList);
      if (element) return element;
    } catch (error) {
      console.log('访问 iframe 失败:', error);
    }
  }
  return null;
}

function dispatchCredentialEvents(input) {
  ['input', 'change', 'blur', 'focus'].forEach(eventType => {
    input.dispatchEvent(new Event(eventType, { bubbles: true }));
  });
}

function scheduleWindchillCompleteClick() {
  if (windchillCompleteClickTimer) return;
  windchillCompleteClickTimer = setTimeout(() => {
    windchillCompleteClickTimer = null;
    const completeButton = document.querySelector('button[id*="P"][name="complete"]');
    if (completeButton && !completeButton.hasAttribute('data-clicked')) {
      console.log('Windchill 守护器找到完成任务按钮，准备点击');
      completeButton.setAttribute('data-clicked', 'true');
      completeButton.click();
    }
  }, 3000);
}

function fillWindchillOnce() {
  if (!isExtensionContextValid() || !isWindchillPage()) return;

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

  const usernameInput = findInPageAndFrames(usernameSelectors);
  const passwordInput = findInPageAndFrames(passwordSelectors);

  if (!usernameInput && !passwordInput) return;

  safeStorageGet(['username', 'password'], result => {
    const username = result.username;
    const password = result.password;

    if (!username || !password) return;

    let filled = false;
    if (usernameInput && usernameInput.value !== username) {
      usernameInput.value = username;
      dispatchCredentialEvents(usernameInput);
      filled = true;
    }
    if (passwordInput && passwordInput.value !== password) {
      passwordInput.value = password;
      dispatchCredentialEvents(passwordInput);
      filled = true;
    }

    if (filled) {
      console.log('Windchill 守护器已填充/补填账号密码');
      scheduleWindchillCompleteClick();
    }
  });
}

function startWindchillAutoFillWatcher() {
  if (!isWindchillPage() || windchillAutoFillInterval) return;

  console.log('启动 Windchill 1秒自动填充守护器');
  fillWindchillOnce();
  windchillAutoFillInterval = setInterval(() => {
    if (!isExtensionContextValid() || !isWindchillPage()) {
      clearInterval(windchillAutoFillInterval);
      windchillAutoFillInterval = null;
      return;
    }
    fillWindchillOnce();
  }, 1000);
}

// 自动填充指定的账号密码
function autoFillCredentials() {
  console.log('开始执行自动填充函数');

  // 定义多个可能的选择器
  const selectors = {
    windchill: {
      username: [
        'input[name*="signatureEngine_username"]',
        'input[type="text"][name*="signatureEngine_username"]',
        'input[name*="___signatureEngine_username___textbox"]',
        '//input[contains(@name, "signatureEngine_username")]',
        '//input[contains(@name, "___signatureEngine_username___textbox")]',
        'input[name="j_username"]',
        '#j_username',
        'input[name="username"]',
        'input[id="username"]'
      ],
      password: [
        'input[name*="signatureEngine_password"]',
        'input[type="password"][name*="signatureEngine_password"]',
        'input[name*="___signatureEngine_password___textbox"]',
        '//input[contains(@name, "signatureEngine_password")]',
        '//input[contains(@name, "___signatureEngine_password___textbox")]',
        'input[name="j_password"]',
        '#j_password',
        'input[name="password"]',
        'input[id="password"]'
      ]
    },
    ehr: {
      username: [
        'input[name="Login1"]',
        '#Login1',
        'input.Login[type="text"]',
        'input[placeholder*="请输入用户名"]',
        'input[type="text"][maxlength="50"]'
      ],
      password: [
        'input[name="Password1"]',
        '#Password1',
        'input.password.pwd-input',
        'input[type="password"][maxlength="50"]',
        'input[placeholder*="请输入密码"]'
      ]
    }
  };

  // 使用不同的选择器方法尝试查找元素
  function findElement(selectorList) {
    // 首先在主文档中查找
    for (const selector of selectorList) {
      try {
        if (selector.startsWith('//')) {
          // XPath选择器
          const element = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          if (element) return element;
        } else {
          // CSS选择器
          const element = document.querySelector(selector);
          if (element) return element;
        }
      } catch (error) {
        console.log(`选择器 ${selector} 查找失败:`, error);
      }
    }

    // 如果主文档中没找到，尝试在所有iframe中查找
    const iframes = document.getElementsByTagName('iframe');
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        for (const selector of selectorList) {
          try {
            if (selector.startsWith('//')) {
              const element = iframeDoc.evaluate(selector, iframeDoc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
              if (element) return element;
            } else {
              const element = iframeDoc.querySelector(selector);
              if (element) return element;
            }
          } catch (error) {
            console.log(`iframe中选择器 ${selector} 查找失败:`, error);
          }
        }
      } catch (error) {
        console.log('访问iframe失败:', error);
      }
    }
    return null;
  }

  // 定期检查元素是否存在并填充
  function tryFill(retryCount = 0, maxRetries = 20) {
    if (retryCount >= maxRetries) {
      console.log('达到最大重试次数，停止尝试');
      return;
    }

    // 根据当前URL选择合适的选择器和存储键
    let currentSelectors;
    let storageKeys;

    const currentUrl = window.location.href;
    console.log('当前页面URL:', currentUrl);

    if (currentUrl.includes('khplm.medtronic.com.cn')) {
      console.log('识别为Windchill系统');
      currentSelectors = selectors.windchill;
      storageKeys = { username: 'username', password: 'password' };
    } else if (currentUrl.includes('ehr.medtronic.com.cn')) {
      console.log('识别为EHR系统登录页面');
      currentSelectors = selectors.ehr;
      storageKeys = { username: 'Login1', password: 'Password1' };
    } else if (currentUrl.includes('medtronic.csod.com')) {
      console.log('识别为Cornerstone系统，跳过自动填充');
      return; // Cornerstone系统不需要自动填充，只需要自动点击功能
    } else {
      console.log('不支持的网站:', currentUrl);
      return;
    }

    const usernameInput = findElement(currentSelectors.username);
    const passwordInput = findElement(currentSelectors.password);

    // 添加调试日志
    console.log('用户名输入框是否找到:', !!usernameInput);
    console.log('密码输入框是否找到:', !!passwordInput);
    if (usernameInput) {
      console.log('找到的用户名输入框:', {
        id: usernameInput.id,
        name: usernameInput.name,
        class: usernameInput.className,
        type: usernameInput.type,
        placeholder: usernameInput.placeholder
      });
    }
    if (passwordInput) {
      console.log('找到的密码输入框:', {
        id: passwordInput.id,
        name: passwordInput.name,
        class: passwordInput.className,
        type: passwordInput.type,
        placeholder: passwordInput.placeholder
      });
    }

    if (!usernameInput || !passwordInput) {
      console.log(`未找到输入框，将在500ms后重试 (${retryCount + 1}/${maxRetries})`);
      setTimeout(() => tryFill(retryCount + 1, maxRetries), 500);
      return;
    }

    // 填充账号密码（尝试3次，每次间隔0.5秒）
    console.log('找到输入框，开始填充账号密码...');
    // 从chrome.storage获取保存的账号密码
    chrome.storage.local.get([storageKeys.username, storageKeys.password], function (result) {
      const username = result[storageKeys.username];
      const password = result[storageKeys.password];

      console.log('是否获取到用户名:', !!username);
      console.log('是否获取到密码:', !!password);

      if (username && password) {
        // 尝试填充函数
        let fillAttemptCount = 0;
        const MAX_FILL_ATTEMPTS = 3;
        
        function attemptFill() {
          fillAttemptCount++;
          console.log(`第 ${fillAttemptCount}/${MAX_FILL_ATTEMPTS} 次尝试填充`);
          
          // 填充值
          usernameInput.value = username;
          passwordInput.value = password;

          // 触发所有可能的事件
          const events = ['input', 'change', 'blur', 'focus'];
          events.forEach(eventType => {
            usernameInput.dispatchEvent(new Event(eventType, { bubbles: true }));
            passwordInput.dispatchEvent(new Event(eventType, { bubbles: true }));
          });
          
          // 等待一小段时间后验证是否填充成功
          setTimeout(() => {
            const usernameSuccess = usernameInput.value === username;
            const passwordSuccess = passwordInput.value === password;
            
            console.log(`填充验证: 用户名=${usernameSuccess}, 密码=${passwordSuccess}`);
            
            if (usernameSuccess && passwordSuccess) {
              console.log('✅ 自动填充成功');
              
              // 只对 Windchill 系统进行登录成功检测
              // EHR 系统需要手动输入验证码，不进行自动登录检测
              if (currentUrl.includes('khplm.medtronic.com.cn')) {
                // 增加 Windchill 登录尝试计数
                windchillLoginAttempts++;
                console.log(`Windchill 登录尝试次数: ${windchillLoginAttempts}/${MAX_LOGIN_ATTEMPTS}`);

                // 保存登录尝试次数到存储
                chrome.storage.local.set({ windchillLoginAttempts: windchillLoginAttempts });

                // 检查是否达到最大尝试次数
                if (windchillLoginAttempts >= MAX_LOGIN_ATTEMPTS) {
                  console.log('达到最大登录尝试次数，停止自动填充');
                  // 不再显示警告提示，静默停止重试
                  // showLoginRetryDialog(currentUrl, storageKeys);
                  return;
                }

                // 设置登录成功检测（5秒后检查是否还在登录页面）
                setTimeout(() => {
                  checkLoginSuccess(currentUrl, storageKeys);
                }, 5000);
              }

              // 尝试聚焦验证码输入框和勾选"7天内免登陆" (针对EHR系统)
              if (currentUrl.includes('ehr.medtronic.com.cn')) {
                setTimeout(() => {
                  // 自动勾选"7天内免登陆"复选框
                  const autoLoginCheckbox = document.querySelector('input[type="checkbox"]') ||
                    document.querySelector('input[name*="remember"]') ||
                    document.querySelector('input[name*="auto"]') ||
                    document.querySelector('input[id*="remember"]') ||
                    document.querySelector('input[id*="auto"]');
                  
                  if (autoLoginCheckbox && !autoLoginCheckbox.checked) {
                    console.log('找到"7天内免登陆"复选框，自动勾选');
                    autoLoginCheckbox.checked = true;
                    autoLoginCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
                    autoLoginCheckbox.dispatchEvent(new Event('click', { bubbles: true }));
                  }
                  
                  // 聚焦验证码输入框
                  const captchaInput = document.querySelector('input[placeholder*="验证码"]') ||
                    document.querySelector('input[name*="Code"]') ||
                    document.querySelector('input[name*="yzm"]');

                  if (captchaInput) {
                    console.log('找到验证码输入框，进行聚焦');
                    captchaInput.focus();
                    captchaInput.click();
                  } else {
                    console.log('未找到验证码输入框');
                  }
                }, 500);
              }

              // 如果是 Windchill 系统，3秒后自动点击完成任务按钮（只点击一次）
              if (currentUrl.includes('khplm.medtronic.com.cn')) {
                console.log('Windchill 系统：3秒后自动点击完成任务按钮');
                setTimeout(() => {
                  const completeButton = document.querySelector('button[id*="P"][name="complete"]');
                  if (completeButton && !completeButton.hasAttribute('data-clicked')) {
                    console.log('找到完成任务按钮，准备点击');
                    // 标记按钮已被点击，防止重复点击
                    completeButton.setAttribute('data-clicked', 'true');
                    completeButton.click();
                    console.log('已点击完成任务按钮');
                  } else if (completeButton && completeButton.hasAttribute('data-clicked')) {
                    console.log('完成任务按钮已被点击过，跳过');
                  } else {
                    console.log('未找到完成任务按钮');
                  }
                }, 3000);
              }
            } else {
              // 填充失败，检查是否还有重试机会
              if (fillAttemptCount < MAX_FILL_ATTEMPTS) {
                console.log(`❌ 填充失败，0.5秒后进行第 ${fillAttemptCount + 1} 次尝试`);
                setTimeout(attemptFill, 500);
              } else {
                console.log('❌ 已尝试3次填充，均失败');
                showToast(
                  '自动填充失败，已尝试3次。请手动输入账号密码。',
                  'error',
                  5000
                );
              }
            }
          }, 100); // 等待100ms验证填充结果
        }
        
        // 开始第一次尝试
        attemptFill();
      } else {
        console.log('未找到保存的账号密码');
        showToast('未找到保存的账号密码，请先在插件设置中配置', 'warning', 3000);
      }
    });
  }

  // 开始尝试填充
  tryFill();
}

// 检查登录是否成功（仅用于 Windchill）
function checkLoginSuccess(currentUrl, storageKeys) {
  // 只检测 Windchill 系统
  const stillOnLoginPage = window.location.href.includes('khplm.medtronic.com.cn');
  
  if (!stillOnLoginPage) {
    // 登录成功，重置计数器
    console.log('Windchill 登录成功，重置尝试计数器');
    windchillLoginAttempts = 0;
    chrome.storage.local.set({ windchillLoginAttempts: 0 });
  } else {
    console.log('仍在 Windchill 登录页面，登录可能失败');
    // 如果还在登录页面且未达到最大次数，继续尝试
    if (windchillLoginAttempts < MAX_LOGIN_ATTEMPTS) {
      console.log('将在3秒后重新尝试填充');
      setTimeout(() => autoFillCredentials(), 3000);
    } else {
      // 已达到最大尝试次数，不再继续尝试
      console.log('已达到最大登录尝试次数，停止自动填充，等待用户手动处理');
    }
  }
}

// 显示 Toast 通知
function showToast(message, type = 'info', duration = 5000, actions = null) {
  // 移除已存在的 Toast
  const existingToast = document.getElementById('kiro-toast-notification');
  if (existingToast) {
    existingToast.remove();
  }

  // 创建 Toast 容器
  const toast = document.createElement('div');
  toast.id = 'kiro-toast-notification';
  
  // 根据类型设置颜色
  let bgColor, borderColor, iconColor;
  let icon = '';
  
  switch(type) {
    case 'success':
      bgColor = 'rgba(52, 199, 89, 0.95)';
      borderColor = '#34c759';
      iconColor = '#fff';
      icon = '✓';
      break;
    case 'error':
      bgColor = 'rgba(255, 59, 48, 0.95)';
      borderColor = '#ff3b30';
      iconColor = '#fff';
      icon = '✕';
      break;
    case 'warning':
      bgColor = 'rgba(255, 149, 0, 0.95)';
      borderColor = '#ff9500';
      iconColor = '#fff';
      icon = '⚠';
      break;
    default:
      bgColor = 'rgba(0, 122, 255, 0.95)';
      borderColor = '#007aff';
      iconColor = '#fff';
      icon = 'ℹ';
  }
  
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    min-width: 300px;
    max-width: 400px;
    background: ${bgColor};
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    color: white;
    padding: 16px 20px;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    animation: slideInRight 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    border: 1px solid ${borderColor};
  `;

  // 创建内容
  let content = `
    <div style="display: flex; align-items: flex-start; gap: 12px;">
      <div style="font-size: 20px; flex-shrink: 0; margin-top: 2px;">${icon}</div>
      <div style="flex: 1;">
        <div style="font-weight: 600; margin-bottom: 4px;">${message}</div>
  `;

  // 如果有操作按钮
  if (actions && actions.length > 0) {
    content += `<div style="display: flex; gap: 8px; margin-top: 12px;">`;
    actions.forEach(action => {
      content += `
        <button 
          id="${action.id}" 
          style="
            padding: 6px 14px;
            background: rgba(255, 255, 255, 0.2);
            color: white;
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 8px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s;
            font-family: inherit;
          "
          onmouseover="this.style.background='rgba(255, 255, 255, 0.3)'"
          onmouseout="this.style.background='rgba(255, 255, 255, 0.2)'"
        >${action.text}</button>
      `;
    });
    content += `</div>`;
  }

  content += `
      </div>
      <button 
        id="kiro-toast-close" 
        style="
          background: none;
          border: none;
          color: white;
          font-size: 20px;
          cursor: pointer;
          padding: 0;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0.7;
          transition: opacity 0.2s;
          flex-shrink: 0;
        "
        onmouseover="this.style.opacity='1'"
        onmouseout="this.style.opacity='0.7'"
      >×</button>
    </div>
  `;

  toast.innerHTML = content;

  // 添加动画样式
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideInRight {
      from {
        transform: translateX(400px);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
    }
    @keyframes slideOutRight {
      from {
        transform: translateX(0);
        opacity: 1;
      }
      to {
        transform: translateX(400px);
        opacity: 0;
      }
    }
  `;
  document.head.appendChild(style);

  document.body.appendChild(toast);

  // 关闭按钮事件
  const closeBtn = document.getElementById('kiro-toast-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      toast.style.animation = 'slideOutRight 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
      setTimeout(() => toast.remove(), 300);
    });
  }

  // 绑定操作按钮事件
  if (actions) {
    actions.forEach(action => {
      const btn = document.getElementById(action.id);
      if (btn) {
        btn.addEventListener('click', () => {
          action.callback();
          toast.style.animation = 'slideOutRight 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
          setTimeout(() => toast.remove(), 300);
        });
      }
    });
  }

  // 自动关闭（如果没有操作按钮或指定了持续时间）
  if (!actions || duration > 0) {
    setTimeout(() => {
      if (document.body.contains(toast)) {
        toast.style.animation = 'slideOutRight 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
        setTimeout(() => toast.remove(), 300);
      }
    }, duration);
  }

  return toast;
}

// 显示登录重试提示（替换原来的对话框）
function showLoginRetryDialog(currentUrl, storageKeys) {
  console.log('显示登录重试提示');
  
  showToast(
    `Windchill 登录失败，已尝试 ${MAX_LOGIN_ATTEMPTS} 次。请检查账号密码是否正确，或手动登录。`,
    'warning',
    0, // 不自动关闭
    [
      {
        id: 'retry-login-btn',
        text: '继续尝试',
        callback: () => {
          console.log('用户选择继续尝试登录');
          windchillLoginAttempts = 0;
          chrome.storage.local.set({ windchillLoginAttempts: 0 });
          autoFillCredentials();
        }
      },
      {
        id: 'manual-login-btn',
        text: '手动处理',
        callback: () => {
          console.log('用户选择手动处理登录');
          // 不重置计数器，保持在最大值，防止再次自动尝试
        }
      }
    ]
  );
}

// 创建统一悬浮面板
function createFloatingButton() {
  const panel = document.createElement('div');
  panel.id = 'autoClickButton';
  panel.style.cssText = `
    position: fixed; left: 20px; top: 50%; transform: translateY(-50%);
    z-index: 10001; background: rgba(15,20,35,0.93); backdrop-filter: blur(14px);
    border: 1px solid rgba(255,255,255,0.13); border-radius: 16px;
    padding: 12px 10px; display: flex; flex-direction: column; align-items: center;
    gap: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.45); user-select: none;
    min-width: 72px; font-family: -apple-system,'Microsoft YaHei',sans-serif; cursor: grab;
  `;

  // 标题把手
  const dragHandle = document.createElement('div');
  dragHandle.textContent = '⚙ 助手';
  dragHandle.style.cssText = `color:rgba(255,255,255,0.45);font-size:11px;letter-spacing:0.5px;cursor:grab;white-space:nowrap;`;
  panel.appendChild(dragHandle);

  // ── 自动点击（Mark Complete）──
  const clickBtn = document.createElement('button');
  clickBtn.id = '_autoClickInnerBtn';
  clickBtn.innerHTML = `点击<br><span id="_clickCountLabel">--</span>次`;
  clickBtn.style.cssText = `
    width:56px;padding:7px 0;background:rgba(0,112,192,0.85);color:white;
    border:1px solid rgba(255,255,255,0.2);border-radius:10px;cursor:pointer;
    font-size:13px;font-weight:600;line-height:1.3;font-family:inherit;transition:background 0.15s;
  `;
  clickBtn.onmouseover = () => { if (!clickBtn.disabled) clickBtn.style.background = 'rgba(0,89,153,0.9)'; };
  clickBtn.onmouseout  = () => { if (!clickBtn.disabled) clickBtn.style.background = isAutoClickRunning ? 'rgba(76,175,80,0.85)' : 'rgba(0,112,192,0.85)'; };
  panel.appendChild(clickBtn);

  // 分隔线
  const sep1 = document.createElement('div');
  sep1.style.cssText = `width:100%;height:1px;background:rgba(255,255,255,0.1);`;
  panel.appendChild(sep1);

  // ── 自动过课（翻页 + 跳过视频 + 扫描按钮）──
  const autoLabel = document.createElement('div');
  autoLabel.textContent = '自动过课';
  autoLabel.style.cssText = `color:rgba(255,255,255,0.45);font-size:11px;white-space:nowrap;`;
  panel.appendChild(autoLabel);

  // 自动过课按钮
  const autoBtn = document.createElement('button');
  autoBtn.id = '_autoNextBtn';
  autoBtn.textContent = '▶ 开始';
  autoBtn.style.cssText = `
    width:56px;padding:7px 0;background:rgba(120,60,200,0.8);color:white;
    border:1px solid rgba(255,255,255,0.2);border-radius:10px;cursor:pointer;
    font-size:12px;font-weight:600;line-height:1.3;font-family:inherit;transition:background 0.15s;
  `;
  autoBtn.onmouseover = () => { if (!autoBtn.disabled) autoBtn.style.background = isAutoNextRunning ? 'rgba(180,40,40,0.9)' : 'rgba(90,40,170,0.9)'; };
  autoBtn.onmouseout  = () => { if (!autoBtn.disabled) autoBtn.style.background = isAutoNextRunning ? 'rgba(220,80,80,0.85)' : 'rgba(120,60,200,0.8)'; };
  autoBtn.addEventListener('click', e => { e.stopPropagation(); toggleAutoNext(autoBtn); });
  panel.appendChild(autoBtn);

  // 自动跳过开关
  let autoSkipRunning = false;
  let autoSkipTimer = null;

  const skipBtn = document.createElement('button');
  skipBtn.id = '_autoSkipBtn';
  skipBtn.textContent = '⏭ 跳过';
  skipBtn.style.cssText = `
    width:56px;padding:5px 0;background:rgba(255,140,0,0.8);color:white;
    border:1px solid rgba(255,255,255,0.18);border-radius:8px;cursor:pointer;
    font-size:12px;font-weight:600;transition:background 0.15s;font-family:inherit;
  `;

  function updateSkipBtn() {
    skipBtn.textContent = autoSkipRunning ? '⏭ 自动' : '⏭ 跳过';
    skipBtn.style.background = autoSkipRunning ? 'rgba(220,80,80,0.85)' : 'rgba(255,140,0,0.8)';
  }

  function runAutoSkip() {
    if (!autoSkipRunning) return;
    skipVideosToEnd();
    autoSkipTimer = setTimeout(runAutoSkip, 2000);
  }

  skipBtn.onmouseover = () => { skipBtn.style.background = autoSkipRunning ? 'rgba(180,40,40,0.9)' : 'rgba(255,100,0,0.9)'; };
  skipBtn.onmouseout  = () => { updateSkipBtn(); };
  skipBtn.addEventListener('click', e => {
    e.stopPropagation();
    autoSkipRunning = !autoSkipRunning;
    updateSkipBtn();
    if (autoSkipRunning) {
      runAutoSkip();
    } else {
      if (autoSkipTimer) { clearTimeout(autoSkipTimer); autoSkipTimer = null; }
    }
  });
  panel.appendChild(skipBtn);

  // ── 拖动逻辑 ──
  let dragging = false, ox = 0, oy = 0, hasDragged = false;
  panel.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
    dragging = true; hasDragged = false;
    const rect = panel.getBoundingClientRect();
    panel.style.transform = 'none';
    panel.style.top  = rect.top  + 'px';
    panel.style.left = rect.left + 'px';
    ox = e.clientX - rect.left;
    oy = e.clientY - rect.top;
    panel.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    hasDragged = true;
    panel.style.left = Math.max(0, Math.min(e.clientX - ox, window.innerWidth  - panel.offsetWidth))  + 'px';
    panel.style.top  = Math.max(0, Math.min(e.clientY - oy, window.innerHeight - panel.offsetHeight)) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; panel.style.cursor = 'grab'; }
  });
  panel.addEventListener('click', e => { if (hasDragged) { e.stopImmediatePropagation(); hasDragged = false; } }, true);

  document.body.appendChild(panel);
  panel._clickBtn = clickBtn;
  return panel;
}

// Mark Complete 完成计数（独立于 Launch 索引）
let markCompleteCount = 0;

// 更新按钮文本：运行中显示"完成N次"，空闲时显示"点击N次"
function updateButtonText(count) {
  const label = document.getElementById('_clickCountLabel');
  const btn   = document.getElementById('_autoClickInnerBtn');
  if (!label || !btn) return;
  label.textContent = count;
  btn.firstChild.textContent = isAutoClickRunning ? '完成\n' : '点击\n';
}

// 初始化按钮文本
function initializeButtonText() {
  safeStorageGet(['markCompleteCount', 'clickCount'], function (result) {
    // 空闲状态显示设置的点击次数
    markCompleteCount = result.markCompleteCount || 0;
    updateButtonText(result.clickCount || 30);
  });
}

// 更新按钮状态
function updateButtonState(isRunning) {
  const btn = document.getElementById('_autoClickInnerBtn');
  if (btn) {
    btn.style.background = isRunning ? 'rgba(76,175,80,0.85)' : 'rgba(0,112,192,0.85)';
    btn.style.cursor = isRunning ? 'not-allowed' : 'pointer';
  }
}

// 自动点击功能（用于 Cornerstone 页面）
let isAutoClickRunning = false;
let currentClickCount = 0;
let targetClickCount = 0;
let noButtonTimeout = null; // 用于跟踪无按钮超时
let consecutiveNoButtonChecks = 0; // 连续未找到可点击按钮的次数
let lastSoftReloadAt = 0; // 最近一次软刷新时间戳(ms)
let refreshAttemptCount = 0; // 刷新页面尝试计数（找不到按钮时触发）
// 兼容存储字段名称
let noButtonRefreshAttempts = 0; // 与存储同步，用于跨刷新累计

// 页面加载时检查是否需要继续自动点击或清理状态
function checkAndContinueAutoClick() {
  console.log('页面加载，检查自动点击状态');

  // 检查是否在自动点击过程中
  safeStorageGet(['isAutoClickRunning', 'currentClickCount', 'targetClickCount', 'autoClickEnabled', 'markCompleteCount'], function (result) {
    if (!result.autoClickEnabled) {
      console.log('自动点击功能未开启，清理所有状态');
      cleanupAutoClickState();
      return;
    }

    const savedMarkCompleteCount = result.markCompleteCount || 0;
    const savedTargetClickCount = result.targetClickCount || 0;

    if (result.isAutoClickRunning && savedTargetClickCount > 0 && savedMarkCompleteCount < savedTargetClickCount) {
      console.log('检测到自动点击进行中，恢复状态继续执行');
      isAutoClickRunning = true;
      currentClickCount  = result.currentClickCount;
      targetClickCount   = savedTargetClickCount;
      markCompleteCount  = savedMarkCompleteCount;

      const button = document.getElementById('_autoClickInnerBtn');
      if (button) {
        button.disabled = true;
        updateButtonState(true);
        updateButtonText(markCompleteCount);
      }

      startPopupMonitoring();
      handleIndependentBrowserWindows();
      chrome.runtime.sendMessage({ action: 'cornerstoneAutoClickStarted' }, () => {});

      safeStorageGet(['noButtonRefreshAttempts'], res => {
        noButtonRefreshAttempts = res.noButtonRefreshAttempts || 0;
        setTimeout(findAndClickMarkComplete, 3000);
      });
    } else {
      // 如果不在自动点击过程中，清理状态重新开始
      console.log('不在自动点击过程中，清理状态重新开始');
      cleanupAutoClickState();
    }
  });
}

// 清理自动点击状态的函数
function cleanupAutoClickState() {
  console.log('清理自动点击状态');

  // 清除超时计时器
  if (noButtonTimeout) {
    clearTimeout(noButtonTimeout);
    noButtonTimeout = null;
    console.log('已清除超时计时器');
  }

  // 清理自动点击运行状态和已点击记录
  isAutoClickRunning = false;
  currentClickCount = 0;
  targetClickCount = 0;
  markCompleteCount = 0;

  safeStorageSet({
    isAutoClickRunning: false,
    currentClickCount: 0,
    targetClickCount: 0,
    markCompleteCount: 0,
    clickedLaunchHrefs: []
  });

  stopPopupMonitoring();

  const button = document.getElementById('autoClickButton');
  if (button) {
    button.disabled = false;
    updateButtonState(false);
    safeStorageGet(['clickCount'], function (result) {
      updateButtonText(result.clickCount || 30);
    });
  }
}

// 获取已点击过的 Launch 按钮 href 列表
function getClickedLaunchHrefs(callback) {
  chrome.storage.local.get(['clickedLaunchHrefs'], function (result) {
    callback(new Set(result.clickedLaunchHrefs || []));
  });
}

// 记录已点击的 Launch 按钮 href
function addClickedLaunchHref(href) {
  getClickedLaunchHrefs(function (set) {
    set.add(href);
    chrome.storage.local.set({ clickedLaunchHrefs: Array.from(set) });
  });
}

function findAndClickMarkComplete() {
  if (!isExtensionContextValid()) {
    // 插件已更新，停止循环
    isAutoClickRunning = false;
    return;
  }

  // 每次执行前都从存储中获取最新的状态，确保页面刷新后状态正确
  safeStorageGet(['isAutoClickRunning', 'currentClickCount', 'targetClickCount', 'markCompleteCount', 'clickCount'], function (result) {
    const storedIsRunning = result.isAutoClickRunning || false;
    const storedCurrentCount = result.currentClickCount || 0;
    const storedTargetCount = result.targetClickCount || result.clickCount || 30;
    const storedMarkCompleteCount = result.markCompleteCount || 0;

    console.log(`存储中的状态: isAutoClickRunning=${storedIsRunning}, currentClickCount=${storedCurrentCount}, markCompleteCount=${storedMarkCompleteCount}, targetClickCount=${storedTargetCount}`);

    if (storedIsRunning !== isAutoClickRunning || storedCurrentCount !== currentClickCount || storedTargetCount !== targetClickCount || storedMarkCompleteCount !== markCompleteCount) {
      isAutoClickRunning = storedIsRunning;
      currentClickCount  = storedCurrentCount;
      targetClickCount   = storedTargetCount;
      markCompleteCount  = storedMarkCompleteCount;
    }

    if (storedIsRunning && !isAutoClickRunning) {
      isAutoClickRunning = true;
      currentClickCount  = storedCurrentCount;
      targetClickCount   = storedTargetCount;
      markCompleteCount  = storedMarkCompleteCount;
    }

    // 停止条件：只看 markCompleteCount 是否达到目标
    if (!isAutoClickRunning || markCompleteCount >= targetClickCount) {
      finishAutoClick();
      return;
    }

    continueClicking();
  });
}

// 继续执行点击逻辑的函数
function continueClicking() {
  // ── 优先：Mark Complete / 标记完成 ──
  const allLinks = Array.from(document.querySelectorAll('a'));
  const markCompleteBtn = allLinks.find(link => {
    const title = link.getAttribute('title') || '';
    const text  = link.textContent?.trim() || '';
    return title.includes('Mark Complete') || title.includes('标记') ||
           text.includes('Mark Complete')  || text.includes('标记');
  });

  if (markCompleteBtn) {
    if (noButtonTimeout) { clearTimeout(noButtonTimeout); noButtonTimeout = null; }
    // 同样避免触发 javascript: href
    const originalHref = markCompleteBtn.getAttribute('href');
    if (originalHref && originalHref.toLowerCase().startsWith('javascript')) {
      markCompleteBtn.removeAttribute('href');
    }
    markCompleteBtn.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
    if (originalHref) markCompleteBtn.setAttribute('href', originalHref);
    markCompleteCount++;
    safeStorageSet({ markCompleteCount });
    updateButtonText(markCompleteCount);
    consecutiveNoButtonChecks = 0;
    console.log(`点击 Mark Complete [完成${markCompleteCount}次, 目标${targetClickCount}次]`);

    if (markCompleteCount >= targetClickCount) { finishAutoClick(); return; }
    setTimeout(findAndClickMarkComplete, 3000);
    return;
  }

  // ── 其次：按顺序点击 Launch / 启动（用 currentClickCount 作为索引）──
  const allLaunchButtons = Array.from(
    document.querySelectorAll('a[title="Launch"], a[title="启动"]')
  ).filter(btn => {
    const href = (btn.getAttribute('href') || '').trim();
    // 排除 test 按钮
    const title = (btn.getAttribute('title') || '').trim();
    return title === 'Launch' || title === '启动';
  });

  console.log(`Launch 按钮总数: ${allLaunchButtons.length}, Launch尝试次数: ${currentClickCount}, 完成次数: ${markCompleteCount}/${targetClickCount}`);

  if (allLaunchButtons.length > 0) {
    // 不用 currentClickCount 当数组下标。Cornerstone 页面常常只显示当前批次/当前页的少量 Launch，
    // 用全局累计数取下标会在点过 1-2 个后越界，导致误判为无按钮并提前退出。
    const btn = allLaunchButtons[0];
    if (noButtonTimeout) { clearTimeout(noButtonTimeout); noButtonTimeout = null; }

    // 阻止 href="javascript:..." 被浏览器执行（触发 CSP），改为只触发 click 事件监听器
    const clickEvent = new MouseEvent('click', { view: window, bubbles: true, cancelable: true });
    // 如果有 onclick 属性，直接调用；否则 dispatchEvent
    if (btn.onclick) {
      btn.onclick(clickEvent);
    } else {
      // 临时移除 href 避免 CSP，触发后恢复
      const originalHref = btn.getAttribute('href');
      btn.removeAttribute('href');
      btn.dispatchEvent(clickEvent);
      if (originalHref) btn.setAttribute('href', originalHref);
    }
    currentClickCount++;
    safeStorageSet({ currentClickCount });
    consecutiveNoButtonChecks = 0;
    console.log(`点击 Launch，Launch尝试次数=${currentClickCount}, href="${btn.getAttribute('href')}"`);

    if (markCompleteCount >= targetClickCount) { finishAutoClick(); return; }
    setTimeout(findAndClickMarkComplete, 3000);
    return;
  }

  // ── 没找到可点击按钮 ──
  consecutiveNoButtonChecks++;
  console.log(`未找到按钮，累计 ${consecutiveNoButtonChecks} 次`);

  if (consecutiveNoButtonChecks >= 3) {
    consecutiveNoButtonChecks = 0;
    safeStorageGet(['noButtonRefreshAttempts'], res => {
      noButtonRefreshAttempts = (res.noButtonRefreshAttempts || 0) + 1;
      safeStorageSet({
        isAutoClickRunning: true, currentClickCount, targetClickCount,
        markCompleteCount, noButtonRefreshAttempts
      }, () => {
        if (noButtonRefreshAttempts >= 3) {
          console.log(`已刷新检查 ${noButtonRefreshAttempts} 次仍无按钮，但完成次数 ${markCompleteCount}/${targetClickCount} 未达标，继续等待而不是退出`);
          noButtonRefreshAttempts = 0;
          safeStorageSet({ noButtonRefreshAttempts: 0 }, () => {
            setTimeout(findAndClickMarkComplete, 5000);
          });
        } else {
          window.location.reload();
        }
      });
    });
    return;
  }
  setTimeout(findAndClickMarkComplete, 1000);
}

// 完成/终止自动点击，统一清理
function finishAutoClick() {
  isAutoClickRunning = false;
  currentClickCount  = 0;
  targetClickCount   = 0;
  markCompleteCount  = 0;
  safeStorageSet({
    isAutoClickRunning: false, currentClickCount: 0, targetClickCount: 0,
    markCompleteCount: 0, clickedLaunchHrefs: [], noButtonRefreshAttempts: 0
  }, () => {
    const btn = document.getElementById('_autoClickInnerBtn');
    if (btn) { btn.disabled = false; updateButtonState(false); }
    safeStorageGet(['clickCount'], r => updateButtonText(r.clickCount || 30));
    stopPopupMonitoring();
  });
}

// ===================== 自动过课功能 =====================

let isAutoNextRunning = false;
let autoNextTimer = null;

function toggleAutoNext(btn) {
  if (isAutoNextRunning) {
    isAutoNextRunning = false;
    if (autoNextTimer) { clearTimeout(autoNextTimer); autoNextTimer = null; }
    btn.textContent = '▶ 开始';
    btn.style.background = 'rgba(120,60,200,0.8)';
  } else {
    isAutoNextRunning = true;
    btn.textContent = '■ 停止';
    btn.style.background = 'rgba(220,80,80,0.85)';
    runAutoNext();
  }
}

// 查找 #next 按钮（含 iframe）
function findNextButton() {
  const btn = document.querySelector('button#next, button[aria-label="下一步"]');
  if (btn) return btn;
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      const b = doc.querySelector('button#next, button[aria-label="下一步"]');
      if (b) return b;
    } catch(e) {}
  }
  return null;
}

// 自动过课主循环：有视频就跳末尾，没视频就翻页
function runAutoNext() {
  if (!isAutoNextRunning) return;

  // 先尝试跳过视频
  const skipped = skipVideosToEnd();
  if (skipped > 0) {
    // 跳过后等 1.5s 让课程处理完成事件，再翻页
    autoNextTimer = setTimeout(() => {
      if (!isAutoNextRunning) return;
      clickNextButton(() => {
        autoNextTimer = setTimeout(() => runAutoNext(), 3000);
      });
    }, 1500);
    return;
  }

  // 没有视频，直接翻页（点3次间隔300ms，然后等5s）
  clickNextButton(() => {
    autoNextTimer = setTimeout(() => runAutoNext(), 5000);
  });
}

// 点击下一步按钮3次，完成后回调
function clickNextButton(callback) {
  let count = 0;
  function doClick() {
    if (!isAutoNextRunning) return;
    const nextEl = findNextButton();
    if (!nextEl) {
      autoNextTimer = setTimeout(() => runAutoNext(), 5000);
      return;
    }
    nextEl.click();
    count++;
    if (count < 3) {
      autoNextTimer = setTimeout(doClick, 300);
    } else {
      callback && callback();
    }
  }
  doClick();
}

// ===================== 自动过课功能 END =====================

// ===================== 视频加速功能 =====================

// 递归收集所有可访问的 document（含嵌套 iframe）
function getAllDocs(doc, result) {
  result = result || [];
  result.push(doc);
  try {
    Array.from(doc.querySelectorAll('iframe')).forEach(f => {
      try { getAllDocs(f.contentDocument || f.contentWindow.document, result); } catch(e) {}
    });
  } catch(e) {}
  return result;
}

// 对所有可访问 document 中的视频设置播放速度
function setVideoSpeed(speed) {
  // 本页直接操作
  getAllDocs(document).forEach(doc => {
    try {
      doc.querySelectorAll('video').forEach(v => {
        try { v.playbackRate = speed; } catch(e) {}
      });
    } catch(e) {}
  });
  // 通过 background 注入到其他 SCORM tab（处理独立弹窗）
  chrome.runtime.sendMessage({ action: 'videoSpeed', speed }, () => {});
}

// 跳到视频末尾（让课程认为视频已播完）
function skipVideosToEnd() {
  let found = 0;
  // 本页直接操作
  getAllDocs(document).forEach(doc => {
    try {
      doc.querySelectorAll('video').forEach(v => {
        try {
          if (v.duration && isFinite(v.duration)) {
            v.currentTime = v.duration - 0.1;
            found++;
          }
        } catch(e) {}
      });
    } catch(e) {}
  });
  // 通过 background 注入到其他 SCORM tab
  chrome.runtime.sendMessage({ action: 'videoSkip' }, (resp) => {
    if (resp && resp.tabs > 0) console.log('已向', resp.tabs, '个 tab 注入跳过指令');
  });
  return found;
}

// 监听新出现的 video 元素并自动应用当前速度
function observeNewVideos(speed) {
  const applyToNode = (node) => {
    if (node.nodeName === 'VIDEO') {
      try {
        node.playbackRate = speed;
        // 如果是"跳过"模式，等 metadata 加载后直接跳末尾
        if (speed >= 16) {
          const jump = () => {
            if (node.duration && isFinite(node.duration)) {
              node.currentTime = node.duration - 0.1;
            }
          };
          node.addEventListener('loadedmetadata', jump, { once: true });
          node.addEventListener('canplay', jump, { once: true });
        }
      } catch(e) {}
    }
    if (node.querySelectorAll) {
      node.querySelectorAll('video').forEach(v => {
        try { v.playbackRate = speed; } catch(e) {}
      });
    }
  };

  // 监听主文档
  const obs = new MutationObserver(mutations => {
    mutations.forEach(m => m.addedNodes.forEach(applyToNode));
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // 同时监听已有 iframe 内部
  getAllDocs(document).forEach(doc => {
    if (doc === document) return;
    try {
      const iframeObs = new MutationObserver(mutations => {
        mutations.forEach(m => m.addedNodes.forEach(applyToNode));
      });
      iframeObs.observe(doc.body, { childList: true, subtree: true });
    } catch(e) {}
  });

  return obs;
}

let videoSpeedObserver = null;
let currentVideoSpeed = 1;

// ===================== 视频加速功能 END =====================

// 初始化悬浮面板
function initializeAutoClickButton() {
  // 只在顶层页面显示，iframe 内不创建
  if (window.top !== window) return;
  // 只在 Cornerstone 页面显示
  if (!window.location.href.includes('medtronic.csod.com')) return;

  chrome.storage.local.get(['autoClickEnabled'], function (result) {
    if (!result.autoClickEnabled) return;

    const panel = createFloatingButton();
    const clickBtn = panel._clickBtn;

    initializeButtonText();

    clickBtn.addEventListener('click', function () {
      if (!isAutoClickRunning) {
        chrome.storage.local.get(['clickCount'], function (result) {
          const clickCount = result.clickCount || 30;
          isAutoClickRunning = true;
          currentClickCount  = 0;
          targetClickCount   = clickCount;
          markCompleteCount  = 0;

          chrome.storage.local.set({
            isAutoClickRunning: true,
            currentClickCount: 0,
            targetClickCount: clickCount,
            markCompleteCount: 0,
            clickedLaunchHrefs: [],
            noButtonRefreshAttempts: 0
          });

          clickBtn.disabled = true;
          updateButtonState(true);
          updateButtonText(0);
          startPopupMonitoring();
          handleIndependentBrowserWindows();
          chrome.runtime.sendMessage({ action: 'cornerstoneAutoClickStarted' }, () => {});
          findAndClickMarkComplete();
        });
      }
    });
  });
}

// 在页面加载完成后初始化
if (document.readyState === 'complete') {
  initializeAutoClickButton();
  checkAndContinueAutoClick();
} else {
  window.addEventListener('load', () => {
    initializeAutoClickButton();
    checkAndContinueAutoClick();
  });
}

// 监听DOM变化
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.addedNodes.length) {
      console.log('检测到DOM变化，检查是否可以尝试填充');
      // 根据当前系统检查对应的登录尝试次数
      const currentUrl = window.location.href;
      if (currentUrl.includes('khplm.medtronic.com.cn')) {
        startWindchillAutoFillWatcher();
        chrome.storage.local.get(['windchillLoginAttempts'], function(result) {
          const attempts = result.windchillLoginAttempts || 0;
          if (attempts >= MAX_LOGIN_ATTEMPTS) {
            console.log(`Windchill 登录尝试次数已达到最大值 (${attempts}/${MAX_LOGIN_ATTEMPTS})，跳过自动填充`);
          } else {
            autoFillCredentials();
          }
        });
      } else if (currentUrl.includes('ehr.medtronic.com.cn')) {
        // EHR 系统不进行登录检测，直接填充
        autoFillCredentials();
      } else {
        // 其他系统直接填充
        autoFillCredentials();
      }
    }
  });
});

// 配置观察选项
const config = {
  childList: true,
  subtree: true
};

// 开始观察
observer.observe(document.body, config);

// 等待DOM加载完成后执行自动填充
console.log('当前文档状态:', document.readyState);

// 页面刷新或重新打开时，重置登录尝试次数（不从存储恢复）
// 这样每次打开页面都会重新尝试自动填充
windchillLoginAttempts = 0;
ehrLoginAttempts = 0;
console.log('页面加载，重置所有系统的登录尝试次数');
chrome.storage.local.set({ 
  windchillLoginAttempts: 0,
  ehrLoginAttempts: 0
});

if (document.readyState === 'complete') {
  console.log('文档已完全加载，检查是否可以执行自动填充');
  // 根据当前系统检查对应的登录尝试次数
  const currentUrl = window.location.href;
  if (currentUrl.includes('khplm.medtronic.com.cn')) {
    startWindchillAutoFillWatcher();
    chrome.storage.local.get(['windchillLoginAttempts'], function(result) {
      const attempts = result.windchillLoginAttempts || 0;
      if (attempts >= MAX_LOGIN_ATTEMPTS) {
        console.log(`Windchill 登录尝试次数已达到最大值 (${attempts}/${MAX_LOGIN_ATTEMPTS})，跳过自动填充`);
      } else {
        console.log('Windchill 登录尝试次数未达到最大值，执行自动填充');
        autoFillCredentials();
      }
    });
  } else if (currentUrl.includes('ehr.medtronic.com.cn')) {
    // EHR 系统不进行登录检测，直接填充
    console.log('EHR 系统，直接执行自动填充');
    autoFillCredentials();
  } else {
    // 其他系统直接填充
    autoFillCredentials();
  }
} else {
  console.log('文档尚未完全加载，添加load事件监听器');
  window.addEventListener('load', () => {
    console.log('文档加载完成，检查是否可以执行自动填充');
    // 根据当前系统检查对应的登录尝试次数
    const currentUrl = window.location.href;
    if (currentUrl.includes('khplm.medtronic.com.cn')) {
      startWindchillAutoFillWatcher();
      chrome.storage.local.get(['windchillLoginAttempts'], function(result) {
        const attempts = result.windchillLoginAttempts || 0;
        if (attempts >= MAX_LOGIN_ATTEMPTS) {
          console.log(`Windchill 登录尝试次数已达到最大值 (${attempts}/${MAX_LOGIN_ATTEMPTS})，跳过自动填充`);
        } else {
          console.log('Windchill 登录尝试次数未达到最大值，执行自动填充');
          autoFillCredentials();
        }
      });
    } else if (currentUrl.includes('ehr.medtronic.com.cn')) {
      // EHR 系统不进行登录检测，直接填充
      console.log('EHR 系统，直接执行自动填充');
      autoFillCredentials();
    } else {
      // 其他系统直接填充
      autoFillCredentials();
    }
  });
}

// 监听存储变化
chrome.storage.onChanged.addListener((changes, namespace) => {
  console.log('检测到存储变化:', { changes, namespace });
  if (namespace === 'local') {
    if (changes.username || changes.password || changes.Login1 || changes.Password1) {
      console.log('用户名或密码发生变化，检查是否可以重新执行自动填充');
      // 用户更新了账号密码，重置对应系统的登录尝试次数
      const currentUrl = window.location.href;
      if (currentUrl.includes('khplm.medtronic.com.cn') && (changes.username || changes.password)) {
        windchillLoginAttempts = 0;
        chrome.storage.local.set({ windchillLoginAttempts: 0 }, () => {
          console.log('已重置 Windchill 登录尝试次数，重新执行自动填充');
          startWindchillAutoFillWatcher();
          autoFillCredentials();
        });
      } else if (currentUrl.includes('ehr.medtronic.com.cn') && (changes.Login1 || changes.Password1)) {
        ehrLoginAttempts = 0;
        chrome.storage.local.set({ ehrLoginAttempts: 0 }, () => {
          console.log('已重置 EHR 登录尝试次数，重新执行自动填充');
          autoFillCredentials();
        });
      }
    }
    if (changes.clickCount) {
      console.log('点击次数设置发生变化:', changes.clickCount.newValue);
      // 只有在未运行时才更新按钮文本
      if (!isAutoClickRunning) {
        updateButtonText(changes.clickCount.newValue);
      }
    }
  }
});

// 监听来自 background 的停止指令
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'stopAllActions') {
    console.log('收到停止所有指令的消息');
    
    // 停止自动点击
    if (isAutoClickRunning) {
      console.log('停止自动点击功能');
      cleanupAutoClickState();
    }
    
    // 重置所有系统的登录尝试计数
    windchillLoginAttempts = 0;
    ehrLoginAttempts = 0;
    console.log('重置所有系统的登录尝试计数');
    
    // 移除可能存在的 Toast 通知
    const toast = document.getElementById('kiro-toast-notification');
    if (toast) {
      toast.remove();
      console.log('移除 Toast 通知');
    }
    
    // 停止弹窗监控
    stopPopupMonitoring();
    console.log('停止弹窗监控');
    
    sendResponse({ success: true, message: '所有指令已停止' });
  }
  return true;
});

// 弹出窗体识别和自动关闭功能 - 只在自动点击运行时启用
let popupObserver = null;
let popupInterval = null;

// 查找并关闭弹出窗体
function findAndClosePopup() {
  // 只在自动点击运行时才执行
  if (!isAutoClickRunning) {
    return;
  }

  // 常见的弹出窗体选择器
  const popupSelectors = [
    // 模态框
    '.modal',
    '.modal-dialog',
    '.modal-content',
    '[role="dialog"]',
    '[aria-modal="true"]',
    // 弹出框
    '.popup',
    '.popover',
    '.tooltip',
    // 特定类名
    '.p-dialog',
    '.p-overlay-panel',
    '.p-confirm-dialog',
    // 关闭按钮
    '.close',
    '.btn-close',
    '[data-dismiss="modal"]',
    '[aria-label="Close"]',
    '[title="Close"]'
  ];

  let popupFound = false;

  const closeButtonSelectors = [
    '.modal .close',
    '.modal-dialog .close',
    '.modal-content .close',
    '.btn-close',
    '[data-dismiss="modal"]',
    '[aria-label="Close"]',
    '[title="Close"]',
    'button.close'
  ];

  function pressEscape(doc) {
    doc.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true
    }));
  }

  function clickCloseButton(doc) {
    for (const selector of closeButtonSelectors) {
      try {
        const closeBtn = doc.querySelector(selector);
        if (closeBtn) {
          console.log('找到弹窗关闭按钮:', selector);
          closeBtn.click();
          return true;
        }
      } catch (error) {
        console.log('查找弹窗关闭按钮失败:', error);
      }
    }
    return false;
  }

  // 查找弹出窗体
  for (const selector of popupSelectors) {
    try {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        console.log('找到弹出窗体:', selector);
        popupFound = true;

        if (!clickCloseButton(document)) {
          console.log('按ESC键关闭弹窗');
          pressEscape(document);
        }

        return true;
      }
    } catch (error) {
      console.log('查找弹出窗体时出错:', error);
    }
  }

  // 查找iframe中的弹出窗体
  const iframes = document.getElementsByTagName('iframe');
  for (const iframe of iframes) {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      for (const selector of popupSelectors) {
        try {
          const elements = iframeDoc.querySelectorAll(selector);
          if (elements.length > 0) {
            console.log('在iframe中找到弹出窗体:', selector);
            popupFound = true;

            if (!clickCloseButton(iframeDoc)) {
              console.log('在iframe中按ESC键关闭弹窗');
              pressEscape(iframeDoc);
            }

            return true;
          }
        } catch (error) {
          console.log('在iframe中查找弹出窗体时出错:', error);
        }
      }
    } catch (error) {
      console.log('访问iframe失败:', error);
    }
  }

  if (!popupFound) {
    console.log('未找到弹出窗体');
  }
  return false;
}

// 启动弹出窗体监控
function startPopupMonitoring() {
  // 检查是否在Cornerstone页面
  if (!window.location.href.includes('medtronic.csod.com')) {
    return;
  }

  console.log('启动弹出窗体监控');

  // 监听DOM变化，检测新出现的弹出窗体
  if (!popupObserver) {
    popupObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.addedNodes.length) {
          // 检查是否添加了弹出窗体
          const newNodes = Array.from(mutation.addedNodes);
          newNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // 检查新添加的元素是否是弹出窗体
              const popupSelectors = ['.modal', '.modal-dialog', '.modal-content', '[role="dialog"]', '[aria-modal="true"]', '.popup', '.popover', '.tooltip', '.p-dialog', '.p-overlay-panel', '.p-confirm-dialog'];
              for (const selector of popupSelectors) {
                if (node.matches && node.matches(selector)) {
                  console.log('检测到新的弹出窗体:', selector);
                  // 4秒后自动关闭
                  setTimeout(() => {
                    findAndClosePopup();
                  }, 4000);
                  return;
                }
              }

              // 检查新添加的元素内部是否包含弹出窗体
              if (node.querySelectorAll) {
                for (const selector of popupSelectors) {
                  const popup = node.querySelector(selector);
                  if (popup) {
                    console.log('检测到新元素中包含弹出窗体:', selector);
                    // 4秒后自动关闭
                    setTimeout(() => {
                      findAndClosePopup();
                    }, 4000);
                    return;
                  }
                }
              }
            }
          });
        }
      });
    });

    // 配置观察选项
    const popupConfig = {
      childList: true,
      subtree: true
    };

    // 开始观察
    popupObserver.observe(document.body, popupConfig);
  }

  // 定期检查现有弹出窗体（每1秒检查一次）
  if (!popupInterval) {
    popupInterval = setInterval(() => {
      findAndClosePopup();
    }, 1000);
  }
}

// 停止弹出窗体监控
function stopPopupMonitoring() {
  console.log('停止弹出窗体监控');

  if (popupObserver) {
    popupObserver.disconnect();
    popupObserver = null;
  }

  if (popupInterval) {
    clearInterval(popupInterval);
    popupInterval = null;
  }

  // 清除超时计时器
  if (noButtonTimeout) {
    clearTimeout(noButtonTimeout);
    noButtonTimeout = null;
    console.log('已清除超时计时器');
  }
}

// 处理独立浏览器页面关闭功能
function handleIndependentBrowserWindows() {
  // 检查是否在Cornerstone页面
  if (!window.location.href.includes('medtronic.csod.com')) {
    return;
  }

  // 检查是否开启了自动点击功能
  chrome.storage.local.get(['autoClickEnabled'], function (result) {
    if (!result.autoClickEnabled) {
      console.log('自动点击功能未开启，跳过独立浏览器页面处理');
      return;
    }

    console.log('初始化独立浏览器页面处理功能');

    // 监听Launch/启动按钮点击事件
    function handleLaunchButtonClick() {
      // 查找所有Launch/启动按钮
      const launchButtons = document.querySelectorAll('a[title="Launch"], a[title="启动"]');
      launchButtons.forEach(button => {
        // 移除之前的事件监听器（避免重复）
        button.removeEventListener('click', handleNewWindow);
        // 添加新的事件监听器
        button.addEventListener('click', handleNewWindow);
      });
    }

    // 处理新窗口打开
    function handleNewWindow(event) {
      console.log('检测到Launch/启动按钮点击，准备处理新窗口');

      // 获取目标URL
      const targetUrl = event.target.href || event.target.getAttribute('href');
      if (targetUrl) {
        console.log('目标URL:', targetUrl);

        // 尝试通过chrome.tabs API关闭新打开的标签页
        // 注意：这需要background script的支持
        chrome.runtime.sendMessage({
          action: 'monitorNewTab',
          url: targetUrl
        }, (response) => {
          if (response && response.success) {
            console.log('已设置监控新标签页');
          } else {
            console.log('无法设置监控新标签页');
          }
        });
      }
    }

    // 使用MutationObserver监听Launch按钮的出现
    const launchObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.addedNodes.length) {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // 检查新添加的元素是否是Launch/启动按钮
              if (node.matches && (node.matches('a[title="Launch"]') || node.matches('a[title="启动"]'))) {
                console.log('检测到新的Launch/启动按钮');
                handleLaunchButtonClick();
              }
              // 检查新添加的元素内部是否包含Launch/启动按钮
              if (node.querySelectorAll) {
                const launchButtons = node.querySelectorAll('a[title="Launch"], a[title="启动"]');
                if (launchButtons.length > 0) {
                  console.log('检测到新元素中包含Launch/启动按钮');
                  handleLaunchButtonClick();
                }
              }
            }
          });
        }
      });
    });

    // 配置观察选项
    const launchConfig = {
      childList: true,
      subtree: true
    };

    // 开始观察
    launchObserver.observe(document.body, launchConfig);

    // 初始检查现有的Launch/启动按钮
    handleLaunchButtonClick();
  });
}

// 在页面加载完成后初始化独立浏览器页面处理功能
// 注意：该函数现在只在autoClickEnabled为true时才执行，不需要在页面加载时自动调用
// if (document.readyState === 'complete') {
//   handleIndependentBrowserWindows();
// } else {
//   window.addEventListener('load', handleIndependentBrowserWindows);
// }
