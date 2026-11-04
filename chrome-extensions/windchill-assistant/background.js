// Windchill 助手后台：提供 Basic Auth 凭据和可选的每日打开。

// 同一请求只提交一次凭据，密码错误时不让 Chrome 反复重试导致账号锁定
const authTried = new Set();

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (authTried.has(details.requestId)) {
      callback({});
      return;
    }
    chrome.storage.local.get(['username', 'password'], (result) => {
      if (!result.username || !result.password) {
        callback({});
        return;
      }
      authTried.add(details.requestId);
      if (authTried.size > 200) authTried.delete(authTried.values().next().value);
      callback({ authCredentials: { username: result.username, password: result.password } });
    });
  },
  { urls: ['https://khplm.medtronic.com.cn/*'] },
  ['asyncBlocking']
);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.dailyOpenEnabled || changes.dailyOpenTime)) updateDailyAlarm();
});
function nextRunTime(time = '09:00') {
  const [hours, minutes] = time.split(':').map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number.isFinite(hours) ? hours : 9, Number.isFinite(minutes) ? minutes : 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function updateDailyAlarm() {
  chrome.storage.local.get(['dailyOpenEnabled', 'dailyOpenTime'], (result) => {
    if (!result.dailyOpenEnabled) {
      chrome.alarms.clear('windchillDailyOpen');
      return;
    }
    chrome.alarms.create('windchillDailyOpen', {
      when: nextRunTime(result.dailyOpenTime || '09:00'),
      periodInMinutes: 1440
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'windchillDailyOpen') {
    chrome.tabs.create({ url: 'https://khplm.medtronic.com.cn/Windchill/app/#ptc1/homepage' });
  }
});

function updateContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'stopWindchillActions',
      title: '停止 Windchill 自动填充',
      contexts: ['action']
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  updateContextMenu();
  updateDailyAlarm();
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'stopWindchillActions') return;
  chrome.tabs.query({ url: 'https://khplm.medtronic.com.cn/*' }, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { action: 'stopWindchillActions' }, () => {});
    });
  });
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title: 'Windchill 助手',
    message: '已停止 Windchill 自动填充',
    priority: 1
  });
});

updateDailyAlarm();
