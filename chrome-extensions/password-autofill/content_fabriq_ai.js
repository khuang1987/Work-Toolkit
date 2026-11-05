// Fabriq 工单：AI 优化（标题 / 描述 / 拆分任务 / 分配时间，或一键完整优化）。
// 按钮位于 Description 标题右侧，点击展开右侧栏并显示 AI 面板（覆盖评论区，不改动页面结构）；生成后先对比，确认才写入。
(() => {
  if (window.__mwaFabriqAi) return;
  if (!globalThis.MwaFabriqAiHelpers) {
    console.error('[MWA Fabriq] 未加载 AI 辅助脚本，请重新加载扩展并刷新页面');
    return;
  }
  window.__mwaFabriqAi = true;

  const BAR_ID = 'mwa-fq-ai-bar';
  const PANEL_ID = 'mwa-fq-ai-panel';
  const COMPARE_ID = 'mwa-fq-ai-compare';
  const { buildMessages, parseResult, buildProgressMessages, parseProgress, mergeDescription, buildTranslateMessages, parseTranslate,
  detectLanguage, MAX_TRANSLATE_TITLE, findSimilarTask, diffText, normalizeText, descriptionToHtml, todayIso, MAX_QA_ROUNDS, MAX_TITLE_LENGTH } = globalThis.MwaFabriqAiHelpers;
  const cleanups = new WeakMap();
  let activeBar = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const scopeOf = partial => ({ title: false, description: false, tasks: false, schedule: false, ...partial });
  const FULL = scopeOf({ title: true, description: true, tasks: true });
  const PROGRESS = { ...scopeOf({}), progress: true };
  const TRANSLATE = { ...scopeOf({}), translate: true };

  const css = `
  #${BAR_ID}{display:inline-flex;align-items:center;margin-right:8px;flex:none}
  #${BAR_ID}[data-mode=label]{margin-left:auto;margin-right:0}
  #${BAR_ID} .mwa-ai{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;margin:0;padding:0;border:0;border-radius:50%;background:oklch(0.546 0.215 262.88);color:#fff;cursor:pointer;box-shadow:0 1px 3px #1d4ed84d;transition:filter .15s,box-shadow .15s}
  #${BAR_ID}[data-mode=label] .mwa-ai{width:28px;height:28px}
  #${BAR_ID} .mwa-ai:hover{filter:brightness(1.12)}
  #${BAR_ID} .mwa-ai:focus-visible{outline:2px solid #fff;box-shadow:0 0 0 4px oklch(0.546 0.215 262.88)}
  #${BAR_ID} .mwa-ai.on{filter:brightness(.88);box-shadow:inset 0 0 0 2px #ffffff80}
  .mwa-ui .mwa-busy{position:relative;height:4px;flex-shrink:0;overflow:hidden;background:#dbeafe}
  .mwa-ui .mwa-busy i{position:absolute;top:0;bottom:0;left:-40%;width:40%;border-radius:2px;background:linear-gradient(90deg,#2563eb,#7c3aed);animation:mwa-slide 1.1s ease-in-out infinite}
  @keyframes mwa-slide{0%{left:-40%}100%{left:100%}}
  @keyframes mwa-pulse{0%,100%{box-shadow:0 0 0 0 oklch(0.546 0.215 262.88/.55)}50%{box-shadow:0 0 0 7px oklch(0.546 0.215 262.88/0)}}
  #${BAR_ID} .mwa-ai.busy{animation:mwa-pulse 1.2s ease-out infinite}
  @media(prefers-reduced-motion:reduce){.mwa-ui .mwa-busy i{animation-duration:3s}#${BAR_ID} .mwa-ai.busy{animation:none}}
  .mwa-ui{font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;color:#1f2937;color-scheme:light}
  .mwa-ui *{box-sizing:border-box}
  .mwa-ui[hidden],.mwa-ui [hidden]{display:none!important}
  .mwa-ui .mwa-btn{border:1px solid #2563eb;background:#fff;color:#2563eb;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}
  .mwa-ui .mwa-btn.primary{background:#2563eb;color:#fff}
  .mwa-ui .mwa-btn:disabled{opacity:.5;cursor:default}
  .mwa-ui input[type=text],.mwa-ui input[type=date],.mwa-ui textarea{width:100%;border:1px solid #cbd5e1;border-radius:6px;padding:6px 8px;font:inherit;background:#fff;color:#1f2937}
  .mwa-ui input::placeholder,.mwa-ui textarea::placeholder{color:#64748b}
  .mwa-ui textarea{resize:vertical;line-height:1.6}
  .mwa-ui .mwa-row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
  .mwa-ui .mwa-msg{margin-top:6px;color:#64748b;font-size:13px}
  .mwa-ui .mwa-msg.err{color:#b91c1c}
  .mwa-ui h3{margin:0 0 8px;font-size:15px;font-weight:600}
  .mwa-ui .mwa-chips{display:flex;flex-wrap:wrap;gap:6px}
  .mwa-ui .mwa-chip{border:1px solid #cbd5e1;border-radius:14px;padding:2px 10px;cursor:pointer;background:#fff;color:#334155;font:inherit;font-size:13px}
  .mwa-ui .mwa-chip.on{background:#2563eb;border-color:#2563eb;color:#fff}
  .mwa-ui .mwa-chip:disabled{opacity:.5;cursor:default}
  .mwa-ui .mwa-other{margin-top:8px;min-height:60px}
  #${PANEL_ID}{position:absolute;z-index:20;top:72px;right:0;bottom:0;width:400px;display:flex;flex-direction:column;background:#fff;border-left:1px solid #e2e8f0;box-shadow:-6px 0 16px #0f172a14}
  #${PANEL_ID} header,#${PANEL_ID} footer{padding:10px 16px;background:#f8fafc;flex-shrink:0}
  #${PANEL_ID} header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e2e8f0}
  #${PANEL_ID} footer{border-top:1px solid #e2e8f0;padding:12px 16px 14px}
  #${PANEL_ID} h2{margin:0;font-size:16px;font-weight:600}
  #${PANEL_ID} .mwa-close{border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#475569}
  #${PANEL_ID} .mwa-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;overflow:hidden;padding:12px 14px}
  #${PANEL_ID} .mwa-status{padding:8px 14px 10px;border-top:1px solid #e2e8f0;max-height:30%;overflow:auto}
  #${PANEL_ID} .mwa-status:not(:has(.mwa-msg:not(:empty),.mwa-view:not([hidden]))){display:none}
  #${PANEL_ID} .mwa-status .mwa-msg{margin-top:2px}
  #${PANEL_ID} .mwa-section{margin-top:14px}
  #${PANEL_ID} .mwa-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  #${PANEL_ID} .mwa-mod{flex:none;display:flex;flex-direction:column;border:1px solid #cbd5e1;border-radius:12px;overflow:hidden;background:#fff}
  #${PANEL_ID} .mwa-mod.open{flex:1 1 auto;min-height:0;border-color:#2563eb;box-shadow:0 2px 10px #2563eb26}
  #${PANEL_ID} .mwa-mod-h{display:flex;width:100%;flex:none;flex-direction:row;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px;border:0;background:#f1f5f9;color:#334155;font:inherit;cursor:pointer;text-align:left}
  #${PANEL_ID} .mwa-mod:not(.open) .mwa-mod-h small{display:none}
  #${PANEL_ID} .mwa-mod:not(.open) .mwa-sign{width:20px;height:20px;font-size:16px}
  #${PANEL_ID} .mwa-mod-h:hover{background:#e2e8f0}
  #${PANEL_ID} .mwa-mod-t{display:flex;flex-direction:column;min-width:0}
  #${PANEL_ID} .mwa-mod-t b{font-weight:600;font-size:14px}
  #${PANEL_ID} .mwa-mod-h small{font-size:12px;font-weight:400;color:#64748b}
  #${PANEL_ID} .mwa-sign{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#fff;border:1px solid #94a3b8;color:#334155;font-size:18px;line-height:1;font-weight:600}
  #${PANEL_ID} .mwa-mod.open .mwa-mod-h{background:#2563eb;color:#fff}
  #${PANEL_ID} .mwa-mod.open .mwa-mod-h small{color:#dbeafe}
  #${PANEL_ID} .mwa-mod.open .mwa-sign{background:#fff;border-color:#fff;color:#2563eb}
  #${PANEL_ID} .mwa-mod-b{flex:1 1 auto;min-height:0;overflow:auto;padding:12px;overscroll-behavior:contain}
  #${PANEL_ID} .mwa-mod-b>.mwa-section:first-child,#${PANEL_ID} .mwa-mod-b>.mwa-progress{margin-top:0}
  #${PANEL_ID} .mwa-tr{display:flex;gap:8px}
  #${PANEL_ID} .mwa-tr .mwa-btn{flex:1}
  #${PANEL_ID} .mwa-act{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:9px 12px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:#1f2937;font:inherit;font-size:14px;font-weight:600;cursor:pointer;text-align:left}
  #${PANEL_ID} .mwa-act small{font-size:12px;font-weight:400;color:#64748b}
  #${PANEL_ID} .mwa-act:hover:not(:disabled){border-color:#2563eb;background:#eff6ff}
  #${PANEL_ID} .mwa-act:disabled{opacity:.5;cursor:default}
  #${PANEL_ID} .mwa-act.wide{grid-column:1/-1;flex-direction:row;align-items:center;justify-content:space-between}
  #${PANEL_ID} .mwa-big{display:block;width:100%;padding:13px 16px;border:0;border-radius:12px;background:linear-gradient(135deg,#2563eb,#4f46e5);color:#fff;font:inherit;font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 6px 16px #2563eb40}
  #${PANEL_ID} .mwa-big:hover:not(:disabled){filter:brightness(1.07)}
  #${PANEL_ID} .mwa-big:disabled{opacity:.55;cursor:default;box-shadow:none}
  #${PANEL_ID} .mwa-big small{display:block;font-size:12px;font-weight:400;opacity:.85}
  #${PANEL_ID} .mwa-qa{margin-top:14px;padding:10px;border:1px solid #c7d2fe;border-radius:8px;background:#f8faff}
  #${PANEL_ID} .mwa-question{margin-top:10px}
  #${PANEL_ID} .mwa-question textarea{min-height:56px;margin-top:4px}
  #${PANEL_ID} details{margin-top:8px;font-size:13px;color:#475569}
  #${PANEL_ID} summary{cursor:pointer;color:#2563eb}
  #${PANEL_ID} .mwa-view{margin-top:8px}
  #${COMPARE_ID}{position:fixed;inset:0;margin:auto;width:min(1120px,94vw);max-width:94vw;max-height:90vh;padding:0;border:1px solid #cbd5e1;border-radius:12px;background:#fff;box-shadow:0 20px 70px #0005}
  #${COMPARE_ID}::backdrop{background:#0f172a88}
  #${COMPARE_ID} .mwa-layout{display:flex;flex-direction:column;max-height:88vh}
  #${COMPARE_ID} header,#${COMPARE_ID} footer{padding:14px 20px;background:#f8fafc;flex-shrink:0}
  #${COMPARE_ID} header{border-bottom:1px solid #e2e8f0}
  #${COMPARE_ID} footer{border-top:1px solid #e2e8f0}
  #${COMPARE_ID} h2{margin:0;font-size:18px;font-weight:600}
  #${COMPARE_ID} .mwa-scroll{overflow:auto;padding:8px 20px 16px;overscroll-behavior:contain}
  #${COMPARE_ID} .mwa-block{margin-top:12px}
  #${COMPARE_ID} .mwa-bh{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:6px;border-bottom:1px solid #e2e8f0;margin-bottom:8px}
  #${COMPARE_ID} .mwa-bh h3{margin:0}
  #${COMPARE_ID} .mwa-bh .mwa-btn{padding:3px 12px;font-size:13px}
  #${COMPARE_ID} .mwa-cap{margin-bottom:4px;font-size:12px;color:#64748b}
  #${COMPARE_ID} .mwa-hrow{display:flex;align-items:center;justify-content:space-between}
  #${COMPARE_ID} .mwa-close{border:0;background:transparent;font-size:24px;line-height:1;cursor:pointer;color:#475569;padding:0 4px}
  #${COMPARE_ID} .mwa-end{justify-content:flex-end}
  #${COMPARE_ID} .mwa-regen{margin-bottom:6px}
  #${COMPARE_ID} .mwa-regen .mwa-chips{margin-top:2px}
  #${COMPARE_ID} .mwa-edit{min-height:44px;padding:12px;border:1px solid #93c5fd;border-radius:8px;background:#fff;white-space:pre-wrap;overflow-wrap:anywhere;outline:none;cursor:text}
  #${COMPARE_ID} .mwa-edit:focus{box-shadow:0 0 0 2px #2563eb55;border-color:#2563eb}
  #${COMPARE_ID} .mwa-edit ins{color:#166534}
  #${COMPARE_ID} .mwa-columns{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  #${COMPARE_ID} .mwa-column{min-width:0}
  #${COMPARE_ID} .mwa-column.wide{grid-column:1/-1}
  #${COMPARE_ID} .mwa-diff{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #e2e8f0;border-radius:8px;padding:12px;min-height:44px}
  #${COMPARE_ID} .mwa-diff.desc{min-height:140px}
  #${COMPARE_ID} .mwa-diff span{color:inherit}
  #${COMPARE_ID} del{background:#fee2e2;color:#991b1b;text-decoration:line-through}
  #${COMPARE_ID} ins{background:#dcfce7;color:#166534;text-decoration:none}
  #${COMPARE_ID} .mwa-task{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0;padding:6px;background:#f0fdf4;border-radius:6px}
  #${COMPARE_ID} .mwa-task>input[type=text]{flex:1 1 160px;min-width:140px;width:auto}
  #${COMPARE_ID} .mwa-dup{flex:1 0 100%;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:4px 6px;border-radius:6px;background:#fef9c3;color:#854d0e;font-size:13px}
  #${COMPARE_ID} .mwa-dup select{max-width:none;flex:1 1 260px;min-width:0}
  #${COMPARE_ID} .mwa-task[data-applied=true]{opacity:.6}
  #${COMPARE_ID} .mwa-task.sched .mwa-name{flex:1;min-width:0;overflow-wrap:anywhere}
  #${COMPARE_ID} .mwa-task.sched input[type=date]{width:150px;flex:none}
  #${COMPARE_ID} .mwa-bact{display:inline-flex;gap:8px}
  #${COMPARE_ID} .mwa-task select{flex:none;max-width:170px;padding:4px;border:1px solid #cbd5e1;border-radius:6px;font:inherit;font-size:13px;background:#fff}
  #${COMPARE_ID} .mwa-task input[type=date]{width:140px;flex:none}
  #${COMPARE_ID} .mwa-task .mwa-now{flex:none;font-size:12px;color:#64748b}
  #${COMPARE_ID} .mwa-task.upd .mwa-name{flex:1;min-width:0;overflow-wrap:anywhere}
  #${PANEL_ID} .mwa-progress textarea{width:100%;box-sizing:border-box;min-height:84px;padding:8px;border:1px solid #cbd5e1;border-radius:10px;font:inherit;font-size:14px;resize:vertical}
  #${PANEL_ID} .mwa-progress .mwa-btn{margin-top:8px;width:100%}
  #${COMPARE_ID} .mwa-edit.multi{min-height:140px}
  #${COMPARE_ID} ul{padding-left:20px}
  #${COMPARE_ID} details{margin-top:10px}
  #${COMPARE_ID} summary{cursor:pointer;color:#2563eb}
  @media(max-width:700px){#${COMPARE_ID} .mwa-columns{grid-template-columns:1fr}}`;

  const DIRECTIONS = ['更简洁', '更详细', '突出风险与影响', '任务拆得更细', '任务更少更聚焦', '补充验收标准', '一周内完成', '两周内完成'];
  const DIRECTION_SETS = {
    title: ['更简短', '突出设备 / 工序', '突出问题现象', '带上批次 / 编号', '突出影响'],
    description: ['更简洁', '更详细', '突出风险与影响', '补充验收标准'],
    tasks: ['任务拆得更细', '任务更少更聚焦', '先临时措施再根治', '补充验收标准'],
    schedule: ['一周内完成', '两周内完成', '高风险优先', '每项间隔更短']
  };

  const getModal = () => document.querySelector('.modal.is-active');
  const getTitleEl = modal => modal.querySelector('[data-qa="title"] .ProseMirror, .ticket-title .ProseMirror, .ProseMirror[data-placeholder="Add a title"]');
  const getDescEl = modal => modal.querySelector('.rich-text-editor-prosemirror');
  const getTaskEls = modal => [...modal.querySelectorAll('[data-qa=task-description] .ProseMirror')];
  const getAddTaskBtn = modal => modal.querySelector('[data-qa=add-a-new-task-placeholder]');
  const getDescLabel = modal => [...modal.querySelectorAll('[data-qa=field-label]')].find(e => /Description/i.test(e.textContent));

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

  function requestAi(action, data = {}) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ action, ...data }, res => {
          if (chrome.runtime.lastError) return reject(new Error('扩展已重载，请刷新页面'));
          if (!res || !res.ok) return reject(new Error((res && res.error) || '请求失败'));
          resolve(res.data);
        });
      } catch (e) {
        reject(new Error('扩展已重载，请刷新页面'));
      }
    });
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

  async function writeDescription(modal, text) {
    const el = getDescEl(modal);
    if (!el) throw new Error('未找到描述输入框');
    focusEditor(el, '无法聚焦描述编辑器，未写入；请检查页面编辑权限');
    await clearEditor(el);
    // 以粘贴 HTML 的方式写入，模板问题成为列表项（黑点），回答为列表内的普通段落。
    const html = descriptionToHtml(text);
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

  // 通过 Fabriq 自带的日期选择器设置任务日期（按钮 aria-label 形如 "Wednesday, November 4, 2026"）。
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
    const label = new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    let clicked = false;
    for (let i = 0; i < 24 && !clicked; i++) {
      const button = [...picker.querySelectorAll('button[aria-label]')]
        .find(b => b.getAttribute('aria-label') === label && !b.classList.contains('f-datepicker__outside-displayed-month'));
      if (button) { button.click(); clicked = true; break; }
      const shown = new Date(`${picker.querySelector('[aria-label=datetime-picker-navigation]')?.textContent.trim()} 1`);
      if (Number.isNaN(+shown)) break;
      const direction = year * 12 + month - 1 > shown.getFullYear() * 12 + shown.getMonth() ? 'next' : 'previous';
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
      const mine = await waitFor(() => [...document.querySelectorAll('.f-dropdown-content *')].find(e => e.children.length === 0 && /Assign to myself/i.test(e.textContent)), 2500);
      if (!mine) throw new Error('未找到「Assign to myself」');
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

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    children.forEach(c => node.append(c));
    return node;
  }

  // 调整方向：点击芯片切换颜色（可多选）；「其他…」展开自由输入。芯片可按功能范围切换，更有针对性。
  function makePicker(placeholder, initial = DIRECTIONS) {
    const selected = new Set();
    const other = el('textarea', { className: 'mwa-other', hidden: true, rows: 2, placeholder });
    other.setAttribute('aria-label', '其他调整方向');
    const chipsBox = el('div', { className: 'mwa-chips' });
    let chips = [];
    let disabled = false;
    const otherChip = el('button', { type: 'button', className: 'mwa-chip', textContent: '其他…' });
    otherChip.setAttribute('aria-pressed', 'false');
    otherChip.onclick = () => {
      other.hidden = !other.hidden;
      otherChip.classList.toggle('on', !other.hidden);
      otherChip.setAttribute('aria-pressed', String(!other.hidden));
      if (!other.hidden) other.focus();
    };
    function setOptions(list) {
      selected.clear();
      chips = list.map(name => {
        const chip = el('button', { type: 'button', className: 'mwa-chip', textContent: name, disabled });
        chip.setAttribute('aria-pressed', 'false');
        chip.onclick = () => {
          const on = !selected.has(name);
          if (on) selected.add(name); else selected.delete(name);
          chip.classList.toggle('on', on);
          chip.setAttribute('aria-pressed', String(on));
        };
        return chip;
      });
      chipsBox.replaceChildren(...chips, otherChip);
    }
    setOptions(initial);
    const node = el('div', {}, chipsBox, other);
    return {
      node,
      setOptions,
      value: () => [...selected, other.hidden ? '' : other.value.trim()].filter(Boolean).join('；'),
      setDisabled: value => { disabled = value; [...chips, otherChip, other].forEach(item => { item.disabled = value; }); }
    };
  }

  // 只有单一功能时给出针对该内容的调整方向；多项（完整优化）用通用方向。
  function directionsFor(scope) {
    if (scope.progress) return ['评论更简短', '评论更正式', '少建任务', '任务拆得更细', '只写评论', '补充风险与阻塞'];
    if (scope.translate) return ['更口语', '更正式', '保留专业术语不翻译', '更简短'];
    const keys = ['title', 'description', 'tasks', 'schedule'].filter(key => scope[key]);
    return keys.length === 1 ? (DIRECTION_SETS[keys[0]] || DIRECTIONS) : DIRECTIONS;
  }

  // 「优化后」只有一个可编辑框：纯文本，差异在其中以绿色高亮，输入时实时更新（光标保持）。
  function makeEditor(label, multiline) {
    const node = el('div', { className: 'mwa-edit' + (multiline ? ' multi' : ''), contentEditable: 'plaintext-only', spellcheck: false });
    node.setAttribute('role', 'textbox');
    if (multiline) node.setAttribute('aria-multiline', 'true');
    node.setAttribute('aria-label', label);
    const caretOffset = () => {
      const selection = getSelection();
      if (!selection.rangeCount || !node.contains(selection.anchorNode)) return null;
      const range = selection.getRangeAt(0).cloneRange();
      range.selectNodeContents(node);
      range.setEnd(selection.anchorNode, selection.anchorOffset);
      return range.toString().length;
    };
    const placeCaret = offset => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (remaining <= text.length) {
          const range = document.createRange();
          range.setStart(text, remaining);
          range.collapse(true);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        remaining -= text.length;
      }
    };
    Object.defineProperty(node, 'value', {
      get: () => (multiline ? node.textContent.replace(/\r/g, '') : node.textContent.replace(/\s+/g, ' ').trim()),
      set: text => { node.textContent = text; }
    });
    Object.defineProperty(node, 'disabled', {
      get: () => node.contentEditable === 'false',
      set: value => { node.contentEditable = value ? 'false' : 'plaintext-only'; }
    });
    node.paint = parts => {
      const offset = caretOffset();
      node.replaceChildren(...parts.filter(part => part.type !== 'delete')
        .map(part => el(part.type === 'insert' ? 'ins' : 'span', { textContent: part.text })));
      if (offset !== null) placeCaret(offset);
    };
    if (!multiline) node.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    return node;
  }

  // 页面语言（用于悬浮提示）：优先 <html lang>，其次浏览器语言。
  const uiLang = () => (/^zh/i.test(document.documentElement.lang || navigator.language || '') ? 'zh' : 'en');
  const TIPS = {
    zh: { open: 'AI 优化', close: '收起 AI 优化栏' },
    en: { open: 'AI optimize', close: 'Collapse AI optimize panel' }
  };
  const SPARKLE = '<svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true" focusable="false"><path fill="currentColor" d="M10 6Q11.4 11.6 17 13Q11.4 14.4 10 20Q8.6 14.4 3 13Q8.6 11.6 10 6Z"/><path fill="currentColor" d="M18.5 2.8Q19.14 5.36 21.7 6Q19.14 6.64 18.5 9.2Q17.86 6.64 15.3 6Q17.86 5.36 18.5 2.8Z"/><path fill="currentColor" d="M19 15.8Q19.44 17.56 21.2 18Q19.44 18.44 19 20.2Q18.56 18.44 16.8 18Q18.56 17.56 19 15.8Z"/></svg>';

  function buildBar(owner) {
    const state = { result: null, scope: FULL, before: null, expected: null, titleElement: null, busy: false,
      appliedDescription: null, appliedTitle: null, qa: [], pending: null, qaScope: FULL, sidebarOpened: false, toggling: false };
    const bar = el('span', { id: BAR_ID });
    // 图标按钮（无文字，便于多语言）：悬浮提示随页面语言切换中 / 英文。
    const toggle = el('button', { className: 'mwa-ai', type: 'button', innerHTML: SPARKLE });
    toggle.setAttribute('aria-expanded', 'false');
    const refreshTip = () => {
      const tip = TIPS[uiLang()][toggle.classList.contains('on') ? 'close' : 'open'];
      toggle.title = tip;
      toggle.setAttribute('aria-label', tip);
    };
    refreshTip();
    bar.append(toggle);
    bar.addEventListener('click', event => event.stopPropagation());

    // 右侧覆盖面板
    const panel = el('aside', { id: PANEL_ID, className: 'mwa-ui', hidden: true });
    panel.setAttribute('aria-label', 'AI 优化');
    const closeBtn = el('button', { className: 'mwa-close', type: 'button', textContent: '×', title: '收起' });
    closeBtn.setAttribute('aria-label', '收起 AI 优化栏');
    const picker = makePicker('补充说明（自然语言），如：突出对产能的影响，两周内完成，按先临时后根治排序');
    const qaTitle = el('h3');
    const qaHistory = el('details', { hidden: true });
    const qaQuestions = el('div');
    const submitAnswers = el('button', { className: 'mwa-btn primary', type: 'button', textContent: '提交回答' });
    const skipQa = el('button', { className: 'mwa-btn', type: 'button', textContent: '跳过，直接生成' });
    const qaBox = el('div', { className: 'mwa-qa', hidden: true }, qaTitle, qaQuestions, qaHistory,
      el('div', { className: 'mwa-row' }, submitAnswers, skipQa));
    const msg = el('div', { className: 'mwa-msg' });
    msg.setAttribute('role', 'status');
    const act = (label, hint, scope, extra) => {
      const node = el('button', { type: 'button', className: 'mwa-act' + (extra ? ` ${extra}` : '') }, label, el('small', { textContent: hint }));
      node.dataset.scope = JSON.stringify(scope);
      return node;
    };
    const titleBtn = act('优化标题', '更清晰简短', scopeOf({ title: true }));
    const descBtn = act('优化描述', '按六项模板', scopeOf({ description: true }));
    const tasksBtn = act('拆分任务', '补充新任务', scopeOf({ tasks: true }));
    const scheduleBtn = act('分配时间', '给无日期任务排期', scopeOf({ schedule: true }));
    const askBtn = el('button', { type: 'button', className: 'mwa-act wide', title: `让 AI 先提问，补全信息后再生成（最多 ${MAX_QA_ROUNDS} 轮）` },
      '问答补充', el('small', { textContent: `描述不清楚时先提问（最多 ${MAX_QA_ROUNDS} 轮）` }));
    const progressInput = el('textarea', { rows: 4, placeholder: '开会时直接输入进展，如：换刀序号问题已定位，小王周五前验证夹具，下周三让 Daping 补 3 个批次数据；我今天更新了客户邮件' });
    progressInput.setAttribute('aria-label', '进展更新');
    const progressBtn = el('button', { className: 'mwa-btn primary', type: 'button', textContent: '分析进展并预览' });
    const progressBox = el('div', { className: 'mwa-section mwa-progress' },
      el('h3', { textContent: '进展更新' }), progressInput, progressBtn);
    const singleBtns = [titleBtn, descBtn, tasksBtn, scheduleBtn];
    const viewBtn = el('button', { className: 'mwa-btn mwa-view', type: 'button', textContent: '查看上次对比', hidden: true });
    const fullBtn = el('button', { className: 'mwa-big', type: 'button' }, '✨ 完整优化', el('small', { textContent: '标题 + 描述 + 任务，一次生成并对比' }));
    // 生成中的不确定进度条（面板和对比弹窗各一条），避免界面变灰时让人误以为卡死。
    const makeBusy = () => {
      const node = el('div', { className: 'mwa-busy', hidden: true }, el('i'));
      node.setAttribute('role', 'progressbar');
      node.setAttribute('aria-label', 'AI 处理中');
      return node;
    };
    const panelBusy = makeBusy();
    const dialogBusy = makeBusy();
    const toEnBtn = el('button', { className: 'mwa-btn', type: 'button', textContent: '译为英文' });
    const toZhBtn = el('button', { className: 'mwa-btn', type: 'button', textContent: '译为中文' });
    // 四个功能模块（抽屉）：每次只展开一个，默认展开「进展更新」；收起的标题堆在展开内容的上方和下方。
    const modules = new Map();
    const openModule = key => modules.forEach((mod, name) => {
      const on = name === key;
      mod.body.hidden = !on;
      mod.section.classList.toggle('open', on);
      mod.sign.textContent = on ? '−' : '+';
      mod.head.setAttribute('aria-expanded', String(on));
    });
    const makeModule = (key, title, hint, ...content) => {
      const sign = el('span', { className: 'mwa-sign', textContent: '+' });
      sign.setAttribute('aria-hidden', 'true');
      const head = el('button', { className: 'mwa-mod-h', type: 'button' },
        el('span', { className: 'mwa-mod-t' }, el('b', { textContent: title }), el('small', { textContent: hint })), sign);
      const body = el('div', { className: 'mwa-mod-b', hidden: true }, ...content);
      head.onclick = () => openModule(key);
      const section = el('section', { className: 'mwa-mod' }, head, body);
      modules.set(key, { head, body, sign, section });
      return section;
    };
    panel.append(
      el('header', {}, el('h2', { textContent: '✨ AI 助手' }), closeBtn),
      panelBusy,
      el('div', { className: 'mwa-body' },
        makeModule('progress', '进展更新', '输入进展 → 更新任务 / 评论', progressBox),
        makeModule('optimize', '内容优化', '标题 · 描述 · 任务 · 时间',
          el('div', { className: 'mwa-actions' }, ...singleBtns),
          el('div', { className: 'mwa-section' }, el('h3', { textContent: '调整方向（可多选）' }), picker.node),
          el('div', { className: 'mwa-section' }, fullBtn)),
        makeModule('qa', '智能问答', '信息不清楚时先提问补充',
          el('div', { className: 'mwa-msg', textContent: `AI 先提问，你回答后再生成优化结果（最多 ${MAX_QA_ROUNDS} 轮）。` }),
          el('div', { className: 'mwa-section mwa-actions' }, askBtn), qaBox),
        makeModule('translate', '翻译', '标题 · 描述 · 任务 中英互译',
          el('div', { className: 'mwa-tr' }, toEnBtn, toZhBtn),
          el('div', { className: 'mwa-msg', textContent: '已发送的评论无法翻译；写评论时可在预览里一键中英切换。' }))),
      el('footer', { className: 'mwa-status' },
        msg, viewBtn)
    );
    openModule('progress');

    // 前后对比弹窗：每个区块标题右侧放对应的应用按钮；底部为取消和全部应用；右上角关闭。
    const dialog = el('dialog', { id: COMPARE_ID, className: 'mwa-ui' });
    dialog.setAttribute('aria-labelledby', 'mwa-fq-ai-compare-title');
    const originalTitle = el('div', { className: 'mwa-diff' });
    const titleInput = makeEditor('优化后的标题（可编辑）', false);
    const originalDiff = el('div', { className: 'mwa-diff desc' });
    const descArea = makeEditor('优化后的描述（可编辑）', true);
    const taskList = el('div');
    const originalTasks = el('ul');
    const scheduleList = el('div');
    const comparisonTitle = el('div', { className: 'mwa-msg' });
    const comparisonMsg = el('div', { className: 'mwa-msg' });
    comparisonMsg.setAttribute('role', 'status');
    const dialogPicker = makePicker('补充说明（自然语言），如：保留具体数据、任务更少、两周内完成');
    const regenerate = el('button', { className: 'mwa-btn', type: 'button', textContent: '重新生成' });
    const hintText = el('span', { textContent: '确认前不会修改工单' });
    const cancel = el('button', { className: 'mwa-btn', type: 'button', textContent: '取消' });
    const closeX = el('button', { className: 'mwa-close', type: 'button', textContent: '×', title: '关闭' });
    closeX.setAttribute('aria-label', '关闭对比');
    const applyTitle = el('button', { className: 'mwa-btn', type: 'button', textContent: '应用标题' });
    const applyDesc = el('button', { className: 'mwa-btn', type: 'button', textContent: '应用描述' });
    const applyTasks = el('button', { className: 'mwa-btn', type: 'button', textContent: '应用任务' });
    const applySchedule = el('button', { className: 'mwa-btn', type: 'button', textContent: '应用时间' });
    const applyAll = el('button', { className: 'mwa-btn primary', type: 'button', textContent: '全部应用' });
    const updatesList = el('div');
    const transList = el('div');
    const applyTrans = el('button', { className: 'mwa-btn', type: 'button', textContent: '应用任务翻译' });
    const commentTranslate = el('button', { className: 'mwa-btn', type: 'button', textContent: '中⇄英' });
    commentTranslate.title = '一键切换评论语言（中文 ⇄ 英文）';
    const applyUpdates = el('button', { className: 'mwa-btn', type: 'button', textContent: '应用调整' });
    const commentArea = makeEditor('评论（可编辑）', true);
    const applyComment = el('button', { className: 'mwa-btn', type: 'button', textContent: '发送评论' });
    const block = (heading, action, ...columns) => el('section', { className: 'mwa-block' },
      el('div', { className: 'mwa-bh' }, el('h3', { textContent: heading }), action),
      el('div', { className: 'mwa-columns' }, ...columns));
    const column = (caption, ...children) => el('div', { className: 'mwa-column' },
      el('div', { className: 'mwa-cap', textContent: caption }), ...children);
    const titleSection = block('任务标题', applyTitle, column('优化前', originalTitle), column('优化后（可直接编辑）', titleInput));
    const descSection = block('描述', applyDesc, column('优化前', originalDiff), column('优化后（可直接编辑）', descArea));
    const tasksSection = block('任务', applyTasks,
      column('已有任务（保留，不删除）', originalTasks), column('建议新增（可改名称、负责人、日期；疑似重复默认不勾选）', taskList));
    const scheduleSection = block('任务时间', applySchedule,
      (() => { const wide = column('建议截止日期（仅为尚无日期的任务；可修改、取消勾选）', scheduleList); wide.classList.add('wide'); return wide; })());
    [titleSection, descSection, tasksSection, scheduleSection].forEach(section => { section.hidden = true; });
    const updatesSection = block('任务调整', applyUpdates,
      (() => { const wide = column('已有任务的负责人 / 截止日期调整（可修改、取消勾选）', updatesList); wide.classList.add('wide'); return wide; })());
    const commentSection = block('评论', el('span', { className: 'mwa-bact' }, commentTranslate, applyComment),
      (() => { const wide = column('将发布到工单评论区（发送后会通知关注者）', commentArea); wide.classList.add('wide'); return wide; })());
    const transSection = block('任务翻译', applyTrans,
      (() => { const wide = column('已有任务的译文（可修改、取消勾选；将就地改写任务文字）', transList); wide.classList.add('wide'); return wide; })());
    transSection.hidden = true;
    updatesSection.hidden = true;
    commentSection.hidden = true;
    const regenBox = el('div', { className: 'mwa-regen' },
      el('div', { className: 'mwa-cap', textContent: '调整方向（针对本次内容，可多选）' }), dialogPicker.node);
    dialog.append(el('div', { className: 'mwa-layout' },
      el('header', {},
        el('div', { className: 'mwa-hrow' }, el('h2', { id: 'mwa-fq-ai-compare-title', textContent: '优化前后对比' }), closeX),
        comparisonTitle,
        el('div', { className: 'mwa-row' }, el('del', { textContent: '红色：删除 / 改写前' }),
          el('ins', { textContent: '绿色：新增 / 改写后' }),
          hintText)),
      dialogBusy,
      el('div', { className: 'mwa-scroll' }, titleSection, descSection, tasksSection, transSection, updatesSection, scheduleSection, commentSection),
      el('footer', {}, regenBox, comparisonMsg,
        el('div', { className: 'mwa-row mwa-end' }, regenerate, cancel, applyAll))
    ));

    const host = owner.querySelector('.ticket-modal') || owner;
    host.append(panel);
    document.body.append(dialog);

    // 面板固定在工单右侧，宽度不小于 400，与 Fabriq 右侧栏对齐。
    function placePanel() {
      const body = owner.querySelector('.ticket-modal__body') || owner.querySelector('.right-panel');
      const hostRect = host.getBoundingClientRect();
      if (!body || !hostRect.width) return;
      const rect = body.getBoundingClientRect();
      const side = owner.querySelector('.right-panel')?.getBoundingClientRect();
      const width = Math.min(Math.max(side?.width || 0, 400), hostRect.width * 0.6);
      const originY = hostRect.top + host.clientTop;
      Object.assign(panel.style, { top: `${rect.top - originY}px`, left: `${host.clientWidth - width}px`,
        width: `${width}px`, height: `${rect.height}px`, right: 'auto', bottom: 'auto' });
    }
    const resizeObserver = new ResizeObserver(placePanel);
    resizeObserver.observe(host);
    const side = owner.querySelector('.right-panel');
    if (side) resizeObserver.observe(side);
    window.addEventListener('resize', placePanel);
    cleanups.set(bar, () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', placePanel);
      dialog.remove();
      panel.remove();
    });

    const setMsg = (text, err) => {
      [msg, comparisonMsg].forEach(node => {
        node.textContent = text || '';
        node.className = 'mwa-msg' + (err ? ' err' : '');
      });
    };

    const has = key => !!state.result && state.result[key] !== null && state.result[key] !== undefined;
    state.people = new Map();
    state.peopleCache = new Map();
    state.teamNames = [];
    // 带缓存的人员检索（同一拼音只查一次）。
    async function lookupPeople(pinyin) {
      if (!state.peopleCache.has(pinyin)) state.peopleCache.set(pinyin, await findPeople(owner, pinyin));
      return state.peopleCache.get(pinyin);
    }
    // 把 AI 给出的负责人称呼解析成 Fabriq 真实姓名，同时收集本工单已有任务的负责人，供手动下拉选择。
    async function resolvePeople(ctx, hints) {
      state.people = new Map();
      for (const hint of hints) {
        if (!state.people.has(hint.pinyin)) state.people.set(hint.pinyin, await lookupPeople(hint.pinyin));
      }
      const team = new Set();
      for (const name of new Set(ctx.taskDetails.map(task => task.assignee).filter(Boolean))) {
        (await lookupPeople(name)).forEach(full => team.add(full));
      }
      state.teamNames = [...team];
    }
    // 负责人下拉：未指定 / 我 / Fabriq 检索到的候选 / 本工单已有负责人；只有唯一候选时才预选，避免选错人。
    function personSelect(assignee) {
      const select = el('select', { className: 'mwa-who', ariaLabel: '负责人' });
      select.append(el('option', { value: '', textContent: '未指定' }), el('option', { value: 'me', textContent: '我' }));
      let preset = '';
      const names = assignee && !assignee.me ? (state.people.get(assignee.pinyin) || []) : [];
      names.forEach(name => select.append(el('option', { value: name, textContent: name })));
      state.teamNames.filter(name => !names.includes(name)).forEach(name => select.append(el('option', { value: name, textContent: name })));
      if (assignee?.me) preset = 'me';
      else if (assignee) {
        if (names.length === 1) preset = names[0];
        else if (!names.length) select.options[0].textContent = `未找到「${assignee.text}」`;
        else select.options[0].textContent = `请选择「${assignee.text}」`;
      }
      select.value = preset;
      return select;
    }
    const rowsOf = list => [...list.querySelectorAll('.mwa-task')];
    const selectedRows = () => rowsOf(taskList)
      .filter(row => row.dataset.applied !== 'true' && row.querySelector('input[type=checkbox]').checked &&
        row.querySelector('input[type=text]').value.trim());
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= todayIso();
    const selectedSchedule = () => rowsOf(scheduleList)
      .filter(row => row.dataset.applied !== 'true' && row.querySelector('input[type=checkbox]').checked &&
        validDate(row.querySelector('input[type=date]').value));
    const titleApplicable = () => has('title') && titleInput.value.trim() &&
      Array.from(titleInput.value).length <= (state.scope?.translate ? MAX_TRANSLATE_TITLE : MAX_TITLE_LENGTH) &&
      normalizeText(titleInput.value) !== normalizeText(state.before.title) &&
      state.appliedTitle !== titleInput.value.trim();
    const descApplicable = () => has('description') && descArea.value.trim() && state.appliedDescription !== descArea.value.trim();
    const selectedTrans = () => rowsOf(transList)
      .filter(row => row.dataset.applied !== 'true' && row.querySelector('input[type=checkbox]').checked &&
        row.querySelector('input[type=text]').value.trim());
    const selectedUpdates = () => rowsOf(updatesList)
      .filter(row => row.dataset.applied !== 'true' && row.querySelector('input[type=checkbox]').checked &&
        (row.querySelector('.mwa-who').value || validDate(row.querySelector('input[type=date]').value)));
    const commentApplicable = () => has('comment') && commentArea.value.trim() && !state.commentSent;

    function updateActions() {
      const pending = !!state.pending;
      panelBusy.hidden = dialogBusy.hidden = !state.busy;
      toggle.classList.toggle('busy', !!state.busy);
      applyTitle.disabled = state.busy || !titleApplicable();
      applyDesc.disabled = state.busy || !descApplicable();
      applyTasks.disabled = state.busy || !has('tasks') || !selectedRows().length;
      applySchedule.disabled = state.busy || !has('schedule') || !selectedSchedule().length;
      applyUpdates.disabled = state.busy || !has('updates') || !selectedUpdates().length;
      applyTrans.disabled = state.busy || !has('translations') || !selectedTrans().length;
      applyComment.disabled = state.busy || !commentApplicable();
      commentTranslate.disabled = state.busy || !commentApplicable();
      applyAll.disabled = state.busy || (applyTitle.disabled && applyDesc.disabled && applyTasks.disabled && applySchedule.disabled &&
        applyUpdates.disabled && applyTrans.disabled && applyComment.disabled);
      [...singleBtns, fullBtn, progressBtn, toEnBtn, toZhBtn].forEach(button => { button.disabled = state.busy || pending; });
      progressInput.disabled = state.busy;
      askBtn.disabled = state.busy || pending || state.qa.length >= MAX_QA_ROUNDS;
      const asked = askBtn.querySelector('small');
      asked.textContent = state.qa.length ? `已问答 ${state.qa.length}/${MAX_QA_ROUNDS} 轮` : `描述不清楚时先提问（最多 ${MAX_QA_ROUNDS} 轮）`;
      [submitAnswers, skipQa, viewBtn, regenerate, cancel, closeX, descArea, titleInput, commentArea].forEach(node => { node.disabled = state.busy; });
      picker.setDisabled(state.busy);
      dialogPicker.setDisabled(state.busy);
      qaQuestions.querySelectorAll('textarea').forEach(area => { area.disabled = state.busy; });
      [taskList, scheduleList, updatesList, transList].forEach(list => rowsOf(list).forEach(row => row.querySelectorAll('input,select').forEach(input => {
        input.disabled = state.busy || row.dataset.applied === 'true';
      })));
    }

    function renderDiff() {
      if (has('description')) {
        const parts = diffText(state.before.description, descArea.value);
        originalDiff.replaceChildren(...parts.filter(part => part.type !== 'insert')
          .map(part => el(part.type === 'delete' ? 'del' : 'span', { textContent: part.text })));
        if (!state.before.description) originalDiff.append(el('span', { textContent: '（原描述为空）' }));
        descArea.paint(parts);
      }
      if (has('title')) {
        const parts = diffText(state.before.title, titleInput.value);
        originalTitle.replaceChildren(...parts.filter(part => part.type !== 'insert')
          .map(part => el(part.type === 'delete' ? 'del' : 'span', { textContent: part.text })));
        if (!state.before.title) originalTitle.append(el('span', { textContent: '（原标题为空）' }));
        // 重绘高亮（保持光标位置）；输入内容被规范化为单行。
        titleInput.paint(parts);
      }
      updateActions();
    }

    // 标题以元素身份加标题文字识别当前工单；允许在写入标题后更新标题文字。
    function assertTarget(checkContent = false) {
      if (!toggle.isConnected || getModal() !== owner || getTitleEl(owner) !== state.titleElement ||
          readContext(owner).title !== state.expected.title) {
        throw new Error('工单已关闭或切换，未继续写入；请在目标工单重新生成');
      }
      if (checkContent) {
        const current = readContext(owner);
        if (normalizeText(current.description) !== normalizeText(state.expected.description) ||
            JSON.stringify(current.tasks) !== JSON.stringify(state.expected.tasks)) {
          throw new Error('工单描述或任务在生成后已有改动，未覆盖；请重新生成对比');
        }
      }
    }

    function showComparison() {
      assertTarget();
      if (!dialog.open) dialog.showModal();
    }

    // 点击按钮展开右侧栏：Fabriq 右侧栏收起时先帮忙展开，收起 AI 栏时再还原。
    async function setPanelOpen(open) {
      if (state.toggling) return;
      state.toggling = true;
      try {
        if (open) {
          if (sidebarCollapsed(owner)) state.sidebarOpened = await setSidebar(owner, true);
          placePanel();
        } else if (state.sidebarOpened) {
          state.sidebarOpened = false;
          panel.hidden = true;
          await setSidebar(owner, false);
        }
        panel.hidden = !open;
        toggle.classList.toggle('on', open);
        toggle.setAttribute('aria-expanded', String(open));
        refreshTip();
        if (open) placePanel();
      } finally {
        state.toggling = false;
      }
    }

    toggle.onclick = () => setPanelOpen(panel.hidden);
    closeBtn.onclick = () => setPanelOpen(false);
    viewBtn.onclick = () => {
      try { showComparison(); } catch (error) { setMsg(error.message, true); }
    };
    cancel.onclick = () => {
      dialog.close();
      setMsg('未应用本次预览；已确认应用的内容不会回退。');
      viewBtn.focus();
    };
    closeX.onclick = () => cancel.click();
    [dialog, panel].forEach(node => ['keydown', 'keyup', 'keypress', 'click'].forEach(type =>
      node.addEventListener(type, event => event.stopPropagation())));
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (!state.busy) cancel.click();
    });
    descArea.addEventListener('input', event => { if (!event.isComposing) renderDiff(); });
    descArea.addEventListener('compositionend', renderDiff);
    titleInput.addEventListener('input', event => { if (!event.isComposing) renderDiff(); });
    titleInput.addEventListener('compositionend', renderDiff);
    [taskList, scheduleList].forEach(list => { list.addEventListener('input', updateActions); list.addEventListener('change', updateActions); });

    function showQuestions(questions, scope) {
      state.pending = questions;
      state.qaScope = scope;
      qaTitle.textContent = `问答补充 · 第 ${state.qa.length + 1}/${MAX_QA_ROUNDS} 轮`;
      qaQuestions.replaceChildren(...questions.map((question, index) => {
        const area = el('textarea', { rows: 2, placeholder: '请补充；不清楚可留空，不会写入描述' });
        area.setAttribute('aria-label', question);
        return el('div', { className: 'mwa-question' }, el('div', { textContent: `${index + 1}. ${question}` }), area);
      }));
      qaHistory.hidden = !state.qa.length;
      if (state.qa.length) {
        qaHistory.replaceChildren(el('summary', { textContent: `已补充的信息（${state.qa.length} 轮）` }),
          ...state.qa.flatMap(round => round.questions.map((question, index) =>
            el('div', { textContent: `问：${question} 答：${round.answers[index] || '（未回答）'}` }))));
      }
      qaBox.hidden = false;
      openModule('qa');
      setMsg('信息还不够清楚，请补充后继续；也可以跳过，不明确的项将留空。');
      qaQuestions.querySelector('textarea')?.focus();
    }

    function showResult(result, ctx, titleElement, scope) {
      state.result = result;
      state.scope = scope;
      state.before = ctx;
      state.expected = ctx;
      state.titleElement = titleElement;
      state.appliedDescription = null;
      state.appliedTitle = null;
      titleSection.hidden = !has('title');
      descSection.hidden = !has('description');
      tasksSection.hidden = !has('tasks');
      scheduleSection.hidden = !has('schedule');
      updatesSection.hidden = !has('updates');
      commentSection.hidden = !has('comment');
      transSection.hidden = !has('translations');
      transList.replaceChildren();
      (result.translations || []).forEach(item => {
        const rowNode = el('div', { className: 'mwa-task trans' }, el('input', { type: 'checkbox', checked: true, ariaLabel: '应用此译文' }),
          el('span', { className: 'mwa-now', textContent: item.task }), el('input', { type: 'text', value: item.text, ariaLabel: `${item.task} 的译文` }));
        rowNode.dataset.task = item.task;
        transList.append(rowNode);
      });
      state.commentSent = false;
      commentArea.value = result.comment || '';
      updatesList.replaceChildren();
      (result.updates || []).forEach(item => {
        const now = [item.current.assignee || '无负责人', item.current.due || '无日期'].join(' / ');
        const rowNode = el('div', { className: 'mwa-task upd' }, el('input', { type: 'checkbox', checked: true, ariaLabel: '应用此调整' }),
          el('span', { className: 'mwa-name', textContent: item.task }), el('span', { className: 'mwa-now', textContent: `现：${now}` }),
          personSelect(item.assignee), el('input', { type: 'date', value: item.due || '', min: todayIso(), ariaLabel: `${item.task} 的截止日期` }));
        rowNode.dataset.task = item.task;
        updatesList.append(rowNode);
      });
      titleInput.value = result.title || '';
      dialogPicker.setOptions(directionsFor(scope));
      hintText.textContent = has('description') ? '确认前不会修改工单；描述的模板问题应用后以列表（黑点）显示' : '确认前不会修改工单';
      descArea.value = result.description || '';
      originalTasks.replaceChildren(...(ctx.tasks.length ? ctx.tasks : ['（无已有任务）']).map(text => el('li', { textContent: text })));
      const existing = new Set(ctx.tasks.map(normalizeText));
      taskList.replaceChildren();
      const incoming = (result.taskItems || (result.tasks || []).map(task => ({ title: task }))).filter(item => !existing.has(normalizeText(item.title)));
      incoming.forEach(item => {
        // 疑似重复：优先采用 AI 指出的已有任务，其次本地相似度；默认不勾选，可选择合并到已有任务（只补负责人 / 日期，不新增）。
        const byAi = item.duplicateOf && ctx.tasks.find(task => normalizeText(task) === normalizeText(item.duplicateOf));
        const dup = byAi || findSimilarTask(item.title, ctx.tasks)?.task || '';
        const checkbox = el('input', { type: 'checkbox', checked: !dup, ariaLabel: '添加此任务' });
        const input = el('input', { type: 'text', value: item.title, ariaLabel: '建议新增任务' });
        const rowNode = el('div', { className: 'mwa-task' }, checkbox, el('span', { textContent: '+' }), input,
          personSelect(item.assignee), el('input', { type: 'date', value: item.due || '', min: todayIso(), ariaLabel: '截止日期' }));
        if (dup) {
          const mode = el('select', { className: 'mwa-mode', ariaLabel: '重复任务处理方式' },
            el('option', { value: 'merge', textContent: '合并到该任务（不新增，只补负责人 / 日期）' }), el('option', { value: 'add', textContent: '仍然新增为新任务' }));
          rowNode.dataset.dup = dup;
          rowNode.append(el('div', { className: 'mwa-dup' }, el('span', { textContent: `⚠ 疑似重复：${dup}` }), mode));
        }
        taskList.append(rowNode);
      });
      if (has('tasks') && !taskList.children.length) taskList.append(el('div', { className: 'mwa-msg', textContent: '无需新增任务，已有任务保持不变。' }));
      scheduleList.replaceChildren();
      (result.schedule || []).forEach(item => {
        const checkbox = el('input', { type: 'checkbox', checked: true, ariaLabel: '应用此日期' });
        const date = el('input', { type: 'date', value: item.due, min: todayIso(), ariaLabel: `${item.task} 的截止日期` });
        const rowNode = el('div', { className: 'mwa-task sched' }, checkbox, el('span', { className: 'mwa-name', textContent: item.task }), date);
        rowNode.dataset.task = item.task;
        scheduleList.append(rowNode);
      });
      comparisonTitle.textContent = ctx.title;
      viewBtn.hidden = false;
      qaBox.hidden = true;
      renderDiff();
      showComparison();
      setMsg('仅生成了预览，尚未修改工单。请检查高亮差异并明确确认。');
    }

    async function generate(scope, mode, direction) {
      if (state.busy || getModal() !== owner || !toggle.isConnected) return;
      state.busy = true;
      updateActions();
      setMsg('AI 处理中…');
      try {
        await ensureTasksLoaded(owner);
        const ctx = readContext(owner);
        if (!ctx.title && !ctx.description && !ctx.tasks.length) throw new Error('请先填写标题或描述');
        if (scope.schedule && !ctx.undatedTasks.length) {
          setMsg(ctx.tasks.length ? '所有任务都已有时间，无需排期。' : '还没有任务，请先点「拆分任务」或手动添加任务。');
          return;
        }
        const effectiveMode = state.qa.length >= MAX_QA_ROUNDS ? 'generate' : mode;
        const allowQuestions = !!scope.description && effectiveMode !== 'generate';
        const previous = state.result ? {
          ...(has('title') ? { title: titleInput.value.trim() } : {}),
          ...(has('description') ? { description: descArea.value } : {}),
          ...(has('tasks') ? { tasks: rowsOf(taskList).map(row => row.querySelector('input[type=text]').value.trim()).filter(Boolean) } : {}),
          ...(has('schedule') ? { schedule: rowsOf(scheduleList).map(row => ({ task: row.dataset.task, due: row.querySelector('input[type=date]').value })) } : {})
        } : null;
        const titleElement = getTitleEl(owner);
        const raw = await requestAi('fabriqAiGenerate', {
          messages: buildMessages(ctx, { direction, scope, qa: state.qa, mode: effectiveMode, previous })
        });
        if (!toggle.isConnected || getModal() !== owner || getTitleEl(owner) !== titleElement ||
            readContext(owner).title !== ctx.title) {
          throw new Error('工单已关闭或切换，生成结果未应用；请在目标工单重新生成');
        }
        const parsed = parseResult(raw, { allowQuestions, scope });
        if (parsed.type === 'questions') {
          showQuestions(parsed.questions, scope);
          return;
        }
        if (scope.schedule) {
          // 只保留与「尚无日期的任务」一一对应的建议。
          const undated = new Map(ctx.undatedTasks.map(task => [normalizeText(task), task]));
          parsed.schedule = parsed.schedule.map(item => ({ task: undated.get(normalizeText(item.task)), due: item.due })).filter(item => item.task);
          if (!parsed.schedule.length) throw new Error('AI 的排期与待排期任务不匹配，请重新生成');
        }
        if (scope.tasks && parsed.tasks?.length) {
          // 为新任务带上 AI 的负责人 / 日期建议（负责人只能来自本工单已有负责人），并解析成真实姓名。
          const meta = new Map((parsed.taskMeta || []).map(item => [normalizeText(item.task), item]));
          parsed.taskItems = parsed.tasks.map(title => {
            const item = meta.get(normalizeText(title)) || {};
            return { title, due: item.due || null, duplicateOf: item.duplicateOf || null,
              assignee: item.assignee ? { text: item.assignee, pinyin: item.assignee } : null };
          });
          setMsg('正在检索负责人…');
          await resolvePeople(ctx, parsed.taskItems.map(item => item.assignee).filter(Boolean));
          if (!toggle.isConnected || getModal() !== owner || getTitleEl(owner) !== titleElement) throw new Error('工单已关闭或切换，生成结果未应用');
        }
        showResult(parsed, ctx, titleElement, scope);
      } catch (e) {
        setMsg(e.message || String(e), true);
      } finally {
        state.busy = false;
        updateActions();
      }
    }
    async function generateProgress(direction) {
      if (state.busy || getModal() !== owner || !toggle.isConnected) return;
      const text = progressInput.value.trim();
      if (!text) { setMsg('请先输入今天的进展', true); return; }
      state.busy = true;
      updateActions();
      setMsg('AI 分析进展中…');
      try {
        await ensureTasksLoaded(owner);
        const ctx = readContext(owner);
        if (!ctx.title) throw new Error('请先打开已有标题的工单');
        const previous = state.result?.progress ? {
          ...(has('comment') ? { comment: commentArea.value.trim() } : {}),
          tasks: rowsOf(taskList).map(row => row.querySelector('input[type=text]').value.trim()).filter(Boolean)
        } : null;
        const titleElement = getTitleEl(owner);
        const raw = await requestAi('fabriqAiGenerate', { messages: buildProgressMessages(ctx, { progressText: text, direction, previous }) });
        if (!toggle.isConnected || getModal() !== owner || getTitleEl(owner) !== titleElement || readContext(owner).title !== ctx.title) {
          throw new Error('工单已关闭或切换，生成结果未应用；请在目标工单重新生成');
        }
        const parsed = parseProgress(raw);
        const known = new Map(ctx.taskDetails.map(task => [normalizeText(task.text), task]));
        const updates = parsed.updates.filter(item => known.has(normalizeText(item.task)))
          .map(item => ({ ...item, task: known.get(normalizeText(item.task)).text,
            current: { assignee: known.get(normalizeText(item.task)).assignee, due: known.get(normalizeText(item.task)).due } }));
        // 先在 Fabriq 的人员检索里把拼音解析成真实姓名，再展示预览。
        setMsg('正在检索负责人…');
        const hints = [...parsed.tasks, ...parsed.updates].map(item => item.assignee).filter(item => item && !item.me);
        await resolvePeople(ctx, hints);
        if (getModal() !== owner || getTitleEl(owner) !== titleElement) throw new Error('工单已关闭或切换，生成结果未应用');
        const today = todayIso();
        const label = `${Number(today.slice(5, 7))}/${Number(today.slice(8, 10))}`;
        const explicitDescription = /(更新|补充|修改|完善|写入|写到|加到|添加到?|记录到?).{0,6}描述|描述.{0,4}(更新|补充|修改|完善|里)/.test(text);
        const description = parsed.additions.length && explicitDescription ? mergeDescription(ctx.description, parsed.additions, label) : null;
        if (!description && !parsed.comment && !parsed.tasks.length && !updates.length) {
          throw new Error('进展中没有可写入的评论或任务（描述只在你明确要求时才会更新），请补充说明');
        }
        showResult({ progress: true, comment: parsed.comment, description, taskItems: parsed.tasks,
          tasks: parsed.tasks.length ? parsed.tasks.map(task => task.title) : null, updates: updates.length ? updates : null },
          ctx, titleElement, PROGRESS);
        setMsg('仅生成了预览，尚未修改工单。请核对负责人和日期后确认。');
      } catch (e) {
        setMsg(e.message || String(e), true);
      } finally {
        state.busy = false;
        updateActions();
      }
    }
    // 翻译标题 / 描述 / 已有任务（已发送的评论不可翻译）。target 为 null 时按标题 + 描述的当前语言自动取反。
    async function generateTranslate(target, direction) {
      if (state.busy || getModal() !== owner || !toggle.isConnected) return;
      state.busy = true;
      updateActions();
      setMsg('AI 翻译中…');
      try {
        await ensureTasksLoaded(owner);
        const ctx = readContext(owner);
        if (!ctx.title && !ctx.description && !ctx.tasks.length) throw new Error('没有可翻译的内容');
        const want = target || state.translateTarget || (detectLanguage(`${ctx.title}${ctx.description}`) === 'zh' ? 'en' : 'zh');
        state.translateTarget = want;
        const titleElement = getTitleEl(owner);
        const items = { title: ctx.title, description: ctx.description, tasks: ctx.tasks };
        const raw = await requestAi('fabriqAiGenerate', { messages: buildTranslateMessages(items, { target: want, direction }) });
        if (!toggle.isConnected || getModal() !== owner || getTitleEl(owner) !== titleElement || readContext(owner).title !== ctx.title) {
          throw new Error('工单已关闭或切换，译文未应用；请在目标工单重新翻译');
        }
        const parsed = parseTranslate(raw, { title: !!ctx.title, description: !!ctx.description, tasks: ctx.tasks.length });
        showResult({ translate: true, title: parsed.title ?? null, description: parsed.description ?? null, tasks: null,
          translations: parsed.tasks ? parsed.tasks.map((text, index) => ({ task: ctx.tasks[index], text })) : null }, ctx, titleElement, TRANSLATE);
        setMsg(`已生成${want === 'en' ? '英文' : '中文'}译文预览，尚未修改工单。`);
      } catch (e) {
        setMsg(e.message || String(e), true);
      } finally {
        state.busy = false;
        updateActions();
      }
    }
    toEnBtn.onclick = () => { state.translateTarget = 'en'; generateTranslate('en', ''); };
    toZhBtn.onclick = () => { state.translateTarget = 'zh'; generateTranslate('zh', ''); };
    // 评论一键中英切换：只翻译预览里尚未发送的评论文字。
    commentTranslate.onclick = async () => {
      if (state.busy || !commentApplicable()) return;
      state.busy = true;
      updateActions();
      setMsg('AI 翻译评论中…');
      try {
        const source = commentArea.value.trim();
        const target = detectLanguage(source) === 'zh' ? 'en' : 'zh';
        const raw = await requestAi('fabriqAiGenerate', { messages: buildTranslateMessages({ comment: source }, { target }) });
        commentArea.value = parseTranslate(raw, { comment: true }).comment;
        setMsg(`评论已译为${target === 'en' ? '英文' : '中文'}，可继续编辑后发送。`);
      } catch (e) {
        setMsg(e.message || String(e), true);
      } finally {
        state.busy = false;
        updateActions();
      }
    };
    progressBtn.onclick = () => { state.result = null; generateProgress(''); };
    progressInput.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); progressBtn.click(); }
    });
    singleBtns.forEach(button => { button.onclick = () => generate(JSON.parse(button.dataset.scope), 'auto', picker.value()); });
    fullBtn.onclick = () => generate(FULL, 'auto', picker.value());
    askBtn.onclick = () => generate(FULL, 'ask', '');
    regenerate.onclick = () => {
      if (state.scope.progress) return generateProgress(dialogPicker.value());
      if (state.scope.translate) return generateTranslate(state.translateTarget, dialogPicker.value());
      return generate(state.scope, 'generate', dialogPicker.value());
    };
    submitAnswers.onclick = () => {
      const answers = [...qaQuestions.querySelectorAll('textarea')].map(area => area.value.trim());
      if (!answers.some(Boolean)) { setMsg('请至少回答一个问题，或点击「跳过，直接生成」', true); return; }
      state.qa.push({ questions: state.pending, answers });
      state.pending = null;
      qaBox.hidden = true;
      generate(state.qaScope, 'auto', '');
    };
    skipQa.onclick = () => {
      state.pending = null;
      qaBox.hidden = true;
      generate(state.qaScope, 'generate', '');
    };

    async function run(parts) {
      if (state.busy || !state.result || !dialog.open) return;
      state.busy = true;
      let succeeded = false;
      updateActions();
      try {
        await ensureTasksLoaded(owner);
        assertTarget(true);
        // A modal dialog makes the site editor inert; dismiss it only after explicit confirmation.
        dialog.close();
        if (parts.desc && descApplicable()) {
          setMsg('正在应用已确认的描述…');
          await writeDescription(owner, descArea.value.trim());
          assertTarget();
          const current = readContext(owner);
          state.expected = current;
          if (current.description.replace(/\s+/g, '') !== descArea.value.trim().replace(/\s+/g, '')) {
            throw new Error('描述写入后与预览不一致（页面内容已变化），请核对 Fabriq 描述；可再次点「应用描述」重新写入');
          }
          state.appliedDescription = descArea.value.trim();
        }
        const rows = parts.tasks && has('tasks') ? selectedRows() : [];
        for (const row of rows) {
          assertTarget(true);
          const merge = row.dataset.dup && row.querySelector('.mwa-mode')?.value === 'merge';
          // 合并：不新增任务，只给疑似重复的已有任务补负责人 / 日期（已有的不覆盖）。
          const title = merge ? row.dataset.dup : row.querySelector('input[type=text]').value.trim();
          if (!merge && !readContext(owner).tasks.some(task => normalizeText(task) === normalizeText(title))) {
            setMsg(`正在添加已确认的任务：${title}`);
            await addTasks(owner, [title]);
            assertTarget();
            if (!readContext(owner).tasks.some(task => normalizeText(task) === normalizeText(title))) {
              throw new Error('任务未出现在页面中，请检查保存状态后再继续');
            }
          }
          row.dataset.applied = 'true';
          row.querySelector('input[type=checkbox]').checked = false;
          state.expected = readContext(owner);
          const who = row.querySelector('.mwa-who')?.value;
          const due = row.querySelector('input[type=date]')?.value;
          const created = taskInfos(owner).find(task => normalizeText(task.text) === normalizeText(title));
          if (created && who && !created.assignee) {
            setMsg(`正在分配负责人：${title}`);
            await setTaskAssignee(created.row, who);
          }
          if (created && validDate(due || '') && !created.hasDate) {
            setMsg(`正在设置时间：${title}`);
            await setTaskDate(created.row, due);
          }
        }
        const updateRows = parts.updates && has('updates') ? selectedUpdates() : [];
        for (const row of updateRows) {
          assertTarget(true);
          const info = taskInfos(owner).find(task => normalizeText(task.text) === normalizeText(row.dataset.task));
          if (!info) throw new Error(`页面上找不到任务「${row.dataset.task}」，未调整`);
          const who = row.querySelector('.mwa-who').value;
          const due = row.querySelector('input[type=date]').value;
          if (who && (who === 'me' || normalizeText(info.assignee) !== normalizeText(who))) {
            setMsg(`正在调整负责人：${info.text}`);
            await setTaskAssignee(info.row, who);
          }
          if (validDate(due) && info.dateText !== due) {
            setMsg(`正在调整时间：${info.text}`);
            await setTaskDate(info.row, due, { overwrite: true });
          }
          row.dataset.applied = 'true';
          row.querySelector('input[type=checkbox]').checked = false;
        }
        const scheduleRows = parts.schedule && has('schedule') ? selectedSchedule() : [];
        for (const row of scheduleRows) {
          assertTarget(true);
          const taskText = row.dataset.task;
          const info = taskInfos(owner).find(task => normalizeText(task.text) === normalizeText(taskText));
          if (!info) throw new Error(`页面上找不到任务「${taskText}」，未设置时间`);
          if (info.hasDate) {
            setMsg(`任务「${taskText}」已有日期，已跳过`);
          } else {
            setMsg(`正在设置时间：${taskText}`);
            await setTaskDate(info.row, row.querySelector('input[type=date]').value);
          }
          row.dataset.applied = 'true';
          row.querySelector('input[type=checkbox]').checked = false;
        }
        const transRows = parts.translations && has('translations') ? selectedTrans() : [];
        for (const row of transRows) {
          assertTarget(true);
          const info = taskInfos(owner).find(task => normalizeText(task.text) === normalizeText(row.dataset.task));
          if (!info) throw new Error(`页面上找不到任务「${row.dataset.task}」，未翻译`);
          setMsg(`正在翻译任务：${info.text}`);
          await rewriteTask(owner, info.editor, row.querySelector('input[type=text]').value.trim());
          assertTarget();
          state.expected = readContext(owner);
          row.dataset.applied = 'true';
          row.querySelector('input[type=checkbox]').checked = false;
        }
        // 标题最后写入：标题文字用于识别当前工单，写入后更新识别信息。
        if (parts.title && titleApplicable()) {
          assertTarget(true);
          const value = titleInput.value.replace(/\s+/g, ' ').trim();
          setMsg('正在应用已确认的标题…');
          await writeTitle(owner, value);
          if (!toggle.isConnected || getModal() !== owner) throw new Error('工单已关闭或切换，请核对标题保存状态');
          const current = readContext(owner);
          if (normalizeText(current.title) !== value) throw new Error('标题写入后与预览不一致，请检查 Fabriq 编辑器');
          state.appliedTitle = titleInput.value.trim();
          state.titleElement = getTitleEl(owner);
          state.expected = current;
        }
        if (parts.comment && commentApplicable()) {
          assertTarget();
          setMsg('正在发送评论…');
          await postComment(owner, commentArea.value.trim());
          state.commentSent = true;
        }
        setMsg('已应用，请核对 Fabriq 保存状态；已有任务未删除。可点「查看上次对比」回看。');
        succeeded = true;
      } catch (e) {
        setMsg(e.message || String(e), true);
      } finally {
        state.busy = false;
        updateActions();
        // 成功后保持对比页关闭，直接查看页面上的结果；失败时重新打开以便看到错误并重试。
        if (!succeeded && toggle.isConnected && getModal() === owner && getTitleEl(owner) === state.titleElement &&
            readContext(owner).title === state.expected.title && !dialog.open) showComparison();
      }
    }
    applyTitle.onclick = () => run({ title: true });
    applyDesc.onclick = () => run({ desc: true });
    applyTasks.onclick = () => run({ tasks: true });
    applySchedule.onclick = () => run({ schedule: true });
    applyUpdates.onclick = () => run({ updates: true });
    applyTrans.onclick = () => run({ translations: true });
    applyComment.onclick = () => run({ comment: true });
    applyAll.onclick = () => run({ title: true, desc: true, tasks: true, schedule: true, updates: true, translations: true, comment: true });
    transList.addEventListener('input', updateActions);
    transList.addEventListener('change', updateActions);
    commentArea.addEventListener('input', updateActions);
    updatesList.addEventListener('input', updateActions);
    updatesList.addEventListener('change', updateActions);
    updateActions();
    return bar;
  }

  // 放在工单 ID 左侧（与 Archive 等页面按钮同高同色系）；没有 ID（未保存工单）时退回 Description 标题行右侧。
  function placement(modal) {
    const chip = modal.querySelector('[data-qa=ticket-id-chip]');
    const idBox = chip && (chip.parentElement?.matches('.f-stack') ? chip.parentElement : chip);
    if (idBox?.parentElement) return { host: idBox.parentElement, before: idBox, mode: 'header' };
    const label = getDescLabel(modal);
    return label ? { host: label, before: null, mode: 'label' } : null;
  }

  function ensureBar() {
    if (!document.getElementById('mwa-fq-ai-style')) {
      document.head.append(el('style', { id: 'mwa-fq-ai-style', textContent: css }));
    }
    const modal = getModal();
    const existing = activeBar || document.getElementById(BAR_ID);
    const spot = modal && placement(modal);
    if (!modal || !spot || !getDescEl(modal) || !getTitleEl(modal)) {
      if (existing) { cleanups.get(existing)?.(); existing.remove(); }
      activeBar = null;
      return;
    }
    const placed = existing && existing.parentElement === spot.host && (!spot.before || existing.nextSibling === spot.before);
    if (placed) return;
    if (existing && existing.isConnected && spot.host.contains(existing) && modal.contains(existing)) {
      // 仅位置变化（页面重排）：就地移动，保留面板状态。
      spot.host.insertBefore(existing, spot.before);
      existing.dataset.mode = spot.mode;
      return;
    }
    if (existing) { cleanups.get(existing)?.(); existing.remove(); }
    activeBar = buildBar(modal);
    activeBar.dataset.mode = spot.mode;
    spot.host.insertBefore(activeBar, spot.before);
  }

  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(ensureBar, 300);
  }).observe(document.body, { childList: true, subtree: true });
  ensureBar();
})();
