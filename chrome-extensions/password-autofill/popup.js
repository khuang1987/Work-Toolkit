document.addEventListener('DOMContentLoaded', function () {
  // 密码显示/隐藏功能
  const togglePasswordButtons = document.querySelectorAll('.toggle-password');
  togglePasswordButtons.forEach(button => {
    button.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      
      const targetId = this.getAttribute('data-target');
      const input = document.getElementById(targetId);
      
      if (input.type === 'password') {
        input.type = 'text';
        this.textContent = '🙈'; // 隐藏图标
        this.title = '隐藏密码';
      } else {
        input.type = 'password';
        this.textContent = '👁️'; // 显示图标
        this.title = '显示密码';
      }
    });
  });

  // 系统卡片交互逻辑
  const systemCards = document.querySelectorAll('.system-card');
  
  systemCards.forEach(card => {
    const clickArea = card.querySelector('.click-area');
    const expandArea = card.querySelector('.expand-area');
    const url = card.getAttribute('data-url');
    
    // 左侧2/3区域：点击打开网页（如果有URL）
    if (clickArea && url) {
      clickArea.addEventListener('click', function(e) {
        // 如果点击的是开关，不处理
        if (e.target.closest('.toggle-switch')) {
          return;
        }
        e.stopPropagation();
        chrome.tabs.create({ url: url });
      });
    }
    
    // 右侧1/3区域：点击展开/收起设置
    if (expandArea) {
      expandArea.addEventListener('click', function(e) {
        e.stopPropagation();
        card.classList.toggle('expanded');
      });
    }
  });

  // 每日自动打开开关特殊处理
  const dailyOpenSwitch = document.getElementById('dailyOpenSwitch');
  const dailySettings = document.getElementById('dailySettings');
  
  // 初始化每日自动打开状态
  chrome.storage.local.get(['dailyOpenEnabled', 'dailyOpenTime'], function (result) {
    dailyOpenSwitch.checked = !!result.dailyOpenEnabled;
    if (result.dailyOpenTime) {
      document.getElementById('dailyOpenTime').value = result.dailyOpenTime;
    }
    
    // 默认不展开，即使开关是打开的
    // 用户需要手动点击下拉箭头才能展开
  });

  // 开关切换事件
  dailyOpenSwitch.addEventListener('change', function () {
    const enabled = dailyOpenSwitch.checked;
    chrome.storage.local.set({ dailyOpenEnabled: enabled }, () => {
      showStatus(enabled ? '每日自动打开已开启' : '每日自动打开已关闭', enabled ? 'success' : '');
      
      // 不自动展开/收起设置区域，由用户手动控制
    });
  });

  // Windchill设置
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const saveButton = document.getElementById('save');

  // 加载保存的Windchill设置
  chrome.storage.local.get(['username', 'password'], function (result) {
    if (result.username) {
      usernameInput.value = result.username;
    }
    if (result.password) {
      passwordInput.value = result.password;
    }
  });

  // 保存Windchill设置
  saveButton.addEventListener('click', function () {
    const username = usernameInput.value;
    const password = passwordInput.value;

    chrome.storage.local.set({
      username: username,
      password: password
    }, function () {
      showStatus('Windchill设置已保存', 'success');
    });
  });

  // Cornerstone点击次数设置
  const clickCountInput = document.getElementById('clickCount');
  const saveClickCountButton = document.getElementById('saveClickCount');

  // 加载保存的点击次数
  chrome.storage.local.get(['clickCount'], function (result) {
    if (result.clickCount) {
      clickCountInput.value = result.clickCount;
    }
  });

  // 保存点击次数设置
  saveClickCountButton.addEventListener('click', function () {
    const clickCount = parseInt(clickCountInput.value);
    if (isNaN(clickCount) || clickCount < 1 || clickCount > 100) {
      showStatus('请输入1-100之间的数字', 'error');
      return;
    }

    chrome.storage.local.set({
      clickCount: clickCount
    }, function () {
      showStatus('点击次数设置已保存', 'success');
    });
  });

  // EHR设置
  const ehrUsernameInput = document.getElementById('ehrUsername');
  const ehrPasswordInput = document.getElementById('ehrPassword');
  const saveEhrButton = document.getElementById('saveEhr');

  // 加载保存的EHR设置
  chrome.storage.local.get(['Login1', 'Password1'], function (items) {
    if (items.Login1) {
      ehrUsernameInput.value = items.Login1;
    }
    if (items.Password1) {
      ehrPasswordInput.value = items.Password1;
    }
  });

  // 保存EHR设置
  saveEhrButton.addEventListener('click', function () {
    const ehrUsername = ehrUsernameInput.value;
    const ehrPassword = ehrPasswordInput.value;

    chrome.storage.local.set({
      'Login1': ehrUsername,
      'Password1': ehrPassword
    }, function () {
      showStatus('EHR设置已保存', 'success');
    });
  });

  // 每日自动打开时间设置
  const dailyOpenTimeInput = document.getElementById('dailyOpenTime');
  const saveTimeButton = document.getElementById('saveTime');

  // 保存时间事件
  saveTimeButton.addEventListener('click', function () {
    const time = dailyOpenTimeInput.value;
    if (!time) {
      showStatus('请选择有效时间', 'error');
      return;
    }
    chrome.storage.local.set({ dailyOpenTime: time }, () => {
      showStatus('启动时间已保存', 'success');
    });
  });

  // Planner主题设置
  const themeToggleBtn = document.getElementById('themeToggleBtn');

  // 加载保存的主题设置
  chrome.storage.sync.get(['panelTheme'], function (result) {
    const theme = result.panelTheme || 'dark';
    themeToggleBtn.textContent = theme === 'light' ? '☀️' : '🌙';
    themeToggleBtn.title = theme === 'light' ? '切换到深色主题' : '切换到浅色主题';
  });

  // 主题按钮点击事件
  themeToggleBtn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    
    chrome.storage.sync.get(['panelTheme'], function (result) {
      const currentTheme = result.panelTheme || 'dark';
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      
      themeToggleBtn.textContent = newTheme === 'light' ? '☀️' : '🌙';
      themeToggleBtn.title = newTheme === 'light' ? '切换到深色主题' : '切换到浅色主题';
      
      // 添加缩放动画（更subtle）
      themeToggleBtn.style.transform = 'scale(1.2)';
      setTimeout(() => {
        themeToggleBtn.style.transform = 'scale(1)';
      }, 150);
      
      chrome.storage.sync.set({ panelTheme: newTheme }, () => {
        showStatus(newTheme === 'light' ? '已切换到浅色主题 ☀️' : '已切换到深色主题 🌙', 'success');
      });
    });
  });

  // Workday 绩效评估/提交自动化
  function startWorkdayAction(action) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab || !tab.url || !tab.url.includes('myworkday.com')) {
          showStatus('请先切换到 Workday 页面', 'error');
          return;
        }
        chrome.tabs.sendMessage(tab.id, { action }, () => {
          if (chrome.runtime.lastError) {
            // content script 可能还没注入，用 scripting 注入后再发消息
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content_workday.js']
            }, () => {
              setTimeout(() => {
                chrome.tabs.sendMessage(tab.id, { action });
              }, 500);
            });
          }
          showStatus('自动化已启动，查看页面右下角面板', 'success');
          window.close();
        });
      });
  }

  const startWorkdayBtn = document.getElementById('startWorkdayAuto');
  if (startWorkdayBtn) {
    startWorkdayBtn.addEventListener('click', function () {
      startWorkdayAction('startWorkdayAuto');
    });
  }

  const startWorkdaySubmitBtn = document.getElementById('startWorkdaySubmit');
  if (startWorkdaySubmitBtn) {
    startWorkdaySubmitBtn.addEventListener('click', function () {
      startWorkdayAction('startWorkdaySubmit');
    });
  }

  // 状态显示函数
  function showStatus(message, type) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = 'status ' + type;
    status.style.display = 'block';
    
    // 自动隐藏
    setTimeout(function () {
      status.style.display = 'none';
    }, 2500);
  }

  // 添加键盘快捷键支持
  document.addEventListener('keydown', function(e) {
    // Ctrl/Cmd + S 保存当前展开的设置
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      const expandedCard = document.querySelector('.system-card.expanded');
      if (expandedCard) {
        const saveButton = expandedCard.querySelector('button');
        if (saveButton) {
          saveButton.click();
        }
      }
    }
  });

  // 添加输入框回车保存功能
  document.querySelectorAll('input').forEach(input => {
    input.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        const card = input.closest('.system-card');
        if (card) {
          const saveButton = card.querySelector('button');
          if (saveButton) {
            saveButton.click();
          }
        }
      }
    });
  });
});
