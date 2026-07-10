// Background script for handling new tab monitoring and closing

let monitoredUrls = new Set();
let mainTabId = null;
let cornerstonePopupCandidateTabIds = new Set();

// 记录所有 SCORM 相关 tab
let scormTabIds = new Set();

// ── 注入视频控制到指定 tab ──
function injectVideoControl(tabId, action) {
  const code = action === 'skip'
    ? `(function(){
        function skipAll(doc){
          try{
            doc.querySelectorAll('video').forEach(v=>{
              if(v.duration&&isFinite(v.duration)){v.currentTime=v.duration-0.1;}
            });
          }catch(e){}
          try{
            Array.from(doc.querySelectorAll('iframe')).forEach(f=>{
              try{skipAll(f.contentDocument||f.contentWindow.document);}catch(e){}
            });
          }catch(e){}
        }
        skipAll(document);
      })()`
    : `(function(speed){
        function applyAll(doc){
          try{
            doc.querySelectorAll('video').forEach(v=>{
              try{v.playbackRate=speed;}catch(e){}
            });
          }catch(e){}
          try{
            Array.from(doc.querySelectorAll('iframe')).forEach(f=>{
              try{applyAll(f.contentDocument||f.contentWindow.document);}catch(e){}
            });
          }catch(e){}
        }
        applyAll(document);
      })(${action})`;

  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: action === 'skip'
      ? function() {
          document.querySelectorAll('video').forEach(v => {
            if (v.duration && isFinite(v.duration)) v.currentTime = v.duration - 0.1;
          });
        }
      : new Function(`document.querySelectorAll('video').forEach(v=>{try{v.playbackRate=${action};}catch(e){}});`)
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background script received message:', request);

  if (request.action === 'monitorNewTab') {
    const url = request.url;
    if (sender && sender.tab && sender.tab.id) {
      mainTabId = sender.tab.id;
    }
    monitoredUrls.add(url);
    sendResponse({ success: true });
  }

  if (request.action === 'cornerstoneAutoClickStarted') {
    if (sender && sender.tab && sender.tab.id) {
      mainTabId = sender.tab.id;
    }
    sendResponse({ success: true });
  }

  // 视频跳过：注入到所有 SCORM tab
  if (request.action === 'videoSkip') {
    const targets = scormTabIds.size > 0 ? [...scormTabIds] : [];
    // 也包含发送方 tab
    if (sender && sender.tab && sender.tab.id) targets.push(sender.tab.id);
    const unique = [...new Set(targets)];
    unique.forEach(tabId => {
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          document.querySelectorAll('video').forEach(v => {
            try { if (v.duration && isFinite(v.duration)) v.currentTime = v.duration - 0.1; } catch(e) {}
          });
        }
      }).catch(() => {});
    });
    sendResponse({ success: true, tabs: unique.length });
  }

  // 视频变速：注入到所有 SCORM tab
  if (request.action === 'videoSpeed') {
    const speed = request.speed || 1;
    const targets = scormTabIds.size > 0 ? [...scormTabIds] : [];
    if (sender && sender.tab && sender.tab.id) targets.push(sender.tab.id);
    const unique = [...new Set(targets)];
    unique.forEach(tabId => {
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (s) => {
          document.querySelectorAll('video').forEach(v => {
            try { v.playbackRate = s; } catch(e) {}
          });
        },
        args: [speed]
      }).catch(() => {});
    });
    sendResponse({ success: true, tabs: unique.length });
  }

  return true;
});

function shouldCloseCornerstonePopup(tab) {
  if (!tab || !tab.id || mainTabId === null || tab.id === mainTabId) return false;

  const url = tab.url || '';
  const pendingUrl = tab.pendingUrl || '';
  const combinedUrl = `${url} ${pendingUrl}`;
  const openedFromMainTab = tab.openerTabId === mainTabId || cornerstonePopupCandidateTabIds.has(tab.id);

  if (openedFromMainTab) return true;

  if (combinedUrl.includes('medtronic.csod.com') && cornerstonePopupCandidateTabIds.has(tab.id)) {
    return true;
  }

  return false;
}

function closeCornerstonePopupTab(tabId, reason, delay = 2000) {
  if (!tabId || tabId === mainTabId) return;
  setTimeout(() => {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || !tab || tab.id === mainTabId) return;
      console.log(`Closing Cornerstone popup tab (${reason}):`, tab.url || tab.pendingUrl || tab.id);
      chrome.tabs.remove(tabId, () => {
        cornerstonePopupCandidateTabIds.delete(tabId);
        if (chrome.runtime.lastError) {
          console.log('Close Cornerstone popup failed:', chrome.runtime.lastError.message);
        }
      });
    });
  }, delay);
}

// 只关闭新建且不是主tabId的标签页
chrome.tabs.onCreated.addListener((tab) => {
  console.log('New tab created:', tab.url, 'tabId:', tab.id);
  // 记录 SCORM tab
  if (tab.url && tab.url.includes('medtronic.csod.com')) {
    scormTabIds.add(tab.id);
  }

  if (mainTabId !== null && tab.id !== mainTabId && tab.openerTabId === mainTabId) {
    cornerstonePopupCandidateTabIds.add(tab.id);
    closeCornerstonePopupTab(tab.id, 'opened from Cornerstone main tab');
  }

  for (const monitoredUrl of monitoredUrls) {
    if (tab.url && (tab.url.includes(monitoredUrl) || tab.url.includes(monitoredUrl.replace('javascript:void(0);', '')))) {
      if (mainTabId !== null && tab.id !== mainTabId) {
        console.log('Found monitored URL in new tab, closing:', tab.url);
        setTimeout(() => {
          chrome.tabs.remove(tab.id, () => {
            console.log('New tab closed:', tab.id);
          });
        }, 2000);
        monitoredUrls.delete(monitoredUrl);
      }
      break;
    }
  }
});

// 只关闭新建且不是主tabId的标签页
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 记录 SCORM tab
  if (tab.url && tab.url.includes('medtronic.csod.com')) {
    scormTabIds.add(tabId);
  }

  if (shouldCloseCornerstonePopup(tab)) {
    closeCornerstonePopupTab(tabId, 'Cornerstone popup updated');
    return;
  }

  if (changeInfo.status === 'complete' && tab.url) {
    for (const monitoredUrl of monitoredUrls) {
      if (tab.url.includes(monitoredUrl) || tab.url.includes(monitoredUrl.replace('javascript:void(0);', ''))) {
        if (mainTabId !== null && tabId !== mainTabId) {
          console.log('Found monitored URL, closing tab:', tab.url);
          setTimeout(() => {
            chrome.tabs.remove(tabId, () => {
              console.log('Tab closed:', tabId);
            });
          }, 2000);
          monitoredUrls.delete(monitoredUrl);
        }
        break;
      }
    }
  }
});

// tab 关闭时清理 scormTabIds
chrome.tabs.onRemoved.addListener((tabId) => {
  scormTabIds.delete(tabId);
  cornerstonePopupCandidateTabIds.delete(tabId);
});

// 缓存的凭据
let cachedCredentials = {
  username: '',
  password: ''
};

// 更新缓存的凭据
function updateCachedCredentials() {
  chrome.storage.local.get(['username', 'password'], (result) => {
    if (result.username && result.password) {
      cachedCredentials.username = result.username;
      cachedCredentials.password = result.password;
      console.log('Credentials cached for Basic Auth');
    }
  });
}

// 初始化时获取凭据
updateCachedCredentials();

// 监听存储变化自动更新缓存
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.username || changes.password)) {
    updateCachedCredentials();
  }
});

// 监听 Basic Auth 认证请求
chrome.webRequest.onAuthRequired.addListener(
  function (details) {
    console.log('Auth required for:', details.url);
    if (details.url.includes('khplm.medtronic.com.cn') && cachedCredentials.username && cachedCredentials.password) {
      console.log('Providing cached credentials for Windchill');
      return {
        authCredentials: {
          username: cachedCredentials.username,
          password: cachedCredentials.password
        }
      };
    }
    return {};
  },
  { urls: ["https://khplm.medtronic.com.cn/*"] },
  ["blocking"]
);

console.log('Background script loaded');

// 注册右键菜单
function updateContextMenu() {
  chrome.storage.local.get(['autoClickEnabled', 'autoClosePopup'], function (result) {
    const enabled = !!result.autoClickEnabled;
    const popupEnabled = !!result.autoClosePopup;
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'toggleAutoClick',
        title: enabled ? '🟢 自动点击已开启 (点击关闭)' : '⚪ 自动点击已关闭 (点击开启)',
        contexts: ['action']
      });

      chrome.contextMenus.create({
        id: 'toggleAutoClosePopup',
        title: popupEnabled ? '🟢 自动关闭弹窗已开启 (点击关闭)' : '⚪ 自动关闭弹窗已关闭 (点击开启)',
        contexts: ['action']
      });

      // 添加分隔线
      chrome.contextMenus.create({
        id: 'separator',
        type: 'separator',
        contexts: ['action']
      });

      // 添加中止所有指令选项
      chrome.contextMenus.create({
        id: 'stopAllActions',
        title: '🛑 中止所有插件指令',
        contexts: ['action']
      });
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  updateContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'toggleAutoClick') {
    chrome.storage.local.get(['autoClickEnabled'], function (result) {
      const enabled = !!result.autoClickEnabled;
      chrome.storage.local.set({ autoClickEnabled: !enabled }, () => {
        updateContextMenu();

        // 刷新所有已打开的 Cornerstone 页面
        chrome.tabs.query({ url: "*://medtronic.csod.com/*" }, (tabs) => {
          tabs.forEach(tab => {
            console.log('刷新 Cornerstone 页面:', tab.url);
            chrome.tabs.reload(tab.id);
          });
        });
      });
    });
  }

  if (info.menuItemId === 'toggleAutoClosePopup') {
    chrome.storage.local.get(['autoClosePopup'], function (result) {
      const popupEnabled = !!result.autoClosePopup;
      chrome.storage.local.set({ autoClosePopup: !popupEnabled }, () => {
        updateContextMenu();

        // 刷新所有已打开的 Cornerstone 页面
        chrome.tabs.query({ url: "*://medtronic.csod.com/*" }, (tabs) => {
          tabs.forEach(tab => {
            console.log('刷新 Cornerstone 页面:', tab.url);
            chrome.tabs.reload(tab.id);
          });
        });
      });
    });
  }

  if (info.menuItemId === 'stopAllActions') {
    console.log('用户请求中止所有插件指令');
    
    // 清理所有自动点击相关状态
    chrome.storage.local.set({
      isAutoClickRunning: false,
      currentClickCount: 0,
      targetClickCount: 0,
      clickedLaunchHrefs: [],
      noButtonRefreshAttempts: 0,
      windchillLoginAttempts: 0,
      ehrLoginAttempts: 0
    }, () => {
      console.log('已清理所有运行状态');
      
      // 向所有相关页面发送停止指令
      const targetUrls = [
        "*://khplm.medtronic.com.cn/*",
        "*://medtronic.csod.com/*",
        "*://ehr.medtronic.com.cn/*"
      ];
      
      targetUrls.forEach(urlPattern => {
        chrome.tabs.query({ url: urlPattern }, (tabs) => {
          tabs.forEach(tab => {
            console.log('向页面发送停止指令:', tab.url);
            chrome.tabs.sendMessage(tab.id, { action: 'stopAllActions' }, (response) => {
              if (chrome.runtime.lastError) {
                console.log('发送消息失败:', chrome.runtime.lastError.message);
              } else {
                console.log('停止指令已发送到:', tab.url);
              }
            });
          });
        });
      });
      
      // 显示通知
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Medtronic Smart Assistant',
        message: '所有插件指令已中止',
        priority: 2
      });
    });
  }
});

// 监听设置变化，动态更新菜单和定时任务
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.autoClickEnabled) {
      updateContextMenu();
    }
    if (changes.dailyOpenEnabled || changes.dailyOpenTime) {
      updateDailyAlarm();
    }
  }
});

// 计算下一个运行时间
function getNextRunTime(targetTimeStr = "09:00") {
  const [hours, minutes] = targetTimeStr.split(':').map(Number);
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(hours, minutes, 0, 0);

  // 如果今天已经过了设定时间，则设为明天
  if (now > nextRun) {
    nextRun.setDate(now.getDate() + 1);
  }
  return nextRun.getTime();
}

// 更新定时任务
function updateDailyAlarm() {
  chrome.storage.local.get(['dailyOpenEnabled', 'dailyOpenTime'], (result) => {
    if (result.dailyOpenEnabled) {
      // 默认 09:00
      const timeStr = result.dailyOpenTime || "09:00";
      chrome.alarms.create('dailyOpenPages', {
        when: getNextRunTime(timeStr),
        periodInMinutes: 1440 // 24小时
      });
      console.log(`Daily alarm set for: ${new Date(getNextRunTime(timeStr)).toLocaleString()} (Target: ${timeStr})`);
    } else {
      chrome.alarms.clear('dailyOpenPages');
      console.log('Daily alarm cleared');
    }
  });
}

// 监听定时任务触发
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dailyOpenPages') {
    console.log('Daily alarm triggered, opening pages...');
    const urls = [
      'https://khplm.medtronic.com.cn/Windchill/app/#ptc1/homepage',
      'http://ehr.medtronic.com.cn/'
    ];

    urls.forEach(url => {
      chrome.tabs.create({ url: url });
    });
  }
});

// 初始化或更新定时器
updateDailyAlarm();
