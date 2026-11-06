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

let ehrLoginAttempts = 0;
// 每个页面只自动填一次；DOM 变化触发的重复调用会覆盖用户正在输入的内容。
let ehrFillState = 'idle';
const EHR_FILL_DELAY_MS = 1500;
// 自动填充指定的账号密码
function autoFillCredentials() {
  if (ehrFillState !== 'idle') return;
  ehrFillState = 'pending';
  setTimeout(runEhrAutoFill, EHR_FILL_DELAY_MS);
}

function runEhrAutoFill() {
  console.log('开始执行自动填充函数');

  // 定义多个可能的选择器
  const selectors = {
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
      ehrFillState = 'done';
      console.log('达到最大重试次数，停止尝试');
      return;
    }

    // 根据当前URL选择合适的选择器和存储键
    let currentSelectors;
    let storageKeys;

    const currentUrl = window.location.href;
    console.log('当前页面URL:', currentUrl);

    if (currentUrl.includes('ehr.medtronic.com.cn')) {
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
    safeStorageGet([storageKeys.username, storageKeys.password], function (result) {
      ehrFillState = 'done';
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
              try { chrome.runtime.sendMessage({ action: 'mwaLogActivity', app: /csod/.test(location.hostname) ? 'Cornerstone' : 'EHR', title: '登录自动填充', detail: location.hostname }); } catch (e) { /* 扩展已重载 */ }
              
              // 尝试聚焦验证码输入框和勾选"7天内免登陆"
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

            } else {
              // 填充失败，检查是否还有重试机会
              if (fillAttemptCount < MAX_FILL_ATTEMPTS) {
                console.log(`❌ 填充失败，0.5秒后进行第 ${fillAttemptCount + 1} 次尝试`);
                setTimeout(attemptFill, 500);
              } else {
                console.log('❌ 已尝试3次填充，均失败');
                try { chrome.runtime.sendMessage({ action: 'mwaLogActivity', ok: false, app: /csod/.test(location.hostname) ? 'Cornerstone' : 'EHR', title: '登录自动填充', detail: `${location.hostname}：已尝试 3 次均失败` }); } catch (e) { /* 扩展已重载 */ }
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

// 创建统一悬浮面板（右下角，默认折叠为图标；点击图标展开，面板内「–」收起）
function createFloatingButton() {
  const dock = MwaDock.create({ id: 'autoClickButton', title: 'Cornerstone 助手', icon: 'icons/cornerstone.png' });
  const panel = dock.root;
  panel._dock = dock;
  const row = (label, control) => {
    const node = document.createElement('div');
    node.className = 'mwa-row';
    const text = document.createElement('span');
    text.textContent = label;
    node.append(text, control);
    return node;
  };
  const list = document.createElement('div');
  list.className = 'mwa-list';
  dock.body.appendChild(list);

  // ── 自动点击（Mark Complete）──
  const clickBtn = document.createElement('button');
  clickBtn.id = '_autoClickInnerBtn';
  clickBtn.type = 'button';
  clickBtn.className = 'mwa-btn';
  clickBtn.innerHTML = `点击<br><span id="_clickCountLabel">--</span>次`;
  clickBtn.querySelector('br').hidden = true;
  list.appendChild(row('自动点击', clickBtn));

  // ── 自动过课（翻页 + 跳过视频 + 扫描按钮）──
  const autoBtn = document.createElement('button');
  autoBtn.id = '_autoNextBtn';
  autoBtn.type = 'button';
  autoBtn.className = 'mwa-btn indigo';
  autoBtn.textContent = '▶ 开始';
  autoBtn.addEventListener('click', e => { e.stopPropagation(); toggleAutoNext(autoBtn); });
  list.appendChild(row('自动过课', autoBtn));

  // 自动跳过开关
  let autoSkipRunning = false;
  let autoSkipTimer = null;

  const skipBtn = document.createElement('button');
  skipBtn.id = '_autoSkipBtn';
  skipBtn.type = 'button';
  skipBtn.className = 'mwa-btn orange';
  skipBtn.textContent = '⏭ 跳过';

  function updateSkipBtn() {
    skipBtn.textContent = autoSkipRunning ? '⏭ 自动' : '⏭ 跳过';
    skipBtn.classList.toggle('danger', autoSkipRunning);
    skipBtn.classList.toggle('orange', !autoSkipRunning);
  }

  function runAutoSkip() {
    if (!autoSkipRunning) return;
    skipVideosToEnd();
    autoSkipTimer = setTimeout(runAutoSkip, 2000);
  }

  skipBtn.addEventListener('click', e => {
    e.stopPropagation();
    autoSkipRunning = !autoSkipRunning;
    updateSkipBtn();
    if (autoSkipRunning) {
      try { chrome.runtime.sendMessage({ action: 'mwaLogActivity', app: 'Cornerstone', title: '开启自动跳过视频', detail: location.hostname }); } catch (e) { /* 扩展已重载 */ }
      runAutoSkip();
    } else {
      if (autoSkipTimer) { clearTimeout(autoSkipTimer); autoSkipTimer = null; }
    }
  });
  list.appendChild(row('跳过视频', skipBtn));

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
  btn.firstChild.textContent = isAutoClickRunning ? '停止' : '点击';
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
    btn.classList.toggle('green', !!isRunning);
    btn.style.cursor = 'pointer';
  }
  refreshCornerstoneDock();
}

// 折叠为图标时，用绿点提示自动点击 / 自动过课正在运行
function refreshCornerstoneDock() {
  globalThis.MwaDock?.get('autoClickButton')?.setActive(isAutoClickRunning || isAutoNextRunning);
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
// 自动点击只允许在 Cornerstone 首页顶层窗口运行；课程弹出页若也运行会清空共享的存储状态，导致主页面停止
function isCornerstoneHomePage() {
  return window.top === window && /medtronic\.csod\.com/.test(location.hostname) && /lms-learner-home|\/home/i.test(location.href);
}

function checkAndContinueAutoClick() {
  if (!isCornerstoneHomePage()) return;
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
        button.title = '再次点击可停止';
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
    clickedLaunchHrefs: [], launchAttempts: {}
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
  safeStorageGet(['clickedLaunchHrefs'], function (result) {
    callback(new Set(result.clickedLaunchHrefs || []));
  });
}

// 记录已点击的 Launch 按钮 href
function addClickedLaunchHref(href) {
  getClickedLaunchHrefs(function (set) {
    set.add(href);
    safeStorageSet({ clickedLaunchHrefs: Array.from(set) });
  });
}

function findAndClickMarkComplete() {
  if (!isCornerstoneHomePage()) return;
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

// ── Cornerstone 按钮查找：递归遍历 shadow DOM 与同源 iframe，兼容 a/button/role=button ──
const CORNERSTONE_BTN_PATTERNS = {
  launch: /^(launch|启动)$/i,
  markComplete: /mark\s*complete|标记.{0,4}完成|^标记$/i
};
const CORNERSTONE_BTN_SELECTOR = 'a, button, [role="button"], input[type="button"], input[type="submit"]';

function deepQueryAll(selector, root, out, depth) {
  out = out || [];
  depth = depth || 0;
  if (!root || depth > 8) return out;
  try { root.querySelectorAll(selector).forEach(el => out.push(el)); } catch (e) {}
  let all = [];
  try { all = root.querySelectorAll('*'); } catch (e) {}
  all.forEach(el => {
    if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out, depth + 1);
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      try { if (el.contentDocument) deepQueryAll(selector, el.contentDocument, out, depth + 1); } catch (e) {}
    }
  });
  return out;
}

function isCornerstoneElVisible(el) {
  try {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const r = el.getBoundingClientRect();
    const win = el.ownerDocument.defaultView;
    const cs = win.getComputedStyle(el);
    return (r.width > 0 || r.height > 0) && cs.visibility !== 'hidden' && cs.display !== 'none';
  } catch (e) { return true; }
}

function matchCornerstoneButton(el, kind) {
  const re = CORNERSTONE_BTN_PATTERNS[kind];
  const texts = [
    el.getAttribute('title'), el.getAttribute('aria-label'), el.getAttribute('data-tag'),
    el.value, (el.textContent || '').replace(/\s+/g, ' ').trim()
  ].filter(Boolean).map(s => s.trim());
  return texts.some(t => t.length <= 40 && re.test(t));
}

function findCornerstoneButtons(kind) {
  return deepQueryAll(CORNERSTONE_BTN_SELECTOR, document)
    .filter(el => matchCornerstoneButton(el, kind) && isCornerstoneElVisible(el));
}

function clickCornerstoneElement(el) {
  const win = el.ownerDocument.defaultView || window;
  const href = el.getAttribute('href');
  const isJsHref = href && href.trim().toLowerCase().startsWith('javascript');
  // 避免 javascript: href 触发 CSP，仅触发事件监听器
  if (isJsHref) el.removeAttribute('href');
  try {
    el.scrollIntoView({ block: 'center' });
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, { view: win, bubbles: true, cancelable: true }));
    });
    el.click();
  } finally {
    if (isJsHref) el.setAttribute('href', href);
  }
  cornerstoneDevLog('click', { tag: el.tagName, title: el.getAttribute('title'), text: (el.textContent || '').trim().slice(0, 40), href });
}

// ── 开发者模式（storage.devMode）：详细日志 + 诊断 + CDP 调试入口 ──
let cornerstoneDevMode = false;
let cornerstoneDevPanel = false; // 页面诊断面板默认隐藏，需要时在控制台设置 chrome.storage.local devPanel=true
safeStorageGet(['devMode', 'devPanel'], r => { cornerstoneDevMode = !!r.devMode; cornerstoneDevPanel = !!r.devPanel; });
try {
  chrome.storage.onChanged.addListener(changes => {
    if (changes.devMode) cornerstoneDevMode = !!changes.devMode.newValue;
    if (changes.devPanel) cornerstoneDevPanel = !!changes.devPanel.newValue;
  });
} catch (e) {}

function cornerstoneDevLog(event, data) {
  if (!cornerstoneDevMode) return;
  console.log('[MWA-DEV]', event, data || '');
  try {
    const log = JSON.parse(document.documentElement.dataset.mwaDevLog || '[]');
    log.push({ t: new Date().toISOString(), event, data });
    document.documentElement.dataset.mwaDevLog = JSON.stringify(log.slice(-50));
  } catch (e) {}
}

function cornerstoneDiagnose() {
  const describe = el => ({
    tag: el.tagName, title: el.getAttribute('title'), aria: el.getAttribute('aria-label'),
    text: (el.textContent || '').trim().slice(0, 40), href: el.getAttribute('href'),
    visible: isCornerstoneElVisible(el), frame: el.ownerDocument === document ? 'top' : 'iframe'
  });
  const candidates = deepQueryAll(CORNERSTONE_BTN_SELECTOR, document)
    .filter(el => /launch|complete|启动|标记|完成/i.test((el.getAttribute('title') || '') + (el.getAttribute('aria-label') || '') + (el.textContent || '')))
    .slice(0, 30).map(describe);
  const info = {
    url: location.href,
    state: { isAutoClickRunning, currentClickCount, targetClickCount, markCompleteCount },
    launch: findCornerstoneButtons('launch').map(describe),
    markComplete: findCornerstoneButtons('markComplete').map(describe),
    candidates,
    iframes: document.querySelectorAll('iframe').length
  };
  try { document.documentElement.dataset.mwaDiag = JSON.stringify(info); } catch (e) {}
  return info;
}

// 开发者模式下在页面左下角显示实时诊断（可在无 CDP 时直接查看/被无障碍树读取）
function renderCornerstoneDevPanel() {
  let el = document.getElementById('mwa-dev-panel');
  if (!cornerstoneDevMode || !cornerstoneDevPanel) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'mwa-dev-panel';
    el.style.cssText = 'position:fixed;left:110px;bottom:8px;z-index:2147483647;max-width:520px;max-height:40vh;overflow:auto;background:rgba(0,0,0,.85);color:#9f9;font:11px/1.4 Consolas,monospace;padding:6px 8px;border-radius:6px;white-space:pre-wrap';
    document.body.appendChild(el);
  }
  const d = cornerstoneDiagnose();
  const fmt = a => a.map(x => `${x.tag}[${x.frame}] "${x.title || x.aria || x.text}" vis=${x.visible}`).join('\n  ') || '(none)';
  el.textContent = `[MWA-DEV] run=${d.state.isAutoClickRunning} done=${d.state.markCompleteCount}/${d.state.targetClickCount} launchTried=${d.state.currentClickCount} iframes=${d.iframes}\nLaunch:\n  ${fmt(d.launch)}\nMarkComplete:\n  ${fmt(d.markComplete)}\nCandidates:\n  ${fmt(d.candidates.slice(0, 12))}`;
}
if (window.top === window && window.location.href.includes('medtronic.csod.com')) {
  setInterval(() => { try { renderCornerstoneDevPanel(); } catch (e) {} }, 3000);
}

// 供 MAIN world 的 dev_bridge.js 通过 postMessage 调用（CDP: window.__mwaDev.diagnose()）
if (window.top === window && window.location.href.includes('medtronic.csod.com')) {
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.source !== 'mwa-dev-req') return;
    safeStorageGet(['devMode'], r => {
      if (!r.devMode) return;
      let result;
      try {
        if (e.data.cmd === 'diagnose') result = cornerstoneDiagnose();
        else if (e.data.cmd === 'start') { document.getElementById('_autoClickInnerBtn')?.click(); result = 'toggled'; }
        else if (e.data.cmd === 'step') { continueClicking(); result = 'stepped'; }
        else if (e.data.cmd === 'click') {
          const els = findCornerstoneButtons(e.data.kind);
          if (els[0]) clickCornerstoneElement(els[0]);
          result = els.length ? 'clicked' : 'not found';
        } else if (e.data.cmd === 'log') result = JSON.parse(document.documentElement.dataset.mwaDevLog || '[]');
        else if (e.data.cmd === 'reload') { chrome.runtime.reload(); result = 'reloading'; }
      } catch (err) { result = 'error: ' + err.message; }
      window.postMessage({ source: 'mwa-dev-res', id: e.data.id, result }, '*');
    });
  });
}

// 继续执行点击逻辑的函数
const LAUNCH_MAX_PER_TARGET = 1;
const LAUNCH_COOLDOWN_MS = 90000;
let lastMarkCompleteEl = null;
let lastMarkCompleteAt = 0;
const NO_BUTTON_CHECKS_BEFORE_RELOAD = 15;
function continueClicking() {
  // ── 优先：Mark Complete / 标记完成 ──
  const markCompleteBtn = findCornerstoneButtons('markComplete')[0];

  if (markCompleteBtn) {
    // 同一个按钮 15 秒内不重复计数，避免页面还没刷新就把一次点击算成多次完成
    if (markCompleteBtn === lastMarkCompleteEl && Date.now() - lastMarkCompleteAt < 15000) {
      setTimeout(findAndClickMarkComplete, 3000);
      return;
    }
    lastMarkCompleteEl = markCompleteBtn;
    lastMarkCompleteAt = Date.now();
    if (noButtonTimeout) { clearTimeout(noButtonTimeout); noButtonTimeout = null; }
    clickCornerstoneElement(markCompleteBtn);
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
  const allLaunchButtons = findCornerstoneButtons('launch');

  console.log(`Launch 按钮总数: ${allLaunchButtons.length}, Launch尝试次数: ${currentClickCount}, 完成次数: ${markCompleteCount}/${targetClickCount}`);

  // 防死循环：总尝试上限
  if (currentClickCount >= targetClickCount * 3 + 5) {
    console.warn('Launch 尝试次数超过上限，停止自动点击以防死循环');
    cornerstoneDevLog('abort', { reason: 'launch cap', currentClickCount });
    finishAutoClick();
    return;
  }

  if (allLaunchButtons.length > 0) {
    // 每个 Launch 目标（课程卡片+href）有尝试次数上限和冷却时间，避免同一个打不完/不会变成 Mark Complete 的课程被反复打开
    safeStorageGet(['launchAttempts'], res => {
      const attempts = res.launchAttempts || {};
      const now = Date.now();
      const keyOf = b => {
        try {
          // 用按钮自带的 "Launch: 课程名" 作为稳定标识；卡片文字会随状态变化
          const label = b.getAttribute('aria-label') || b.getAttribute('title') || '';
          if (/launch.*:|启动.*:/i.test(label)) return label.trim();
          const card = b.closest('li, tr, [class*="card"], [class*="item"], [data-tag]') || b.parentElement;
          return (b.getAttribute('href') || '') + '|' + ((card && card.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        } catch (e) {
          cornerstoneDevLog('keyOf-error', String(e));
          return String(b.getAttribute('title') || '') + '|' + allLaunchButtons.indexOf(b);
        }
      };
      const btn = allLaunchButtons.find(b => {
        const a = attempts[keyOf(b)];
        return !a || ((a.n || 0) < LAUNCH_MAX_PER_TARGET && now - (a.t || 0) > LAUNCH_COOLDOWN_MS);
      });

      if (!btn) {
        consecutiveNoButtonChecks++;
        cornerstoneDevLog('launch-skipped', { buttons: allLaunchButtons.length, stall: consecutiveNoButtonChecks });
        if (consecutiveNoButtonChecks >= 20) {
          console.warn('所有 Launch 目标都已达到尝试上限，停止');
          finishAutoClick();
          return;
        }
        setTimeout(findAndClickMarkComplete, 3000);
        return;
      }

      const key = keyOf(btn);
      attempts[key] = { n: (attempts[key]?.n || 0) + 1, t: now };
      safeStorageSet({ launchAttempts: attempts });
      if (noButtonTimeout) { clearTimeout(noButtonTimeout); noButtonTimeout = null; }

      clickCornerstoneElement(btn);
      currentClickCount++;
      safeStorageSet({ currentClickCount });
      consecutiveNoButtonChecks = 0;
      console.log(`点击 Launch，Launch尝试次数=${currentClickCount}, 目标第${attempts[key].n}次, href="${btn.getAttribute('href')}"`);

      if (markCompleteCount >= targetClickCount) { finishAutoClick(); return; }
      setTimeout(findAndClickMarkComplete, 3000);
    });
    return;
  }

  // ── 没找到可点击按钮 ──
  consecutiveNoButtonChecks++;
  console.log(`未找到按钮，累计 ${consecutiveNoButtonChecks} 次`);

  // 页面（尤其是刷新后的 SPA）渲染较慢，连续约 15 秒都没有按钮才刷新，避免无限刷新循环
  if (consecutiveNoButtonChecks >= NO_BUTTON_CHECKS_BEFORE_RELOAD) {
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
    markCompleteCount: 0, clickedLaunchHrefs: [], launchAttempts: {}, noButtonRefreshAttempts: 0
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
    btn.classList.add('indigo');
    btn.classList.remove('danger');
  } else {
    isAutoNextRunning = true;
    btn.textContent = '■ 停止';
    btn.classList.add('danger');
    btn.classList.remove('indigo');
    runAutoNext();
  }
  refreshCornerstoneDock();
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
    if (!nextEl || nextEl.disabled || nextEl.getAttribute('aria-disabled') === 'true') {
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
            v.muted = true;
            v.currentTime = Math.max(0, v.duration - 0.1);
            // 暂停状态下不会触发 ended 事件，需要让它播放到末尾
            if (v.paused && !v.ended) v.play().catch(() => {});
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

  safeStorageGet(['autoClickEnabled'], function (result) {
    if (!result.autoClickEnabled) return;

    const panel = createFloatingButton();
    const clickBtn = panel._clickBtn;

    initializeButtonText();

    clickBtn.addEventListener('click', function () {
      if (isAutoClickRunning) {
        // 运行中再点一次即停止
        cleanupAutoClickState();
        chrome.runtime.sendMessage({ action: 'cornerstoneAutoClickStopped' }, () => { void chrome.runtime.lastError; });
        return;
      }
      if (!isAutoClickRunning) {
        safeStorageGet(['clickCount'], function (result) {
          const clickCount = result.clickCount || 30;
          isAutoClickRunning = true;
          currentClickCount  = 0;
          targetClickCount   = clickCount;
          markCompleteCount  = 0;

          safeStorageSet({
            isAutoClickRunning: true,
            currentClickCount: 0,
            targetClickCount: clickCount,
            markCompleteCount: 0,
            clickedLaunchHrefs: [], launchAttempts: {},
            noButtonRefreshAttempts: 0
          });

          clickBtn.title = '再次点击可停止';
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
      const currentUrl = window.location.href;
      if (currentUrl.includes('ehr.medtronic.com.cn')) {
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

// 页面刷新或重新打开时，重置 EHR 登录尝试次数。
ehrLoginAttempts = 0;
console.log('页面加载，重置 EHR 登录尝试次数');
safeStorageSet({ ehrLoginAttempts: 0 });

if (document.readyState === 'complete') {
  console.log('文档已完全加载，检查是否可以执行自动填充');
  const currentUrl = window.location.href;
  if (currentUrl.includes('ehr.medtronic.com.cn')) {
    console.log('EHR 系统，直接执行自动填充');
    autoFillCredentials();
  }
} else {
  console.log('文档尚未完全加载，添加load事件监听器');
  window.addEventListener('load', () => {
    console.log('文档加载完成，检查是否可以执行自动填充');
    const currentUrl = window.location.href;
    if (currentUrl.includes('ehr.medtronic.com.cn')) {
      console.log('EHR 系统，直接执行自动填充');
      autoFillCredentials();
    }
  });
}

// 监听存储变化
chrome.storage.onChanged.addListener((changes, namespace) => {
  console.log('检测到存储变化:', { changes, namespace });
  if (namespace === 'local') {
    if (changes.Login1 || changes.Password1) {
      console.log('用户名或密码发生变化，检查是否可以重新执行自动填充');
      const currentUrl = window.location.href;
      if (currentUrl.includes('ehr.medtronic.com.cn')) {
        ehrLoginAttempts = 0;
        ehrFillState = 'idle';
        safeStorageSet({ ehrLoginAttempts: 0 }, () => {
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
    
    ehrLoginAttempts = 0;
    console.log('重置 EHR 登录尝试计数');
    
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

  // 只处理真正的对话框；.tooltip/.popover 常驻 DOM，.close 也可能是普通按钮。
  const popupSelectors = [
    '.modal', '.modal-dialog', '[role="dialog"]', '[aria-modal="true"]',
    '.popup', '.p-dialog', '.p-overlay-panel', '.p-confirm-dialog'
  ];
  const closeButtonSelectors = [
    '.close', '.btn-close', '[data-dismiss="modal"]',
    '[aria-label="Close"]', '[aria-label="关闭"]', '[title="Close"]', '[title="关闭"]'
  ];

  function isVisible(el) {
    if (!el || !el.ownerDocument) return false;
    const view = el.ownerDocument.defaultView;
    if (!view) return false;
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function closePopupIn(doc) {
    for (const selector of popupSelectors) {
      let popup = null;
      try { popup = Array.from(doc.querySelectorAll(selector)).find(isVisible); } catch (e) {}
      if (!popup) continue;
      console.log('找到弹出窗体:', selector);
      // 只在该弹窗内部找可见的关闭按钮，避免误点页面上的其他按钮
      for (const closeSelector of closeButtonSelectors) {
        const closeBtn = Array.from(popup.querySelectorAll(closeSelector)).find(isVisible);
        if (closeBtn) {
          closeBtn.click();
          return true;
        }
      }
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      return true;
    }
    return false;
  }

  if (closePopupIn(document)) return true;
  for (const iframe of document.getElementsByTagName('iframe')) {
    try {
      const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      if (iframeDoc && closePopupIn(iframeDoc)) return true;
    } catch (error) {}
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
  safeStorageGet(['autoClickEnabled'], function (result) {
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
