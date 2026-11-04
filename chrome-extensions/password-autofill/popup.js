document.addEventListener('DOMContentLoaded', function () {
  // 版本号取自 manifest，避免与发布版本不一致
  const version = document.querySelector('.version');
  if (version) version.textContent = 'v' + chrome.runtime.getManifest().version;

  // 密码显示/隐藏
  document.querySelectorAll('.toggle-password').forEach(button => {
    button.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const input = document.getElementById(this.getAttribute('data-target'));
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      this.textContent = hidden ? '隐藏' : '显示';
    });
  });

  // 应用行：左侧打开网页，右侧 +/− 展开配置
  document.querySelectorAll('.app').forEach(card => {
    const url = card.getAttribute('data-url');
    const open = card.querySelector('.app-open');
    const toggle = card.querySelector('.app-toggle');
    if (open && url) open.addEventListener('click', () => chrome.tabs.create({ url }));
    if (toggle) toggle.addEventListener('click', () => card.classList.toggle('open'));
  });

  // 通用：复选框直接读写 storage
  function bindSwitch(id, key, onText) {
    const el = document.getElementById(id);
    chrome.storage.local.get([key], r => { el.checked = !!r[key]; });
    el.addEventListener('change', () => {
      chrome.storage.local.set({ [key]: el.checked }, () => showStatus(`${onText}${el.checked ? '已开启' : '已关闭'}`, 'success'));
    });
  }
  bindSwitch('autoClickEnabled', 'autoClickEnabled', '自动点击面板');
  bindSwitch('autoClosePopup', 'autoClosePopup', '自动关闭课程弹窗');
  bindSwitch('devModeToggle', 'devMode', '开发者模式');
  bindSwitch('dailyOpenSwitch', 'dailyOpenEnabled', 'EHR 每日打开');

  chrome.storage.local.get(['dailyOpenTime'], r => {
    if (r.dailyOpenTime) document.getElementById('dailyOpenTime').value = r.dailyOpenTime;
  });

  document.getElementById('stopAll').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopAllFromPopup' }, () => {
      void chrome.runtime.lastError;
      showStatus('已中止所有插件指令', 'success');
    });
  });

  // Windchill 设置
  const wcUser = document.getElementById('windchillUsername');
  const wcPass = document.getElementById('windchillPassword');
  const wcDailyEnabled = document.getElementById('windchillDailyOpenEnabled');
  const wcDailyTime = document.getElementById('windchillDailyOpenTime');
  chrome.storage.local.get(['windchillUsername', 'windchillPassword', 'windchillDailyOpenEnabled', 'windchillDailyOpenTime'], function (result) {
    wcUser.value = result.windchillUsername || '';
    wcPass.value = result.windchillPassword || '';
    wcDailyEnabled.checked = !!result.windchillDailyOpenEnabled;
    wcDailyTime.value = result.windchillDailyOpenTime || '09:00';
  });
  document.getElementById('saveWindchill').addEventListener('click', function () {
    if (!!wcUser.value.trim() !== !!wcPass.value) {
      showStatus('用户名和密码需同时填写，或同时留空', 'error');
      return;
    }
    chrome.storage.local.set({ windchillUsername: wcUser.value.trim(), windchillPassword: wcPass.value }, () => {
      showStatus('Windchill 登录设置已保存', 'success');
    });
  });
  wcDailyEnabled.addEventListener('change', function () {
    chrome.storage.local.set({ windchillDailyOpenEnabled: wcDailyEnabled.checked }, () => {
      showStatus(wcDailyEnabled.checked ? 'Windchill 每日打开已开启' : 'Windchill 每日打开已关闭', 'success');
    });
  });
  document.getElementById('saveWindchillTime').addEventListener('click', function () {
    if (!wcDailyTime.value) {
      showStatus('请选择有效时间', 'error');
      return;
    }
    chrome.storage.local.set({ windchillDailyOpenTime: wcDailyTime.value }, () => {
      showStatus('Windchill 每日打开时间已保存', 'success');
    });
  });

  // Fabriq AI 设置
  const aiBase = document.getElementById('aiBaseUrl');
  const aiProvider = document.getElementById('aiProvider');
  const aiModel = document.getElementById('aiModel');
  const aiKey = document.getElementById('aiKey');
  const aiModels = document.getElementById('aiModels');
  const aiModelStatus = document.getElementById('aiModelStatus');
  const refreshModels = document.getElementById('refreshAiModels');
  chrome.storage.local.get(['fabriqAi'], r => {
    const c = r.fabriqAi || {};
    aiBase.value = c.baseUrl || '';
    aiProvider.value = c.provider || 'openai';
    aiModel.value = c.model || '';
    aiKey.value = c.key || '';
  });
  function readAiConfig() {
    const url = new URL(aiBase.value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('接口地址需为不含账号、查询参数或片段的 HTTPS 地址');
    }
    if (!aiKey.value.trim()) throw new Error('请填写 API Key');
    const provider = aiProvider.value;
    if (url.origin === 'https://api.gpt.medtronic.com' &&
        /^\/providers\/(?:openai|anthropic)\/v1\/?$/.test(url.pathname)) {
      url.pathname = `/providers/${provider}/v1`;
    }
    return { baseUrl: url.href.replace(/\/$/, ''), provider, model: aiModel.value.trim(), key: aiKey.value.trim() };
  }
  function aiPermission(config, callback) {
    chrome.permissions.request({ origins: [new URL(config.baseUrl).origin + '/*'] }, granted => {
      if (chrome.runtime.lastError || !granted) {
        aiModelStatus.textContent = '未授权访问该接口地址';
        showStatus('未授权访问该接口地址', 'error');
      } else callback();
    });
  }
  aiProvider.addEventListener('change', () => {
    if (/^https:\/\/api\.gpt\.medtronic\.com\/providers\/(?:openai|anthropic)\/v1\/?$/.test(aiBase.value.trim())) {
      aiBase.value = `https://api.gpt.medtronic.com/providers/${aiProvider.value}/v1`;
    }
    aiModel.value = '';
    aiModels.replaceChildren();
    aiModelStatus.textContent = '接口类型已切换，请刷新模型列表后选择模型并保存';
  });
  aiBase.addEventListener('input', () => {
    aiModels.replaceChildren();
    aiModelStatus.textContent = '接口地址已修改，请刷新模型列表';
  });
  refreshModels.addEventListener('click', () => {
    let config;
    try { config = readAiConfig(); }
    catch (error) { showStatus(error.message, 'error'); return; }
    aiPermission(config, async () => {
      refreshModels.disabled = true;
      aiModelStatus.textContent = '正在查询该接口实际开放的模型…';
      try {
        const response = await chrome.runtime.sendMessage({ action: 'fabriqAiModels', config });
        if (!response?.ok) throw new Error(response?.error || '模型列表查询失败');
        const current = readAiConfig();
        if (current.baseUrl !== config.baseUrl || current.provider !== config.provider || current.key !== config.key) {
          throw new Error('设置已更改，请重新刷新模型列表');
        }
        aiModels.replaceChildren(...response.data.map(model => {
          const option = document.createElement('option');
          option.value = model.id;
          option.label = model.name;
          return option;
        }));
        aiModelStatus.textContent = `已获取 ${response.data.length} 个文本模型，可从模型输入框列表中选择`;
      } catch (error) {
        aiModelStatus.textContent = error.message;
        showStatus(error.message, 'error');
      } finally { refreshModels.disabled = false; }
    });
  });
  document.getElementById('saveAi').addEventListener('click', function () {
    let config;
    try {
      config = readAiConfig();
      if (!config.model) throw new Error('请选择或输入模型 ID');
    } catch (error) { showStatus(error.message, 'error'); return; }
    aiPermission(config, () => {
      chrome.storage.local.set({ fabriqAi: config }, () => {
        if (chrome.runtime.lastError) showStatus('AI 设置保存失败', 'error');
        else showStatus('AI 设置已保存', 'success');
      });
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

  // 开发者模式在 bindSwitch 中处理

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

  // Ctrl/Cmd + S 保存当前展开卡片的第一个保存按钮
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      document.querySelector('.app.open button.save')?.click();
    }
  });

  // 输入框回车保存
  document.querySelectorAll('.app input').forEach(input => {
    input.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') input.closest('.field')?.parentElement.querySelector('button.save')?.click();
    });
  });
});
