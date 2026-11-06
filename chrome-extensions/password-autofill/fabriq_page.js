// Fabriq 页面层：读取工单（标题 / 描述 / 任务 / 人员）和向页面写入的全部 DOM 操作，不含任何 UI。
// 选择器集中在 SELECTORS，便于页面改版时统一修正并供自检使用。
(() => {
  'use strict';
  const { normalizeText, descriptionToHtml } = globalThis.MwaFabriqAiHelpers;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 页面选择器集中在这里：Fabriq 改版时只需修正此表；diagnose() 用它逐项自检。
  // scope: document = 整个页面；modal = 工单弹窗内；required = 缺失会让对应功能不可用。
  const SELECTORS = {
    modal: { selector: '.modal.is-active', scope: 'document', required: true, feature: '识别工单弹窗' },
    title: { selector: '[data-qa="title"] .ProseMirror, .ticket-title .ProseMirror, .ProseMirror[data-placeholder="Add a title"]', scope: 'modal', required: true, feature: '读写标题' },
    description: { selector: '.rich-text-editor-prosemirror', scope: 'modal', required: true, feature: '读写描述' },
    descriptionLabel: { selector: '[data-qa=field-label]', scope: 'modal', required: false, feature: 'AI 按钮备用位置' },
    ticketIdChip: { selector: '[data-qa=ticket-id-chip]', scope: 'modal', required: false, feature: 'AI 按钮位置（工单 ID 左侧）' },
    taskEditor: { selector: '[data-qa=task-description] .ProseMirror', scope: 'modal', required: false, feature: '读写任务（工单没有任务时可能为空）' },
    addTask: { selector: '[data-qa=add-a-new-task-placeholder]', scope: 'modal', required: true, feature: '添加任务' },
    taskDate: { selector: '[data-qa=date]', scope: 'modal', required: false, feature: '任务日期' },
    taskUser: { selector: '[data-qa=user]', scope: 'modal', required: false, feature: '任务负责人' },
    ticketUser: { selector: '[data-qa=ticket-user]', scope: 'modal', required: true, feature: '人员检索（借用工单负责人选择框）' },
    commentEditor: { selector: '.comment-input .ProseMirror', scope: 'modal', required: false, feature: '发送评论' },
    rightPanel: { selector: '.right-panel', scope: 'modal', required: false, feature: 'AI 栏对齐 / 展开右侧栏' },
    showHistory: { selector: '[data-qa=ticket-modal-show-history]', scope: 'modal', required: false, feature: '展开右侧栏（栏收起时才出现）' },
    hideHistory: { selector: '[data-qa=hide-history-feed-button]', scope: 'modal', required: false, feature: '收起右侧栏（栏展开时才出现）' },
    leftPanel: { selector: '[data-qa=ticket-modal-left-panel]', scope: 'modal', required: false, feature: '任务懒加载滚动' }
  };
  const query = (modal, name) => (SELECTORS[name].scope === 'document' ? document : modal).querySelector(SELECTORS[name].selector);
  const queryAll = (modal, name) => [...(SELECTORS[name].scope === 'document' ? document : modal).querySelectorAll(SELECTORS[name].selector)];

  // 自检：逐项报告选择器命中数量，缺失时指出会影响哪项功能。
  function diagnose(modal) {
    const items = Object.entries(SELECTORS).map(([name, spec]) => {
      const count = modal || spec.scope === 'document' ? queryAll(modal, name).length : 0;
      return { name, selector: spec.selector, required: spec.required, feature: spec.feature, count, ok: count > 0 };
    });
    return { time: new Date().toISOString(), url: location.href, items,
      failedRequired: items.filter(item => item.required && !item.ok), failedOptional: items.filter(item => !item.required && !item.ok) };
  }

  const getModal = () => document.querySelector(SELECTORS.modal.selector);
  const getTitleEl = modal => modal.querySelector(SELECTORS.title.selector);
  const getDescEl = modal => modal.querySelector(SELECTORS.description.selector);
  const getTaskEls = modal => [...modal.querySelectorAll(SELECTORS.taskEditor.selector)];
  const getAddTaskBtn = modal => modal.querySelector(SELECTORS.addTask.selector);
  const getDescLabel = modal => [...modal.querySelectorAll(SELECTORS.descriptionLabel.selector)].find(e => /Description|描述/i.test(e.textContent));
  // 任务及其日期、负责人：[data-qa=date] 带 empty 类表示尚未排期；[data-qa=user] 含 person_outline 表示未分配。
  function assigneeOf(row) {
    const trigger = row?.querySelector('[data-qa=user]');
    const text = trigger ? trigger.innerText.trim() : '';
    if (!text || /person_outline/.test(text)) return '';
    return text.split('\n').map(part => part.trim()).filter(Boolean).pop() || '';
  }

  function taskInfos(modal) {
    return getTaskEls(modal).map(editor => {
      const row = editor.closest('.task-row');
      const date = row?.querySelector('[data-qa=date]') || null;
      const hasDate = !!date && !date.classList.contains('empty');
      return { editor, row, text: editor.innerText.trim(), hasDate, dateText: hasDate ? date.innerText.trim() : '', assignee: assigneeOf(row) };
    }).filter(task => task.text);
  }

  function readContext(modal) {
    const title = (getTitleEl(modal)?.innerText || '').trim();
    const description = (getDescEl(modal)?.innerText || '').trim();
    const infos = taskInfos(modal);
    const tasks = infos.map(task => task.text);
    const undatedTasks = infos.filter(task => !task.hasDate).map(task => task.text);
    const team = (document.querySelector('[data-qa=team-name],header h1')?.innerText || document.title.split('|')[0]).replace(/^●\s*/, '').trim();
    return { title, description, tasks, undatedTasks, team,
      taskDetails: infos.map(task => ({ text: task.text, assignee: task.assignee, due: task.dateText })) };
  }

  // Fabriq 的任务行是懒加载的，未滚动到时只有骨架；读取前先让它们渲染，否则会漏掉已有任务。
  async function ensureTasksLoaded(modal) {
    const pending = () => [...modal.querySelectorAll('.task-row.loading')];
    if (!pending().length) return;
    const scroller = modal.querySelector('[data-qa=ticket-modal-left-panel]');
    const saved = scroller ? scroller.scrollTop : null;
    for (let i = 0; i < 24 && pending().length; i++) {
      pending()[0].scrollIntoView({ block: 'center' });
      await sleep(250);
    }
    if (scroller && saved !== null) scroller.scrollTop = saved;
    if (pending().length) throw new Error('任务列表尚未加载完成，请稍后重试');
  }

  // Fabriq 右侧栏：收起时约 65px 宽，用其自带的按钮展开 / 收起。
  const sidebarCollapsed = modal => {
    const side = modal.querySelector('.right-panel');
    return !side || side.getBoundingClientRect().width < 200;
  };
  async function setSidebar(modal, open) {
    if (open === !sidebarCollapsed(modal)) return false;
    const button = modal.querySelector(open ? '[data-qa=ticket-modal-show-history]' : '[data-qa=hide-history-feed-button]');
    if (!button) return false;
    button.click();
    await sleep(500);
    return true;
  }

  function focusEditor(node, message) {
    node.focus();
    if (document.activeElement !== node && !node.contains(document.activeElement)) throw new Error(message);
  }

  async function waitFor(fn, timeout = 3000, step = 100) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = fn();
      if (value) return value;
      if (Date.now() > end) return null;
      await sleep(step);
    }
  }

  // Tiptap 在 selectAll 后要过一个事件周期才同步选区；不等待就删除会残留旧内容，之后粘贴会与旧内容混在一起。
  async function clearEditor(el) {
    for (let i = 0; i < 6; i++) {
      document.execCommand('selectAll', false, null);
      await sleep(120);
      document.execCommand('delete', false, null);
      await sleep(150);
      if (!el.innerText.trim()) return;
    }
    throw new Error('无法清空原有内容，未写入；请手动清空后重试');
  }

  // rawHtml 用于撤销：原样写回快照里的 HTML；为空描述时只清空。
  async function writeDescription(modal, text, rawHtml) {
    const el = getDescEl(modal);
    if (!el) throw new Error('未找到描述输入框');
    focusEditor(el, '无法聚焦描述编辑器，未写入；请检查页面编辑权限');
    await clearEditor(el);
    if (rawHtml !== undefined && !String(text).trim()) { el.blur(); await sleep(500); return; }
    // 以粘贴 HTML 的方式写入，模板问题成为列表项（黑点），回答为列表内的普通段落。
    const html = rawHtml || descriptionToHtml(text);
    const data = new DataTransfer();
    data.setData('text/html', html);
    data.setData('text/plain', text);
    const paste = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    const emptyHtml = el.innerHTML;
    el.dispatchEvent(paste);
    await sleep(200);
    if (!paste.defaultPrevented && el.innerHTML === emptyHtml) document.execCommand('insertHTML', false, html);
    await sleep(300);
    el.blur();
    await sleep(500);
  }

  async function writeTitle(modal, text) {
    const el = getTitleEl(modal);
    if (!el) throw new Error('未找到标题输入框');
    focusEditor(el, '无法聚焦标题编辑器，未写入；请检查页面编辑权限');
    await clearEditor(el);
    document.execCommand('insertText', false, text);
    await sleep(300);
    el.blur();
    await sleep(600);
  }

  // 就地改写已有任务的文字（翻译）：清空后插入，失去焦点即保存。
  async function rewriteTask(modal, editor, text) {
    if (!modal.isConnected || getModal() !== modal) throw new Error('工单已关闭或切换，未继续改写任务');
    focusEditor(editor, '无法聚焦任务输入框，未改写');
    await clearEditor(editor);
    if (!document.execCommand('insertText', false, text)) throw new Error('任务输入失败，请检查页面编辑权限');
    await sleep(300);
    editor.blur();
    await sleep(1200);
  }

  // 点击 Add 会新建一个空白任务行；在该行输入后失去焦点即保存。不再按 Enter，否则 Fabriq 会额外保存一个空白任务。
  async function addTasks(modal, tasks) {
    const addBtn = getAddTaskBtn(modal);
    if (!addBtn) throw new Error('未找到「Add a task」，请先保存工单');
    const firstEmpty = () => getTaskEls(modal).find(editor => !editor.innerText.trim());
    for (const title of tasks) {
      let el = firstEmpty();
      if (!el) {
        addBtn.click();
        for (let i = 0; i < 100 && !el; i++) { await sleep(100); el = firstEmpty(); }
      }
      if (!el) throw new Error('空白任务输入框未出现，已停止以免改写已有任务');
      if (!modal.isConnected || getModal() !== modal) throw new Error('工单已关闭或切换，未继续添加任务');
      focusEditor(el, '无法聚焦任务输入框，未添加；请检查页面编辑权限');
      if (!document.execCommand('insertText', false, title)) throw new Error('任务输入失败，请检查页面编辑权限');
      await sleep(300);
      el.blur();
      await sleep(1200);
    }
  }

  // 日期按钮的 aria-label 随界面语言变化：英文 "Wednesday, November 4, 2026"，中文 "2026年11月4日星期三"。
  // 统一解析成年月日，不依赖具体语言。
  function parsePickerDate(label) {
    const zh = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(label || '');
    if (zh) return { y: +zh[1], m: +zh[2], d: +zh[3] };
    const time = Date.parse(label || '');
    if (Number.isNaN(time)) return null;
    const date = new Date(time);
    return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
  }

  // 通过 Fabriq 自带的日期选择器设置任务日期。
  // overwrite=true 时允许改写已有日期（任务调整）；否则已有日期不覆盖。
  async function setTaskDate(row, iso, { overwrite = false } = {}) {
    const holder = row?.querySelector('[data-qa=date]');
    if (!holder) throw new Error('未找到任务的日期控件');
    if (!overwrite && !holder.classList.contains('empty')) throw new Error('任务已有日期，未覆盖');
    holder.scrollIntoView({ block: 'center' });
    holder.click();
    const picker = await waitFor(() => document.querySelector('.date-picker'), 3000);
    if (!picker) throw new Error('日期选择器未打开');
    const [year, month, day] = iso.split('-').map(Number);
    let clicked = false;
    for (let i = 0; i < 24 && !clicked; i++) {
      const days = [...picker.querySelectorAll('button[aria-label]')]
        .filter(b => !b.classList.contains('f-datepicker__outside-displayed-month'))
        .map(button => ({ button, date: parsePickerDate(button.getAttribute('aria-label')) }))
        .filter(item => item.date);
      const target = days.find(({ date }) => date.y === year && date.m === month && date.d === day);
      if (target) { target.button.click(); clicked = true; break; }
      if (!days.length) throw new Error('无法识别日期选择器中的日期格式（界面语言不受支持）');
      const shown = days[0].date;
      const direction = year * 12 + month > shown.y * 12 + shown.m ? 'next' : 'previous';
      const nav = picker.querySelector(`[aria-label=datetime-picker-${direction}]`);
      if (!nav) break;
      nav.click();
      await sleep(150);
    }
    if (!clicked) throw new Error(`日期选择器中未找到 ${iso}`);
    const written = overwrite
      ? await waitFor(() => !document.querySelector('.date-picker') && !holder.classList.contains('empty'), 3000)
      : await waitFor(() => !holder.classList.contains('empty'), 3000);
    if (!written) throw new Error(`任务日期未写入（${iso}），请检查 Fabriq 页面`);
    await sleep(400);
  }

  // ───── 人员：Fabriq 的人员选择框按姓名（拼音）检索 ─────
  const optionName = option => option.innerText.trim().split('\n').map(part => part.trim()).filter(Boolean).pop() || '';
  const peopleOptions = () => [...document.querySelectorAll('[data-qa=autocomplete-option]')].map(optionName);

  async function typeInPeopleSearch(query) {
    const input = await waitFor(() => document.querySelector('[data-qa=autocomplete-search]'), 2500);
    if (!input) throw new Error('人员选择框未打开');
    input.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    if (query) document.execCommand('insertText', false, query);
    await sleep(900);
    return input;
  }

  // 借用工单顶部的负责人选择框做检索（只检索，不选择），返回匹配到的姓名。
  async function searchPeople(modal, query) {
    const trigger = modal.querySelector('[data-qa=ticket-user]');
    if (!trigger || !query.trim()) return [];
    trigger.click();
    try {
      await typeInPeopleSearch(query.trim());
      return [...new Set(peopleOptions())];
    } finally {
      const input = document.querySelector('[data-qa=autocomplete-search]');
      if (input) { input.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }
      trigger.click();
      await sleep(400);
    }
  }

  // 依次用完整拼音和各个词检索，直到有结果。
  async function findPeople(modal, pinyin) {
    const full = pinyin.trim();
    const tokens = [...new Set(full.split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
    for (const query of [full, ...tokens]) {
      const found = await searchPeople(modal, query);
      if (found.length) return found;
    }
    return [];
  }

  // 给任务行分配负责人：who 为姓名，或 'me'（Assign to myself）。
  async function setTaskAssignee(row, who) {
    const trigger = row?.querySelector('[data-qa=user]');
    if (!trigger) throw new Error('未找到任务的负责人控件');
    trigger.scrollIntoView({ block: 'center' });
    trigger.click();
    if (who === 'me') {
      const mine = await waitFor(() => [...document.querySelectorAll('.f-dropdown-content *')].find(e => e.children.length === 0 && /Assign to myself|分配给我自己|分配给自己|分配给我/i.test(e.textContent)), 2500);
      if (!mine) throw new Error('未找到「分配给我自己 / Assign to myself」');
      (mine.closest('button,[role=button],[role=menuitem],a,div') || mine).click();
    } else {
      await typeInPeopleSearch(who);
      const option = [...document.querySelectorAll('[data-qa=autocomplete-option]')].find(o => normalizeText(optionName(o)).toLowerCase() === normalizeText(who).toLowerCase());
      if (!option) {
        trigger.click();
        throw new Error(`人员检索中未找到「${who}」`);
      }
      option.click();
    }
    const changed = await waitFor(() => !document.querySelector('[data-qa=autocomplete-search]') && assigneeOf(row), 3000);
    if (!changed) throw new Error(`负责人未设置成功（${who === 'me' ? '我' : who}），请检查 Fabriq 页面`);
    await sleep(400);
  }

  // 在评论框中写入并点击发送（评论框里已有未发送内容时不覆盖）。
  async function postComment(modal, text) {
    const editor = modal.querySelector('.comment-input .ProseMirror');
    if (!editor) throw new Error('未找到评论输入框');
    if (editor.innerText.trim()) throw new Error('评论框里已有未发送的内容，请先处理后再发送');
    focusEditor(editor, '无法聚焦评论框，未发送');
    const html = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`).join('');
    const data = new DataTransfer();
    data.setData('text/html', html);
    data.setData('text/plain', text);
    const paste = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    const before = editor.innerHTML;
    editor.dispatchEvent(paste);
    await sleep(250);
    if (!paste.defaultPrevented && editor.innerHTML === before) document.execCommand('insertHTML', false, html);
    await sleep(300);
    if (!editor.innerText.trim()) throw new Error('评论内容未能写入评论框');
    const send = [...(editor.closest('.input-row') || modal).querySelectorAll('button[data-qa=icon-button]')].pop();
    if (!send) throw new Error('未找到评论发送按钮，内容已留在评论框中，请手动发送');
    send.click();
    if (!await waitFor(() => !editor.innerText.trim(), 4000)) throw new Error('评论可能未发送成功，内容仍在评论框中，请手动确认');
    await sleep(600);
  }

  globalThis.MwaFabriqPage = { SELECTORS, diagnose, query, queryAll, getModal, getTitleEl, getDescEl, getTaskEls, getAddTaskBtn, getDescLabel, assigneeOf, taskInfos, readContext, ensureTasksLoaded, sidebarCollapsed, setSidebar, focusEditor, waitFor, clearEditor, writeDescription, writeTitle, rewriteTask, addTasks, setTaskDate, searchPeople, findPeople, setTaskAssignee, postComment, sleep };
})();
