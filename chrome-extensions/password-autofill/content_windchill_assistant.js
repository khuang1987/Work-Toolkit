// Windchill 智能工作台：紧凑输入、原生高级搜索和审批摘要。
// 查询结果交给 Windchill 自己的页面展示；浮层只保留输入、筛选和数量汇总。
(function () {
  'use strict';

  if (window.top !== window || location.hostname !== 'khplm.medtronic.com.cn') return;
  if (document.getElementById('windchill-assistant-host')) return;

  const host = document.createElement('div');
  host.id = 'windchill-assistant-host';
  // 开放 Shadow DOM 便于 Windchill 用户的无障碍工具和浏览器自动化读取浮层控件。
  const shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  function initialMode() {
    try { return sessionStorage.getItem('windchillAssistantMode') === 'approval' ? 'approval' : 'search'; } catch (error) { return 'search'; }
  }

  const state = {
    records: [],
    tasks: [],
    mode: initialMode(),
    loading: false,
    requestId: 0,
    nativeSearch: 'idle',
    nativeShown: null,
    truncated: false,
    serverTotal: 0,
    paging: false,
    filters: new Set(['drawing']),
    formats: new Set(['pdf', 'dwg', 'word', 'excel', 'ppt', 'archive']),
    resultFilterReady: false,
    resultVersion: 0,
    partial: false,
    credentialConfigured: false,
    autoFillEnabled: true,
    currentTaskDetail: null
  };

  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (element) => Boolean(element && element.getClientRects().length);
  const approvalCacheKey = 'windchillAssistantApprovalTasksV2';
  const MAX_RESULT_ITEMS = 100;

  function saveApprovalTaskCache(tasks) {
    try {
      sessionStorage.setItem(approvalCacheKey, JSON.stringify({
        savedAt: Date.now(),
        tasks: tasks.map((task) => ({
          title: task.title,
          number: task.number,
          subjectTitle: task.subjectTitle,
          subjectText: task.subjectText,
          version: task.version,
          lifecycleState: task.lifecycleState,
          status: task.status,
          description: task.description,
          context: task.context,
          owner: task.owner,
          priority: task.priority,
          process: task.process,
          taskDescription: task.taskDescription,
          initiator: task.initiator,
          deadline: task.deadline,
          created: task.created,
          role: task.role,
          taskUrl: task.taskUrl,
          subjectUrl: task.subjectUrl,
          nativeKey: task.nativeKey
        }))
      }));
    } catch (error) {}
  }

  function restoreApprovalTaskCache() {
    if (state.tasks.length) return;
    try {
      const cached = JSON.parse(sessionStorage.getItem(approvalCacheKey) || '{}');
      if (Array.isArray(cached.tasks)) state.tasks = cached.tasks;
    } catch (error) {}
  }

  function storageGet(keys, callback) {
    try { chrome.storage.local.get(keys, callback); } catch (error) {}
  }

  function storageSet(value, callback) {
    try { chrome.storage.local.set(value, callback); } catch (error) {}
  }

  function textValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'object') return clean(value);
    return clean(value.Display || value.display || value.Name || value.name || value.Title || value.title || value.FullName || value.fullName || value.Value || value.value || value.ID || value.id);
  }

  function firstValue(object, keys) {
    for (const key of keys) {
      if (object && object[key] !== undefined && object[key] !== null && textValue(object[key])) return textValue(object[key]);
    }
    return '';
  }

  function odataString(value) {
    return String(value || '').replace(/'/g, "''");
  }

  function odataItems(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload && payload.value)) return payload.value;
    if (Array.isArray(payload && payload.items)) return payload.items;
    if (Array.isArray(payload && payload.data)) return payload.data;
    return [];
  }

  async function fetchWindchillOData(path, params = {}, options = {}) {
    const search = new URLSearchParams(params);
    // 服务端分页：nextLink 是完整 URL，只允许同源。
    const url = /^https?:\/\//i.test(path)
      ? (path.startsWith(location.origin) ? path : '')
      : `${location.origin}/Windchill/servlet/odata/${path}${search.toString() ? `?${search}` : ''}`;
    if (!url) throw new Error('拒绝访问非 Windchill 同源地址');
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12000);
    try {
      const response = await fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Windchill REST ${response.status}: ${clean(body).slice(0, 180)}`);
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new Error('Windchill 返回的不是 JSON，可能尚未启用 REST 服务');
      }
    } catch (error) {
      if (error && error.name === 'AbortError' && timedOut) {
        throw new Error('Windchill 接口响应超时（12 秒）');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  // 分类、图纸和签名文件规则来自规则库（插件后台「Windchill 规则库」）；
  // 先用内置默认值，读取到已保存规则后替换并重新查询。
  const Rules = globalThis.WcRules;
  let rules = Rules.defaults();

  function documentPrefix(value) {
    return Rules.prefixOf(rules, clean(value));
  }

  function hasLeadingDocumentPrefix(value) {
    return Rules.hasLeadingPrefix(rules, clean(value));
  }

  function categoryForDocument(item, kind) {
    const name = firstValue(item, ['Name', 'Title', 'FileName', 'name', 'title']);
    const source = [
      firstValue(item, ['Number', 'DocumentNumber']),
      name,
      firstValue(item, ['Description', 'description']),
      firstValue(item, ['Context', 'Folder', 'Organization']),
      firstValue(item, ['Type', 'Category', 'DocumentType'])
    ].filter(Boolean).join(' ');
    const category = Rules.classify(rules, { text: source, name });
    if (category) return category;
    if (kind === 'cad' || kind === 'drawing') return 'drawing';
    return 'other';
  }

  function primaryContentSource(item) {
    const primary = item && (item.PrimaryContent || item.primaryContent
      || item.PrimaryContentInfo || item.primaryContentInfo || item.Content || item.content);
    if (!primary) return '';
    let source = '';
    try {
      source = JSON.stringify(primary);
    } catch (error) {
      source = String(primary || '');
    }
    return source;
  }

  function formatFromSource(source) {
    const value = String(source || '');
    if (/\.pdf(?:[^a-z0-9]|$)|file[_-]?pdf|application\/pdf|下载\s*pdf|(?:mime|format|formatname|contenttype)[^\n]{0,100}\bpdf\b/i.test(value)) return 'pdf';
    if (/\.dwg(?:[^a-z0-9]|$)|file[_-]?dwg|application\/acad|application\/dwg|(?:mime|format|formatname|contenttype)[^\n]{0,100}\bdwg\b/i.test(value)) return 'dwg';
    if (/\.docx?(?:[^a-z0-9]|$)|file[_-]?(?:ms)?word|application\/msword|wordprocessingml\.document|下载[^\n]{0,40}\bword\b|(?:mime|format|formatname|contenttype)[^\n]{0,100}\b(?:docx?|word)\b/i.test(value)) return 'word';
    if (/\.(?:xls|xlsx|xlsb)(?:[^a-z0-9]|$)|file[_-]?excel|application\/vnd\.ms-excel|application\/vnd\.ms-excel\.sheet\.binary\.macroenabled\.12|spreadsheetml\.sheet|下载[^\n]{0,40}\bexcel\b|(?:mime|format|formatname|contenttype)[^\n]{0,100}\b(?:xlsb?|xlsx|excel)\b/i.test(value)) return 'excel';
    if (/\.pptx?(?:[^a-z0-9]|$)|file[_-]?(?:ms)?powerpoint|powerpoint|presentationml\.presentation|(?:mime|format|formatname|contenttype)[^\n]{0,100}\b(?:pptx?|powerpoint)\b/i.test(value)) return 'ppt';
    if (/\.(?:zip|rar|7z|tar|gz)(?:[^a-z0-9]|$)|file[_-]?(?:zip|rar|7z)|application\/(?:zip|x-rar-compressed|x-7z-compressed)|(?:mime|format|formatname|contenttype)[^\n]{0,100}\b(?:zip|rar|7z|tar|gz)\b/i.test(value)) return 'archive';
    return 'other';
  }

  function formatForDocument(item) {
    return formatFromSource([
      primaryContentSource(item),
      firstValue(item, ['Name', 'Title', 'FileName', 'Format', 'MimeType', 'ContentType'])
    ].filter(Boolean).join(' '));
  }

  function normalizeDocument(item, kind) {
    const title = firstValue(item, ['Name', 'Title', 'FileName', 'name', 'title']) || '未命名对象';
    const number = firstValue(item, ['Number', 'DocumentNumber', 'FileName', 'Name']);
    const version = firstValue(item, ['Version', 'VersionID', 'Revision', 'Iteration']);
    const status = firstValue(item, ['State', 'LifeCycleState', 'Status', 'ChangeStatus']);
    const description = firstValue(item, ['Description', 'description']);
    const context = firstValue(item, ['Context', 'Folder', 'Organization']);
    const format = formatForDocument(item);
    return {
      oid: firstValue(item, ['ID']),
      title,
      number,
      version,
      status,
      text: [title, number, version, status, description, context].filter(Boolean).join(' · '),
      identifier: number || title,
      kind,
      category: categoryForDocument(item, kind),
      format,
      isPdf: format === 'pdf',
      contents: Rules.extractContents(item, formatFromSource),
      hasLeadingPrefix: hasLeadingDocumentPrefix(number) || hasLeadingDocumentPrefix(title)
    };
  }

  function normalizeTask(item) {
    const activity = item && item.Activity || {};
    const subject = item && item.Subject || {};
    const owner = item && (item.OriginalOwner || item.Owner) || {};
    const title = firstValue(activity, ['Name', 'Title']) || firstValue(item, ['Name', 'Subject']) || 'Windchill 审批任务';
    const number = firstValue(subject, ['Number', 'Name', 'Title']) || firstValue(item, ['Number']);
    const subjectTitle = firstValue(subject, ['Name', 'Title', 'Description', 'description']);
    const version = firstValue(subject, ['Version', 'VersionID', 'Revision']);
    const status = firstValue(item, ['Status', 'State']) || firstValue(item, ['StatusDisplay']);
    const lifecycleState = firstValue(subject, ['LifeCycleState', 'LifecycleState', 'State', 'Status']);
    const description = firstValue(subject, ['Description', 'description']);
    const context = firstValue(subject, ['Context', 'Folder', 'Organization']);
    const ownerName = firstValue(owner, ['FullName', 'Name']);
    const initiator = firstValue(item, ['CreatedBy', 'Initiator']) || ownerName;
    const priority = firstValue(item, ['Priority', 'PriorityDisplay']);
    const process = firstValue(item, ['Process', 'ProcessName', 'Workflow', 'WorkflowName']);
    const taskDescription = firstValue(item, ['Instructions', 'Description', 'TaskDescription', 'Comment']);
    const deadline = firstValue(item, ['Deadline', 'DueDate', 'DeadlineDate']);
    const created = firstValue(item, ['CreatedOn', 'CreateTimestamp', 'StartTime']);
    const role = firstValue(item, ['Role', 'RoleDisplay']);
    return {
      title,
      number,
      subjectTitle,
      version,
      status,
      lifecycleState,
      description,
      context,
      owner: ownerName,
      priority,
      process,
      taskDescription,
      initiator,
      deadline,
      created,
      role,
      taskUrl: firstValue(item, ['URL', 'Url', 'Link', 'Href', 'href']),
      subjectUrl: firstValue(subject, ['URL', 'Url', 'Link', 'Href', 'href']),
      text: [title, subjectTitle, number, version, status, lifecycleState, description, context, ownerName, priority, process, taskDescription, initiator, created, deadline, role].filter(Boolean).join(' · ')
    };
  }

  function taskCellText(row, className) {
    return clean(row.querySelector(`td.${className}`)?.innerText || '');
  }

  function taskCellLink(row, className) {
    const link = row.querySelector(`td.${className} a[href]`);
    return link ? { text: clean(link.innerText), href: link.href } : { text: '', href: '' };
  }

  function parseTaskSubject(text) {
    const subjectText = clean(text);
    const parts = subjectText.split(/\s*,\s*/).map(clean).filter(Boolean);
    const version = [...parts].reverse().find((part) => /^(?:[A-Z]\.)?\d+(?:\.\d+)+$/i.test(part)) || '';
    const candidate = parts.slice(0, 3).join(' ');
    const number = candidate.match(/\b[A-Z]{1,12}-\d[\w.-]*\b/i)?.[0] || '';
    const displayTitle = parts.filter((part) => part !== version && part !== number).join(' · ') || subjectText;
    return { subjectText, subjectTitle: displayTitle, number, version };
  }

  function nativeApprovalTaskRows() {
    return [...document.querySelectorAll('.x-grid3-row')]
      .filter((row) => row.querySelector('td.x-grid3-td-ASSIGNMENT_NAME')
        && row.querySelector('td.x-grid3-td-ASSIGNMENT_SUBJECT'));
  }

  function isApprovalListRoute() {
    // 详情页切换时首页的 Ext 网格可能还残留在 DOM 中，不能仅凭行数判断当前页面。
    if (/wt\.workflow\.work\.WorkItem|tcomp\/infoPage/i.test(location.href)) return false;
    return /#ptc1\/homepage|assignments\.list/i.test(location.href)
      || nativeApprovalTaskRows().length > 0;
  }

  function extractNativeApprovalTasks() {
    return nativeApprovalTaskRows().map((row) => {
      const activity = taskCellLink(row, 'x-grid3-td-ASSIGNMENT_NAME');
      const subject = taskCellLink(row, 'x-grid3-td-ASSIGNMENT_SUBJECT');
      const parsedSubject = parseTaskSubject(subject.text || taskCellText(row, 'x-grid3-td-ASSIGNMENT_SUBJECT'));
      const taskUrl = activity.href || taskCellLink(row, 'x-grid3-td-infoPageAction').href;
      return {
        title: activity.text || 'Windchill 审批任务',
        number: parsedSubject.number,
        subjectTitle: parsedSubject.subjectTitle,
        subjectText: parsedSubject.subjectText,
        version: parsedSubject.version,
        lifecycleState: taskCellText(row, 'x-grid3-td-ASSIGNMENT_SUBJECT_LC_STATE'),
        status: taskCellText(row, 'x-grid3-td-ASSIGNMENT_STATUS'),
        deadline: taskCellText(row, 'x-grid3-td-ASSIGNMENT_DEADLINE'),
        created: taskCellText(row, 'x-grid3-td-ASSIGNMENT_CREATED'),
        context: taskCellText(row, 'x-grid3-td-ASSIGNMENT_CONTAINER'),
        role: taskCellText(row, 'x-grid3-td-ASSIGNMENT_ROLE'),
        taskUrl,
        subjectUrl: subject.href,
        nativeKey: taskUrl || `${activity.text}¦${parsedSubject.subjectText}`
      };
    });
  }

  function extractCurrentTaskDetail() {
    if (!/wt\.workflow\.work\.WorkItem/i.test(location.href)) return null;
    const root = document.querySelector('[id*="workitemtaskFormTemplate"]');
    if (!root) return null;
    const fields = {};
    root.querySelectorAll('tr').forEach((row) => {
      const cells = [...row.querySelectorAll(':scope > td')];
      if (cells.length < 2) return;
      const label = clean(cells[0].innerText).replace(/[：:]$/, '');
      const value = clean(cells[1].innerText);
      if (label) fields[label] = value;
    });
    const subjectRow = [...root.querySelectorAll('tr')].find((row) => /^主题[：:]?$/.test(clean(row.querySelector(':scope > td:first-child')?.innerText)));
    const linkedSubject = subjectRow?.querySelector('td:nth-child(2) a[href]');
    if (!fields['主题'] && !fields['进程'] && !linkedSubject) return null;
    const subjectInfo = parseTaskSubject(linkedSubject?.innerText || fields['主题']);
    return {
      taskUrl: location.href,
      process: fields['进程'],
      initiator: fields['进程启动者'],
      owner: fields['工作负责人'],
      role: fields['角色'],
      priority: fields['优先级'],
      deadline: fields['最后期限'],
      subjectTitle: clean(linkedSubject?.innerText || fields['主题']),
      subjectNumber: subjectInfo.number,
      subjectVersion: subjectInfo.version,
      subjectUrl: linkedSubject?.href || '',
      taskDescription: fields['指示'],
      currentKey: [location.href, fields['进程'], fields['主题'], fields['最后期限']].join('¦')
    };
  }

  function extractCurrentDocumentDetail() {
    if (!/tcomp\/infoPage/i.test(location.href) || /wt\.workflow\.work\.WorkItem/i.test(location.href)) return null;
    const identity = clean(document.querySelector('#infoPageIdentityDisplayText')?.innerText);
    const root = document.querySelector('#infoPageinfoPanelID') || document.querySelector('[id*="infoPageinfoPanelID"]');
    if (!identity || !root) return null;
    const fields = {};
    root.querySelectorAll('tr').forEach((row) => {
      const cells = [...row.querySelectorAll(':scope > td')];
      if (cells.length < 2) return;
      const label = clean(cells[0].innerText).replace(/[：:]$/, '');
      const value = clean(cells.slice(1).map((cell) => cell.innerText).join(' '));
      if (label && value) fields[label] = value;
    });
    if (!fields['说明'] && !fields['格式名称'] && !fields['上下文'] && !fields['名称']) return null;
    const parsedIdentity = parseTaskSubject(identity);
    return {
      kind: 'document',
      objectUrl: location.href,
      subjectTitle: identity,
      subjectNumber: parsedIdentity.number,
      subjectVersion: parsedIdentity.version,
      description: fields['说明'],
      format: fields['格式名称'],
      lifecycleState: fields['状态'],
      status: fields['状况'],
      context: fields['上下文'],
      location: fields['位置'],
      name: fields['名称'],
      modifiedBy: fields['修改者'],
      modifiedAt: fields['上次修改时间'],
      createdBy: fields['创建者'],
      createdAt: fields['创建时间'],
      recordType: fields['记录类型'],
      currentKey: [location.href, identity, fields['说明'], fields['上次修改时间']].join('¦')
    };
  }

  function extractCurrentApprovalContext() {
    return extractCurrentTaskDetail() || extractCurrentDocumentDetail();
  }

  function renderNativeTaskDetails(detail) {
    if (!detail || detail.kind === 'document') return;
    const taskRoot = document.querySelector('[id*="workitemtaskFormTemplate"]');
    if (!taskRoot) return;
    if (!document.getElementById('windchill-assistant-task-details-style')) {
      const style = document.createElement('style');
      style.id = 'windchill-assistant-task-details-style';
      style.textContent = `
        #windchill-assistant-task-details { box-sizing: border-box; margin: 0 0 12px; padding: 12px 14px; border: 1px solid #1976a5; border-radius: 8px; background: #eef8fc; box-shadow: 0 2px 8px rgba(7, 94, 156, .14); color: #304c5d; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
        #windchill-assistant-task-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 420px); align-items: start; gap: 18px; margin: 0 14px 14px; position: relative; z-index: 1; }
        #windchill-assistant-task-layout > [id*="workitemtaskFormTemplate"] { min-width: 0; width: auto !important; }
        #windchill-assistant-task-layout > #windchill-assistant-task-details { min-width: 0; margin: 0; }
        .windchill-assistant-task-details-title { margin: -12px -14px 10px; padding: 8px 14px; border-radius: 7px 7px 0 0; background: linear-gradient(135deg, #075e9c, #087f9c); color: #fff; font-size: 14px; font-weight: 800; }
        .windchill-assistant-task-details-note, .windchill-assistant-task-details-hint { margin-top: 4px; color: #607783; font-size: 12px; }
        .windchill-assistant-task-details-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 16px; margin-top: 10px; }
        .windchill-assistant-task-detail-field { min-width: 0; overflow-wrap: anywhere; }
        .windchill-assistant-task-detail-field.wide { grid-column: 1 / -1; }
        .windchill-assistant-task-detail-field strong { color: #355466; }
        .windchill-assistant-task-detail-field a { color: #075e9c; font-weight: 700; }
        @media (max-width: 1100px) { #windchill-assistant-task-layout { grid-template-columns: 1fr; } #windchill-assistant-task-layout > #windchill-assistant-task-details { order: -1; } }
        @media (max-width: 600px) { .windchill-assistant-task-details-grid { grid-template-columns: 1fr; } .windchill-assistant-task-detail-field.wide { grid-column: auto; } }
      `;
      document.head?.append(style);
    }
    const relatedTask = state.tasks.find((task) =>
      (detail.taskUrl && task.taskUrl === detail.taskUrl)
      || (detail.subjectUrl && task.subjectUrl === detail.subjectUrl)
      || (detail.subjectNumber && task.number === detail.subjectNumber)
    ) || {};
    let card = document.getElementById('windchill-assistant-task-details');
    if (!card) {
      card = document.createElement('section');
      card.id = 'windchill-assistant-task-details';
    }
    card.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'windchill-assistant-task-details-title';
    heading.textContent = 'Windchill 助手 · 审批重点';
    card.append(heading);
    const note = document.createElement('div');
    note.className = 'windchill-assistant-task-details-note';
    note.textContent = '以下内容来自当前审批任务和主题对象链接，便于审批前快速了解变更背景。';
    card.append(note);
    const grid = document.createElement('div');
    grid.className = 'windchill-assistant-task-details-grid';
    const addField = (label, value, options = {}) => {
      if (!value) return;
      const field = document.createElement('div');
      field.className = `windchill-assistant-task-detail-field${options.wide ? ' wide' : ''}`;
      const labelElement = document.createElement('strong');
      labelElement.textContent = `${label}：`;
      field.append(labelElement);
      if (options.href) {
        const link = document.createElement('a');
        link.href = options.href;
        link.textContent = value;
        link.title = options.title || `打开${label}`;
        field.append(link);
      } else {
        field.append(document.createTextNode(value));
      }
      grid.append(field);
    };
    addField('主题', detail.subjectTitle, { wide: true, href: detail.subjectUrl, title: '打开 ECN 主题对象详情' });
    addField('编号', detail.subjectNumber || relatedTask.number);
    addField('版本', detail.subjectVersion || relatedTask.version);
    addField('生命周期', relatedTask.lifecycleState);
    addField('状态', relatedTask.status);
    addField('项目/上下文', relatedTask.context, { wide: true });
    addField('流程', detail.process, { wide: true });
    addField('发起者', detail.initiator);
    addField('负责人', detail.owner);
    addField('角色', detail.role);
    addField('优先级', detail.priority);
    addField('截止时间', detail.deadline);
    addField('审批指示', detail.taskDescription, { wide: true });
    addField('变更说明', relatedTask.description, { wide: true });
    card.append(grid);
    const hint = document.createElement('div');
    hint.className = 'windchill-assistant-task-details-hint';
    hint.textContent = detail.subjectUrl
      ? '需要查看 ECN 的页面说明、文件格式或具体内容时，请点击上方主题链接。'
      : '当前任务没有提供主题对象链接。';
    card.append(hint);
    const pagePanel = document.getElementById('infoPageinfoPanelID')
      || document.querySelector('[id*="infoPageinfoPanelID"]');
    if (!pagePanel) return;
    let layout = document.getElementById('windchill-assistant-task-layout');
    if (!layout || layout.parentElement !== pagePanel) {
      if (layout && layout.contains(taskRoot)) pagePanel.insertBefore(taskRoot, pagePanel.firstElementChild);
      if (layout?.isConnected) layout.remove();
      layout = document.createElement('div');
      layout.id = 'windchill-assistant-task-layout';
      layout.setAttribute('aria-label', 'Windchill 审批与助手信息');
      pagePanel.insertBefore(layout, pagePanel.firstElementChild);
    }
    if (!layout.contains(taskRoot)) layout.append(taskRoot);
    if (!layout.contains(card)) layout.append(card);
    taskRoot.querySelectorAll('tr').forEach((row) => {
      const cells = [...row.querySelectorAll(':scope > td')];
      const label = clean(cells[0]?.innerText);
      if (!/用户名|密码/.test(label) || !cells[1]) return;
      cells[1].style.textAlign = 'left';
      cells[1].style.verticalAlign = 'top';
      const input = cells[1].querySelector('input');
      if (input) {
        input.style.display = 'block';
        input.style.float = 'none';
        input.style.marginLeft = '0';
        input.style.marginRight = '0';
        input.style.textAlign = 'left';
      }
    });
  }

  let nativeTaskDetailsObserver = null;
  let nativeTaskDetailsStopTimer = null;
  function scheduleNativeTaskDetails() {
    nativeTaskDetailsObserver?.disconnect();
    if (nativeTaskDetailsStopTimer) window.clearTimeout(nativeTaskDetailsStopTimer);
    let observer = null;
    const update = () => {
      const detail = extractCurrentTaskDetail();
      if (!detail) return false;
      const changed = currentTaskSignature(detail) !== currentTaskSignature(state.currentTaskDetail);
      state.currentTaskDetail = detail;
      const taskRoot = document.querySelector('[id*="workitemtaskFormTemplate"]');
      const layout = document.getElementById('windchill-assistant-task-layout');
      const card = document.getElementById('windchill-assistant-task-details');
      const pagePanel = document.getElementById('infoPageinfoPanelID')
        || document.querySelector('[id*="infoPageinfoPanelID"]');
      const needsRender = !pagePanel || !layout || !card || layout.parentElement !== pagePanel || !layout.contains(taskRoot);
      if (changed || needsRender) renderNativeTaskDetails(detail);
      if (changed && state.mode === 'approval') renderApproval();
      return true;
    };
    observer = new MutationObserver(() => {
      update();
    });
    nativeTaskDetailsObserver = observer;
    observer.observe(document.documentElement, { childList: true, subtree: true });
    [0, 500, 1200, 2500, 5000, 10000, 15000].forEach((delay) => window.setTimeout(update, delay));
    nativeTaskDetailsStopTimer = window.setTimeout(() => {
      observer?.disconnect();
      if (nativeTaskDetailsObserver === observer) nativeTaskDetailsObserver = null;
    }, 30000);
  }

  let lastWindchillRoute = location.href;
  function handleWindchillRouteChange() {
    if (location.href === lastWindchillRoute) return;
    lastWindchillRoute = location.href;
    state.currentTaskDetail = null;
    nativeTaskDetailsObserver?.disconnect();
    nativeTaskDetailsObserver = null;
    if (nativeTaskDetailsStopTimer) {
      window.clearTimeout(nativeTaskDetailsStopTimer);
      nativeTaskDetailsStopTimer = null;
    }
    document.getElementById('windchill-assistant-task-details')?.remove();
    const oldLayout = document.getElementById('windchill-assistant-task-layout');
    const oldTaskRoot = oldLayout?.querySelector('[id*="workitemtaskFormTemplate"]');
    if (oldLayout?.isConnected) {
      if (oldTaskRoot) oldLayout.parentElement?.insertBefore(oldTaskRoot, oldLayout);
      oldLayout.remove();
    }
    if (state.mode === 'approval') {
      state.requestId += 1;
      state.loading = false;
      restoreApprovalTaskCache();
      if (isApprovalListRoute()) {
        loadApprovalTasks();
      } else {
        renderApproval();
        scheduleApprovalTaskEnrichment(state.requestId);
      }
    }
    if (/wt\.workflow\.work\.WorkItem/i.test(location.href)) scheduleNativeTaskDetails();
  }
  window.addEventListener('hashchange', handleWindchillRouteChange);
  window.addEventListener('popstate', handleWindchillRouteChange);
  ['pushState', 'replaceState'].forEach((method) => {
    const original = history[method];
    if (typeof original !== 'function') return;
    history[method] = function (...args) {
      const result = original.apply(this, args);
      window.setTimeout(handleWindchillRouteChange, 0);
      return result;
    };
  });

  function mergeNativeApprovalTasks(tasks) {
    const nativeTasks = extractNativeApprovalTasks();
    if (!nativeTasks.length) return tasks;
    const used = new Set();
    const mergedNative = nativeTasks.map((nativeTask, index) => {
      const matchIndex = tasks.findIndex((task, taskIndex) => !used.has(taskIndex)
        && ((nativeTask.taskUrl && task.taskUrl && nativeTask.taskUrl === task.taskUrl)
          || (nativeTask.number && task.number && nativeTask.number === task.number)));
      const resolvedIndex = matchIndex >= 0 ? matchIndex : (tasks[index] ? index : -1);
      if (resolvedIndex >= 0) used.add(resolvedIndex);
      const apiTask = resolvedIndex >= 0 ? tasks[resolvedIndex] : {};
      const merged = { ...apiTask, ...nativeTask };
      merged.description = apiTask.description || '';
      merged.text = [
        merged.title,
        merged.subjectTitle,
        merged.number,
        merged.version,
        merged.lifecycleState,
        merged.status,
        merged.description,
        merged.context,
        merged.initiator,
        merged.created,
        merged.deadline,
        merged.role
      ].filter(Boolean).join(' · ');
      return merged;
    });
    return mergedNative.concat(tasks.filter((task, index) => !used.has(index)));
  }

  function approvalTaskSignature(tasks) {
    return tasks.map((task) => [
      task.nativeKey,
      task.taskUrl,
      task.subjectUrl,
      task.subjectTitle,
      task.number,
      task.version,
      task.lifecycleState,
      task.status,
      task.deadline,
      task.context,
      task.role
    ].join('¦')).join('§');
  }

  function currentTaskSignature(detail) {
    return detail ? detail.currentKey : '';
  }

  function scheduleApprovalTaskEnrichment(requestId) {
    let observer = null;
    let stopTimer = null;
    const enrich = () => {
      if (requestId !== state.requestId || state.mode !== 'approval') return true;
      const nativeTasks = isApprovalListRoute() ? extractNativeApprovalTasks() : [];
      const merged = nativeTasks.length ? mergeNativeApprovalTasks(state.tasks) : state.tasks;
      const detail = extractCurrentApprovalContext();
      const tasksChanged = approvalTaskSignature(merged) !== approvalTaskSignature(state.tasks);
      const detailChanged = currentTaskSignature(detail) !== currentTaskSignature(state.currentTaskDetail);
      if (tasksChanged || detailChanged) {
        state.tasks = merged;
        if (nativeTasks.length) saveApprovalTaskCache(state.tasks);
        state.currentTaskDetail = detail;
        renderNativeTaskDetails(detail);
        renderApproval();
      }
      return nativeTasks.length > 0;
    };
    [250, 900, 1800, 3500, 6000, 10000].forEach((delay) => window.setTimeout(() => {
      if (enrich() && observer) {
        observer.disconnect();
        observer = null;
        if (stopTimer) window.clearTimeout(stopTimer);
      }
    }, delay));
    observer = new MutationObserver(() => {
      if (enrich()) {
        observer.disconnect();
        observer = null;
        if (stopTimer) window.clearTimeout(stopTimer);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    stopTimer = window.setTimeout(() => observer?.disconnect(), 20000);
  }

  function endpointDefinitions(keyword, filters, formats) {
    const escaped = odataString(keyword);
    const wantDrawing = filters.has('drawing');
    const wantQuality = filters.has('quality');
    const wantEngineering = filters.has('engineering');
    const all = !filters.size && !formats.size;
    const endpoints = [];
    const match = `(contains(Name,'${escaped}') or contains(Number,'${escaped}'))`;

    // 质量/工程按规则库里的编号前缀 / 名称关键词在服务端过滤，避免 $top 被无关记录占满导致漏数据。
    const categoryFilter = Rules.odataCategoryFilter(
      rules, [...(wantQuality ? ['quality'] : []), ...(wantEngineering ? ['engineering'] : [])], odataString
    );
    if ((wantQuality || wantEngineering) && categoryFilter) {
      endpoints.push({
        path: 'DocMgmt/Documents',
        kind: 'document',
        filter: `${match} and (${categoryFilter})`
      });
    } else if (all || (formats.size && !wantDrawing)) {
      endpoints.push({
        path: 'DocMgmt/Documents',
        kind: 'document',
        filter: `contains(Name,'${escaped}') or contains(Number,'${escaped}')`
      });
    }
    if (all || formats.has('dwg')) {
      endpoints.push({
        path: 'CADDocumentMgmt/CADDocuments',
        kind: 'cad',
        filter: `contains(FileName,'${escaped}')`
      });
    }
    if (wantDrawing) {
      endpoints.push({
        path: 'DocMgmt/Documents',
        kind: 'drawing',
        // 图纸默认按名称包含关键词查询，避免只按编号漏掉关联图纸；规则库可放宽为名称或编号。
        filter: rules.categories.drawing.requireNameKeyword ? `contains(Name,'${escaped}')` : match
      });
    }
    return endpoints;
  }

  // 相关度：编号完全一致 > 编号以关键词结尾/开头 > 编号包含 > 名称包含
  function relevance(record, keyword) {
    const key = clean(keyword).toUpperCase();
    const number = clean(record.number).toUpperCase();
    const title = clean(record.title).toUpperCase();
    if (number === key) return 0;
    if (number.endsWith(key) || number.startsWith(key)) return 1;
    if (number.includes(key)) return 2;
    if (title.includes(key)) return 3;
    return 4;
  }

  async function searchWindchillDocuments(keyword, filters, formats, signal, onProgress) {
    const endpoints = endpointDefinitions(keyword, filters, formats);
    const buckets = endpoints.map(() => []);
    const totals = endpoints.map(() => 0);
    const finalize = () => {
      const seen = new Set();
      const records = buckets.flat().filter((record) => {
        if (filters.size && !filters.has(record.category)) return false;
        if (formats.size && !formats.has(record.format)) return false;
        // 图纸快捷项只保留“名称包含关键词、主文件为 PDF、名称/编号不带
        // 前缀”的内容；接口汇总和原生结果行必须使用同一套规则。
        if (filters.has('drawing') && record.category === 'drawing'
          && !Rules.drawingAccepts(rules, record.format, record.hasLeadingPrefix)) return false;
        const key = `${record.number}:${record.title}:${record.version}:${record.format}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).sort((a, b) => relevance(a, keyword) - relevance(b, keyword));
      const serverTotal = totals.reduce((sum, value) => sum + value, 0);
      const fetched = buckets.reduce((sum, bucket) => sum + bucket.length, 0);
      return { records, truncated: serverTotal > fetched, serverTotal };
    };

    const settled = await Promise.allSettled(endpoints.map(async (endpoint, index) => {
      const expand = endpoint.kind === 'cad' ? 'AllPrimaryContents' : 'PrimaryContent,Attachments';
      let payload = await fetchWindchillOData(endpoint.path, {
        '$filter': endpoint.filter,
        '$top': String(MAX_RESULT_ITEMS),
        '$count': 'true',
        '$expand': expand
      }, { signal });
      let items = odataItems(payload);
      totals[index] = Number(payload && payload['@odata.count']) || items.length;
      buckets[index] = items.map((item) => normalizeDocument(item, endpoint.kind));
      if (onProgress) onProgress(finalize(), true);
      // Windchill 默认每页只给 25 条，沿 nextLink 继续取并逐页渐进显示。
      for (let page = 0; payload && payload['@odata.nextLink'] && items.length < MAX_RESULT_ITEMS && page < 8; page += 1) {
        payload = await fetchWindchillOData(payload['@odata.nextLink'], {}, { signal });
        const more = odataItems(payload);
        items = items.concat(more);
        buckets[index] = buckets[index].concat(more.map((item) => normalizeDocument(item, endpoint.kind)));
        if (onProgress) onProgress(finalize(), Boolean(payload && payload['@odata.nextLink']));
      }
    }));
    const failures = settled.filter((result) => result.status === 'rejected');
    if (failures.length === settled.length && failures.length) throw failures[0].reason;
    return { ...finalize(), partial: failures.length > 0 };
  }
  function nativeElementById(id) {
    return document.getElementById(id);
  }

  function nativeLabel(element) {
    return clean([
      element && element.innerText,
      element && element.getAttribute('aria-label'),
      element && element.getAttribute('title'),
      element && element.getAttribute('data-qtip'),
      element && element.getAttribute('qtip'),
      element && element.getAttribute('ext:qtip'),
      element && element.getAttribute('data-description'),
      element && element.getAttribute('description')
    ].filter(Boolean).join(' '));
  }

  function findNativeAdvancedLink() {
    const stable = nativeElementById('ext-gen63');
    if (stable && visible(stable)) return stable;
    return [...document.querySelectorAll('a,[role="link"],button,[role="button"]')]
      .find((element) => visible(element) && /高级搜索|advanced\s+search/i.test(nativeLabel(element)));
  }

  function findNativeCriteriaEditor() {
    const stable = nativeElementById('editSearchCriteriaLink');
    const stableLink = stable && (stable.querySelector('a') || stable);
    if (stableLink && visible(stableLink)) return stableLink;
    return [...document.querySelectorAll('a,[role="link"],button,[role="button"]')]
      .find((element) => visible(element) && /编辑搜索条件|edit\s+search\s+criteria/i.test(nativeLabel(element)));
  }

  function findNativeSearchNavigation() {
    const stable = nativeElementById('object_search_navigation_nav');
    if (stable && visible(stable)) return stable;
    return [...document.querySelectorAll('a,[role="link"]')]
      .find((element) => visible(element) && /^搜索(?:\(S\))?$|^search$/i.test(nativeLabel(element)));
  }

  function findNativeKeywordField() {
    const stable = nativeElementById('keywordkeywordField_SearchTextBox');
    if (stable && visible(stable)) return stable;
    const advancedRoot = nativeElementById('advancedSearchCompDiv');
    if (!advancedRoot) return null;
    return [...advancedRoot.querySelectorAll('input[type="search"],input[type="text"]')]
      .find((element) => visible(element) && !/^gloabalSearchField$/i.test(element.id)
        && /关键字|keyword|搜索|search/i.test(nativeLabel(element)));
  }

  function findNativeSearchButton() {
    const stableContainer = nativeElementById('searchButtonDiv');
    const stableButton = stableContainer && stableContainer.querySelector('button');
    if (stableButton && visible(stableButton)) return stableButton;
    const advancedRoot = nativeElementById('advancedSearchCompDiv');
    if (!advancedRoot) return null;
    return [...advancedRoot.querySelectorAll('button,[role="button"]')]
      .find((element) => visible(element) && /^搜索$|^search$/i.test(nativeLabel(element)));
  }

  function findNativeListFilter() {
    const stable = nativeElementById('wt.doc.WTDocument.defaultSearchView.searchInListTextBox');
    if (stable && visible(stable)) return stable;
    return [...document.querySelectorAll('input[type="search"],input[type="text"]')]
      .find((element) => visible(element) && /在表格中搜索|searchs+ins+list/i.test(nativeLabel(element)));
  }

  let nativeActionToken = 0;
  function pageNativeAction(action, element, checked) {
    if (!element) return;
    const token = String(++nativeActionToken);
    const detail = { action, id: element.id, token };
    // 没有 id 的元素（如 javascript: 链接）通过临时属性交给页面桥执行，
    // 避免在内容脚本环境触发点击而被 CSP 拦截。
    if (!element.id) {
      element.setAttribute('data-wca-target', token);
      detail.selector = `[data-wca-target="${token}"]`;
    }
    if (action === 'checkbox') detail.checked = checked;
    if (action === 'key') detail.key = checked;
    document.dispatchEvent(new CustomEvent('windchill-assistant:native-action', {
      detail
    }));
    return document.documentElement.getAttribute('data-wca-bridge-last-action') === token;
  }

  function nativeMouseClick(element) {
    if (!element) return;
    if (/^\s*javascript:/i.test(element.closest?.('a')?.getAttribute('href') || '')) return;
    const options = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1, detail: 1 };
    ['mousedown', 'mouseup', 'click'].forEach((type) => {
      element.dispatchEvent(new MouseEvent(type, { ...options, buttons: type === 'mouseup' || type === 'click' ? 0 : 1 }));
    });
  }

  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    ['input', 'change', 'keyup'].forEach((type) => input.dispatchEvent(new Event(type, { bubbles: true })));
  }

  function setNativeCheckbox(input, checked) {
    if (!input) return;
    const targetState = Boolean(checked);
    if (Boolean(input.checked) !== targetState) pageNativeAction('checkbox', input, targetState);
    if (Boolean(input.checked) !== targetState) nativeMouseClick(input);
    if (Boolean(input.checked) !== targetState) input.click();

    // Windchill 的 Ext 复选框除了 checked 属性，还会把状态同步到
    // 原生属性并监听 change；连续点击后立即提交时，后台仍可能收到
    // 上一次的“所有类型”。这里补齐 DOM 状态和条件事件。
    if (Boolean(input.checked) !== targetState) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
      if (setter) setter.call(input, targetState);
      else input.checked = targetState;
    }
    if (targetState) input.setAttribute('checked', '');
    else input.removeAttribute('checked');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function applyNativeTypeFilters(filters, formats) {
    const allTypes = nativeElementById('wt.fc.Persistable');
    const cad = nativeElementById('WCTYPE|wt.epm.EPMDocument|com.libeier.DefaultEPMDocument');
    const documentType = nativeElementById('wt.doc.WTDocument');
    const hasBusinessFilter = filters.has('drawing') || filters.has('engineering') || filters.has('quality');
    const wantsCad = !hasBusinessFilter && formats.has('dwg');
    const wantsDocument = hasBusinessFilter || formats.size > 0;
    // 这三个业务分类都以 Windchill 文档为主：图纸是无前缀的 PDF 文档，
    // MG/PS/PII 则是文档编号前缀。CAD 文档只在未选快捷分类时保留。

    if (!filters.size && !formats.size) {
      setNativeCheckbox(allTypes, true);
      setNativeCheckbox(cad, false);
      setNativeCheckbox(documentType, false);
      return;
    }

    setNativeCheckbox(allTypes, false);
    setNativeCheckbox(cad, wantsCad);
    setNativeCheckbox(documentType, wantsDocument);
  }

  function findNativeNumberValueInput() {
    const attribute = nativeElementById('qBAttributeTD-2');
    const row = attribute && attribute.parentElement;
    if (!row) return null;
    return [...row.querySelectorAll('input[type="text"],input:not([type])')]
      .find((input) => input.id !== 'combo-qBAttributeTD-2');
  }

  function applyNativeCriteria(keyword, filters) {
    const numberValue = findNativeNumberValueInput();
    if (!numberValue) return;
    // Windchill 编号条件只提供“=”/“≠”，图纸改用关键字检索实现包含匹配；
    // 与 MG/PS/PII 联选时同样留空，由结果行过滤保留多选后的并集。
    setNativeValue(numberValue, '');
  }

  function resultRows() {
    const root = nativeElementById('searchResultTableDiv');
    if (!root) return [];
    const isCurrentOrFilteredRow = (row) => visible(row) || row.hasAttribute('data-wca-display');
    // Windchill 的结果区还包含多层工具栏和按钮表格；只有 x-grid3-body 下的行才是真正的数据行。
    const gridRows = [...root.querySelectorAll('.x-grid3-body > .x-grid3-row')].filter(isCurrentOrFilteredRow);
    if (gridRows.length) return gridRows;
    return [...root.querySelectorAll('table[id*="_TABLE"] > tbody > tr')]
      .filter((row) => row.cells.length >= 2)
      .filter(isCurrentOrFilteredRow);
  }

  function elementText(element) {
    return clean(element && (element.innerText || element.textContent));
  }

  function rowTextValues(row) {
    const values = [
      ...[...row.querySelectorAll('td')].map(elementText),
      ...[...row.querySelectorAll('a')].map((element) => [
        elementText(element),
        element.getAttribute('title'),
        element.getAttribute('aria-label'),
        element.getAttribute('data-qtip'),
        element.href
      ].filter(Boolean).join(' ')),
      elementText(row)
    ];
    return values.flatMap((value) => clean(value).split(/[\r\n]+/).map(clean)).filter(Boolean);
  }

  function rowAssetSource(row) {
    return [
      elementText(row),
      ...[...row.querySelectorAll('a')].map((element) => [
        elementText(element),
        element.getAttribute('title'),
        element.getAttribute('aria-label'),
        element.getAttribute('data-qtip'),
        element.href
      ].filter(Boolean).join(' ')),
      ...[...row.querySelectorAll('img')].map((element) => [
        element.getAttribute('src'),
        element.getAttribute('alt'),
        element.getAttribute('title'),
        element.getAttribute('data-qtip'),
        element.getAttribute('qtip'),
        element.getAttribute('ext:qtip')
      ].filter(Boolean).join(' '))
    ].filter(Boolean).join(' ');
  }

  function resultIdentifier(row, keyword) {
    const identifierCells = [...row.querySelectorAll('td[class*="-td-number"], td[class*="-td-identifier"], [data-column="number"]')];
    const directIdentifier = identifierCells
      .map((cell) => clean(cell.querySelector('a')?.innerText || cell.innerText))
      .find(Boolean);
    if (directIdentifier && directIdentifier !== '…' && directIdentifier !== '...') return directIdentifier;
    const preferredValues = identifierCells.flatMap((cell) => [
      elementText(cell),
      ...[...cell.querySelectorAll('a')].map((element) => [
        elementText(element),
        element.getAttribute('title'),
        element.getAttribute('aria-label')
      ].filter(Boolean).join(' '))
    ]).filter(Boolean);
    const preferredTokens = preferredValues.flatMap((value) => value.split(/\s+/).map(clean)).filter(Boolean);
    const prefixedToken = new RegExp(`^(?:${Rules.prefixAlternation(rules)})(?:[-_ ]?[A-Z0-9][A-Z0-9._-]*)$`, 'i');
    const preferred = preferredTokens.find((token) => prefixedToken.test(token))
      || preferredTokens.find((token) => identifierMatches(token, keyword));
    if (preferred) return preferred;

    const values = rowTextValues(row);
    const tokens = values.flatMap((value) => value.split(/\s+/).map(clean)).filter(Boolean);
    const prefixed = tokens.find((token) => prefixedToken.test(token));
    if (prefixed) return prefixed;
    const exact = tokens.find((token) => identifierMatches(token, keyword));
    if (exact) return exact;
    const match = elementText(row).match(new RegExp(`(?:${Rules.prefixAlternation(rules)})[-_ ]?[A-Z0-9._-]+|[A-Z0-9][A-Z0-9._-]{4,}`, 'i'));
    return match ? match[0] : '';
  }

  function rowHasPdf(row) {
    return rowFormat(row) === 'pdf';
  }

  function rowNameText(row) {
    const nameCells = [...row.querySelectorAll('td[class*="-td-name"], [data-column="name"]')];
    return (nameCells.length ? nameCells : [row]).map(elementText).join(' ');
  }

  function rowLooksLikeDrawing(row) {
    const source = rowAssetSource(row);
    // Windchill 结果行的业务类型主要通过图标 qtip 暴露；图纸/CAD 图标
    // 是增强证据，但不能把“无 PII/MG/PS 前缀 + 名称包含 + PDF”规则
    // 收窄成只能显示某一种业务类型，否则会漏掉关联图纸和站点定制文档。
    if (/(?:图纸|drawing)/i.test(source) || /(?:acad|epm_acad|file[_-]?dwg)/i.test(source)) return true;
    return true;
  }

  function rowNameContains(row, keyword) {
    return clean(rowNameText(row)).replace(/\s+/g, '').toUpperCase().includes(
      clean(keyword).replace(/\s+/g, '').toUpperCase()
    );
  }

  function rowFormat(row) {
    // 优先读取格式图标和其提示，而不是整行文本；整行文本可能包含
    // 文件名、描述或附件名称，容易把“提到 PDF”的普通文档误判成 PDF。
    const imageSource = [...row.querySelectorAll('img')].map((element) => [
      element.getAttribute('src'),
      element.getAttribute('alt'),
      element.getAttribute('title'),
      element.getAttribute('data-qtip'),
      element.getAttribute('qtip'),
      element.getAttribute('ext:qtip')
    ].filter(Boolean).join(' ')).join(' ');
    const imageFormat = formatFromSource(imageSource);
    return imageFormat !== 'other' ? imageFormat : formatFromSource(rowAssetSource(row));
  }

  function rowMatchesFormats(row, formats) {
    if (!formats.size) return true;
    if (formats.has(rowFormat(row))) return true;
    return formats.has('pdf') && rowHasPdf(row);
  }

  function identifierMatches(identifier, keyword) {
    return clean(identifier).replace(/\s+/g, '').toUpperCase() === clean(keyword).replace(/\s+/g, '').toUpperCase();
  }

  function rowDocumentCategory(row, identifier) {
    const name = rowNameText(row);
    return Rules.classify(rules, { text: `${identifier} ${name}`, name });
  }

  function rowHasLeadingPrefix(row, identifier) {
    return [identifier, rowNameText(row)].some(hasLeadingDocumentPrefix);
  }

  function resultMatchesFilter(row, identifier, keyword, filters, formats) {
    // 统一口径：与面板（REST）一致，名称或编号必须包含关键词；原生关键字检索是全文
    // 检索，会带回大量只在描述/正文中出现关键词的无关行。
    const needle = clean(keyword).replace(/\s+/g, '').toUpperCase();
    const hay = clean(`${identifier} ${rowNameText(row)}`).replace(/\s+/g, '').toUpperCase();
    if (needle && !hay.includes(needle)) return false;
    const rowCategory = rowDocumentCategory(row, identifier);
    const onlyDrawing = filters.has('drawing')
      && !filters.has('engineering')
      && !filters.has('quality');
    if (!filters.size && !formats.size) return true;
    if (onlyDrawing && !rowLooksLikeDrawing(row)) return false;
    if (onlyDrawing && rowHasLeadingPrefix(row, identifier)) return false;

    // 优先使用 REST 汇总中的同编号记录回配原生结果行，避免取到首列复选框、版本列或名称列。
    const matchedRecords = state.records.filter((record) => identifierMatches(record.identifier, identifier));
    const recordMatches = matchedRecords.some((record) => {
      if (formats.size && !formats.has(record.format)) return false;
      if (!filters.size) return true;
      // 业务分类以原生结果行的编号/名称证据为准，避免同一编号下的普通
      // PDF 文档误继承另一条“图纸”记录的分类。
      if (filters.has('quality') && rowCategory === 'quality') return true;
      if (filters.has('engineering') && rowCategory === 'engineering') return true;
      if (filters.has('drawing') && record.category === 'drawing') {
        const nativeFormat = rowFormat(row);
        return rowLooksLikeDrawing(row) && Rules.drawingFormatOk(rules, record.format) && !rowHasLeadingPrefix(row, identifier)
          && (!rules.categories.drawing.requireNameKeyword || rowNameContains(row, keyword))
          && (nativeFormat === 'other' || Rules.drawingFormatOk(rules, nativeFormat));
      }
      return false;
    });
    // REST 汇总记录只用于增强分类；如果它没有匹配当前原生行，继续走
    // 行级格式、名称和前缀规则，避免普通无前缀 PDF 被提前排除。
    if (recordMatches) return true;

    if (!rowMatchesFormats(row, formats)) return false;
    if (!filters.size) return true;
    if (filters.has('quality') && rowCategory === 'quality') return true;
    if (filters.has('engineering') && rowCategory === 'engineering') return true;
    // 图纸必须是无业务前缀、名称包含关键词，并且原生行或 REST 内容明确是规则允许的格式。
    return filters.has('drawing') && rowLooksLikeDrawing(row) && !rowCategory
      && !documentPrefix(identifier) && !documentPrefix(rowNameText(row)) && !rowHasLeadingPrefix(row, identifier)
      && (!rules.categories.drawing.requireNameKeyword || rowNameContains(row, keyword))
      && Rules.drawingFormatOk(rules, rowFormat(row));
  }

  function restoreNativeResultRows() {
    resultRows().forEach((row) => {
      if (row.hasAttribute('data-wca-display')) row.style.display = row.getAttribute('data-wca-display');
    });
  }

  function applyNativeResultFilter() {
    const keyword = clean(query.value);
    const rows = resultRows();
    if (!rows.length) return;
    const rowSignature = rows.map((row) => [
      row.id || row.className,
      elementText(row).slice(0, 180),
      rowAssetSource(row).slice(0, 220)
    ].join(':')).join('|');
    const signature = [
      state.mode,
      keyword,
      [...state.filters].join(','),
      [...state.formats].join(','),
      state.resultFilterReady,
      state.resultVersion,
      rowSignature
    ].join('¦');
    if (signature === nativeFilterSignature) return;
    nativeFilterSignature = signature;
    // 新一轮汇总还没返回时保留 Windchill 当前结果，避免结果先出现又被
    // 空的/上一轮的汇总数据反复隐藏。
    if (state.mode !== 'search' || !keyword) {
      nativePendingSince = 0;
      restoreNativeResultRows();
      return;
    }
    if (!state.resultFilterReady) {
      // 汇总未就绪时先隐藏原生行（最多 8 秒），避免先闪现全部结果再被筛选。
      if (!nativePendingSince) nativePendingSince = Date.now();
      if (Date.now() - nativePendingSince < 8000) {
        rows.forEach((row) => {
          if (!row.hasAttribute('data-wca-display')) row.setAttribute('data-wca-display', row.style.display || '');
          row.style.display = 'none';
        });
        window.setTimeout(queueNativeResultFilter, 8100 - (Date.now() - nativePendingSince));
      } else restoreNativeResultRows();
      return;
    }
    nativePendingSince = 0;
    // 结果页可能在高级搜索提交后延迟渲染；之前定时写入列表筛选框的时机
    // 可能早于结果表出现，导致原生列表仍显示宽泛结果，随后又被本地规则
    // 全部隐藏。首次捕获到真实结果行时补交一次列表筛选，确保两层结果集
    // 先收敛到同一个关键词，再进行图纸/前缀/格式的行级判断。
    submitNativeListFilter(keyword, state.filters, state.formats);
    let shownCount = 0;
    rows.forEach((row) => {
      if (!row.hasAttribute('data-wca-display')) row.setAttribute('data-wca-display', row.style.display || '');
      const originalDisplay = row.getAttribute('data-wca-display');
      const hasData = Boolean(elementText(row));
      const show = state.mode === 'search' && keyword && hasData
        ? resultMatchesFilter(row, resultIdentifier(row, keyword), keyword, state.filters, state.formats)
        : false;
      row.style.display = show ? originalDisplay : 'none';
      if (show) shownCount += 1;
    });
    // 原生结果表是完整数据；REST 汇总受 $top 限制会少算，所以数量以表格实际显示行为准。
    if (state.nativeSearch === 'submitted' && state.nativeShown !== shownCount) {
      state.nativeShown = shownCount;
      renderSearch();
    }
  }

  let nativeResultObserver = null;
  let nativeResultRootObserver = null;
  let nativeResultObservedRoot = null;
  let nativeResultTimer = null;
  let nativeFilterSignature = '';
  let nativePendingSince = 0;
  let lastNativeSubmissionKey = '';
  let lastNativeSubmissionAt = 0;
  let nativeListFilterKey = '';
  function queueNativeResultFilter() {
    clearTimeout(nativeResultTimer);
    nativeResultTimer = window.setTimeout(applyNativeResultFilter, 80);
  }

  function bindNativeResultObserver() {
    const root = nativeElementById('searchResultTableDiv');
    if (root === nativeResultObservedRoot) return Boolean(root);
    nativeResultRootObserver?.disconnect();
    nativeResultRootObserver = null;
    nativeResultObservedRoot = root;
    if (!root) return false;
    nativeResultRootObserver = new MutationObserver(queueNativeResultFilter);
    nativeResultRootObserver.observe(root, {
      childList: true,
      subtree: true,
      // 只监听结果区的图标属性，避免主页其它网格的图片变化触发全页重算。
      attributes: true,
      attributeFilter: ['src', 'qtip', 'data-qtip', 'ext:qtip']
    });
    return true;
  }

  function watchNativeResults() {
    if (nativeResultObserver || !document.body) return;
    nativeResultObserver = new MutationObserver(() => {
      const bound = bindNativeResultObserver();
      queueNativeResultFilter();
      if (bound) {
        nativeResultObserver?.disconnect();
        nativeResultObserver = null;
      }
    });
    nativeResultObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    if (bindNativeResultObserver()) {
      nativeResultObserver.disconnect();
      nativeResultObserver = null;
    }
    queueNativeResultFilter();
  }

  function submitNativeListFilter(keyword, filters, formats) {
    if (clean(query.value) !== keyword
      || [...state.filters].sort().join(',') !== [...filters].sort().join(',')
      || [...state.formats].sort().join(',') !== [...formats].sort().join(',')) return false;
    const field = findNativeListFilter();
    if (!field || !nativeElementById('searchResultTableDiv')) return false;
    const conditionText = elementText(nativeElementById('advancedSearchCompDiv'));
    if (conditionText && !conditionText.includes(keyword)) return false;
    const key = [keyword, [...filters].sort().join(','), [...formats].sort().join(',')].join('¦');
    if (nativeListFilterKey === key && clean(field.value) === keyword) return true;
    setNativeValue(field, keyword);
    const enterEvent = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    if (!pageNativeAction('key', field, enterEvent)) {
      ['keydown', 'keypress', 'keyup'].forEach((type) => field.dispatchEvent(new KeyboardEvent(type, enterEvent)));
    }
    nativeListFilterKey = key;
    return true;
  }

  function submitNativeAdvancedSearch(keyword, filters, formats) {
    applyNativeTypeFilters(filters, formats);
    // 类型复选框变化后，Windchill 会重新渲染关键字/条件区域；先等
    // 这一轮渲染完成，再写入关键字和编号条件。
    window.setTimeout(() => {
      const currentField = findNativeKeywordField();
      if (!currentField) return;
      setNativeValue(currentField, keyword);
      applyNativeCriteria(keyword, filters);
      // Windchill 需要一点时间把复选框状态写回高级搜索模型；立即提交
      // 会出现界面显示“文档”但结果仍按“所有类型”检索的情况。
      window.setTimeout(() => {
        const button = findNativeSearchButton();
        if (button) {
          if (!pageNativeAction('click', button)) nativeMouseClick(button);
        }
        else currentField.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', bubbles: true
        }));
        watchNativeResults();
        [0, 250, 800, 1600].forEach((delay) => window.setTimeout(queueNativeResultFilter, delay));
      }, 260);
    }, 180);
    return true;
  }

  function hasVisibleNativeSearchForm() {
    return Boolean(findNativeKeywordField() && findNativeSearchButton());
  }

  function openNativeAdvancedSearch(keyword, filters, formats) {
    if (!keyword) return false;
    const submissionKey = [
      keyword,
      [...filters].sort().join(','),
      [...formats].sort().join(',')
    ].join('¦');
    if (submissionKey === lastNativeSubmissionKey && Date.now() - lastNativeSubmissionAt < 2000) return true;
    const rememberSubmission = () => {
      lastNativeSubmissionKey = submissionKey;
      lastNativeSubmissionAt = Date.now();
      nativeListFilterKey = '';
    };
    if (hasVisibleNativeSearchForm()) {
      rememberSubmission();
      submitNativeAdvancedSearch(keyword, filters, formats);
      return true;
    }
    let advancedClicked = false;
    const submitAfterNavigation = (attempt = 0) => {
      if (hasVisibleNativeSearchForm()) {
        submitNativeAdvancedSearch(keyword, filters, formats);
        state.nativeSearch = 'submitted';
        renderSearch();
        return;
      }
      const advancedLink = findNativeAdvancedLink();
      if (advancedLink && !advancedClicked) {
        advancedClicked = true;
        rememberSubmission();
        if (!pageNativeAction('click', advancedLink)) nativeMouseClick(advancedLink);
        window.setTimeout(() => submitAfterNavigation(attempt + 1), 220);
        return;
      }
      if (attempt < 20) window.setTimeout(() => submitAfterNavigation(attempt + 1), 220);
    };
    const criteriaEditor = findNativeCriteriaEditor();
    if (criteriaEditor) {
      rememberSubmission();
      if (!pageNativeAction('click', criteriaEditor)) nativeMouseClick(criteriaEditor);
      window.setTimeout(() => submitAfterNavigation(), 220);
      return true;
    }
    const link = findNativeAdvancedLink();
    if (link) {
      rememberSubmission();
      if (!pageNativeAction('click', link)) nativeMouseClick(link);
      window.setTimeout(() => submitAfterNavigation(), 220);
      return true;
    }
    const navigation = findNativeSearchNavigation();
    if (!navigation) return false;
    rememberSubmission();
    if (!pageNativeAction('navigation', navigation)) nativeMouseClick(navigation);
    window.setTimeout(() => submitAfterNavigation(), 220);
    return true;
  }

  async function loadApprovalTasks() {
    if (!isApprovalListRoute()) {
      restoreApprovalTaskCache();
      state.loading = false;
      state.currentTaskDetail = extractCurrentApprovalContext();
      renderApproval();
      return;
    }
    const requestId = ++state.requestId;
    state.loading = true;
    state.resultFilterReady = false;
    state.nativeSearch = 'idle';
    status.className = 'status';
    status.textContent = '正在获取当前用户的待审批任务…';
    renderApproval();
    try {
      const payload = await fetchWindchillOData('Workflow/WorkItems', {
        '$filter': "Status/Display eq 'Potential'",
        '$expand': 'Activity,Subject,Owner,OriginalOwner',
        '$top': '100'
      });
      if (requestId !== state.requestId) return;
      state.tasks = mergeNativeApprovalTasks(odataItems(payload).map(normalizeTask));
      if (nativeApprovalTaskRows().length) saveApprovalTaskCache(state.tasks);
      state.currentTaskDetail = extractCurrentApprovalContext();
      renderNativeTaskDetails(state.currentTaskDetail);
      state.loading = false;
      status.textContent = `审批摘要已更新 · 共 ${state.tasks.length} 条待审批任务。`;
      renderApproval();
      scheduleApprovalTaskEnrichment(requestId);
    } catch (error) {
      if (requestId !== state.requestId) return;
      state.tasks = extractNativeApprovalTasks();
      if (state.tasks.length) saveApprovalTaskCache(state.tasks);
      state.currentTaskDetail = extractCurrentApprovalContext();
      renderNativeTaskDetails(state.currentTaskDetail);
      state.loading = false;
      status.className = state.tasks.length ? 'status' : 'status error';
      status.textContent = state.tasks.length
        ? `接口暂不可用，已读取 Windchill 页面任务表 · 共 ${state.tasks.length} 条。`
        : `待审批任务获取失败：${error.message}`;
      renderApproval();
    }
  }

  let searchAbortController = null;
  function cancelDocumentSearch() {
    searchAbortController?.abort();
    searchAbortController = null;
  }

  async function searchServerDocuments(submitNative = false) {
    const keyword = clean(query.value);
    if (!keyword) {
      cancelDocumentSearch();
      state.records = [];
      state.partial = false;
      state.nativeSearch = 'idle';
      state.loading = false;
      state.resultFilterReady = true;
      state.resultVersion += 1;
      restoreNativeResultRows();
      status.className = 'status';
      status.textContent = '输入后更新数量；点击检索或按 Enter 提交 Windchill 高级搜索。';
      renderSearch();
      return;
    }

    const requestId = ++state.requestId;
    cancelDocumentSearch();
    const abortController = new AbortController();
    searchAbortController = abortController;
    const filters = new Set(state.filters);
    const formats = new Set(state.formats);
    state.loading = true;
    state.partial = false;
    state.resultFilterReady = false;
    state.nativeShown = null;
    state.truncated = false;
    state.serverTotal = 0;
    state.paging = false;
    if (submitNative) state.nativeSearch = openNativeAdvancedSearch(keyword, filters, formats) ? 'submitted' : 'unavailable';
    status.className = 'status';
    status.textContent = submitNative && state.nativeSearch === 'submitted'
      ? '已交给 Windchill 高级搜索展示结果…'
      : '正在更新结果汇总…';
    renderSearch();

    try {
      const applyProgress = (partialResult, paging) => {
        if (requestId !== state.requestId) return;
        state.records = partialResult.records;
        state.truncated = partialResult.truncated;
        state.serverTotal = partialResult.serverTotal;
        state.paging = paging;
        state.loading = false;
        state.resultFilterReady = true;
        state.resultVersion += 1;
        queueNativeResultFilter();
        renderSearch();
      };
      const result = await searchWindchillDocuments(keyword, filters, formats, abortController.signal, applyProgress);
      state.paging = false;
      if (requestId !== state.requestId) return;
      state.records = result.records;
      state.partial = result.partial;
      state.loading = false;
      state.resultFilterReady = true;
      state.resultVersion += 1;
      queueNativeResultFilter();
      state.truncated = result.truncated;
      state.serverTotal = result.serverTotal;
      saveRuleSamples();
      status.className = 'status done';
      status.textContent = state.partial
        ? `部分分类接口暂不可用，已显示可取得结果 · 共 ${state.records.length} 条。`
        : submitNative && state.nativeSearch === 'submitted'
          ? '检索完成，结果在 Windchill 页面展示；可点「下载」。'
          : `数量汇总已更新 · 共 ${state.records.length} 条。`;
      renderSearch();
    } catch (error) {
      if (requestId !== state.requestId) return;
      state.records = [];
      state.partial = false;
      state.paging = false;
      state.loading = false;
      state.resultFilterReady = false;
      restoreNativeResultRows();
      status.className = 'status error';
      status.textContent = `数量获取失败：${error.message}`;
      renderSearch();
    } finally {
      if (searchAbortController === abortController) searchAbortController = null;
    }
  }

  function make(tag, attrs, content) {
    const element = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => element.setAttribute(key, value));
    if (content !== undefined) element.textContent = content;
    return element;
  }

  const style = make('style', {}, `
    :host { all: initial; }
    *[hidden] { display: none !important; }
    .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: min(380px, calc(100vw - 32px)); overflow: hidden; border: 1px solid #b9ceda; border-radius: 12px; background: #f7fbfd; color: #17212b; box-shadow: 0 10px 28px #08324a3b; font: 12px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .head { display: flex; align-items: center; gap: 8px; padding: 9px 10px; background: linear-gradient(135deg, #073c68, #087f9c); color: #fff; cursor: move; user-select: none; touch-action: none; }
    .logo { width: 28px; height: 28px; flex: 0 0 auto; border-radius: 8px; }
    .brand { min-width: 0; }
    .title { font-weight: 800; letter-spacing: .2px; }
    .subtitle { margin-top: 2px; color: #d8edf8; font-size: 10px; white-space: nowrap; }
    .mode { display: flex; gap: 3px; margin-left: auto; }
    .mode button { border: 1px solid #ffffff55; border-radius: 999px; padding: 4px 7px; background: #ffffff16; color: #e7f5fb; cursor: pointer; font-size: 10px; white-space: nowrap; }
    .mode button.active { background: #fff; color: #073c68; }
    .collapse { flex: 0 0 auto; border: 1px solid #ffffff55; border-radius: 999px; padding: 2px 7px; background: #ffffff16; color: #fff; cursor: pointer; font-size: 16px; line-height: 1; }
    .collapse:hover { background: #ffffff2b; }
    .toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px 6px; background: #fff; }
    .toolbar input { min-width: 0; flex: 1; border: 1px solid #79aabd; border-radius: 8px; padding: 8px 10px; color: #17212b; outline: none; font: inherit; }
    .toolbar input:focus { border-color: #087f9c; box-shadow: 0 0 0 3px #087f9c22; }
    .submit { flex: 0 0 auto; border-color: #087f9c; background: #087f9c; color: #fff; font-weight: 700; }
    .submit:hover { background: #076b84; }
    button { border: 1px solid #a9bdca; border-radius: 7px; padding: 6px 9px; background: #fff; color: #26495c; cursor: pointer; font: 600 11px inherit; }
    button:hover { background: #eaf5fa; }
    .filters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; padding: 0 10px 8px; background: #fff; border-bottom: 1px solid #e2edf2; }
    .filter { display: flex; align-items: center; justify-content: center; gap: 4px; min-width: 0; border: 1px solid #b7cbd8; border-radius: 7px; padding: 6px 4px; background: #f8fbfd; color: #355466; cursor: pointer; font-weight: 700; white-space: nowrap; }
    .filter:has(input:checked) { border-color: #087f9c; background: #e1f2f8; color: #075e9c; box-shadow: inset 0 0 0 1px #087f9c; }
    .filter input { margin: 0; accent-color: #087f9c; }
    .format-row { display: flex; align-items: flex-start; gap: 6px; padding: 6px 10px 8px; background: #fff; border-bottom: 1px solid #e2edf2; }
    .filter-caption { flex: 0 0 auto; padding: 6px 0; color: #536675; font-weight: 700; white-space: nowrap; }
    .format-filters { display: flex; flex: 1; flex-wrap: wrap; gap: 4px; padding: 0; border: 0; }
    .format-filter { padding: 5px 7px; font-size: 10px; }
    .approval-view { padding: 9px 10px 7px; background: #fff; border-bottom: 1px solid #e2edf2; }
    .approval-toolbar { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
    .approval-toolbar strong { color: #073c68; font-size: 12px; }
    .approval-refresh { margin-left: auto; padding: 5px 8px; font-size: 10px; }
    .credential-card { display: flex; align-items: center; gap: 7px; padding: 7px 8px; border: 1px solid #d6e6ed; border-radius: 8px; background: #f7fbfd; }
    .credential-icon { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; background: #e1f2f8; color: #075e9c; font-size: 13px; }
    .credential-copy { min-width: 0; flex: 1; }
    .credential-copy strong { display: block; color: #26495c; font-size: 11px; }
    .credential-copy span { display: block; margin-top: 2px; color: #6a7e8c; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .credential-status { color: #0b7d55 !important; font-weight: 700; }
    .credential-status.missing { color: #a15c00 !important; }
    .credential-toggle { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; color: #075e9c; font-size: 10px; font-weight: 800; white-space: nowrap; cursor: pointer; }
    .credential-toggle input { margin: 0; accent-color: #087f9c; }
    .current-task-focus { margin-top: 8px; padding: 7px 8px; border: 1px solid #cfe1e8; border-radius: 8px; background: #f0f8fb; }
    .current-task-focus-title { color: #075e9c; font-size: 10px; font-weight: 800; }
    .current-task-focus-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 8px; margin-top: 5px; }
    .focus-field { min-width: 0; color: #536675; font-size: 10px; line-height: 1.35; overflow-wrap: anywhere; }
    .focus-field strong { color: #26495c; }
    .focus-field.wide { grid-column: 1 / -1; }
    .focus-link { color: #075e9c; text-decoration: none; }
    .focus-link:hover { text-decoration: underline; }
    .approval-stats { display: flex; gap: 5px; flex-wrap: wrap; margin: 8px 0 6px; }
    .approval-stat { padding: 4px 7px; border-radius: 999px; background: #edf6f9; color: #355466; font-size: 10px; }
    .approval-stat strong { color: #073c68; }
    .task-summary { max-height: 178px; overflow-y: auto; }
    .task-group { margin-top: 6px; border-top: 1px solid #edf2f5; padding-top: 5px; }
    .task-group:first-child { margin-top: 0; border-top: 0; padding-top: 0; }
    .task-group-title { display: flex; justify-content: space-between; gap: 8px; color: #355466; font-size: 10px; font-weight: 800; }
    .task-group-count { color: #6a7e8c; font-weight: 600; }
    .task-item { display: flex; gap: 7px; padding: 4px 0 0 7px; color: #536675; font-size: 10px; }
    .task-item::before { content: '•'; color: #087f9c; font-weight: 900; }
    .task-item-main { min-width: 0; flex: 1; }
    .task-item-title { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .task-item-title strong, .task-item-title a { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #26495c; font-size: 10px; font-weight: 800; }
    .task-item-title a { color: #075e9c; text-decoration: none; }
    .task-item-title a:hover { text-decoration: underline; }
    .task-subject-link { flex: 0 0 auto; color: #087f9c !important; font-size: 9px !important; font-weight: 700 !important; }
    .task-item-main span { display: block; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .approval-empty { padding: 10px 3px 4px; color: #6a7e8c; text-align: center; }
    .collapsed-button { display: none; align-items: center; justify-content: center; width: 48px; height: 48px; padding: 0; border: 1px solid rgba(60, 60, 67, .14); border-radius: 12px; background: #fff; color: #fff; cursor: pointer; overflow: hidden; }
    .collapsed-button:hover { filter: brightness(1.06); }
    .collapsed-button img { width: 100%; height: 100%; border-radius: 11px; object-fit: cover; }
    .panel.collapsed { width: 48px; height: 48px; border-radius: 12px; overflow: visible; box-shadow: 0 6px 20px rgba(0, 0, 0, .18); border-color: transparent; background: transparent; }
    .panel.morphing { will-change: clip-path; }
    .panel.morphing .collapsed-button { display: flex; position: absolute; right: 0; bottom: 0; z-index: 2; pointer-events: none; }
    .panel.collapsed > :not(.collapsed-button) { display: none; }
    .panel.collapsed .collapsed-button { display: flex; }
    .summary { display: flex; align-items: baseline; gap: 7px; padding: 8px 10px 5px; background: #f7fbfd; color: #536675; }
    .summary strong { color: #073c68; font-size: 14px; }
    .summary span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { min-height: 15px; padding: 0 10px 8px; color: #536675; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status.error { color: #b42318; }
    .status.done { margin: 0 10px 8px; padding: 3px 8px; color: #137333; background: #e6f4ea; border-left: 3px solid #1e9e4a; border-radius: 3px; font-weight: 600; }
    .dl-mini { flex: none; align-self: center; margin-left: auto; padding: 1px 8px; border-color: #087f9c; color: #075e9c; font-size: 10px; line-height: 16px; }
  `);
  shadow.appendChild(style);

  const panel = make('section', { class: 'panel', role: 'dialog', 'aria-label': 'Windchill 智能工作台' });
  const head = make('div', { class: 'head' });
  const logo = make('img', { class: 'logo', src: chrome.runtime.getURL('windchill-icon.svg'), alt: 'Windchill' });
  const brand = make('div', { class: 'brand' });
  brand.append(make('div', { class: 'title' }, 'Windchill 助手'));
  brand.append(make('div', { class: 'subtitle' }, '高级搜索 · 登录填充 · 审批摘要'));
  const mode = make('div', { class: 'mode' });
  const searchTab = make('button', { class: 'active', type: 'button' }, '智能查询');
  const approvalTab = make('button', { type: 'button' }, '审批摘要');
  mode.append(searchTab, approvalTab);
  const collapse = make('button', { class: 'collapse', type: 'button', title: '收起为图标', 'aria-label': '收起为图标' }, '−');
  head.append(logo, brand, mode, collapse);

  const toolbar = make('div', { class: 'toolbar' });
  const query = make('input', { type: 'search', placeholder: '输入文件号、文件名或关键词', 'aria-label': 'Windchill 查询' });
  const submit = make('button', { class: 'submit', type: 'button', title: '提交 Windchill 高级搜索', 'aria-label': '提交 Windchill 高级搜索' }, '检索');
  toolbar.append(query, submit);

  const filters = make('div', { class: 'filters', role: 'group', 'aria-label': '快捷筛选（可多选）' });
  [['drawing', '图纸'], ['engineering', '工程文件'], ['quality', '质量文件']].forEach(([value, label]) => {
    const wrapper = make('label', { class: 'filter' });
    const input = make('input', { type: 'checkbox', value, 'aria-label': label });
    input.checked = state.filters.has(value);
    wrapper.append(input, document.createTextNode(label));
    input.addEventListener('change', () => {
      if (input.checked) state.filters.add(value); else state.filters.delete(value);
      if (state.mode === 'search') {
        // 筛选条件本身就是一次新的查询：有关键词时立即重新走 Windchill 高级搜索，
        // 无论上一次是否已经提交过，避免只更新浮层数量而不更新原生条件。
        scheduleSearch(Boolean(clean(query.value)));
      } else renderApproval();
    });
    filters.append(wrapper);
  });

  const formatRow = make('div', { class: 'format-row' });
  const formatFilters = make('div', { class: 'format-filters', role: 'group', 'aria-label': '文件格式（可多选）' });
  formatRow.append(make('span', { class: 'filter-caption' }, '文件格式'));
  [
    ['pdf', 'PDF'], ['dwg', 'DWG'], ['word', 'Word'], ['excel', 'Excel'],
    ['ppt', 'PPT'], ['archive', '压缩包']
  ].forEach(([value, label]) => {
    const wrapper = make('label', { class: 'filter format-filter' });
    const input = make('input', { type: 'checkbox', value, 'aria-label': label });
    input.checked = state.formats.has(value);
    wrapper.append(input, document.createTextNode(label));
    input.addEventListener('change', () => {
      if (input.checked) state.formats.add(value); else state.formats.delete(value);
      if (state.mode === 'search') scheduleSearch(Boolean(clean(query.value)));
      else renderApproval();
    });
    formatFilters.append(wrapper);
  });
  formatRow.append(formatFilters);

  const approvalView = make('div', { class: 'approval-view', hidden: true, 'aria-label': '审批摘要和登录填充' });
  const approvalToolbar = make('div', { class: 'approval-toolbar' });
  const approvalTitle = make('strong', {}, 'Windchill 待审批摘要');
  approvalToolbar.append(approvalTitle);
  const approvalRefresh = make('button', { class: 'approval-refresh', type: 'button' }, '刷新汇总');
  approvalToolbar.append(approvalRefresh);
  const credentialCard = make('div', { class: 'credential-card' });
  credentialCard.append(make('div', { class: 'credential-icon', 'aria-hidden': 'true' }, '🔐'));
  const credentialCopy = make('div', { class: 'credential-copy' });
  const credentialStatus = make('strong', { class: 'credential-status' }, '检查登录填充设置…');
  const credentialHint = make('span', {}, '不展示密码内容，只显示是否已配置');
  credentialCopy.append(credentialStatus, credentialHint);
    const autoFillLabel = make('label', { class: 'credential-toggle' });
    const autoFillToggle = make('input', { type: 'checkbox', 'aria-label': '自动填充登录信息' });
    autoFillLabel.append(autoFillToggle, document.createTextNode('自动填充'));
    credentialCard.append(credentialCopy, autoFillLabel);
  const currentTaskFocus = make('div', { class: 'current-task-focus', hidden: true, 'aria-label': '当前审批重点' });
  const approvalStats = make('div', { class: 'approval-stats' });
  const taskSummary = make('div', { class: 'task-summary' });
  approvalView.append(approvalToolbar, credentialCard, currentTaskFocus, approvalStats, taskSummary);

  const summary = make('div', { class: 'summary' });
  const count = make('strong', {}, '未查询');
  const summaryText = make('span', {}, '支持多选标签；结果在 Windchill 高级搜索页面展示。');
  summary.append(count, summaryText);
  const status = make('div', { class: 'status' }, '输入后更新数量；点击检索或按 Enter 提交 Windchill 高级搜索。');
  const collapsedButton = make('button', { class: 'collapsed-button', type: 'button', title: '展开 Windchill 助手', 'aria-label': '展开 Windchill 助手' });
  collapsedButton.append(make('img', { src: chrome.runtime.getURL('icons/windchill.png'), alt: 'Windchill' }));
  const dlOpen = make('button', { class: 'dl-mini', type: 'button', title: '在新标签页中选择并下载签名文件' }, '下载');
  const dlBar = dlOpen;
  summary.append(dlOpen);
  panel.append(head, toolbar, filters, formatRow, approvalView, summary, status, collapsedButton);
  shadow.append(panel);

  function clampPanelPosition(left, top) {
    const maxLeft = Math.max(6, window.innerWidth - panel.offsetWidth - 6);
    const maxTop = Math.max(6, window.innerHeight - panel.offsetHeight - 6);
    return {
      left: Math.max(6, Math.min(maxLeft, Number(left) || 6)),
      top: Math.max(6, Math.min(maxTop, Number(top) || 6))
    };
  }

  function setPanelPosition(left, top, persist = false) {
    const position = clampPanelPosition(left, top);
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    if (persist) storageSet({ windchillAssistantPanelPosition: position });
  }

  let dragState = null;
  head.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target?.closest?.('button')) return;
    const rect = panel.getBoundingClientRect();
    dragState = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    head.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  head.addEventListener('pointermove', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    setPanelPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
  });
  const finishPanelDrag = (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const rect = panel.getBoundingClientRect();
    dragState = null;
    head.releasePointerCapture?.(event.pointerId);
    setPanelPosition(rect.left, rect.top);
  };
  head.addEventListener('pointerup', finishPanelDrag);
  head.addEventListener('pointercancel', finishPanelDrag);
  window.addEventListener('resize', () => {
    if (panel.style.left && panel.style.top) setPanelPosition(panel.offsetLeft, panel.offsetTop);
  });
  // 默认固定在右下角并折叠为图标，避免遮挡页面；拖动位置只在本次页面内有效。

  const MORPH_EASE = 'cubic-bezier(.22, 1, .36, 1)';
  const ICON_SIZE = 48;
  let morphing = false;

  function anchorBottomRight(rect) {
    const viewport = document.documentElement;
    const right = Math.max(6, (viewport.clientWidth || window.innerWidth) - rect.right);
    const bottom = Math.max(6, (viewport.clientHeight || window.innerHeight) - rect.bottom);
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = `${right}px`;
    panel.style.bottom = `${bottom}px`;
  }

  function keepExpandedInView() {
    const rect = panel.getBoundingClientRect();
    if (rect.top < 6) panel.style.bottom = `${Math.max(6, parseFloat(panel.style.bottom || '12') - (6 - rect.top))}px`;
    if (rect.left < 6) panel.style.right = `${Math.max(6, parseFloat(panel.style.right || '12') - (6 - rect.left))}px`;
  }

  function contentChildren() {
    return [...panel.children].filter((child) => child !== collapsedButton);
  }

  function updateCollapseLabel(collapsed) {
    collapse.textContent = collapsed ? '+' : '−';
    collapse.title = collapsed ? '展开助手' : '收起为图标';
    collapse.setAttribute('aria-label', collapse.title);
  }

  function setPanelCollapsed(collapsed, animate = true) {
    if (morphing || panel.classList.contains('collapsed') === collapsed) return;
    updateCollapseLabel(collapsed);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduceMotion || !panel.animate) {
      if (collapsed) anchorBottomRight(panel.getBoundingClientRect());
      panel.classList.toggle('collapsed', collapsed);
      if (!collapsed) keepExpandedInView();
      return;
    }
    morphing = true;
    if (collapsed) anchorBottomRight(panel.getBoundingClientRect());
    else {
      panel.classList.remove('collapsed');
      keepExpandedInView();
    }
    panel.classList.add('morphing');
    const { width, height } = panel.getBoundingClientRect();
    const full = 'inset(0px 0px 0px 0px round 12px)';
    const icon = `inset(${Math.max(0, height - ICON_SIZE)}px 0px 0px ${Math.max(0, width - ICON_SIZE)}px round 12px)`;
    const duration = collapsed ? 300 : 360;
    const shape = panel.animate(
      [{ clipPath: collapsed ? full : icon }, { clipPath: collapsed ? icon : full }],
      { duration, easing: MORPH_EASE }
    );
    const fadeContent = { duration: collapsed ? 160 : 220, delay: collapsed ? 0 : 120, easing: 'ease', fill: 'both' };
    const contentAnimations = contentChildren().map((child) => child.animate(
      collapsed ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }],
      fadeContent
    ));
    const iconAnimation = collapsedButton.animate(
      collapsed
        ? [{ opacity: 0, transform: 'scale(.82)' }, { opacity: 1, transform: 'scale(1)' }]
        : [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.82)' }],
      { duration: collapsed ? 200 : 150, delay: collapsed ? duration - 200 : 0, easing: MORPH_EASE, fill: 'both' }
    );
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (collapsed) panel.classList.add('collapsed');
      panel.classList.remove('morphing');
      shape.cancel();
      contentAnimations.forEach((animation) => animation.cancel());
      iconAnimation.cancel();
      morphing = false;
    };
    shape.finished.then(settle, settle);
    // 后台标签页不推进动画时也要落到最终状态
    window.setTimeout(settle, duration + 250);
  }

  updateCollapseLabel(true);
  panel.classList.add('collapsed');

  collapse.addEventListener('click', () => setPanelCollapsed(true));
  collapsedButton.addEventListener('click', () => setPanelCollapsed(false));

  function selectedFilterLabel() {
    if (!state.filters.size) return '全部类型';
    return [...state.filters].map((value) => ({ drawing: '图纸', engineering: '工程文件', quality: '质量文件' }[value])).join('、');
  }

  function selectedFormatLabel() {
    if (!state.formats.size) return '全部格式';
    return [...state.formats].map((value) => ({
      pdf: 'PDF', dwg: 'DWG', word: 'Word', excel: 'Excel', ppt: 'PPT', archive: '压缩包'
    }[value])).join('、');
  }

  function filteredTasks() {
    const keyword = clean(query.value).toLowerCase();
    if (!keyword) return state.tasks;
    return state.tasks.filter((task) => task.text.toLowerCase().includes(keyword));
  }

  function renderCredentialStatus() {
    autoFillToggle.checked = state.autoFillEnabled;
    credentialStatus.textContent = state.credentialConfigured
      ? (state.autoFillEnabled ? '登录信息已配置 · 自动填充已开启' : '登录信息已配置 · 自动填充已关闭')
      : '尚未配置 Windchill 登录信息';
    credentialStatus.classList.toggle('missing', !state.credentialConfigured || !state.autoFillEnabled);
    credentialHint.textContent = !state.credentialConfigured
      ? '请先点击扩展图标保存用户名和密码'
      : (state.autoFillEnabled ? '页面出现登录框时自动填写；关闭后请手动输入' : '当前不会自动填写，登录时请手动输入');
  }

  function loadCredentialStatus() {
    storageGet(['windchillUsername', 'windchillPassword', 'Login1', 'Password1', 'windchillAutoFillEnabled'], (result) => {
      state.credentialConfigured = Boolean(result && ((result.windchillUsername && result.windchillPassword) || (result.Login1 && result.Password1)));
      state.autoFillEnabled = result?.windchillAutoFillEnabled !== false;
      renderCredentialStatus();
    });
  }

  function taskGroupName(task) {
    return task.title || 'Windchill 审批任务';
  }

  function renderApprovalDetails(tasks) {
    approvalStats.replaceChildren();
    taskSummary.replaceChildren();
    if (state.loading) {
      taskSummary.append(make('div', { class: 'approval-empty' }, '正在获取当前用户的待审批任务…'));
      return;
    }
    if (!tasks.length) {
      taskSummary.append(make('div', { class: 'approval-empty' }, '当前没有待审批事项'));
      return;
    }

    const groups = new Map();
    tasks.forEach((task) => {
      const name = taskGroupName(task);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(task);
    });
    const stats = [
      ['总数', tasks.length],
      ...[...groups.entries()].slice(0, 3).map(([name, group]) => [name, group.length])
    ];
    stats.forEach(([label, value]) => {
      const stat = make('span', { class: 'approval-stat' });
      stat.append(document.createTextNode(`${label} `), make('strong', {}, String(value)));
      approvalStats.append(stat);
    });

    const maxItems = 10;
    let renderedItems = 0;
    for (const [groupName, group] of groups) {
      if (renderedItems >= maxItems) break;
      const groupElement = make('div', { class: 'task-group' });
      const groupTitle = make('div', { class: 'task-group-title' });
      groupTitle.append(make('span', {}, groupName), make('span', { class: 'task-group-count' }, `${group.length} 条`));
      groupElement.append(groupTitle);
      group.slice(0, maxItems - renderedItems).forEach((task) => {
        const item = make('div', { class: 'task-item' });
        const main = make('div', { class: 'task-item-main' });
        const identity = task.subjectTitle || task.subjectText || [task.number, task.version].filter(Boolean).join(' · ') || task.title;
        const titleLine = make('div', { class: 'task-item-title' });
        if (task.taskUrl) {
          titleLine.append(make('a', { href: task.taskUrl, title: '打开审批页面' }, identity));
        } else {
          titleLine.append(make('strong', {}, identity));
        }
        if (task.subjectUrl && task.subjectUrl !== task.taskUrl) {
          titleLine.append(make('a', { class: 'task-subject-link', href: task.subjectUrl, title: '打开主题对象' }, '主题'));
        }
        const detail = [
          task.number,
          task.version,
          task.lifecycleState,
          task.status,
          task.owner ? `负责人：${task.owner}` : '',
          task.initiator ? `发起：${task.initiator}` : '',
          task.priority ? `优先级：${task.priority}` : '',
          task.deadline ? `截止：${task.deadline}` : '',
          task.context,
          task.description ? `说明：${task.description}` : ''
        ].filter(Boolean).join(' · ') || '待处理';
        main.append(titleLine, make('span', {}, detail));
        item.append(main);
        groupElement.append(item);
        renderedItems += 1;
      });
      taskSummary.append(groupElement);
    }
    if (tasks.length > renderedItems) {
      taskSummary.append(make('div', { class: 'approval-empty' }, `其余 ${tasks.length - renderedItems} 条已汇总，未在浮层展开`));
    }
  }

  function renderCurrentTaskFocus() {
    currentTaskFocus.replaceChildren();
    const detail = state.currentTaskDetail;
    if (!detail) {
      currentTaskFocus.hidden = true;
      return;
    }
    currentTaskFocus.hidden = false;
    const isDocument = detail.kind === 'document';
    currentTaskFocus.append(make('div', { class: 'current-task-focus-title' }, isDocument ? '当前 ECN / 文档重点' : '当前审批重点'));
    const grid = make('div', { class: 'current-task-focus-grid' });
    const addField = (label, value, options = {}) => {
      if (!value) return;
      const field = make('div', { class: `focus-field${options.wide ? ' wide' : ''}` });
      field.append(make('strong', {}, `${label}：`));
      if (options.href) {
        field.append(make('a', { class: 'focus-link', href: options.href, title: options.title || `打开${label}` }, value));
      } else {
        field.append(document.createTextNode(value));
      }
      grid.append(field);
    };
    addField(isDocument ? '对象' : '主题', detail.subjectTitle, {
      wide: true,
      href: isDocument ? detail.objectUrl : detail.subjectUrl,
      title: isDocument ? '打开当前对象页面' : '打开 ECN 主题对象，查看说明和内容'
    });
    addField('编号', detail.subjectNumber);
    addField('版本', detail.subjectVersion);
    if (isDocument) {
      addField('页面说明', detail.description, { wide: true });
      addField('格式', detail.format);
      addField('生命周期', detail.lifecycleState);
      addField('状态', detail.status);
      addField('上下文', detail.context);
      addField('位置', detail.location, { wide: true });
      addField('修改者', detail.modifiedBy);
      addField('最后修改', detail.modifiedAt);
      addField('记录类型', detail.recordType);
      return currentTaskFocus.append(grid);
    }
    addField('流程', detail.process, { wide: true });
    addField('发起者', detail.initiator);
    addField('负责人', detail.owner);
    addField('角色', detail.role);
    addField('优先级', detail.priority);
    addField('截止时间', detail.deadline);
    addField('指示', detail.taskDescription, { wide: true });
    currentTaskFocus.append(grid);
  }

  // ───── 签名文件批量下载（独立弹窗选择，本脚本负责验证与下载） ─────
  const dl = { plans: new Map(), abort: null };

  // 弹窗与脚本约定的文件序号：有内容明细时就是 record.contents 的下标；没有时只有一个“主文件”占位。
  function fileListOf(record) {
    return record.contents.length
      ? record.contents
      : [{ role: 'primary', id: '', fileName: '', mime: '', urls: [], size: 0, format: record.format }];
  }

  function downloadJob() {
    dl.plans.clear();
    const items = state.records.slice(0, rules.download.maxFiles).map((record, index) => {
      const key = `${index}:${record.oid || record.number}`;
      const plan = Rules.planSigned(rules, record);
      const files = fileListOf(record);
      dl.plans.set(key, { record, files });
      return {
        key, number: record.number, title: record.title, version: record.version, format: record.format,
        category: record.category, status: plan.status, reason: plan.reason, confidence: plan.confidence,
        pickIndex: plan.pick ? Math.max(0, files.indexOf(plan.pick)) : -1,
        files: files.map((file) => ({ role: file.role, fileName: file.fileName, format: file.format, size: file.size, signed: Rules.fileIsSigned(rules, file) }))
      };
    });
    return { keyword: clean(query.value), origin: location.origin, rules, items };
  }

  function updateDownloadBar() {
    dlBar.hidden = state.mode !== 'search';
  }

  function openDownloader() {
    if (state.loading || !state.records.length) {
      status.className = 'status';
      status.textContent = '请先检索：有结果后再点「下载」。';
      return;
    }
    try {
      chrome.runtime.sendMessage({ action: 'wcOpenDownloader', job: downloadJob() }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          status.className = 'status error';
          status.textContent = `无法打开下载页：${chrome.runtime.lastError?.message || response?.error || '未知错误'}`;
        }
      });
    } catch (error) {
      status.className = 'status error';
      status.textContent = '扩展已重载，请刷新页面';
    }
  }

  // 下载弹窗逐份请求：验证下载地址后交给后台 chrome.downloads。
  try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'wcDownloadCancel') {
        dl.abort?.abort();
        dl.abort = null;
        sendResponse({ ok: true });
        return;
      }
      if (request.action !== 'wcDownloadItem') return;
      const entry = dl.plans.get(request.key);
      const content = entry && entry.files[request.fileIndex];
      if (!content) {
        sendResponse({ status: 'failed', reason: '检索结果已变化，请回到 Windchill 页面重新点「下载」' });
        return;
      }
      dl.abort = dl.abort && !dl.abort.signal.aborted ? dl.abort : new AbortController();
      globalThis.WcDownload.downloadOne({
        record: entry.record, content, rules, origin: location.origin, batch: request.batch, signal: dl.abort.signal,
        useFileName: Boolean(request.useFileName)
      }).then(sendResponse);
      return true;
    });
  } catch (error) {}

  dlOpen.addEventListener('click', openDownloader);

  // 最近一次检索的样本（编号 / 名称 / 文件名），供插件后台让 AI 建议规则调整；只保存文本，不含地址。
  function saveRuleSamples() {
    storageSet({
      windchillRuleSamples: state.records.slice(0, 60).map((record) => ({
        number: record.number, title: record.title, format: record.format, category: record.category,
        files: record.contents.map((content) => content.fileName).filter(Boolean)
      })),
      windchillRuleSamplesAt: Date.now()
    });
  }

  function applyRules(raw) {
    rules = Rules.normalize(raw);
    if (state.mode === 'search' && clean(query.value)) scheduleSearch(false);
  }

  // 悬浮窗只显示数量汇总和状态条；结果列表交给 Windchill 原生页面和下载窗口，避免结果过多放不下。
  function renderResultList() {
    updateDownloadBar();
  }

  function renderSearch() {
    const keyword = clean(query.value);
    if (!keyword) {
      count.textContent = '未查询';
      summaryText.textContent = '';
      renderResultList();
      return;
    }
    count.textContent = state.loading ? '查询中…' : `共 ${state.records.length} 条` + (state.paging ? ' …' : '');
    // 汇总只显示数量，不再附加说明文字。
    summaryText.textContent = '';
    renderResultList();
  }

  function renderApproval() {
    const tasks = filteredTasks();
    const listRoute = isApprovalListRoute();
    approvalTitle.textContent = listRoute ? 'Windchill 待审批摘要' : '审批摘要（沿用首页数据）';
    approvalRefresh.hidden = !listRoute;
    count.textContent = state.loading ? '获取中…' : `共 ${tasks.length} 条`;
    summaryText.textContent = listRoute ? '当前用户待审批任务 · 首页实时数据' : '当前任务详情 · 沿用首页审批数据';
    renderCredentialStatus();
    renderCurrentTaskFocus();
    renderApprovalDetails(tasks);
  }

  function render() {
    const approvalMode = state.mode === 'approval';
    [toolbar, filters, formatRow].forEach((element) => { element.hidden = approvalMode; });
    approvalView.hidden = !approvalMode;
    if (approvalMode) { dlBar.hidden = true; }
    if (approvalMode) renderApproval(); else renderSearch();
  }

  approvalRefresh.addEventListener('click', () => loadApprovalTasks());
  autoFillToggle.addEventListener('change', () => {
    state.autoFillEnabled = autoFillToggle.checked;
    storageSet({ windchillAutoFillEnabled: state.autoFillEnabled });
    status.className = 'status';
    status.textContent = state.autoFillEnabled
      ? '自动填充已开启；登录页会自动填写账号密码。'
      : '自动填充已关闭；登录时请手动输入账号密码。';
    renderCredentialStatus();
  });

  let searchTimer = null;
  function scheduleSearch(submitNative = false) {
    clearTimeout(searchTimer);
    cancelDocumentSearch();
    // 立即使正在进行的请求失效。否则用户在请求完成前切换筛选项时，
    // 旧响应可能在 250ms 防抖窗口内先写回，造成结果先出现后消失。
    state.requestId += 1;
    state.resultFilterReady = false;
    renderSearch();
    // 先标记本轮结果未就绪，防止旧汇总在新查询完成前反复隐藏结果；
    // 再在短暂防抖后只发起一次新的查询。
    applyNativeResultFilter();
    if (!clean(query.value)) return;
    searchTimer = window.setTimeout(() => searchServerDocuments(submitNative), 250);
  }

  function openNativeSearchNow() {
    const keyword = clean(query.value);
    if (!keyword) return;
    if (state.mode === 'approval') {
      loadApprovalTasks();
      return;
    }
    // 点击检索始终视为一次全新的检索：清除去重/筛选缓存，并重新拉取汇总。
    lastNativeSubmissionKey = '';
    lastNativeSubmissionAt = 0;
    nativeListFilterKey = '';
    nativeFilterSignature = '';
    state.nativeSearch = 'idle';
    scheduleSearch(true);
  }

  searchTab.addEventListener('click', () => {
    state.mode = 'search';
    try { sessionStorage.removeItem('windchillAssistantMode'); } catch (error) {}
    state.loading = false;
    state.nativeSearch = 'idle';
    restoreNativeResultRows();
    nativeFilterSignature = '';
    searchTab.classList.add('active');
    approvalTab.classList.remove('active');
    query.placeholder = '输入文件号、文件名或关键词';
    render();
  });

  approvalTab.addEventListener('click', () => {
    state.mode = 'approval';
    try { sessionStorage.setItem('windchillAssistantMode', 'approval'); } catch (error) {}
    clearTimeout(searchTimer);
    cancelDocumentSearch();
    state.requestId += 1;
    state.loading = false;
    state.nativeSearch = 'idle';
    state.resultFilterReady = false;
    query.value = '';
    restoreNativeResultRows();
    nativeFilterSignature = '';
    approvalTab.classList.add('active');
    searchTab.classList.remove('active');
    query.placeholder = '审批状态下无需输入';
    render();
    loadCredentialStatus();
    restoreApprovalTaskCache();
    if (isApprovalListRoute()) loadApprovalTasks();
    else scheduleApprovalTaskEnrichment(state.requestId);
  });

  query.addEventListener('input', () => {
    if (state.mode === 'search') {
      // 重新输入时先取消自动提交，避免只把第一个字符送进 Windchill。
      state.nativeSearch = 'idle';
      scheduleSearch(false);
    } else renderApproval();
  });
  query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      openNativeSearchNow();
    }
  });
  submit.addEventListener('click', openNativeSearchNow);

  if (state.mode === 'approval') {
    searchTab.classList.remove('active');
    approvalTab.classList.add('active');
    query.placeholder = '审批状态下无需输入';
  }
  render();
  loadCredentialStatus();
  storageGet([Rules.STORAGE_KEY], (result) => {
    if (result && result[Rules.STORAGE_KEY]) applyRules(result[Rules.STORAGE_KEY]);
  });
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[Rules.STORAGE_KEY]) applyRules(changes[Rules.STORAGE_KEY].newValue);
    });
  } catch (error) {}
  if (state.mode === 'approval') {
    restoreApprovalTaskCache();
    renderApproval();
    if (isApprovalListRoute()) loadApprovalTasks();
    else scheduleApprovalTaskEnrichment(state.requestId);
  }
  scheduleNativeTaskDetails();
})();
