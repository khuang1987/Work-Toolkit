// =====================================================
// EHR 待办一键审批 v2 (汇总弹窗版)
// 运行于 http://ehr.medtronic.com.cn/ (顶层页面 / 待办页)
// 纯 API 方案:
//   GetFlowTree            -> 分类清单
//   GetMstGridData         -> 各流程待审批主数据 (含审批全部字段)
//   GetItemGridData_Search -> 请假明细 (小时数)
//   WF005Api/BatApprove    -> 批量审批
// 流程: 点击按钮 -> 扫描汇总 -> 弹窗(默认全选, 超1天电光蓝高亮)
//       -> 用户勾选 -> 确认 -> 当前类别逐条审批 -> 状态提示
// =====================================================

(function () {
  'use strict';

  const ELECTRIC_BLUE = '#00E5FF';
  const STORE_KEY = 'kiro_ehr_approve_meta';

  const FLOW_DEFS = [
    { code: 'QK01', table: 't_hr_bk', sort: 'ID', label: '补卡审批' },
    { code: 'PLQJ01', table: 'T_OA_QJMst', sort: 'ID', label: '批量请假' },
    { code: 'JB01', table: 'T_HR_jiaban', sort: 'ID', label: '个人加班' },
    { code: 'GRPLJB001', table: 'T_OA_GRJBOverTimeMst', sort: 'OTNO', label: '个人批量加班' },
    { code: 'PLJB06', table: 'T_OA_JBOverTimeMst', sort: 'OTNO', label: '批量加班(考勤员专用)' }
  ];

  const LEAF_FLOW = 'PLQJ01'; // 需要拉明细的流程

  function isEhrPage() {
    return location.hostname === 'ehr.medtronic.com.cn';
  }

  function isTopFrame() {
    try { return window.self === window.top; } catch (e) { return true; }
  }

  function isOvertimeAddPage() {
    return location.pathname.toLowerCase().indexOf('/ehr/atd08/add') === 0;
  }

  function isLeaveAddPage() {
    return location.pathname.toLowerCase().indexOf('/ehr/atd13/add') === 0;
  }

  function isPatchAddPage() {
    return location.pathname.toLowerCase().indexOf('/ehr/atd1103/add1') === 0;
  }

  function getWorkflowFormCode() {
    if (location.pathname.toLowerCase().indexOf('/oa/wf005/edit') !== 0) return '';
    return new URLSearchParams(location.search).get('flowCode') || '';
  }

  // ── API ──
  async function postForm(url, params) {
    const body = new URLSearchParams();
    for (const k of Object.keys(params)) {
      const v = params[k];
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        v.forEach((x, i) => body.append(k + '[' + i + ']', String(x)));
      } else {
        body.append(k, String(v));
      }
    }
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString()
    });
    return resp.json();
  }

  async function apiFlowTree() {
    return postForm('/Api/WF007Api/GetFlowTree', {});
  }

  async function apiMst(flow) {
    const j = await postForm('/Api/WF007Api/GetMstGridData', {
      FlowCode: flow.code,
      TableName: flow.table,
      rows: 500,
      page: 1,
      search: false,
      nd: Date.now(),
      sortColName: flow.sort,
      sortDirection: 'desc',
      Filter: ''
    });
    if (j.success === false) throw new Error(flow.code + ': ' + (j.err || '查询失败'));
    return j.griddata || [];
  }

  async function apiItems(flow, mstId) {
    const itemTable = flow.code === 'PLQJ01'
      ? 'T_OA_QJItem'
      : flow.code === 'GRPLJB001'
        ? 'T_OA_GRJBOverTimeItem'
        : 'T_OA_JBOverTimeItem';
    const j = await postForm('/Api/WF007Api/GetItemGridData_Search', {
      FlowCode: flow.code,
      TableName: itemTable,
      MstId: mstId,
      rows: 500,
      page: 1,
      search: false,
      sortColName: 'SNO',
      sortDirection: 'desc',
      Filter: '',
      sidx: '',
      sord: '',
      nd: Date.now()
    });
    if (j.success === false) return [];
    return j.griddata || [];
  }

  // Selected: [{TaskId,FlowCode,CurrStepNum,CurrActivityCode,FormDataId,FormNo,PkID}]
  async function apiApprove(selected) {
    const params = {};
    selected.forEach((s, i) => {
      const p = 'Selected[' + i + ']';
      params[p + '[TaskId]'] = s.TaskId;
      params[p + '[FlowCode]'] = s.FlowCode;
      params[p + '[CurrStepNum]'] = s.CurrStepNum;
      params[p + '[CurrActivityCode]'] = s.CurrActivityCode;
      params[p + '[FormDataId]'] = s.FormDataId;
      params[p + '[FormNo]'] = s.FormNo;
      params[p + '[PkID]'] = s.PkID;
    });
    // FormData.mst = 第一条的完整字段 (兼容服务器回写)
    const mst = selected[0].RowData || {};
    for (const k of Object.keys(mst)) {
      const v = mst[k];
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') continue;
      params['FormData[mst][' + k + ']'] = String(v);
    }
    return postForm('/Api/WF005Api/BatApprove', params);
  }

  // ── 数据模型: 汇总 ──
  function fmtDate(v) {
    if (!v) return '';
    if (typeof v === 'string') {
      const m = v.match(/\/Date\((\d+)\+0800\)\//);
      if (m) return new Date(+m[1]).toLocaleDateString('zh-CN');
      return v.replace('T', ' ').slice(0, 16);
    }
    return String(v);
  }

  function parseHours(v) {
    if (v === null || v === undefined || v === '') return 0;
    const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  function formatDays(hours) {
    const days = Math.round((hours / 8) * 10) / 10;
    return `${days}天`;
  }

  function formatTime(v) {
    if (!v) return '';
    const text = String(v).replace('T', ' ');
    const match = text.match(/(\d{2}:\d{2})/);
    return match ? match[1] : '';
  }

  function formatDateOnly(v) {
    return fmtDate(v).split(' ')[0];
  }

  function formatPeople(row) {
    const people = row._people || [];
    if (people.length === 0) {
      const name = row.EmpName || row.G_zdr || row.Creator || '';
      const code = row.EmpCode || row.G_zdrcode || row.CreatorCode || '';
      return name ? `${name}${code ? ` ${code}` : ''}` : '';
    }
    const names = people.map(p => p.name + (p.code ? ` ${p.code}` : ''));
    return names.length <= 3 ? names.join('、') : `${names.slice(0, 3).join('、')} 等${names.length}人`;
  }

  // 生成某条待审批的描述信息 (时间 / 时长)
  function describe(flow, row) {
    const d = {};
    if (flow.code === 'QK01') {
      d.detail = (row.cqlb || '') + ' ' + fmtDate(row.G_qksj);
      d.hours = 0;
    } else if (flow.code === 'PLQJ01') {
      d.detail = '申请日期 ' + fmtDate(row.ApplicationDate);
      d.hours = 0; // 由明细汇总
      const people = row._personCount || 0;
      const days = formatDays(row._hours || 0);
      d.extraDetail = people > 1 ? `${people}人 · 最长${days}` : `${people}人 · ${days}`;
    } else if (flow.code === 'JB01') {
      d.detail = fmtDate(row.ksrq) + ' ' + (row.kssj || '').slice(11, 16) + ' ~ ' +
                 fmtDate(row.jsrq) + ' ' + (row.jssj || '').slice(11, 16);
      d.hours = parseHours(row.sqjb);
    } else {
      // GRPLJB001 / PLJB06
      const beginDate = formatDateOnly(row.BeginTime || row.OverDate);
      const endDate = formatDateOnly(row.EndTime || row.BeginTime || row.OverDate);
      const beginTime = formatTime(row.BeginTime1 || row.BeginTime);
      const endTime = formatTime(row.endTime1 || row.EndTime);
      d.detail = `${beginDate}${beginTime ? ` ${beginTime}` : ''} ~ ${endDate}${endTime ? ` ${endTime}` : ''}`;
      d.hours = row._hours || parseHours(row.TotalHour);
      d.people = formatPeople(row);
    }
    return d;
  }

  async function scanAll(progress) {
    const items = [];
    let treeFlows = [];
    try {
      treeFlows = await apiFlowTree();
    } catch (e) { /* 树接口失败则只用内置定义 */ }

    // 合并内置定义 + 树中未知流程 (动态获取 TableName)
    const defs = FLOW_DEFS.slice();
    const known = new Set(FLOW_DEFS.map(f => f.code));
    function collectNodes(nodes) {
      if (!Array.isArray(nodes)) return;
      for (const n of nodes) {
        if (n.isFolder) { collectNodes(n.children); } else if (!known.has(n.key)) {
          defs.push({ code: n.key, table: '', sort: 'ID', label: n.title, dynamic: true });
          known.add(n.key);
        }
      }
    }
    collectNodes(treeFlows);

    for (let fi = 0; fi < defs.length; fi++) {
      const flow = defs[fi];
      if (progress) progress('扫描 ' + flow.label + ' (' + (fi + 1) + '/' + defs.length + ')...');
      let rows = [];
      try {
        rows = await apiMst(flow);
      } catch (e) {
        if (progress) progress('跳过 ' + flow.label + ': ' + e.message);
        continue;
      }
      for (const row of rows) {
        if (flow.code === 'PLQJ01' || flow.code === 'GRPLJB001' || flow.code === 'PLJB06') {
          try {
            const items_ = await apiItems(flow, row.FormDataId);
            const people = new Map();
            for (const detail of items_) {
              const code = detail.QJEmpCode || detail.EmpCode || detail.QJEmpID || '';
              const name = detail.QJEmpName || detail.EmpName || '';
              const key = String(code || name || 'unknown');
              const person = people.get(key) || { code: String(code), name: name || String(code), hours: 0 };
              person.hours += parseHours(detail.qjxs || detail.TotalHour);
              people.set(key, person);
            }
            const personHours = Array.from(people.values()).map(person => person.hours);
            row._people = Array.from(people.values());
            row._personCount = people.size;
            // 同一批量单可能包含同一人的多条明细,按单人累计时长判断高亮。
            row._hours = personHours.length ? Math.max(...personHours) : parseHours(row.TotalHour);
            row._days = row._hours / 8;
            row._detailRemark = items_.find(detail => detail.Remark || detail.QJRemark)?.Remark ||
              items_.find(detail => detail.QJRemark)?.QJRemark || '';
          } catch (e) {
            row._personCount = 0;
            row._hours = 0;
            row._days = 0;
          }
        }
        const desc = describe(flow, row);
        if (flow.code === LEAF_FLOW) desc.hours = row._hours || 0;
        if (flow.code === 'GRPLJB001' || flow.code === 'PLJB06') {
          desc.hours = row._hours || parseHours(row.TotalHour);
          desc.people = formatPeople(row);
        }
        const hours = desc.hours || 0;
        items.push({
          flowCode: flow.code,
          flowLabel: flow.label,
          row: row,
          desc: desc,
          hours: hours,
          highlight: hours > 24,
          selected: true
        });
      }
    }
    return items;
  }

  // ── UI: 右下角可折叠助手面板（与 Cornerstone / Workday 一致，默认折叠为图标）──
  // 「申请填写」（加班 / 批量请假 / 补卡填写助手）暂不启用：入口与表单页内的助手面板均不再创建。
  const FILL_ASSISTANT_ENABLED = false;
  const APPROVE_LABEL = '一键审批';
  let button = null;
  let applicationButton = null;
  let formLauncher = null;

  const FORM_MODES = [
    { key: 'overtime', label: '个人批量加班流程', url: '/OA/WF005/Edit?flowCode=GRPLJB001&formCode=GRPLJB001&from=WF005' },
    { key: 'leave', label: '批量请假申请', url: '/OA/WF005/Edit?flowCode=PLQJ01&formCode=PLQJ_02&from=WF005' },
    { key: 'overtimeBatch', label: '批量加班流程', url: '/OA/WF005/Edit?flowCode=PLJB06&formCode=PLJB006&from=WF005' },
    { key: 'patch', label: '补卡审批流程', url: '/eHR/ATD1103/Add1/' }
  ];

  function ensureButton() {
    if (button && document.body.contains(button)) return button;
    const dock = globalThis.MwaDock.create({ id: 'kiro-ehr-dock', title: 'EHR 助手', icon: 'icons/ehr.png' });
    const hint = document.createElement('p');
    hint.className = 'mwa-hint';
    hint.textContent = '汇总所有待审批事项，勾选后一键审批。';
    button = document.createElement('button');
    button.id = 'kiro-ehr-approve-btn';
    button.type = 'button';
    button.className = 'mwa-btn block';
    button.textContent = APPROVE_LABEL;
    button.title = '汇总待审批事项并一键审批';
    button.addEventListener('click', onButtonClick);
    dock.body.append(hint, button);
    return button;
  }

  function ensureApplicationButton() {
    return null;
  }

  function closeFormLauncher() {
    if (formLauncher?.overlay?.parentNode) formLauncher.overlay.parentNode.removeChild(formLauncher.overlay);
    formLauncher = null;
  }

  function openFormLauncher() {
    if (formLauncher?.overlay?.parentNode) return;

    const overlay = document.createElement('div');
    overlay.id = 'kiro-ehr-form-launcher';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483645;
      background: rgba(10,16,30,.62); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Microsoft YaHei', -apple-system, Arial, sans-serif;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      width: 1180px; height: 760px; max-width: 96vw; max-height: 92vh;
      display: flex; flex-direction: column; overflow: hidden;
      background: #0f1626; border: 1px solid rgba(166,79,232,.55);
      border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.65); color: #e8eef7;
    `;

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:13px 18px;border-bottom:1px solid rgba(255,255,255,.1);';
    header.innerHTML = '<div><strong style="font-size:16px;color:#d9c6ff;">📝 申请填写助手</strong><span style="margin-left:12px;color:#9eacc2;font-size:12px;">选择标签进入对应原生表单,只填充不提交</span></div>';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'border:0;background:transparent;color:#9eacc2;font-size:18px;cursor:pointer;padding:2px 6px;';
    close.onclick = closeFormLauncher;
    header.appendChild(close);
    box.appendChild(header);

    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;gap:7px;padding:10px 14px 0;border-bottom:1px solid rgba(255,255,255,.1);overflow-x:auto;';
    box.appendChild(tabBar);

    const status = document.createElement('div');
    status.style.cssText = 'padding:7px 18px;color:#9eacc2;font-size:12px;border-bottom:1px solid rgba(255,255,255,.07);';
      status.textContent = '表单加载中...';
    box.appendChild(status);

    const content = document.createElement('div');
    content.style.cssText = 'display:flex;flex:1;min-height:0;overflow:hidden;';

    const frame = document.createElement('iframe');
    frame.id = 'kiro-ehr-form-frame';
    frame.style.cssText = 'flex:1;min-width:0;width:100%;border:0;background:#fff;';
    frame.setAttribute('title', 'EHR申请表单');

    const side = document.createElement('div');
    side.id = 'kiro-ehr-form-side-panel';
    side.style.cssText = 'width:270px;flex:0 0 270px;overflow:auto;padding:14px;background:#101b2c;border-left:1px solid rgba(166,79,232,.35);color:#e8eef7;';
    content.append(frame, side);
    box.appendChild(content);

    const footer = document.createElement('div');
    footer.style.cssText = 'padding:9px 18px;color:#7187a6;font-size:11px;border-top:1px solid rgba(255,255,255,.1);';
    footer.textContent = '表单中的“确认填入”只回填字段。最终提交请由员工手动点击 EHR 原生保存按钮。';
    box.appendChild(footer);

    overlay.appendChild(box);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeFormLauncher();
    });
    document.body.appendChild(overlay);

    formLauncher = { overlay, frame, tabBar, status, side, current: 'overtime' };

    function sendToForm(action, payload) {
      if (!frame.contentWindow) return;
      frame.contentWindow.postMessage({ source: 'kiro-ehr-launcher', action, ...payload }, location.origin);
    }

    function nextLeaveSuffix() {
      const d = frame.contentDocument;
      for (let i = 2; i <= 6; i++) {
        if (!d?.getElementById(`QJEmpCode${i}`)?.value) return String(i);
      }
      return '2';
    }

    function sendCurrentEmployee(suffix) {
      getCurrentEmployee().then(user => {
        if (!user.code) {
          status.textContent = '未读取到本人工号,请使用员工选择器';
          return;
        }
        const workflow = formLauncher.current === 'overtime' || formLauncher.current === 'overtimeBatch';
        sendToForm('defaultEmployee', {
          user,
          suffix: suffix || (formLauncher.current === 'leave' ? nextLeaveSuffix() : ''),
          workflowAll: workflow && formLauncher.current === 'overtime',
          workflowRowIndex: workflow && formLauncher.workflowRowSelect ? Number(formLauncher.workflowRowSelect.value) : null
        });
      });
    }

    function input(label, type, value, key, readonly = false) {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:block;margin-top:9px;color:#aebad0;font-size:12px;';
      const text = document.createElement('div');
      text.textContent = label;
      const el = document.createElement('input');
      el.type = type;
      el.dataset.key = key;
      el.value = value || '';
      el.readOnly = readonly;
      el.style.cssText = 'width:100%;box-sizing:border-box;margin-top:3px;padding:6px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;';
      wrap.append(text, el);
      return wrap;
    }

    function sideButton(text, action) {
      const b = document.createElement('button');
      b.textContent = text;
      b.dataset.action = action;
      b.style.cssText = 'width:100%;padding:7px;margin-top:8px;border:1px solid #287eb5;border-radius:6px;background:#12314d;color:#dff5ff;cursor:pointer;font:600 12px inherit;';
      return b;
    }

    function quickButton(text, action) {
      const b = sideButton(text, action);
      b.style.cssText += 'width:auto;display:inline-block;margin:4px 4px 0 0;padding:6px 9px;font-size:11px;';
      return b;
    }

    function renderSide(mode) {
      side.innerHTML = `<div style="font-weight:700;font-size:14px;color:#d9c6ff;">${mode.label}</div><div style="margin-top:5px;color:#7187a6;font-size:11px;">员工默认留空,可点击“填写本人”</div>`;
      const isWorkflowOvertime = mode.key === 'overtime' || mode.key === 'overtimeBatch';
      let workflowRowSelect = null;
      if (isWorkflowOvertime) {
        workflowRowSelect = document.createElement('select');
        workflowRowSelect.style.cssText = 'width:100%;box-sizing:border-box;margin-top:7px;padding:6px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;';
        const maxRows = mode.key === 'overtimeBatch' ? 30 : 5;
        for (let i = 0; i < maxRows; i++) workflowRowSelect.add(new Option(`第${i + 1}行员工`, String(i)));
        side.appendChild(workflowRowSelect);
        formLauncher.workflowRowSelect = workflowRowSelect;
      }
      const employee = sideButton(isWorkflowOvertime ? (mode.key === 'overtime' ? '选择个人' : '选择当前行员工') : mode.key === 'leave' ? '选择员工(逐行填充)' : '选择员工(单人)', 'employee');
      side.appendChild(employee);
      employee.onclick = () => {
        if (isWorkflowOvertime) sendToForm('workflowEmployee', { rowIndex: Number(workflowRowSelect.value), workflowAll: mode.key === 'overtime' });
        else if (mode.key === 'leave') sendToForm('leaveEmployee', { suffix: nextLeaveSuffix() });
        else sendToForm('employee', {});
      };
      if (mode.key === 'overtime') {
        const copyEmployee = sideButton('复制个人到全部明细行', 'copyEmployee');
        side.appendChild(copyEmployee);
        copyEmployee.onclick = () => sendToForm('workflowEmployeeAllRows', {});
      }
      const self = sideButton('填写本人', 'self');
      self.style.background = '#244b38';
      self.style.borderColor = '#45d483';
      side.appendChild(self);
      self.textContent = isWorkflowOvertime ? (mode.key === 'overtime' ? '填写本人到全部行' : '填写本人到当前行') : '填写本人';
      self.onclick = () => sendCurrentEmployee(formLauncher.current === 'leave' ? nextLeaveSuffix() : '');

      if (isWorkflowOvertime) {
        const date = input('加班日期', 'date', new Date().toISOString().slice(0, 10), 'date');
        const shift = sideButton('选择班制(可选)', 'shift');
        let beginOffset = 0;
        const preset = document.createElement('label');
        preset.style.cssText = 'display:block;margin-top:9px;color:#aebad0;font-size:12px;';
        preset.innerHTML = '<div>快捷班次</div>';
        const presetBox = document.createElement('div');
        presetBox.style.cssText = 'display:flex;flex-wrap:wrap;';
        const presetValues = [
          ['白班', 'early', '08:00', 0],
          ['中班', 'middle', '16:00', 0],
          ['夜班', 'night', '00:00', 1]
        ];
        presetValues.forEach(([label, value, start, offset]) => {
          const b = quickButton(label, value);
          b.onclick = () => {
            beginOffset = offset;
            preset.dataset.value = value;
            begin.querySelector('input').value = start;
            duration.querySelector('input').value = '8';
            updateEnd();
          };
          presetBox.appendChild(b);
        });
        preset.appendChild(presetBox);
        const begin = input('开始时间', 'time', '08:00', 'begin');
        const duration = input('时长(小时)', 'number', '8', 'duration');
        const end = input('结束时间(自动计算)', 'time', '16:00', 'end', true);
        const durationBox = document.createElement('div');
        durationBox.style.cssText = 'display:flex;flex-wrap:wrap;margin-top:2px;';
        ['1', '2', '3'].forEach(hours => {
          const b = quickButton(`${hours}小时`, `hours-${hours}`);
          b.onclick = () => {
            duration.querySelector('input').value = hours;
            updateEnd();
          };
          durationBox.appendChild(b);
        });
        duration.appendChild(durationBox);
        const noBreak = document.createElement('label');
        noBreak.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:9px;color:#cbd8eb;font-size:12px;';
        noBreak.innerHTML = '<input data-key="noBreak" type="checkbox"> 直落';
        const apply = sideButton('确认填入表单', 'apply');
        side.append(shift, date, preset, begin, duration, end, noBreak, apply);
        shift.onclick = () => sendToForm('shift', {});
        const updateEnd = () => {
          const result = calculateEndTime(begin.querySelector('input').value, duration.querySelector('input').value);
          if (result) end.querySelector('input').value = result.time;
        };
        begin.querySelector('input').oninput = updateEnd;
        duration.querySelector('input').oninput = updateEnd;
        apply.onclick = () => {
          const result = calculateEndTime(begin.querySelector('input').value, duration.querySelector('input').value);
          sendToForm('applyOvertime', { config: {
            date: date.querySelector('input').value,
            begin: begin.querySelector('input').value,
            end: result?.time || end.querySelector('input').value,
            beginOffset,
            endOffset: beginOffset + (result?.dayOffset || 0),
            noBreak: noBreak.querySelector('input').checked
          }});
        };
        updateEnd();
      } else if (mode.key === 'leave') {
        const type = sideButton('选择请假类型', 'type');
        const date = input('开始日期', 'date', new Date().toISOString().slice(0, 10), 'date');
        const begin = input('开始时间', 'time', '08:00', 'begin');
        const duration = input('时长(小时)', 'number', '8', 'duration');
        const end = input('结束时间(自动计算)', 'time', '16:00', 'end', true);
        const leaveHours = quickButton('8小时', 'leave-8');
        leaveHours.style.display = 'block';
        leaveHours.style.width = '100%';
        leaveHours.onclick = () => {
          duration.querySelector('input').value = '8';
          const result = calculateEndTime(begin.querySelector('input').value, '8');
          if (result) end.querySelector('input').value = result.time;
        };
        const apply = sideButton('确认填入表单', 'apply');
        const rows = document.createElement('div');
        rows.style.cssText = 'margin-top:9px;border-top:1px solid rgba(255,255,255,.1);padding-top:7px;color:#aebad0;font-size:11px;';
        rows.textContent = '逐行选择人员/请假类型';
        for (let i = 2; i <= 6; i++) {
          const line = document.createElement('div');
          line.style.cssText = 'display:flex;gap:4px;align-items:center;margin-top:4px;';
          const label = document.createElement('span');
          label.textContent = `第${i - 1}行`;
          label.style.cssText = 'width:38px;color:#7187a6;';
          const person = quickButton('人员', `person-${i}`);
          const leaveType = quickButton('类型', `type-${i}`);
          person.onclick = () => sendToForm('leaveEmployee', { suffix: String(i) });
          leaveType.onclick = () => sendToForm('leaveType', { suffix: String(i) });
          line.append(label, person, leaveType);
          rows.appendChild(line);
        }
        side.append(type, rows, date, begin, duration, leaveHours, end, apply);
        type.onclick = () => sendToForm('leaveType', { suffix: nextLeaveSuffix() });
        const updateEnd = () => {
          const result = calculateEndTime(begin.querySelector('input').value, duration.querySelector('input').value);
          if (result) end.querySelector('input').value = result.time;
        };
        begin.querySelector('input').oninput = updateEnd;
        duration.querySelector('input').oninput = updateEnd;
        apply.onclick = () => {
          const startDate = date.querySelector('input').value;
          const result = calculateEndTime(begin.querySelector('input').value, duration.querySelector('input').value);
          sendToForm('applyLeave', { config: {
            date: startDate,
            begin: begin.querySelector('input').value,
            endDate: dateWithOffset(startDate, result?.dayOffset || 0),
            end: result?.time || end.querySelector('input').value
          }});
        };
        updateEnd();
      } else {
        const date = input('补卡日期', 'date', new Date().toISOString().slice(0, 10), 'date');
        const point = document.createElement('label');
        point.style.cssText = 'display:block;margin-top:9px;color:#aebad0;font-size:12px;';
        point.innerHTML = '<div>补卡点</div><select data-key="point" style="width:100%;box-sizing:border-box;margin-top:3px;padding:6px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;"><option value="in">上班</option><option value="out">下班</option></select>';
        const reason = sideButton('选择补卡原因', 'reason');
        const apply = sideButton('确认填入表单', 'apply');
        side.append(date, point, reason, apply);
        reason.onclick = () => sendToForm('reason', {});
        apply.onclick = () => sendToForm('applyPatch', { config: { date: date.querySelector('input').value, point: point.querySelector('select').value }});
      }
    }

    function activate(mode) {
      formLauncher.current = mode.key;
      frame.src = `${mode.url}${mode.url.includes('?') ? '&' : '?'}kiroExternal=1`;
      status.textContent = `${mode.label}表单加载中...`;
      renderSide(mode);
      Array.from(tabBar.children).forEach(tab => {
        const active = tab.dataset.mode === mode.key;
        tab.style.background = active ? 'rgba(166,79,232,.28)' : 'rgba(255,255,255,.05)';
        tab.style.borderColor = active ? '#a64fe8' : 'rgba(255,255,255,.12)';
        tab.style.color = active ? '#fff' : '#aebad0';
      });
    }

    FORM_MODES.forEach(mode => {
      const tab = document.createElement('button');
      tab.dataset.mode = mode.key;
      tab.textContent = mode.label;
      tab.style.cssText = 'flex:0 0 auto;border:1px solid rgba(255,255,255,.12);border-bottom:2px solid transparent;border-radius:8px 8px 0 0;background:rgba(255,255,255,.05);color:#aebad0;padding:8px 20px;cursor:pointer;font:600 13px inherit;';
      tab.onclick = () => activate(mode);
      tabBar.appendChild(tab);
    });
    frame.addEventListener('load', () => {
      if (!formLauncher) return;
      status.textContent = '已加载。请在表单内选择人员和字段,确认填入后手动保存。';
      getCurrentEmployee().then(user => {
        frame.contentWindow?.postMessage({ source: 'kiro-ehr-launcher', action: 'defaultEmployee', user }, location.origin);
      });
    });
    window.addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
      if (event.data?.source === 'kiro-ehr-form') status.textContent = event.data.message || status.textContent;
    });
    activate(FORM_MODES[0]);
  }

  async function onButtonClick() {
    if (dialogApi && dialogApi.open) return; // 已有弹窗
    const btn = ensureButton();
    btn.textContent = '扫描中…';
    btn.style.pointerEvents = 'none';
    try {
      const items = await scanAll(text => { btn.textContent = text; });
      btn.textContent = APPROVE_LABEL;
      btn.style.pointerEvents = '';
      if (items.length === 0) {
        showToast('🎉 当前没有待审批事项', 'success');
        return;
      }
      openDialog(items);
    } catch (e) {
      console.error('EHR审批扫描失败:', e);
      btn.textContent = APPROVE_LABEL;
      btn.style.pointerEvents = '';
      showToast('扫描失败: ' + e.message, 'error');
    }
  }

  function refreshSummary() {
    try {
      sessionStorage.setItem('kiro_ehr_refresh_summary', '1');
    } catch (e) {}
    window.location.reload();
  }

  // ── UI: 汇总弹窗 (标签页 + 分组勾选) ──
  let dialogApi = null;
  let dialogState = null;

  function openDialog(items, preferredFlowCode) {
    const overlay = document.createElement('div');
    overlay.id = 'kiro-ehr-dialog-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(10, 16, 30, 0.55); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Microsoft YaHei', -apple-system, Arial, sans-serif;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      width: 840px; max-width: 94vw; max-height: 86vh; display: flex; flex-direction: column;
      background: #0f1626; border: 1px solid rgba(255,255,255,0.12); border-radius: 14px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6); color: #e8eef7; overflow: hidden;
    `;

    // 分组 (保持顺序)
    const flowOrder = [];
    const groups = new Map();
    for (const it of items) {
      if (!groups.has(it.flowCode)) {
        groups.set(it.flowCode, []);
        flowOrder.push(it.flowCode);
      }
      groups.get(it.flowCode).push(it);
    }
    let currentFlow = flowOrder.includes(preferredFlowCode) ? preferredFlowCode : flowOrder[0];

    // 头部
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,0.1);
    `;
    header.innerHTML = `<div style="font-size:15px;font-weight:600;">
      待审批汇总 · 共 <span id="kiro-ehr-total">${items.length}</span> 条
      <span style="font-weight:400;color:#8fa3c0;font-size:12px;margin-left:10px;">
        点击标签切换类别,每次只审批当前类别
      </span></div>`;
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `cursor:pointer;color:#8fa3c0;font-size:16px;padding:4px 8px;border-radius:6px;`;
    closeBtn.onmouseenter = () => closeBtn.style.color = '#fff';
    closeBtn.onmouseleave = () => closeBtn.style.color = '#8fa3c0';
    closeBtn.onclick = () => closeDialog(false);
    header.appendChild(closeBtn);
    box.appendChild(header);

    // 标签栏 (横向排列)
    const tabBar = document.createElement('div');
    tabBar.style.cssText = `
      display: flex; gap: 6px; padding: 10px 14px 0;
      overflow-x: auto; border-bottom: 1px solid rgba(255,255,255,0.08);
      scrollbar-width: thin;
    `;
    box.appendChild(tabBar);

    // 工具栏
    const toolbar = document.createElement('div');
    toolbar.style.cssText = `
      display: flex; align-items: center; gap: 10px; padding: 10px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 12px; color: #aebad0;
    `;
    function mkBtn(text, style) {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = `cursor:pointer;border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.06);color:#cfe0ff;border-radius:6px;padding:3px 12px;font-size:12px;font-family:inherit;` + (style || '');
      return b;
    }
    const selAll = mkBtn('☑ 全选');
    const selNone = mkBtn('☐ 全不选');
    const selInvert = mkBtn('⇄ 反选');
    const legend = document.createElement('span');
    legend.style.cssText = `margin-left:auto;`;
    legend.innerHTML = `<span style="color:${ELECTRIC_BLUE};font-weight:600;">■ 电光蓝</span> = 请假/加班超过 1 天(>24h)`;
    selAll.onclick = () => setGroupAll(true);
    selNone.onclick = () => setGroupAll(false);
    selInvert.onclick = () => {
      groups.get(currentFlow).forEach(i => { i.selected = !i.selected; });
      renderTabs(); renderList();
    };
    toolbar.append(selAll, selNone, selInvert, legend);
    box.appendChild(toolbar);

    // 列表
    const listWrap = document.createElement('div');
    listWrap.style.cssText = `flex:1;overflow-y:auto;padding:6px 10px;`;
    box.appendChild(listWrap);

    // 底部
    const footer = document.createElement('div');
    footer.style.cssText = `
      display: flex; align-items: center; gap: 12px; padding: 12px 18px;
      border-top: 1px solid rgba(255,255,255,0.1);
    `;
    const countLabel = document.createElement('span');
    countLabel.style.cssText = `font-size:13px;color:#aebad0;`;
    const spacer = document.createElement('span');
    spacer.style.cssText = `flex:1;`;
    const refreshBtn = mkBtn('🔄 刷新汇总', `padding:7px 22px;`);
    refreshBtn.onclick = refreshSummary;
    const cancelBtn = mkBtn('取 消', `padding:7px 22px;`);
    cancelBtn.onclick = () => closeDialog(false);
    const okBtn = mkBtn('✅ 审批 (0)', `padding:7px 22px;background:#0b7fd9;border-color:#0b7fd9;color:#fff;font-weight:600;`);
    okBtn.onclick = onConfirm;
    footer.append(countLabel, spacer, refreshBtn, cancelBtn, okBtn);
    box.appendChild(footer);

    overlay.appendChild(box);
    overlay.onclick = (e) => { if (e.target === overlay) closeDialog(false); };
    document.body.appendChild(overlay);

    dialogState = {
      items: items, overlay: overlay, okBtn: okBtn, countLabel: countLabel,
      listWrap: listWrap, tabBar: tabBar, groups: groups, flowOrder: flowOrder,
      currentFlow: currentFlow, refreshBtn: refreshBtn, cancelBtn: cancelBtn,
      selAll: selAll, selNone: selNone, selInvert: selInvert,
      executing: false, _renderTabs: renderTabs, _renderList: renderList
    };
    dialogApi = {
      open: true,
      close: () => closeDialog(false),
      updateCount: updateCounts
    };

    // 渲染标签
    function renderTabs() {
      const s = dialogState;
      s.tabBar.innerHTML = '';
      for (const fc of s.flowOrder) {
        const its = s.groups.get(fc);
        const pending = its.filter(i => i.status !== 'success');
        const sel = pending.filter(i => i.selected).length;
        const done = its.length - pending.length;
        const active = fc === s.currentFlow;
        const tab = document.createElement('div');
        tab.style.cssText = `
          display: flex; align-items: center; gap: 6px; flex-shrink: 0;
          padding: 7px 14px; border-radius: 10px 10px 0 0; cursor: pointer;
          font-size: 13px; font-weight: 600; user-select: none;
          background: ${active ? 'rgba(11,127,217,0.22)' : 'rgba(255,255,255,0.04)'};
          border: 1px solid ${active ? '#0b7fd9' : 'rgba(255,255,255,0.08)'};
          border-bottom: ${active ? '2px solid #00a8e8' : '2px solid transparent'};
          color: ${active ? '#fff' : '#9fb6d8'};
        `;
        // 组勾选框
        const cbLabel = document.createElement('label');
        cbLabel.style.cssText = `display:flex;align-items:center;cursor:pointer;`;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.style.cssText = `width:14px;height:14px;accent-color:#0b7fd9;cursor:pointer;`;
        cb.disabled = dialogState.executing;
        cb.checked = pending.length > 0 && sel === pending.length;
        cb.indeterminate = sel > 0 && sel < pending.length;
        cb.disabled = s.executing || pending.length === 0;
        cb.onchange = (e) => {
          e.stopPropagation();
          setGroupChecked(fc, cb.checked);
        };
        cbLabel.appendChild(cb);
        cbLabel.onclick = (e) => e.stopPropagation();

        const name = document.createElement('span');
        name.textContent = its[0].flowLabel;

        const cnt = document.createElement('span');
        cnt.style.cssText = `font-size:11px;color:${active ? '#7fd0ff' : '#6c7fa0'};font-weight:400;`;
        cnt.textContent = `${sel}/${its.length}${done ? ` · ✓${done}` : ''}`;

        tab.append(cbLabel, name, cnt);
        tab.onclick = () => switchTab(fc);
        s.tabBar.appendChild(tab);
      }
    }

    function switchTab(fc) {
      const s = dialogState;
      if (s.executing || fc === s.currentFlow) return;
      s.currentFlow = fc;
      renderTabs();
      renderList();
    }

    function setGroupChecked(fc, v) {
      dialogState.groups.get(fc).forEach(i => {
        if (i.status !== 'success') i.selected = v;
      });
      renderTabs();
      renderList();
    }

    function setGroupAll(v) {
      const s = dialogState;
      s.groups.get(s.currentFlow).forEach(i => {
        if (i.status !== 'success') i.selected = v;
      });
      renderTabs();
      renderList();
    }

    // 渲染当前类别列表
    function renderList() {
      const s = dialogState;
      s.listWrap.innerHTML = '';
      const its = s.groups.get(s.currentFlow) || [];
      for (const it of its) {
        const row = document.createElement('label');
        row.style.cssText = `
          display: flex; align-items: center; gap: 10px; padding: 7px 10px; margin: 3px 0;
          border-radius: 8px; cursor: pointer; font-size: 13px; line-height: 1.4;
          background: ${it.highlight ? 'rgba(0,229,255,0.10)' : 'rgba(255,255,255,0.03)'};
          border-left: 3px solid ${it.highlight ? ELECTRIC_BLUE : 'transparent'};
        `;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = it.selected;
        cb.disabled = dialogState.executing || it.status === 'success';
        cb.style.cssText = `width:15px;height:15px;accent-color:#0b7fd9;flex-shrink:0;cursor:pointer;`;
        cb.onchange = () => { it.selected = cb.checked; renderTabs(); updateCounts(); };

        const main = document.createElement('div');
        main.style.cssText = `flex:1;min-width:0;`;
        const nameLine = document.createElement('div');
        nameLine.style.cssText = `color:#dbe6f5;font-weight:600;`;
        let mid = '';
        if (it.flowCode === 'QK01') mid = it.desc.detail;
        else if (it.flowCode === 'PLQJ01') mid = it.desc.detail + ' · ' + it.desc.extraDetail;
        else mid = it.desc.detail;
        const subject = it.desc.people || formatPeople(it.row);
        nameLine.textContent = subject + (mid ? '  ·  ' + mid : '');
        const remark = document.createElement('div');
        remark.style.cssText = `color:#8fa3c0;font-size:12px;`;
        remark.textContent = (it.row.Remark || it.row._detailRemark || '') || '\u00a0';
        main.append(nameLine, remark);

        const hoursTag = document.createElement('span');
        if (it.hours > 0) {
          hoursTag.textContent = it.hours + 'h';
          hoursTag.style.cssText = `
            flex-shrink:0; font-size:11px; font-weight:600; padding: 2px 7px; border-radius: 9px;
            ${it.highlight
              ? `color:#02131f;background:${ELECTRIC_BLUE};box-shadow:0 0 10px rgba(0,229,255,0.6);`
              : `color:#8fa3c0;background:rgba(255,255,255,0.08);`}`;
        } else {
          hoursTag.textContent = '—';
          hoursTag.style.cssText = `flex-shrink:0;font-size:11px;color:#5c6e8c;`;
        }

        if (it.highlight) {
          const badge = document.createElement('span');
          badge.textContent = '⚠ 超1天';
          badge.style.cssText = `flex-shrink:0;font-size:11px;font-weight:700;color:${ELECTRIC_BLUE};padding:2px 7px;border:1px solid ${ELECTRIC_BLUE};border-radius:9px;`;
          row.append(cb, main, hoursTag, badge, createStatusBadge(it));
        } else {
          row.append(cb, main, hoursTag, createStatusBadge(it));
        }
        s.listWrap.appendChild(row);
      }
      updateCounts();
    }

    function updateCounts() {
      const s = dialogState;
      const its = s.groups.get(s.currentFlow) || [];
      const sel = its.filter(i => i.selected && i.status !== 'success').length;
      const done = its.filter(i => i.status === 'success').length;
      const failed = its.filter(i => i.status === 'failed').length;
      s.okBtn.textContent = `✅ 审批 ${its[0] ? its[0].flowLabel : ''} (${sel})`;
      s.countLabel.textContent = `已选 ${sel} / ${its.length} 条 · 已完成 ${done} 条${failed ? ` · 失败 ${failed} 条` : ''}`;
      s.countLabel.style.cssText = `font-size:13px;color:#aebad0;`;
    }

    function createStatusBadge(it) {
      const status = document.createElement('span');
      status.style.cssText = 'flex-shrink:0;min-width:58px;text-align:right;font-size:11px;font-weight:600;';
      if (it.status === 'processing') {
        status.textContent = '⏳ 审批中';
        status.style.color = '#7fd0ff';
      } else if (it.status === 'success') {
        status.textContent = '✓ 已完成';
        status.style.color = '#45d483';
      } else if (it.status === 'failed') {
        status.textContent = '✕ 失败';
        status.style.color = '#ff8a8a';
        if (it.error) status.title = it.error;
      }
      return status;
    }

    function closeDialog(reScan) {
      if (dialogApi && dialogApi.open) dialogApi.open = false;
      dialogApi = null;
      dialogState = null;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    renderTabs();
    renderList();
  }

  // ── 执行审批 (仅当前类别, 逐条执行) ──
  async function onConfirm() {
    const s = dialogState;
    if (!s) return;
    const fc = s.currentFlow;
    const its = s.groups.get(fc) || [];
    const selected = its.filter(i => i.selected && i.status !== 'success');
    if (selected.length === 0) { showToast('请至少勾选一条', 'warning'); return; }
    const flowLabel = its[0] ? its[0].flowLabel : fc;

    const btn = s.okBtn;
    s.executing = true;
    btn.disabled = true;
    btn.style.pointerEvents = 'none';
    [s.refreshBtn, s.cancelBtn, s.selAll, s.selNone, s.selInvert].forEach(control => {
      if (control) control.disabled = true;
    });
    const total = selected.length;
    let approved = 0, failed = 0;
    const failures = [];

    const redraw = () => {
      const scrollTop = s.listWrap.scrollTop;
      s._renderTabs();
      s._renderList();
      s.listWrap.scrollTop = scrollTop;
    };

    for (const it of selected) {
      it.status = 'processing';
      btn.textContent = `⏳ ${approved + failed + 1} / ${total} · ${flowLabel}`;
      redraw();
      let result;
      try {
        result = await apiApprove([{
          TaskId: it.row.TaskId,
          FlowCode: it.row.FlowCode || fc,
          CurrStepNum: it.row.CurrStepNum,
          CurrActivityCode: it.row.ActivityCode,
          FormDataId: it.row.FormDataId,
          FormNo: it.row.FormNo,
          PkID: it.row.ID,
          RowData: it.row
        }]);
      } catch (e) {
        result = { success: false, err: String(e) };
      }
      if (result && result.success) {
        it.status = 'success';
        it.selected = false;
        approved++;
      } else {
        it.status = 'failed';
        it.error = result && result.err ? result.err : '审批失败';
        failed++;
        failures.push((it.row.EmpName || it.row.G_zdr || it.row.EmpCode || it.row.G_zdrcode || '?') + ' ' + it.error);
      }
      redraw();
      await new Promise(r => setTimeout(r, 350));
    }

    s.executing = false;
    btn.disabled = false;
    btn.style.pointerEvents = '';
    [s.refreshBtn, s.cancelBtn, s.selAll, s.selNone, s.selInvert].forEach(control => {
      if (control) control.disabled = false;
    });
    redraw();

    const msg = `${flowLabel} 审批完成:\n✅ 通过 ${approved} 条\n` + (failed ? `❌ 失败 ${failed} 条\n${failures.slice(0, 6).join('\n')}` : '');
    showToast(msg, failed ? 'warning' : 'success', 8000);
  }

  // 外部切换标签 (供审批完成后自动跳转使用)
  function switchTabExternal(fc) {
    const s = dialogState;
    if (!s || !s.flowOrder.includes(fc) || fc === s.currentFlow) return;
    s.currentFlow = fc;
    if (s._renderTabs) s._renderTabs();
    if (s._renderList) s._renderList();
  }

  // ── Toast ──
  function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration || 5000;
    const old = document.getElementById('kiro-ehr-toast');
    if (old) old.remove();
    const colors = {
      success: ['#1f9d55', '✓'],
      error: ['#e5484d', '✕'],
      warning: ['#e58b00', '⚠'],
      info: ['#0b7fd9', 'ℹ']
    };
    const [bg, icon] = colors[type] || colors.info;
    const t = document.createElement('div');
    t.id = 'kiro-ehr-toast';
    t.style.cssText = `
      position: fixed; top: 24px; right: 24px; z-index: 2147483647;
      background: #0f1626; border: 1px solid ${bg}; color: #e8eef7;
      border-radius: 12px; padding: 14px 18px; max-width: 420px;
      font: 13px/1.6 'Microsoft YaHei', sans-serif;
      box-shadow: 0 10px 36px rgba(0,0,0,0.5); white-space: pre-line;
    `;
    t.innerHTML = `<span style="color:${bg};font-weight:700;margin-right:6px;">${icon}</span>${message}`;
    document.body.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, duration);
  }

  // ── 加班申请填写助手 ──
  function setNativeFieldValue(element, value) {
    if (!element) return;
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function getCurrentEmployee() {
    const topWindow = (() => {
      try { return window.top; } catch (e) { return window; }
    })();
    const fallback = {
      code: String(window.ssousercode || topWindow.ssousercode || ''),
      name: document.querySelector('.ui-layout-top-link-text')?.textContent.trim() ||
        topWindow.document?.querySelector('.ui-layout-top-link-text')?.textContent.trim() || ''
    };
    try {
      const html = await (await fetch('/', { credentials: 'same-origin' })).text();
      return {
        code: html.match(/ssousercode\s*=\s*["']([^"']+)["']/i)?.[1] || fallback.code,
        name: html.match(/ui-layout-top-link-text[^>]*>([^<]+)</i)?.[1]?.trim() || fallback.name
      };
    } catch (e) {
      return fallback;
    }
  }

  async function applyDefaultEmployeeSelf(targetDocument = document) {
    const user = await getCurrentEmployee();
    if (!user.code) return false;
    setNativeFieldValue(targetDocument.getElementById('Code'), user.code);
    setNativeFieldValue(targetDocument.getElementById('EmpID'), user.code);
    setNativeFieldValue(targetDocument.getElementById('Name'), user.name);
    const view = targetDocument.defaultView;
    if (typeof view?.EmpChange === 'function') view.EmpChange();
    if (typeof view?.GetPathData === 'function') view.GetPathData();
    return true;
  }

  function calculateEndTime(start, duration) {
    const match = String(start || '').match(/^(\d{1,2}):(\d{2})$/);
    const hours = Number(duration);
    if (!match || !Number.isFinite(hours) || hours <= 0) return null;
    const total = Number(match[1]) * 60 + Number(match[2]) + Math.round(hours * 60);
    return {
      time: `${String(Math.floor((total % 1440) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`,
      dayOffset: Math.floor(total / 1440)
    };
  }

  function dateWithOffset(dateText, offset) {
    const date = new Date(`${dateText}T00:00:00`);
    date.setDate(date.getDate() + Number(offset || 0));
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function dispatchBlur(element) {
    if (!element) return;
    element.dispatchEvent(new Event('blur', { bubbles: false }));
  }

  function openNativeEmployeePicker() {
    const input = document.getElementById('Code');
    const button = input?.parentElement?.querySelector('button');
    if (button) button.click();
  }

  function openNativePicker(id) {
    const input = document.getElementById(id);
    const button = input?.parentElement?.querySelector('button');
    if (button) button.click();
  }

  function openNativeEmployeePickerFor(suffix) {
    openNativePicker(`QJEmpCode${suffix}`);
  }

  function openNativeLeaveTypePickerFor(suffix) {
    openNativePicker(`QJTypeName${suffix}`);
  }

  function ensureTemporaryOvertimeRow() {
    let row = document.querySelector('.temporariness_time');
    if (row) return row;
    const add = document.querySelector('[title="添加临时加班"]');
    if (add) add.click();
    row = document.querySelector('.temporariness_time:last-of-type');
    return row;
  }

  function applyOvertimePreset(config, status) {
    if (isWorkflowOvertimeForm()) {
      applyWorkflowOvertime(config, status);
      return;
    }
    const dateInput = document.getElementById('OverTimeDate');
    const selectedDate = config.date || dateInput?.value;
    if (!dateInput || !selectedDate) {
      status('请先选择加班日期');
      return;
    }

    // 日期必须先于临时行设置, EHR 的 DateChange 会清理旧时段。
    setNativeFieldValue(dateInput, selectedDate);
    dispatchBlur(dateInput);

    const row = ensureTemporaryOvertimeRow();
    if (!row) {
      status('未找到时段行,请点击“添加临时加班”');
      return;
    }

    const beginSelect = row.querySelector('select[data-type="begin"]');
    const endSelect = row.querySelector('select[data-type="end"]');
    const beginInput = row.querySelector('input[name="temporariness_begintime"]');
    const endInput = row.querySelector('input[name="temporariness_endtime"]');
    const restInput = row.querySelector('input[name="DeductionRest"]');
    const noBreak = row.querySelector('input[name="NoBreak"]');
    if (!beginInput || !endInput) {
      status('时段行尚未准备好,请稍后再试');
      return;
    }

    const beginOffset = String(config.beginOffset ?? 0);
    const endOffset = String(config.endOffset ?? 0);
    if (beginSelect) {
      setNativeFieldValue(beginSelect, beginOffset);
      beginInput.setAttribute('data-date', dateWithOffset(selectedDate, beginOffset));
    }
    if (endSelect) {
      setNativeFieldValue(endSelect, endOffset);
      endInput.setAttribute('data-date', dateWithOffset(selectedDate, endOffset));
    }
    setNativeFieldValue(beginInput, config.begin);
    setNativeFieldValue(endInput, config.end);
    dispatchBlur(beginInput);
    dispatchBlur(endInput);

    if (restInput) setNativeFieldValue(restInput, config.rest || '');
    if (noBreak) {
      noBreak.checked = !!config.noBreak;
      noBreak.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const typeInput = document.getElementById('jblx');
    if (typeInput && !typeInput.value) setNativeFieldValue(typeInput, '加班申请');
    const meal = document.getElementById('sfkyc');
    if (meal && !meal.value) setNativeFieldValue(meal, '2');

    const length = row.querySelector('input[name="temporariness_timelength"]');
    status(`已填入 ${selectedDate} ${config.begin} - ${config.end}${length?.value ? ` (${length.value}小时)` : ''},请核对后保存`);
  }

  function isWorkflowOvertimeForm() {
    const path = location.pathname.toLowerCase();
    const code = new URLSearchParams(location.search).get('flowCode');
    return path.indexOf('/oa/wf005/edit') === 0 && (code === 'GRPLJB001' || code === 'PLJB06');
  }

  function workflowOvertimeCode() {
    return new URLSearchParams(location.search).get('flowCode') || '';
  }

  function workflowOvertimeRows() {
    return Array.from(document.querySelectorAll('input[name="EmpCode"]'))
      .map(input => input.closest('tr'))
      .filter(row => row && row.querySelector('input[name="BeginTime"]') && row.querySelector('input[name="EndTime"]'));
  }

  function workflowEmployeeInput(row) {
    return row?.querySelector('input[name="EmpCode"]');
  }

  function openWorkflowEmployeePicker(rowIndex = 0) {
    const row = workflowOvertimeRows()[Math.max(0, Number(rowIndex) || 0)];
    const input = workflowEmployeeInput(row);
    input?.parentElement?.querySelector('button')?.click();
  }

  function setWorkflowEmployee(row, code, name) {
    if (!row) return;
    setNativeFieldValue(row.querySelector('input[name="EmpCode"]'), code);
    setNativeFieldValue(row.querySelector('input[name="EmpID"]'), code);
    setNativeFieldValue(row.querySelector('input[name="EmpName"]'), name || '');
  }

  function applyWorkflowEmployeeToRows(code, name, rowIndex = null) {
    const rows = workflowOvertimeRows();
    if (rowIndex === null) rows.forEach(row => setWorkflowEmployee(row, code, name));
    else setWorkflowEmployee(rows[Number(rowIndex) || 0], code, name);
  }

  function applyWorkflowOvertime(config, status) {
    const rows = workflowOvertimeRows();
    if (rows.length === 0) return status('未找到批量加班明细行');
    const endDate = dateWithOffset(config.date, config.endOffset || 0);
    const duration = Number(config.duration || 0);
    rows.forEach(row => {
      if (config.employeeCode) setWorkflowEmployee(row, config.employeeCode, config.employeeName);
      setNativeFieldValue(row.querySelector('input[name="BeginTime"]'), config.date);
      setNativeFieldValue(row.querySelector('input[name="beginTime1"]'), config.begin);
      setNativeFieldValue(row.querySelector('input[name="EndTime"]'), endDate);
      setNativeFieldValue(row.querySelector('input[name="endTime1"]'), config.end);
      setNativeFieldValue(row.querySelector('input[name="TotalHour"]'), duration ? String(duration) : '');
      if (config.remark) setNativeFieldValue(row.querySelector('input[name="Remark"]'), config.remark);
    });
    status(`已填入 ${rows.length} 条加班明细: ${config.date} ${config.begin}-${config.end},请核对后保存`);
  }

  function applyLeavePreset(config, status) {
    const rows = Array.from(document.querySelectorAll('input[id^="QJEmpCode"]'))
      .map(input => input.id.match(/^QJEmpCode(\d+)$/)?.[1])
      .filter(Boolean);
    if (rows.length === 0) return status('未找到批量请假明细行');
    const endDate = config.endDate || config.date;
    rows.forEach(suffix => {
      setNativeFieldValue(document.getElementById(`QJBeginDate${suffix}`), config.date);
      setNativeFieldValue(document.getElementById(`QJBeginTime${suffix}`), config.begin);
      setNativeFieldValue(document.getElementById(`QJEndDate${suffix}`), endDate);
      setNativeFieldValue(document.getElementById(`QJEndTime${suffix}`), config.end);
      dispatchBlur(document.getElementById(`QJBeginDate${suffix}`));
      dispatchBlur(document.getElementById(`QJBeginTime${suffix}`));
      dispatchBlur(document.getElementById(`QJEndDate${suffix}`));
      dispatchBlur(document.getElementById(`QJEndTime${suffix}`));
    });
    const codes = String(config.employeeCodes || '').split(',').map(x => x.trim()).filter(Boolean);
    const names = String(config.employeeNames || '').split(',').map(x => x.trim()).filter(Boolean);
    codes.slice(0, rows.length).forEach((code, index) => {
      const suffix = rows[index];
      setNativeFieldValue(document.getElementById(`QJEmpCode${suffix}`), code);
      setNativeFieldValue(document.getElementById(`QJEmpID${suffix}`), code);
      setNativeFieldValue(document.getElementById(`QJEmpName${suffix}`), names[index] || '');
    });
    status(`已填入 ${Math.min(codes.length, rows.length)} 行人员及请假时间,请核对后手动保存`);
  }

  function fillLeaveRowsFromSelection(status) {
    const rows = Array.from(document.querySelectorAll('input[id^="QJEmpCode"]'))
      .map(input => input.id.match(/^QJEmpCode(\d+)$/)?.[1])
      .filter(Boolean);
    const codes = String(document.getElementById('QJEmpCode2')?.value || '').split(',').filter(Boolean);
    const names = String(document.getElementById('QJEmpName2')?.value || '').split(',').filter(Boolean);
    rows.forEach((suffix, index) => {
      if (!codes[index]) return;
      setNativeFieldValue(document.getElementById(`QJEmpCode${suffix}`), codes[index]);
      setNativeFieldValue(document.getElementById(`QJEmpID${suffix}`), codes[index]);
      setNativeFieldValue(document.getElementById(`QJEmpName${suffix}`), names[index] || '');
    });
    status(`已按明细行写入 ${Math.min(codes.length, rows.length)} 名员工`);
  }

  function applyPatchPreset(config, status) {
    const date = document.getElementById('PatchDate');
    if (!date) return status('未找到补卡日期字段');
    setNativeFieldValue(date, config.date);
    dispatchBlur(date);
    if (typeof window.GetPathData === 'function') window.GetPathData();
    setTimeout(() => {
      const candidates = config.point === 'out'
        ? Array.from(document.querySelectorAll('input[name="Patch"][data-type="1"]'))
        : Array.from(document.querySelectorAll('input[name="Patch"][data-type="0"]'));
      const patch = candidates.find(input => input.value === '') || candidates[0];
      const checkbox = patch?.closest('span')?.querySelector('input[name="IfChoose"]');
      if (checkbox) {
        checkbox.checked = true;
        checkbox.value = '1';
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      status(`已选择 ${config.date} ${config.point === 'out' ? '下班' : '上班'}补卡,请核对原因后保存`);
    }, 500);
  }

  function initLeaveAssistant() {
    if (isExternalFormFrame()) {
      initExternalFormBridge('leave');
      return;
    }
    initFormAssistant({
      mode: 'leave',
      title: '⚡ 批量请假填写助手',
      employeeAction: '选择请假人(支持多选)',
      fields: `
        <button data-action="type" style="width:100%;padding:6px;margin-top:6px;border:1px solid #287eb5;border-radius:6px;background:#12314d;color:#dff5ff;cursor:pointer;">选择请假类型</button>
        <div style="margin-top:8px;color:#aebad0;">开始日期/时间</div>
        <div style="display:flex;gap:5px;margin-top:3px;"><input data-field="date" type="date" style="width:58%;box-sizing:border-box;padding:5px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;"><input data-field="begin" type="time" value="08:00" style="width:42%;box-sizing:border-box;padding:5px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;"></div>
        <div style="margin-top:8px;color:#aebad0;">结束日期/时间</div>
        <div style="display:flex;gap:5px;margin-top:3px;"><input data-field="endDate" type="date" style="width:58%;box-sizing:border-box;padding:5px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;"><input data-field="end" type="time" value="17:00" style="width:42%;box-sizing:border-box;padding:5px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;"></div>
      `,
      onEmployee: openNativeEmployeePicker,
      onSetup(panel) {
        panel.querySelector('[data-action="type"]').addEventListener('click', () => openNativePicker('AbsenceCode'));
        const date = document.getElementById('BeginTime')?.value?.slice(0, 10) || new Date().toISOString().slice(0, 10);
        panel.querySelector('[data-field="date"]').value = date;
        panel.querySelector('[data-field="endDate"]').value = date;
      },
      onApply(panel, status) {
        applyLeavePreset({
          date: panel.querySelector('[data-field="date"]').value,
          begin: panel.querySelector('[data-field="begin"]').value,
          endDate: panel.querySelector('[data-field="endDate"]').value,
          end: panel.querySelector('[data-field="end"]').value
        }, status);
      }
    });
  }

  function initPatchAssistant() {
    if (isExternalFormFrame()) {
      initExternalFormBridge('patch');
      return;
    }
    initFormAssistant({
      mode: 'patch',
      title: '⚡ 补卡填写助手',
      employeeAction: '选择补卡员工(支持多选)',
      fields: `
        <div style="margin-top:8px;color:#aebad0;">补卡日期</div>
        <input data-field="date" type="date" style="width:100%;box-sizing:border-box;padding:5px;margin-top:3px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;">
        <div style="margin-top:8px;color:#aebad0;">补卡点</div>
        <select data-field="point" style="width:100%;box-sizing:border-box;padding:5px;margin-top:3px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;"><option value="in">上班</option><option value="out">下班</option></select>
        <button data-action="reason" style="width:100%;padding:6px;margin-top:6px;border:1px solid #287eb5;border-radius:6px;background:#12314d;color:#dff5ff;cursor:pointer;">选择补卡原因</button>
      `,
      onEmployee: openNativeEmployeePicker,
      onSetup(panel) {
        panel.querySelector('[data-action="reason"]').addEventListener('click', () => openNativePicker('ReasonCode'));
        panel.querySelector('[data-field="date"]').value = document.getElementById('PatchDate')?.value || new Date().toISOString().slice(0, 10);
      },
      onApply(panel, status) {
        applyPatchPreset({
          date: panel.querySelector('[data-field="date"]').value,
          point: panel.querySelector('[data-field="point"]').value
        }, status);
      }
    });
  }

  function initFormAssistant(config) {
    if (!document.body || document.getElementById('kiro-ehr-form-helper')) return;
    const panel = document.createElement('div');
    panel.id = 'kiro-ehr-form-helper';
    panel.style.cssText = `position:fixed;right:18px;top:18px;z-index:2147483646;width:238px;padding:12px;border:1px solid rgba(0,168,232,.55);border-radius:12px;background:rgba(15,22,38,.96);color:#e8eef7;box-shadow:0 10px 30px rgba(0,0,0,.35);font:12px/1.45 'Microsoft YaHei',sans-serif;`;
    panel.innerHTML = `<div style="font-weight:700;font-size:14px;margin-bottom:8px;color:#7fd0ff;">${config.title}</div><button data-action="employee" style="width:100%;padding:6px;border:1px solid #287eb5;border-radius:6px;background:#12314d;color:#dff5ff;cursor:pointer;">${config.employeeAction}</button>${config.fields}<button data-action="apply" style="width:100%;padding:7px;margin-top:10px;border:0;border-radius:6px;background:#087fca;color:#fff;font-weight:700;cursor:pointer;">确认填入表单</button><div data-role="status" style="margin-top:8px;color:#92a8c5;min-height:34px;">只填充,不自动保存</div><div style="margin-top:7px;color:#7187a6;font-size:11px;">请核对后点击原生“保存并关闭”。</div>`;
    document.body.appendChild(panel);
    const status = message => { panel.querySelector('[data-role="status"]').textContent = message; };
    panel.querySelector('[data-action="employee"]').addEventListener('click', config.onEmployee);
    config.onSetup(panel);
    panel.querySelector('[data-action="apply"]').addEventListener('click', () => config.onApply(panel, status));
  }

  function isExternalFormFrame() {
    return new URLSearchParams(location.search).get('kiroExternal') === '1';
  }

  function postFormStatus(message, type = 'info') {
    try {
      window.parent.postMessage({ source: 'kiro-ehr-form', type, message }, location.origin);
    } catch (e) {}
  }

  function initExternalFormBridge(mode) {
    if (window.__kiroEhrFormBridge) return;
    window.__kiroEhrFormBridge = true;
    postFormStatus('员工字段为空,可点击右侧“填写本人”或选择员工');
    window.addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      const data = event.data || {};
      if (data.source !== 'kiro-ehr-launcher') return;
      if (data.action === 'defaultEmployee' && data.user?.code) {
        const suffix = data.suffix;
        if (data.workflowAll) applyWorkflowEmployeeToRows(data.user.code, data.user.name, null);
        else if (data.workflowRowIndex !== null && data.workflowRowIndex !== undefined) applyWorkflowEmployeeToRows(data.user.code, data.user.name, data.workflowRowIndex);
        else {
          setNativeFieldValue(document.getElementById(suffix ? `QJEmpCode${suffix}` : 'Code'), data.user.code);
          setNativeFieldValue(document.getElementById(suffix ? `QJEmpID${suffix}` : 'EmpID'), data.user.code);
          setNativeFieldValue(document.getElementById(suffix ? `QJEmpName${suffix}` : 'Name'), data.user.name || '');
        }
        postFormStatus(`已默认选择本人 ${data.user.name || ''} ${data.user.code}`);
      }
      if (data.action === 'employee') openNativeEmployeePicker();
      if (data.action === 'workflowEmployee') openWorkflowEmployeePicker(data.rowIndex);
      if (data.action === 'workflowEmployeeRows') applyWorkflowEmployeeToRows(data.code, data.name, data.rowIndex);
      if (data.action === 'workflowEmployeeAllRows') applyWorkflowEmployeeToRows(data.code, data.name, null);
      if (data.action === 'leaveEmployee') openNativeEmployeePickerFor(data.suffix);
      if (data.action === 'leaveType') openNativeLeaveTypePickerFor(data.suffix);
      if (data.action === 'type') openNativePicker('AbsenceCode');
      if (data.action === 'reason') openNativePicker('ReasonCode');
      if (data.action === 'shift') openNativePicker('ShiftCode');
      if (data.action === 'applyOvertime') applyOvertimePreset(data.config, postFormStatus);
      if (data.action === 'applyLeave') applyLeavePreset(data.config, postFormStatus);
      if (data.action === 'applyPatch') applyPatchPreset(data.config, postFormStatus);
    });
  }

  function initOvertimeAssistant() {
    if (isExternalFormFrame()) {
      initExternalFormBridge('overtime');
      return;
    }
    if (!document.body || document.getElementById('kiro-ehr-overtime-helper')) return;

    const panel = document.createElement('div');
    panel.id = 'kiro-ehr-overtime-helper';
    panel.style.cssText = `
      position: fixed; right: 18px; top: 18px; z-index: 2147483646; width: 224px;
      padding: 12px; border: 1px solid rgba(0,168,232,.55); border-radius: 12px;
      background: rgba(15,22,38,.96); color: #e8eef7; box-shadow: 0 10px 30px rgba(0,0,0,.35);
      font: 12px/1.45 'Microsoft YaHei', sans-serif;
    `;
    panel.innerHTML = `
      <div style="font-weight:700;font-size:14px;margin-bottom:8px;color:#7fd0ff;">⚡ 加班填写助手</div>
      <button data-action="employee" style="width:100%;padding:6px;border:1px solid #287eb5;border-radius:6px;background:#12314d;color:#dff5ff;cursor:pointer;">选择员工(支持多选)</button>
      <button data-action="shift" style="width:100%;padding:6px;margin-top:6px;border:1px solid #287eb5;border-radius:6px;background:#12314d;color:#dff5ff;cursor:pointer;">选择班制(可选)</button>
      <div style="margin-top:8px;color:#aebad0;">加班日期</div>
      <input data-field="date" type="date" style="width:100%;box-sizing:border-box;padding:5px;margin-top:3px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;">
      <div style="margin-top:8px;color:#aebad0;">常用时段</div>
      <select data-field="preset" style="width:100%;box-sizing:border-box;padding:5px;margin-top:3px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;">
        <option value="early">08:00 - 16:00</option>
        <option value="middle">16:00 - 次日00:00</option>
        <option value="night">24:00 - 08:00</option>
      </select>
      <div style="display:flex;gap:5px;margin-top:8px;">
        <input data-field="begin" type="time" value="08:00" style="width:50%;box-sizing:border-box;padding:5px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;">
        <input data-field="end" type="time" value="16:00" style="width:50%;box-sizing:border-box;padding:5px;border-radius:5px;border:1px solid #526781;background:#101b2c;color:#fff;">
      </div>
      <label style="display:flex;align-items:center;gap:6px;margin-top:8px;color:#cbd8eb;">
        <input data-field="noBreak" type="checkbox"> 直落
      </label>
      <button data-action="apply" style="width:100%;padding:7px;margin-top:9px;border:0;border-radius:6px;background:#087fca;color:#fff;font-weight:700;cursor:pointer;">一键填入表单</button>
      <div data-role="status" style="margin-top:8px;color:#92a8c5;min-height:34px;">先选择员工,再选择日期和时段</div>
      <div style="margin-top:7px;color:#7187a6;font-size:11px;">助手只填表,不会自动保存。请核对后点击原生“保存并关闭”。</div>
    `;
    document.body.appendChild(panel);

    const dateInput = panel.querySelector('[data-field="date"]');
    const formDate = document.getElementById('OverTimeDate')?.value;
    if (formDate) dateInput.value = formDate;
    const status = message => { panel.querySelector('[data-role="status"]').textContent = message; };

    panel.querySelector('[data-action="employee"]').addEventListener('click', openNativeEmployeePicker);
    panel.querySelector('[data-action="shift"]').addEventListener('click', () => {
      const input = document.getElementById('ShiftCode');
      const picker = input?.parentElement?.querySelector('button');
      if (picker) picker.click();
      else status('未找到班制选择器');
    });
    panel.querySelector('[data-field="preset"]').addEventListener('change', event => {
      const values = {
        early: ['08:00', '16:00'],
        middle: ['16:00', '00:00'],
        night: ['00:00', '08:00']
      }[event.target.value];
      panel.querySelector('[data-field="begin"]').value = values[0];
      panel.querySelector('[data-field="end"]').value = values[1];
    });
    panel.querySelector('[data-action="apply"]').addEventListener('click', () => {
      const preset = panel.querySelector('[data-field="preset"]').value;
      const offsets = preset === 'middle' ? [0, 1] : preset === 'night' ? [0, 0] : [0, 0];
      applyOvertimePreset({
        date: dateInput.value,
        begin: panel.querySelector('[data-field="begin"]').value,
        end: panel.querySelector('[data-field="end"]').value,
        beginOffset: offsets[0],
        endOffset: offsets[1],
        noBreak: panel.querySelector('[data-field="noBreak"]').checked
      }, status);
    });
  }

  // ── 初始化 ──
  function init() {
    if (!isEhrPage()) return;
    const workflowCode = getWorkflowFormCode();
    // 申请填写助手暂不启用：在这些表单页不创建任何浮层
    if (!FILL_ASSISTANT_ENABLED && (['PLQJ01', 'GRPLJB001', 'QK01'].includes(workflowCode) ||
        isOvertimeAddPage() || isLeaveAddPage() || isPatchAddPage())) return;
    if (workflowCode === 'PLQJ01') {
      initLeaveAssistant();
      return;
    }
    if (workflowCode === 'GRPLJB001') {
      initOvertimeAssistant();
      return;
    }
    if (workflowCode === 'QK01') {
      initPatchAssistant();
      return;
    }
    if (isOvertimeAddPage()) {
      initOvertimeAssistant();
      return;
    }
    if (isLeaveAddPage()) {
      initLeaveAssistant();
      return;
    }
    if (isPatchAddPage()) {
      initPatchAssistant();
      return;
    }
    if (!isTopFrame()) return;
    // 仅顶层 shell 或待办页显示按钮
    const p = location.pathname;
    const ok = p === '/' || p === '/Home' || p === '/Home/Desktop' ||
               p.indexOf('/OA/WF007/Index') === 0 || p.indexOf('/OA/WF007/FormList') === 0;
    if (!ok) return;
    let refreshAfterLoad = false;
    try {
      refreshAfterLoad = sessionStorage.getItem('kiro_ehr_refresh_summary') === '1';
      if (refreshAfterLoad) sessionStorage.removeItem('kiro_ehr_refresh_summary');
    } catch (e) {}

    const boot = () => {
      ensureButton();
      ensureApplicationButton();
      if (refreshAfterLoad) setTimeout(() => onButtonClick(), 800);
    };
    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot, { once: true });
  }

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init);
})();
