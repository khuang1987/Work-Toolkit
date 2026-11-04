// ── 待办同步：定时读取 Windchill / EHR 待审批数量、Fabriq 未读通知，推送给本机工作工具箱 ──
// 只发送到 127.0.0.1，不离开本机。工具箱未运行时静默失败。

const PENDING_SYNC_ALARM = 'pendingSync';
const PENDING_SYNC_MINUTES = 10;
const TOOLBOX_ENDPOINT = 'http://127.0.0.1:47821/pending';
const WINDCHILL_ORIGIN = 'https://khplm.medtronic.com.cn';
const WINDCHILL_TASKS_URL = `${WINDCHILL_ORIGIN}/Windchill/app/#ptc1/homepage`;
const EHR_ORIGIN = 'http://ehr.medtronic.com.cn';
const FABRIQ_ORIGIN = 'https://medtronic.fabriq.tech';
const FABRIQ_TOKEN_KEY = 'fabriqAccessToken';
const EHR_FLOWS = [
  { code: 'QK01', table: 't_hr_bk', sort: 'ID', label: '补卡审批' },
  { code: 'PLQJ01', table: 'T_OA_QJMst', sort: 'ID', label: '批量请假' },
  { code: 'JB01', table: 'T_HR_jiaban', sort: 'ID', label: '个人加班' },
  { code: 'GRPLJB001', table: 'T_OA_GRJBOverTimeMst', sort: 'OTNO', label: '个人批量加班' },
  { code: 'PLJB06', table: 'T_OA_JBOverTimeMst', sort: 'OTNO', label: '批量加班(考勤员专用)' }
];

function pendingText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return pendingText(value.Display ?? value.Value ?? value.Name ?? '');
  return String(value).trim();
}

function pendingPick(obj, keys) {
  for (const key of keys) {
    const text = pendingText(obj && obj[key]);
    if (text) return text;
  }
  return '';
}

async function fetchWithTimeout(url, options = {}, ms = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response, label) {
  const body = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${label} 未登录或会话已过期`);
  }
}

async function collectWindchillPending() {
  const params = new URLSearchParams({
    '$filter': "Status/Display eq 'Potential'",
    '$expand': 'Activity,Subject',
    '$top': '100'
  });
  const response = await fetchWithTimeout(
    `${WINDCHILL_ORIGIN}/Windchill/servlet/odata/Workflow/WorkItems?${params}`,
    { credentials: 'include', headers: { Accept: 'application/json' } }
  );
  const payload = await readJson(response, 'Windchill');
  const rows = Array.isArray(payload) ? payload : (payload.value || []);
  return rows.map((item) => {
    const activity = item.Activity || {};
    const subject = item.Subject || {};
    const title = pendingPick(activity, ['Name', 'Title']) || pendingPick(item, ['Name']) || 'Windchill 审批任务';
    const number = pendingPick(subject, ['Number', 'Name']);
    const name = pendingPick(subject, ['Name', 'Title']);
    return {
      title,
      subtitle: [number, name && name !== number ? name : ''].filter(Boolean).join(' · '),
      time: pendingPick(item, ['CreatedOn', 'CreateTimestamp']),
      url: WINDCHILL_TASKS_URL
    };
  });
}

async function postEhr(path, params) {
  const response = await fetchWithTimeout(`${EHR_ORIGIN}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams(params).toString()
  });
  return readJson(response, 'EHR');
}

async function collectEhrPending() {
  const flows = EHR_FLOWS.slice();
  const known = new Set(flows.map((flow) => flow.code));
  try {
    const tree = await postEhr('/Api/WF007Api/GetFlowTree', {});
    const walk = (nodes) => {
      if (!Array.isArray(nodes)) return;
      for (const node of nodes) {
        if (node.isFolder) walk(node.children);
        else if (node.key && !known.has(node.key)) {
          flows.push({ code: node.key, table: '', sort: 'ID', label: node.title || node.key });
          known.add(node.key);
        }
      }
    };
    walk(tree);
  } catch (error) {
    if (/未登录/.test(error.message)) throw error;
  }

  const items = [];
  for (const flow of flows) {
    let payload;
    try {
      payload = await postEhr('/Api/WF007Api/GetMstGridData', {
        FlowCode: flow.code, TableName: flow.table, rows: 500, page: 1, search: false,
        nd: Date.now(), sortColName: flow.sort, sortDirection: 'desc', Filter: ''
      });
    } catch (error) {
      if (/未登录/.test(error.message)) throw error;
      continue;
    }
    if (!payload || payload.success === false) continue;
    for (const row of payload.griddata || []) {
      const person = pendingPick(row, ['EmpName', 'G_zdr', 'Creator', 'QJEmpName']);
      const formNo = pendingPick(row, ['FormNo', 'OTNO', 'BillNo']);
      items.push({
        title: flow.label,
        subtitle: [person, formNo].filter(Boolean).join(' · '),
        time: pendingPick(row, ['ApplicationDate', 'CreateTime', 'G_qksj', 'ksrq']),
        url: `${EHR_ORIGIN}/`
      });
    }
  }
  return items;
}

async function fabriqGet(path) {
  const headers = { Accept: 'application/json' };
  const stored = await chrome.storage.local.get(FABRIQ_TOKEN_KEY);
  if (stored[FABRIQ_TOKEN_KEY]) headers.Authorization = `BearerFuture ${stored[FABRIQ_TOKEN_KEY]}`;
  const response = await fetchWithTimeout(`${FABRIQ_ORIGIN}${path}`, { credentials: 'include', headers });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Fabriq 未登录或会话已过期，请打开 Fabriq 登录一次');
  }
  return readJson(response, 'Fabriq');
}

function fabriqRows(payload) {
  if (Array.isArray(payload)) return payload;
  return (payload && (payload.results || payload.data || payload.notifications)) || [];
}

function stripHtml(text) {
  return pendingText(text).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

const FABRIQ_MODEL_LABELS = { ticket: '工单', indicator: '指标', routine: '例行', routineinstance: '例行', team: '团队', comment: '评论' };
const FABRIQ_RENEW_KEY = 'fabriqLastRenewTab';
const FABRIQ_RENEW_MINUTES = 60;

function fabriqModelType(row) {
  const raw = pendingText(row.model_type).split('.').pop().toLowerCase();
  return raw.includes('routine') ? 'routine' : raw;
}

async function fetchFabriqNotifications() {
  const me = await fabriqGet('/api/v1/users/me/');
  const userId = me && (me.id ?? (me.user && me.user.id));
  if (userId === undefined || userId === null) throw new Error('Fabriq 未登录或会话已过期，请打开 Fabriq 登录一次');
  const base = `/api/v2/notifications/?user_id=${encodeURIComponent(userId)}`;
  const pages = await Promise.all([
    fabriqGet(`${base}&is_follower=1`),
    fabriqGet(`${base}&is_follower=0`)
  ]);
  return pages.flatMap(fabriqRows);
}

// 与 Fabriq 网页铃铛保持一致：只统计 target=personal 的未读；团队通知单独计数，不计入角标
function buildFabriqItems(rows) {
  const seen = new Set();
  const reactionTickets = new Set();
  const items = [];
  let teamUnread = 0;
  for (const row of rows) {
    if (!row || row.is_read) continue;
    const key = row.id ?? JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.target !== 'personal') {
      teamUnread += 1;
      continue;
    }
    const modelType = fabriqModelType(row);
    if (row.type === 'ticket_reaction_created' && modelType === 'ticket') {
      if (reactionTickets.has(row.model_id)) continue;
      reactionTickets.add(row.model_id);
    }
    const what = FABRIQ_MODEL_LABELS[modelType] || modelType || '通知';
    const name = stripHtml(row.model_repr) || stripHtml(row.instance_repr);
    const kind = pendingText(row.type).replace(/_/g, ' ');
    items.push({
      title: stripHtml(row.notification_text) || name || 'Fabriq 通知',
      subtitle: [`${what}${name ? `：${name}` : ''}`, kind].filter(Boolean).join(' · '),
      time: pendingPick(row, ['event_datetime', 'created', 'created_at']),
      url: `${FABRIQ_ORIGIN}/tasks`
    });
  }
  items.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  return { items, teamUnread };
}

// 会话过期时，在后台打开一个不激活的 Fabriq 标签页续期登录，完成后关闭（每小时最多一次）
async function renewFabriqSession() {
  const stored = await chrome.storage.local.get(FABRIQ_RENEW_KEY);
  if (Date.now() - (stored[FABRIQ_RENEW_KEY] || 0) < FABRIQ_RENEW_MINUTES * 60000) return false;
  await chrome.storage.local.set({ [FABRIQ_RENEW_KEY]: Date.now() });
  let tab;
  try {
    tab = await chrome.tabs.create({ url: `${FABRIQ_ORIGIN}/tasks`, active: false });
    await new Promise((resolve) => {
      const timer = setTimeout(done, 30000);
      function done() {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
      function listener(tabId, info, updated) {
        if (tabId === tab.id && info.status === 'complete' && updated.url && updated.url.startsWith(FABRIQ_ORIGIN)) done();
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
    await new Promise((resolve) => setTimeout(resolve, 8000));
    return true;
  } catch (error) {
    return false;
  } finally {
    if (tab && tab.id !== undefined) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function collectFabriqPending() {
  let rows;
  try {
    rows = await fetchFabriqNotifications();
  } catch (error) {
    if (!/未登录/.test(String(error && error.message)) || !(await renewFabriqSession())) throw error;
    rows = await fetchFabriqNotifications();
  }
  const { items, teamUnread } = buildFabriqItems(rows);
  items.note = teamUnread ? `另有团队通知未读 ${teamUnread} 条（未计入角标）` : '';
  return items;
}

async function reportPending(source, collector) {
  const report = { source, updated: new Date().toISOString() };
  try {
    const items = await collector();
    report.ok = true;
    report.count = items.length;
    report.items = items.slice(0, 50);
    if (items.note) report.note = items.note;
  } catch (error) {
    report.ok = false;
    report.error = error && error.name === 'AbortError' ? '请求超时' : String(error.message || error);
  }
  try {
    await fetchWithTimeout(TOOLBOX_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report)
    }, 5000);
  } catch (error) {
    // 工具箱未运行
  }
  return report;
}

let pendingSyncRunning = null;
function runPendingSync() {
  if (pendingSyncRunning) return pendingSyncRunning;
  pendingSyncRunning = Promise.all([
    reportPending('windchill', collectWindchillPending),
    reportPending('ehr', collectEhrPending),
    reportPending('fabriq', collectFabriqPending)
  ]).finally(() => { pendingSyncRunning = null; });
  return pendingSyncRunning;
}

chrome.alarms.get(PENDING_SYNC_ALARM, (existing) => {
  if (!existing) {
    chrome.alarms.create(PENDING_SYNC_ALARM, { delayInMinutes: 0.2, periodInMinutes: PENDING_SYNC_MINUTES });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PENDING_SYNC_ALARM) runPendingSync();
});

// 登录 Windchill / EHR 或在页面上处理完审批后，尽快刷新一次
let lastPageTriggeredSync = 0;
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (![WINDCHILL_ORIGIN, EHR_ORIGIN, FABRIQ_ORIGIN].some((origin) => tab.url.startsWith(origin))) return;
  if (Date.now() - lastPageTriggeredSync < 60000) return;
  lastPageTriggeredSync = Date.now();
  setTimeout(runPendingSync, 3000);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.action === 'fabriqToken') {
    const token = typeof request.token === 'string' ? request.token : '';
    const save = token ? chrome.storage.local.set({ [FABRIQ_TOKEN_KEY]: token }) : chrome.storage.local.remove(FABRIQ_TOKEN_KEY);
    save.then(() => sendResponse({ ok: true }));
    return true;
  }
  if (!request || request.action !== 'pendingSyncNow') return false;
  runPendingSync().then((reports) => sendResponse({ ok: true, reports }));
  return true;
});
