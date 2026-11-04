document.addEventListener('DOMContentLoaded', () => {
  const username = document.getElementById('username');
  const password = document.getElementById('password');
  const status = document.getElementById('status');

  chrome.storage.local.get(['username', 'password', 'dailyOpenEnabled', 'dailyOpenTime'], (result) => {
    username.value = result.username || '';
    password.value = result.password || '';
    document.getElementById('dailyOpenEnabled').checked = Boolean(result.dailyOpenEnabled);
    document.getElementById('dailyOpenTime').value = result.dailyOpenTime || '09:00';
  });

  document.getElementById('togglePassword').addEventListener('click', () => {
    const visible = password.type === 'text';
    password.type = visible ? 'password' : 'text';
    document.getElementById('togglePassword').textContent = visible ? '显示' : '隐藏';
  });

  document.getElementById('save').addEventListener('click', () => {
    if (!username.value.trim() || !password.value) {
      showStatus('请填写用户名和密码', 'error');
      return;
    }
    chrome.storage.local.set({ username: username.value.trim(), password: password.value }, () => {
      showStatus('Windchill 登录设置已保存');
    });
  });

  document.getElementById('dailyOpenEnabled').addEventListener('change', (event) => {
    chrome.storage.local.set({ dailyOpenEnabled: event.target.checked }, () => {
      showStatus(event.target.checked ? '每日自动打开已开启' : '每日自动打开已关闭');
    });
  });

  document.getElementById('saveTime').addEventListener('click', () => {
    const time = document.getElementById('dailyOpenTime').value;
    if (!time) {
      showStatus('请选择有效时间', 'error');
      return;
    }
    chrome.storage.local.set({ dailyOpenTime: time }, () => showStatus('每日打开时间已保存'));
  });

  function showStatus(message, type = '') {
    status.textContent = message;
    status.className = type;
    setTimeout(() => { status.textContent = ''; }, 2600);
  }
});
