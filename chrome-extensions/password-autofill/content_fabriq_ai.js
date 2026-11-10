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
  const scopeOf = partial => ({ title: false, description: false, tasks: false, schedule: false, ...partial });
  const FULL = scopeOf({ title: true, description: true, tasks: true });
  const PROGRESS = { ...scopeOf({}), progress: true };
  const TRANSLATE = { ...scopeOf({}), translate: true };

  const css = MwaFabriqStyle.build({ BAR_ID, PANEL_ID, COMPARE_ID });

  const DIRECTIONS = ['更简洁', '更详细', '突出风险与影响', '任务拆得更细', '任务更少更聚焦', '补充验收标准', '一周内完成', '两周内完成'];
  const DIRECTION_SETS = {
    title: ['更简短', '突出设备 / 工序', '突出问题现象', '带上批次 / 编号', '突出影响'],
    description: ['更简洁', '更详细', '突出风险与影响', '补充验收标准'],
    tasks: ['任务拆得更细', '任务更少更聚焦', '先临时措施再根治', '补充验收标准'],
    schedule: ['一周内完成', '两周内完成', '高风险优先', '每项间隔更短']
  };

  const { getModal, getTitleEl, getDescEl, getTaskEls, getAddTaskBtn, getDescLabel, assigneeOf, taskInfos, readContext, ensureTasksLoaded, sidebarCollapsed, setSidebar, focusEditor, waitFor, clearEditor, writeDescription, writeTitle, rewriteTask, addTasks, setTaskDate, searchPeople, findPeople, setTaskAssignee, postComment, sleep } = globalThis.MwaFabriqPage;
  const { requestAi } = globalThis.MwaFabriqAiClient;
  const { generateGuarded } = globalThis.MwaFabriqAiGuard;
  const Undo = globalThis.MwaFabriqUndo;
  // 统一的 AI 调用：输入清洗（隐藏凭据）、输出容错解析、不合规自动纠正重试，并带上用途记录到对话日志。
  const askAi = (messages, parse, purpose, ticket) => generateGuarded({ messages, parse,
    call: (msgs, info) => requestAi('fabriqAiGenerate', { messages: msgs, meta: { purpose, ticket, attempt: info.attempt, masked: info.masked } }) });


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
    if (scope.progress) return ['更简洁', '更详细', '评论更正式', '少建任务', '任务拆得更细', '只写评论', '补充风险与阻塞'];
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
    const progressInput = el('textarea', { rows: 3, placeholder: '开会时直接输入进展，如：换刀序号问题已定位，小王周五前验证夹具，下周三让 Daping 补 3 个批次数据；我今天更新了客户邮件' });
    progressInput.setAttribute('aria-label', '进展更新');
    const progressBtn = el('button', { className: 'mwa-btn primary', type: 'button', textContent: '分析进展并预览' });
    const progressBox = el('div', { className: 'mwa-section mwa-progress' },
      el('h3', { textContent: '进展更新' }), progressInput, progressBtn);
    const singleBtns = [titleBtn, descBtn, tasksBtn, scheduleBtn];
    const viewBtn = el('button', { className: 'mwa-menu-item mwa-view', type: 'button', textContent: '查看上次对比', hidden: true });
    const undoBtn = el('button', { className: 'mwa-menu-item', type: 'button', textContent: '撤销上次应用', hidden: true });
    const diagBtn = el('button', { className: 'mwa-menu-item', type: 'button', textContent: '页面自检', title: '检查 Fabriq 页面结构是否仍与插件匹配' });
    const logBtn = el('button', { className: 'mwa-menu-item', type: 'button', textContent: '操作记录 / AI 对话记录', title: '在插件后台查看和下载' });
    // 顶部「⋯」工具菜单：查看上次对比、撤销、自检、记录；不可用的项灰显。
    const menuBtn = el('button', { className: 'mwa-tool', type: 'button', textContent: '⋯', title: '工具：上次对比 / 撤销 / 自检 / 记录' });
    menuBtn.setAttribute('aria-haspopup', 'menu');
    menuBtn.setAttribute('aria-expanded', 'false');
    const menu = el('div', { className: 'mwa-menu', hidden: true }, viewBtn, undoBtn, diagBtn, logBtn);
    menu.setAttribute('role', 'menu');
    const setMenu = open => { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
    menuBtn.onclick = event => { event.stopPropagation(); setMenu(menu.hidden); };
    menu.addEventListener('click', () => setMenu(false));
    logBtn.onclick = () => { try { chrome.runtime.sendMessage({ action: 'openOptions' }); } catch { /* 扩展已重载 */ } };
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
    panel.addEventListener('click', event => { if (!menu.contains(event.target) && event.target !== menuBtn) setMenu(false); });
    panel.append(
      el('header', {}, el('h2', { textContent: '✨ AI 助手' }), el('span', { className: 'mwa-hbtns' }, menuBtn, closeBtn), menu),
      panelBusy,
      el('div', { className: 'mwa-body' },
        makeModule('progress', '进展与优化', '上：进展更新　下：标题 · 描述 · 任务 · 时间',
          progressBox,
          el('div', { className: 'mwa-section mwa-direction' }, el('h3', { textContent: '调整方向（进展更新、内容优化通用，可多选）' }), picker.node),
          el('div', { className: 'mwa-section mwa-optimize' }, el('h3', { textContent: '内容优化' }),
            el('div', { className: 'mwa-actions' }, ...singleBtns), fullBtn)),
        makeModule('qa', '智能问答', '信息不清楚时先提问补充',
          el('div', { className: 'mwa-msg', textContent: `AI 先提问，你回答后再生成优化结果（最多 ${MAX_QA_ROUNDS} 轮）。` }),
          el('div', { className: 'mwa-section mwa-actions' }, askBtn), qaBox),
        makeModule('translate', '翻译', '标题 · 描述 · 任务 中英互译',
          el('div', { className: 'mwa-tr' }, toEnBtn, toZhBtn),
          el('div', { className: 'mwa-msg', textContent: '已发送的评论无法翻译；写评论时可在预览里一键中英切换。' }))),
      el('footer', { className: 'mwa-status' },
        msg)
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
        const purpose = effectiveMode === 'ask' ? 'qa' : (Object.keys(scope).filter(key => scope[key]).join('+') || 'optimize');
        const { result: parsed } = await askAi(buildMessages(ctx, { direction, scope, qa: state.qa, mode: effectiveMode, previous }),
          raw => parseResult(raw, { allowQuestions, scope }), purpose, ctx.title);
        if (!toggle.isConnected || getModal() !== owner || getTitleEl(owner) !== titleElement ||
            readContext(owner).title !== ctx.title) {
          throw new Error('工单已关闭或切换，生成结果未应用；请在目标工单重新生成');
        }
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
        const { result: parsed } = await askAi(buildProgressMessages(ctx, { progressText: text, direction, previous }), parseProgress, 'progress', ctx.title);
        if (!toggle.isConnected || getModal() !== owner || getTitleEl(owner) !== titleElement || readContext(owner).title !== ctx.title) {
          throw new Error('工单已关闭或切换，生成结果未应用；请在目标工单重新生成');
        }
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
        const { result: parsed } = await askAi(buildTranslateMessages(items, { target: want, direction }),
          raw => parseTranslate(raw, { title: !!ctx.title, description: !!ctx.description, tasks: ctx.tasks.length }), `translate:${want}`, ctx.title);
        if (!toggle.isConnected || getModal() !== owner || getTitleEl(owner) !== titleElement || readContext(owner).title !== ctx.title) {
          throw new Error('工单已关闭或切换，译文未应用；请在目标工单重新翻译');
        }
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
        const { result } = await askAi(buildTranslateMessages({ comment: source }, { target }), raw => parseTranslate(raw, { comment: true }),
          `comment-translate:${target}`, state.before?.title || '');
        commentArea.value = result.comment;
        setMsg(`评论已译为${target === 'en' ? '英文' : '中文'}，可继续编辑后发送。`);
      } catch (e) {
        setMsg(e.message || String(e), true);
      } finally {
        state.busy = false;
        updateActions();
      }
    };
    progressBtn.onclick = () => { state.result = null; generateProgress(picker.value()); };
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

    // 记录本次应用（含撤销所需快照）；只有改了标题 / 描述 / 任务文字才可自动撤销。
    async function saveOperation(snap, op) {
      if (!snap || !op.applied.length) return;
      await Undo.record({ ticket: snap.title, afterTitle: op.afterTitle || snap.title, url: location.href, applied: op.applied,
        manual: op.manual, rewrites: op.rewrites, touchedTitle: op.touchedTitle, touchedDesc: op.touchedDesc,
        reversible: op.touchedTitle || op.touchedDesc || op.rewrites.length > 0, snapshot: snap });
      refreshUndo();
    }

    async function refreshUndo() {
      if (!toggle.isConnected || getModal() !== owner) return;
      undoBtn.hidden = !(await Undo.latestFor([readContext(owner).title]));
    }

    async function undoLast() {
      if (state.busy) return;
      const entry = await Undo.latestFor([readContext(owner).title]);
      if (!entry) { undoBtn.hidden = true; setMsg('没有可撤销的记录。'); return; }
      const restores = [entry.touchedTitle && '标题', entry.touchedDesc && '描述', entry.rewrites.length && `${entry.rewrites.length} 个任务文字`].filter(Boolean).join('、');
      const manual = entry.manual.length ? `\n\n以下内容无法自动撤销，需要你手动处理：\n- ${entry.manual.join('\n- ')}` : '';
      if (!confirm(`将把 ${restores} 恢复到应用之前的内容。${manual}\n\n继续撤销？`)) return;
      state.busy = true;
      updateActions();
      try {
        await ensureTasksLoaded(owner);
        const now = readContext(owner).title;
        if (now !== entry.ticket && now !== entry.afterTitle) throw new Error('当前工单与记录不一致，未撤销');
        // 先恢复任务和描述，标题最后（标题用于识别当前工单）。
        for (const item of [...entry.rewrites].reverse()) {
          const info = taskInfos(owner).find(task => normalizeText(task.text) === normalizeText(item.to));
          if (!info) throw new Error(`找不到任务「${item.to}」，未能恢复（可能已被修改）`);
          setMsg(`正在恢复任务：${item.from}`);
          await rewriteTask(owner, info.editor, item.from);
        }
        if (entry.touchedDesc) {
          setMsg('正在恢复描述…');
          await writeDescription(owner, entry.snapshot.descriptionText, entry.snapshot.descriptionHtml);
        }
        if (entry.touchedTitle) {
          setMsg('正在恢复标题…');
          await writeTitle(owner, entry.snapshot.title);
        }
        await Undo.markUndone(entry.id);
        state.result = null;
        state.expected = readContext(owner);
        state.titleElement = getTitleEl(owner);
        viewBtn.hidden = true;
        setMsg(entry.manual.length ? `已撤销 ${restores}。仍需手动处理：${entry.manual.join('；')}` : `已撤销 ${restores}。`);
      } catch (e) {
        setMsg(e.message || String(e), true);
      } finally {
        state.busy = false;
        updateActions();
        refreshUndo();
      }
    }
    undoBtn.onclick = undoLast;
    refreshUndo();

    // 自检：对照选择器表检查当前页面，缺失时指出会影响哪项功能。
    let diagTimer = null;
    diagBtn.onclick = () => {
      const report = globalThis.MwaFabriqPage.diagnose(getModal());
      const lines = [report.failedRequired.length ? `⚠ 缺少关键元素（${report.failedRequired.length}）：` : '✓ 关键元素齐全',
        ...report.failedRequired.map(item => `  ✗ ${item.feature}：${item.selector}`),
        ...(report.failedOptional.length ? [`可选元素未出现（${report.failedOptional.length}，可能只是当前工单没有）：`,
          ...report.failedOptional.map(item => `  - ${item.feature}`)] : [])];
      const text = lines.join('\n');
      setMsg(text, report.failedRequired.length > 0);
      // 10 秒后自动收起；期间若已被其他提示替换则不清除。
      clearTimeout(diagTimer);
      diagTimer = setTimeout(() => { if (msg.textContent === text) setMsg(''); }, 10000);
      chrome.storage.local.set({ mwaFabriqDiag: report });
    };

    async function run(parts) {
      if (state.busy || !state.result || !dialog.open) return;
      state.busy = true;
      let succeeded = false;
      let snap = null;
      // 本次应用的操作记录：applied = 做了什么；manual = 无法自动撤销、需要手动还原的项；rewrites = 可撤销的任务改写。
      const op = { applied: [], manual: [], rewrites: [], touchedTitle: false, touchedDesc: false };
      updateActions();
      try {
        await ensureTasksLoaded(owner);
        assertTarget(true);
        snap = Undo.snapshot(globalThis.MwaFabriqPage, owner);
        // A modal dialog makes the site editor inert; dismiss it only after explicit confirmation.
        dialog.close();
        if (parts.desc && descApplicable()) {
          setMsg('正在应用已确认的描述…');
          op.touchedDesc = true;
          op.applied.push('描述');
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
            op.applied.push(`新增任务：${title}`);
            op.manual.push(`手动删除新增的任务：${title}`);
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
            op.applied.push(`负责人：${title} → ${who}`);
            if (merge) op.manual.push(`「${title}」负责人原为：无，请手动清除`);
            await setTaskAssignee(created.row, who);
          }
          if (created && validDate(due || '') && !created.hasDate) {
            setMsg(`正在设置时间：${title}`);
            op.applied.push(`日期：${title} → ${due}`);
            if (merge) op.manual.push(`「${title}」日期原为：无，请手动清除`);
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
            op.applied.push(`负责人：${info.text} → ${who}`);
            op.manual.push(`「${info.text}」负责人原为：${info.assignee || '无'}`);
            await setTaskAssignee(info.row, who);
          }
          if (validDate(due) && info.dateText !== due) {
            setMsg(`正在调整时间：${info.text}`);
            op.applied.push(`日期：${info.text} → ${due}`);
            op.manual.push(`「${info.text}」日期原为：${info.dateText || '无'}`);
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
            const when = row.querySelector('input[type=date]').value;
            op.applied.push(`日期：${taskText} → ${when}`);
            op.manual.push(`「${taskText}」日期原为：无，请手动清除`);
            await setTaskDate(info.row, when);
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
          const rewritten = row.querySelector('input[type=text]').value.trim();
          op.applied.push(`任务改写：${info.text}`);
          op.rewrites.push({ from: info.text, to: rewritten });
          await rewriteTask(owner, info.editor, rewritten);
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
          op.touchedTitle = true;
          op.applied.push('标题');
          op.afterTitle = value;
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
          op.applied.push('发送评论');
          op.manual.push('评论已发送，无法自动撤销，请在 Fabriq 中手动删除');
        }
        setMsg('已应用，请核对 Fabriq 保存状态；已有任务未删除。可点「查看上次对比」回看。');
        succeeded = true;
      } catch (e) {
        setMsg(e.message || String(e), true);
      } finally {
        state.busy = false;
        updateActions();
        await saveOperation(snap, op);
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
