// Workday 绩效评估自动化脚本 - 状态机模式

const RATING_TEXT = '3';
const COMMENT_TEXT = '工作表现达到岗位要求，能够胜任本职工作。';
const POLL_INTERVAL = 500; // 状态轮询间隔(ms)

let isRunning = false;
let processedCount = 0;
let totalCount = 0;
let stateTimer = null;
let lastActionPage = '';
let lastPage = '';
let samePageCount = 0;
const processedIds = new Set(); // 已处理的工号
let currentEmployeeId = null;  // 当前正在处理的工号
let automationMode = 'rating';
let submitNextClickCount = 0;
let submitPhase = 'list';

// 从条目文本提取工号，如 (436908)
function extractId(text) {
  const m = text.match(/\((\d{5,7})\)/);
  return m ? m[1] : null;
}

// ── 工具函数 ──

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 等待某元素出现，最多 timeout ms
function waitFor(selector, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const ob = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { ob.disconnect(); resolve(found); }
    });
    ob.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { ob.disconnect(); reject(new Error(`waitFor timeout: ${selector}`)); }, timeout);
  });
}

// 等待某元素消失
function waitForGone(selector, timeout = 8000) {
  return new Promise((resolve) => {
    if (!document.querySelector(selector)) return resolve();
    const ob = new MutationObserver(() => {
      if (!document.querySelector(selector)) { ob.disconnect(); resolve(); }
    });
    ob.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { ob.disconnect(); resolve(); }, timeout);
  });
}

function navClick(el) { el.click(); }

function simulateClick(el) {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  el.click();
}

function mouseClick(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  ['mouseenter','mouseover','mousedown','mouseup','click'].forEach(type => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
  });
}

function findButtonByTitleOrText(labels) {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
  return buttons.find(btn => {
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
    if (btn.offsetParent === null && btn.getBoundingClientRect().width === 0) return false;
    const title = (btn.getAttribute('title') || '').trim();
    const aria = (btn.getAttribute('aria-label') || '').trim();
    const text = (btn.textContent || '').trim();
    return labels.some(label => title === label || aria === label || text === label || text.includes(label));
  });
}

function isUsableButton(btn) {
  if (!btn) return false;
  if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
  const rect = btn.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(btn);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  return true;
}

function pickBottomActionButton(buttons) {
  return buttons
    .filter(isUsableButton)
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
}

function buttonDebugLabel(btn) {
  if (!btn) return 'none';
  const rect = btn.getBoundingClientRect();
  const title = btn.getAttribute('title') || '';
  const action = btn.getAttribute('data-uxi-actionbutton-action') || '';
  const automationId = btn.getAttribute('data-automation-id') || '';
  const type = btn.getAttribute('data-automation-button-type') || '';
  const text = (btn.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return `title="${title}" action="${action}" automation="${automationId}" type="${type}" text="${text}" top=${Math.round(rect.top)}`;
}

function findNextButton() {
  const ratingNext = document.querySelector('[data-automation-id="wd-CommandButton_paginationNext"][data-uxi-actionbutton-action="wizard-next"]');
  if (isUsableButton(ratingNext)) return ratingNext;

  const buttons = Array.from(document.querySelectorAll(
    'button[data-automation-id="wd-CommandButton_paginationNext"], button[data-uxi-actionbutton-action="wizard-next"]'
  )).filter(btn => {
    const action = btn.getAttribute('data-uxi-actionbutton-action') || '';
    const automationId = btn.getAttribute('data-automation-id') || '';
    return action === 'wizard-next' || automationId === 'wd-CommandButton_paginationNext';
  });
  return pickBottomActionButton(buttons);
}

function findSubmitButton() {
  const buttons = Array.from(document.querySelectorAll(
    'button[data-uxi-actionbutton-action="bpf-submit"], button[data-automation-button-type="PRIMARY"][title="提交"], button[data-automation-button-type="PRIMARY"][title="Submit"], button[title="提交"], button[title="Submit"]'
  )).filter(btn => {
    const action = btn.getAttribute('data-uxi-actionbutton-action') || '';
    const type = btn.getAttribute('data-automation-button-type') || '';
    return action === 'bpf-submit' || type === 'PRIMARY';
  });
  return pickBottomActionButton(buttons);
}

async function clickWorkdayButton(btn, label) {
  if (!btn) return false;
  btn.scrollIntoView({ block: 'center', inline: 'center' });
  await sleep(500);
  try { btn.focus(); } catch(e) {}
  mouseClick(btn);
  await sleep(250);
  simulateClick(btn);
  await sleep(250);
  btn.click();
  log(`已触发"${label}"按钮点击`);
  return true;
}

async function clickSubmitUntilPageChanges(submitBtn) {
  const startUrl = window.location.href;
  // 从悬浮框读取重复点击次数：id=wd-auto-count
  const countInput = document.getElementById('wd-auto-count');
  const maxRetries = Math.max(1, parseInt(countInput?.value) || 1);
  for (let i = 1; i <= maxRetries; i++) {
    const btn = findSubmitButton() || submitBtn;
    if (!btn) return true;
    log(`检测到提交按钮，尝试点击 (${i}/${maxRetries})`);
    await clickWorkdayButton(btn, '提交');
    // 等待 1s，然后判断页面或提交按钮是否仍然存在
    await sleep(1000);
    const stillHasSubmit = !!findSubmitButton();
    if (!stillHasSubmit || window.location.href !== startUrl) {
      return true;
    }
  }
  // 达到最大重试次数后仍可能存在提交按钮，返回是否还存在提交按钮为失败指标
  return !findSubmitButton();
}

async function waitForNextOrSubmitButton(timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (findSubmitButton() || findNextButton()) return true;
    await sleep(500);
  }
  return false;
}

async function waitForPageChangeFrom(previousPage, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(500);
    const page = detectPage();
    if (page !== previousPage && page !== 'unknown') return page;
  }
  return detectPage();
}

// ── 页面状态检测 ──

function detectPage() {
  const richText     = document.querySelector('[contenteditable="true"]');
  const selectWidget = document.querySelector('[data-automation-id="selectWidget"]');
  const paginationNext = document.querySelector('[data-automation-id="wd-CommandButton_paginationNext"]');
  const saveDraftBtn = document.querySelector('button[title="保存备用"]');

  if (saveDraftBtn) return 'review';
  if (selectWidget) return 'rating';
  if (richText && paginationNext) return 'summary';
  if (document.querySelector('button[data-automation-id="label"][title="开始"]')) return 'start';
  if (document.querySelectorAll('[data-automation-id="inboxItemButton"]').length > 0) return 'list';
  return 'unknown';
}

// ── 各页面操作 ──

// 获取列表滚动容器
function getListContainer() {
  const btn = document.querySelector('[data-automation-id="inboxItemButton"]');
  if (!btn) return null;
  let el = btn.parentElement;
  while (el) {
    const style = window.getComputedStyle(el);
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') return el;
    el = el.parentElement;
  }
  return null;
}

async function handleList() {
  const items = Array.from(document.querySelectorAll('[data-automation-id="inboxItemButton"]'));
  if (items.length === 0) { log('❌ 找不到员工列表'); stopAutomation(); return; }
  totalCount = parseInt(document.querySelector('li[aria-setsize]')?.getAttribute('aria-setsize')) || items.length;

  // 滚到顶部，确保第一个条目可见
  const container = getListContainer();
  if (container) container.scrollTop = 0;
  await sleep(300);

  // 重新获取（滚动后虚拟列表可能重新渲染）
  const firstItem = document.querySelector('[data-automation-id="inboxItem"]');
  if (!firstItem) return;

  const id = extractId(firstItem.closest('[data-automation-id="inboxItemButton"]')?.textContent || firstItem.textContent);
  if (id && processedIds.has(id)) {
    if (automationMode === 'submit') {
      log(`⚠️ 第一条 (${id}) 刚提交过，等待列表刷新`);
      await sleep(2000);
      lastActionPage = '';
      return;
    }
    log(`⚠️ 第一个员工 (${id}) 已处理，可能排序未更新，停止`);
    stopAutomation();
    return;
  }

  currentEmployeeId = id;
  log(`→ 点击员工 (${id})`);
  firstItem.click();

  // 等待右侧预览切换
  await new Promise(resolve => {
    const check = setInterval(() => {
      const previewTitle = document.querySelector('[data-automation-id="promptOption"]');
      const previewId = previewTitle ? extractId(previewTitle.getAttribute('title') || previewTitle.textContent) : null;
      if (previewId === id) { clearInterval(check); resolve(); }
    }, 300);
    setTimeout(() => { clearInterval(check); resolve(); }, 8000);
  });
  await waitFor('button[data-automation-id="label"][title="开始"]').catch(() => {});
}

async function handleStart() {
  const btn = document.querySelector('button[data-automation-id="label"][title="开始"]');
  if (!btn) return;

  // 以右侧预览工号为准更新 currentEmployeeId
  const previewTitle = document.querySelector('[data-automation-id="promptOption"]');
  const previewId = previewTitle ? extractId(previewTitle.getAttribute('title') || previewTitle.textContent) : null;
  if (previewId) currentEmployeeId = previewId;

  log(`点击"开始" (${currentEmployeeId})`);
  simulateClick(btn);
  await waitFor('[data-automation-id="selectWidget"]').catch(() => {});
}

async function handleRating() {
  // 等待 selectWidget 完全渲染可见
  let dropdown = null;
  for (let i = 0; i < 20; i++) {
    const el = document.querySelector('[data-automation-id="selectWidget"]');
    if (el && el.offsetParent !== null) { dropdown = el; break; }
    await sleep(500);
  }
  if (!dropdown) { log('⚠️ 等待评级下拉超时'); return; }

  const selected = document.querySelector('[data-automation-id="selectSelectedOption"]');
  const alreadySet = selected && !selected.textContent.includes('选择一个') && selected.textContent.includes('3');

  if (!alreadySet) {
    window.scrollTo(0, document.body.scrollHeight);
    if (!dropdown) return;
    log('打开评级下拉');
    simulateClick(dropdown);

    // 等待选项出现
    await waitFor('[data-automation-id="selectMenuItem"], [role="option"]').catch(() => {});
    const options = Array.from(document.querySelectorAll(
      '[data-automation-id="selectMenuItem"], [role="option"], [data-automation-id*="menuItem"]'
    ));
    let target = options.find(o => o.textContent.includes('3') && o.textContent.includes('预期'));
    if (!target) target = options.find(o => o.textContent.trim().startsWith('3'));
    if (!target) { log(`❌ 找不到评级选项: ${options.slice(0,5).map(o=>o.textContent.trim()).join(' | ')}`); return; }
    log(`选择: ${target.textContent.trim()}`);
    simulateClick(target);

    // 等待下拉关闭（selectMenuItem 消失）
    await waitForGone('[data-automation-id="selectMenuItem"]');
  } else {
    log('评级已选好，直接下一步');
  }

  const nextBtn = document.querySelector('[data-automation-id="wd-CommandButton_paginationNext"][data-uxi-actionbutton-action="wizard-next"]');
  if (!nextBtn) { log('等待下一步按钮...'); return; }
  log('点击"下一步"');
  navClick(nextBtn);
  // 等待 selectWidget 消失（离开评级页）
  await waitForGone('[data-automation-id="selectWidget"]');
}

async function handleSummary() {
  // 等待富文本框完全渲染（不只是存在，还要可编辑）
  let commentBox = null;
  for (let i = 0; i < 20; i++) {
    const el = document.querySelector('[contenteditable="true"]');
    if (el && el.offsetParent !== null && el.getBoundingClientRect().height > 0) {
      commentBox = el;
      break;
    }
    await sleep(500);
  }
  if (!commentBox) { log('⚠️ 等待评语框超时，跳过'); return; }

  const current = commentBox.textContent.trim();
  if (current !== COMMENT_TEXT) {
    log('填写评语');
    commentBox.focus();
    document.execCommand('selectAll', false, null);
    await sleep(100);
    for (const char of COMMENT_TEXT) {
      commentBox.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: char, cancelable: true }));
      commentBox.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: char, cancelable: true }));
      document.execCommand('insertText', false, char);
      commentBox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
      commentBox.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: char }));
    }
    await sleep(500);

    // 切换焦点离开文本框，让 Workday 确认输入
    commentBox.dispatchEvent(new Event('blur', { bubbles: true }));
    commentBox.blur();
    await sleep(800);
  } else {
    log('评语已填写');
  }

  // 点保存
  const saveBtn = document.querySelector('button[title="保存"]');
  if (saveBtn) {
    log('点击"保存"...');
    mouseClick(saveBtn);
    await sleep(2000); // 等保存完成
  }

  await sleep(500);
  const nextBtn = document.querySelector('[data-automation-id="wd-CommandButton_paginationNext"][data-uxi-actionbutton-action="wizard-next"]');
  if (!nextBtn) { log('等待下一步按钮...'); return; }
  log('点击"下一步"');
  mouseClick(nextBtn);
  await waitForGone('[contenteditable="true"]');
}

async function handleReview() {
  const btn = document.querySelector('button[title="保存备用"]');
  if (!btn) { log('等待"保存备用"按钮...'); return; }
  log('点击"保存备用"');
  mouseClick(btn);
  processedCount++;

  if (currentEmployeeId) {
    processedIds.add(currentEmployeeId);
    log(`✅ 第 ${processedCount}/${totalCount} 个完成，工号 ${currentEmployeeId} 已记录`);
    currentEmployeeId = null;
  } else {
    log(`✅ 第 ${processedCount}/${totalCount} 个完成`);
  }
  updateUI();

  // 等待跳回列表（inboxItemButton 重新出现）
  await waitFor('[data-automation-id="inboxItemButton"]').catch(() => {});
  // 重置状态，让状态机重新从 list 开始
  lastPage = '';
  lastActionPage = '';
}

async function handleSubmitFlowStep() {
  if (!isRunning || automationMode !== 'submit') return;

  const maxCount = window._wdMaxCount || 999;
  if (processedCount >= maxCount) {
    log(`🎉 提交已完成 ${processedCount} 条，达到设定数量`);
    stopAutomation();
    return;
  }

  const page = detectPage();
  if (page !== lastPage) {
    samePageCount = 0;
    lastPage = page;
    lastActionPage = '';
    if (page !== 'unknown') log(`📍 提交流程: ${page}`);
  } else if (page !== 'unknown') {
    samePageCount++;
    if (samePageCount > 30) {
      log(`⚠️ 提交流程停留在 "${page}" 较久，请检查页面`);
      samePageCount = 0;
    }
  }

  if (page === 'list') {
    if (lastActionPage !== 'list') {
      await handleList();
      lastActionPage = 'list';
    }
  } else if (page === 'start') {
    if (lastActionPage !== 'start') {
      await handleStart();
      submitNextClickCount = 0;
      lastActionPage = 'start';
    }
  } else {
    const nextBtn = findNextButton();
    if (submitNextClickCount < 2) {
      if (nextBtn && lastActionPage !== `next-${submitNextClickCount}`) {
        const nextNumber = submitNextClickCount + 1;
        const beforePage = page;
        log(`点击"下一步" (${nextNumber}/2)`);
        await clickWorkdayButton(nextBtn, '下一步');
        await sleep(2500);
        const afterPage = await waitForPageChangeFrom(beforePage, 12000);
        if (afterPage !== beforePage || findNextButton() || findSubmitButton()) {
          submitNextClickCount = nextNumber;
          lastActionPage = `next-${submitNextClickCount}`;
          log(`已进入下一步状态: ${afterPage}`);
        } else {
          log('下一步点击后页面未推进，继续等待真实下一步按钮...');
          lastActionPage = '';
        }
      } else if (!nextBtn) {
        log(`等待"下一步"按钮 (${submitNextClickCount}/2)...`);
      }
    } else {
      const submitBtn = findSubmitButton();
      if (submitBtn) {
      log('点击"提交"');
      const submitted = await clickSubmitUntilPageChanges(submitBtn);
      if (!submitted && findSubmitButton()) {
        log('⚠️ 提交按钮仍停留在页面，继续等待下一轮检测');
        if (isRunning) stateTimer = setTimeout(handleSubmitFlowStep, 1000);
        return;
      }
      processedCount++;
      if (currentEmployeeId) {
        processedIds.add(currentEmployeeId);
        log(`✅ 已提交第 ${processedCount}/${maxCount} 条，工号 ${currentEmployeeId}`);
        currentEmployeeId = null;
      } else {
        log(`✅ 已提交第 ${processedCount}/${maxCount} 条`);
      }
      updateUI();
      if (processedCount >= maxCount) {
        await sleep(1500);
        stopAutomation();
        return;
      }
      await waitFor('[data-automation-id="inboxItemButton"]', 12000).catch(() => {});
      submitNextClickCount = 0;
      lastPage = '';
      lastActionPage = '';
      samePageCount = 0;
      await sleep(1000);
      if (isRunning) stateTimer = setTimeout(handleSubmitFlowStep, POLL_INTERVAL);
      return;
      }
      log('等待真实"提交"按钮...');
    }
  }

  if (isRunning) stateTimer = setTimeout(handleSubmitFlowStep, POLL_INTERVAL);
}

// ── 状态机主循环 ──

async function handleSubmitFlowStep() {
  if (!isRunning || automationMode !== 'submit') return;

  const maxCount = window._wdMaxCount || 999;
  if (processedCount >= maxCount) {
    log(`提交已完成 ${processedCount} 条，达到设定数量`);
    stopAutomation();
    return;
  }

  const page = detectPage();
  if (page !== lastPage) {
    samePageCount = 0;
    lastPage = page;
    if (page !== 'unknown') log(`提交流程页面: ${page}，阶段: ${submitPhase}`);
  } else if (page !== 'unknown') {
    samePageCount++;
    if (samePageCount > 30) {
      log(`提交流程停留在 "${page}" / "${submitPhase}" 较久，请检查页面`);
      samePageCount = 0;
    }
  }

  if (submitPhase === 'list') {
    if (page === 'list' || document.querySelector('[data-automation-id="inboxItem"]')) {
      await handleList();
      submitPhase = 'start';
    } else {
      log('等待列表第一条出现...');
    }
  } else if (submitPhase === 'start') {
    const startBtn = document.querySelector('button[data-automation-id="label"][title="开始"], button[data-automation-id="label"][title="Start"]');
    if (startBtn) {
      await handleStart();
      submitNextClickCount = 0;
      submitPhase = 'next1';
      await sleep(1200);
    } else {
      log('等待"开始"按钮...');
    }
  } else if (submitPhase === 'next1' || submitPhase === 'next2') {
    const nextNumber = submitPhase === 'next1' ? 1 : 2;
    const nextBtn = findNextButton();
    if (nextBtn) {
      log(`点击"下一步" (${nextNumber}/2)：${buttonDebugLabel(nextBtn)}`);
      navClick(nextBtn);
      await sleep(3500);
      submitNextClickCount = nextNumber;
      submitPhase = nextNumber === 1 ? 'next2' : 'submit';
    } else if (submitPhase === 'next2' && findSubmitButton()) {
      submitNextClickCount = 2;
      submitPhase = 'submit';
    } else {
      log(`等待底部真实"下一步"按钮 (${nextNumber}/2)...`);
    }
  } else if (submitPhase === 'submit') {
    const submitBtn = findSubmitButton();
    if (submitBtn) {
      log(`点击"提交"：${buttonDebugLabel(submitBtn)}`);
      const submitted = await clickSubmitUntilPageChanges(submitBtn);
      if (!submitted && findSubmitButton()) {
        log('提交按钮仍停留在页面，继续等待下一轮检测');
        if (isRunning) stateTimer = setTimeout(handleSubmitFlowStep, 1000);
        return;
      }

      processedCount++;
      if (currentEmployeeId) {
        processedIds.add(currentEmployeeId);
        log(`已提交第 ${processedCount}/${maxCount} 条，工号 ${currentEmployeeId}`);
        currentEmployeeId = null;
      } else {
        log(`已提交第 ${processedCount}/${maxCount} 条`);
      }
      updateUI();

      if (processedCount >= maxCount) {
        await sleep(1500);
        stopAutomation();
        return;
      }

      await waitFor('[data-automation-id="inboxItemButton"]', 12000).catch(() => {});
      submitNextClickCount = 0;
      submitPhase = 'list';
      lastPage = '';
      lastActionPage = '';
      samePageCount = 0;
      await sleep(1000);
      if (isRunning) stateTimer = setTimeout(handleSubmitFlowStep, POLL_INTERVAL);
      return;
    }

    const nextBtn = findNextButton();
    if (nextBtn) {
      log(`还未出现提交按钮，继续点击下一步：${buttonDebugLabel(nextBtn)}`);
      navClick(nextBtn);
      await sleep(3500);
    } else {
      log('等待真实"提交"按钮...');
    }
  }

  if (isRunning) stateTimer = setTimeout(handleSubmitFlowStep, POLL_INTERVAL);
}

async function stateMachineStep() {
  if (!isRunning) return;

  const page = detectPage();

  if (page !== lastPage) {
    samePageCount = 0;
    lastPage = page;
    lastActionPage = '';
    if (page !== 'unknown') log(`📍 ${page}`);
  } else if (page !== 'unknown') {
    samePageCount++;
    if (samePageCount > 20) {
      log(`⚠️ "${page}" 页停留过久，请检查`);
      samePageCount = 0;
    }
  }

  // 只用 maxCount 控制停止，移除 totalCount 判断
  const maxCount = window._wdMaxCount || 999;
  if (processedCount >= maxCount) {
    log(`🎉 已完成 ${processedCount} 个，达到设定数量`);
    stopAutomation();
    return;
  }

  if (lastActionPage !== page) {
    switch (page) {
      case 'list':    await handleList();    lastActionPage = page; break;
      case 'start':   await handleStart();   lastActionPage = page; break;
      case 'rating':  await handleRating();  lastActionPage = page; break;
      case 'summary': await handleSummary(); lastActionPage = page; break;
      case 'review':  await handleReview();  lastActionPage = page; break;
    }
  }

  if (isRunning) stateTimer = setTimeout(stateMachineStep, POLL_INTERVAL);
}

// ── 测试函数：单独测试列表选人 ──
async function testSelectNext() {
  log('🧪 测试选人开始...');

  // 1. 找滚动容器并滚到顶部
  const container = getListContainer();
  log(`滚动容器: ${container ? container.className.substring(0,30) : '未找到'}`);
  if (container) {
    container.scrollTop = 0;
    log('已滚到顶部');
    await sleep(500);
  }

  // 2. 获取第一个条目
  const items = Array.from(document.querySelectorAll('[data-automation-id="inboxItem"]'));
  log(`找到 ${items.length} 个条目`);
  if (items.length === 0) { log('❌ 没有条目'); return; }

  const first = items[0];
  const id = extractId(first.closest('[data-automation-id="inboxItemButton"]')?.textContent || first.textContent);
  log(`第一个条目工号: ${id}, 文本: ${first.textContent.trim().substring(0, 40)}`);

  // 3. 尝试点击
  log('尝试 click...');
  first.scrollIntoView({ block: 'center' });
  await sleep(300);
  first.click();
  await sleep(1000);

  // 4. 检查右侧预览是否切换
  const previewTitle = document.querySelector('[data-automation-id="promptOption"]');
  const previewId = previewTitle ? extractId(previewTitle.getAttribute('title') || previewTitle.textContent) : null;
  log(`点击后右侧预览工号: ${previewId}`);
  log(previewId === id ? '✅ 切换成功' : '❌ 切换失败，预览未变化');
}

// ── 控制函数 ──

function runAutomation() {
  if (isRunning) { log('已在运行中'); return; }
  automationMode = 'rating';
  const countInput = document.getElementById('wd-auto-count');
  const maxCount = parseInt(countInput?.value) || 999;
  isRunning = true;
  processedCount = 0;
  totalCount = 0;
  lastPage = '';
  lastActionPage = '';
  samePageCount = 0;
  processedIds.clear();
  currentEmployeeId = null;
  log(`▶ 启动，最多处理 ${maxCount} 个`);
  updateUI();

  // 先点列表第一个人，再开始状态机
  const firstItem = document.querySelector('[data-automation-id="inboxItem"]');
  if (firstItem) {
    const container = getListContainer();
    if (container) container.scrollTop = 0;
    setTimeout(() => {
      const item = document.querySelector('[data-automation-id="inboxItem"]');
      if (item) {
        const id = extractId(item.closest('[data-automation-id="inboxItemButton"]')?.textContent || item.textContent);
        currentEmployeeId = id;
        log(`→ 选择第一个员工 (${id})`);
        item.click();
      }
      setTimeout(() => {
        // 设置最大处理数量
        window._wdMaxCount = maxCount;
        stateMachineStep();
      }, 1500);
    }, 400);
  } else {
    window._wdMaxCount = maxCount;
    stateMachineStep();
  }
}

function runSubmitAutomation() {
  if (isRunning) { log('已在运行中'); return; }
  const countInput = document.getElementById('wd-auto-count');
  const maxCount = parseInt(countInput?.value) || 999;
  automationMode = 'submit';
  isRunning = true;
  processedCount = 0;
  totalCount = 0;
  lastPage = '';
  lastActionPage = '';
  samePageCount = 0;
  submitNextClickCount = 0;
  submitPhase = 'list';
  processedIds.clear();
  currentEmployeeId = null;
  window._wdMaxCount = maxCount;
  log(`▶ 启动提交自动化：最多处理 ${maxCount} 条；第一条 -> 开始 -> 下一步 -> 下一步 -> 提交`);
  updateUI();

  const firstItem = document.querySelector('[data-automation-id="inboxItem"]');
  if (firstItem) {
    const container = getListContainer();
    if (container) container.scrollTop = 0;
    setTimeout(() => {
      const item = document.querySelector('[data-automation-id="inboxItem"]');
      if (item) {
        const id = extractId(item.closest('[data-automation-id="inboxItemButton"]')?.textContent || item.textContent);
        currentEmployeeId = id;
        log(`→ 选择第一条 (${id || '无工号'})`);
        item.click();
        submitPhase = 'start';
      }
      setTimeout(handleSubmitFlowStep, 1500);
    }, 400);
  } else {
    handleSubmitFlowStep();
  }
}

function stopAutomation() {
  isRunning = false;
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  log('⏹ 已停止');
  updateUI();
}

// ── UI ──

function log(msg) {
  console.log('[Workday Auto]', msg);
  const el = document.getElementById('wd-auto-log');
  if (el) {
    const line = document.createElement('div');
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }
}

function updateUI() {
  const btn = document.getElementById('wd-auto-toggle-run');
  const submitBtn = document.getElementById('wd-auto-submit-run');
  const statusEl = document.getElementById('wd-auto-status');
  if (!btn) return;
  if (isRunning) {
    btn.textContent = automationMode === 'rating' ? '⏹ 停止' : '评分';
    btn.style.background = 'rgba(255,59,48,0.8)';
    if (submitBtn) {
      submitBtn.textContent = automationMode === 'submit' ? '⏹ 停止' : '提交';
      submitBtn.style.background = automationMode === 'submit' ? 'rgba(255,59,48,0.8)' : 'rgba(52,199,89,0.85)';
    }
  } else {
    btn.textContent = '评分';
    btn.style.background = 'linear-gradient(135deg,#667eea,#764ba2)';
    if (submitBtn) {
      submitBtn.textContent = '提交';
      submitBtn.style.background = 'rgba(52,199,89,0.85)';
    }
  }
  statusEl.textContent = isRunning ? `${automationMode === 'submit' ? '提交' : '评分'}运行中 (${processedCount}/${totalCount || '?'})` : '就绪';
  statusEl.style.color = isRunning ? '#30d158' : '#8e8e93';
}

function createPanel() {
  if (document.getElementById('wd-auto-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'wd-auto-panel';
  panel.style.cssText = `
    position:fixed;bottom:20px;right:20px;z-index:999999;
    background:rgba(30,30,30,0.95);backdrop-filter:blur(20px);
    border-radius:16px;padding:16px;width:280px;
    box-shadow:0 8px 32px rgba(0,0,0,0.4);
    font-family:-apple-system,'Microsoft YaHei',sans-serif;
    font-size:13px;color:#fff;
    border:1px solid rgba(255,255,255,0.1);
  `;
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <span style="font-weight:600;font-size:14px;">🤖 绩效评估自动化</span>
      <span id="wd-auto-status" style="font-size:12px;color:#8e8e93;">就绪</span>
    </div>
    <div style="font-size:11px;color:#8e8e93;margin-bottom:10px;line-height:1.5;">
      评分: 评级3 + 固定评语 + 保存备用<br>提交: 第一条 -> 开始 -> 下一步 -> 下一步 -> 提交
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px;">
      <button id="wd-auto-toggle-run" style="flex:1;padding:8px;border:none;border-radius:10px;
        background:linear-gradient(135deg,#667eea,#764ba2);
        color:#fff;font-size:13px;font-weight:600;cursor:pointer;">评分</button>
      <button id="wd-auto-submit-run" style="flex:1;padding:8px;border:none;border-radius:10px;
        background:rgba(52,199,89,0.85);
        color:#fff;font-size:13px;font-weight:600;cursor:pointer;">提交</button>
      <button id="wd-auto-chat-run" style="flex:1;padding:8px;border:none;border-radius:10px;
        background:linear-gradient(90deg,#ff8a65,#ff5252);
        color:#fff;font-size:13px;font-weight:600;cursor:pointer;">谈话</button>
      <input id="wd-auto-count" type="number" min="1" max="100" value="5" style="
        width:60px;padding:4px 8px;border:none;border-radius:8px;
        background:rgba(255,255,255,0.1);color:#fff;font-size:12px;text-align:center;">
    </div>
    <div id="wd-auto-chatbox" style="display:none;margin-bottom:8px;">
      <textarea id="wd-auto-chat-input" placeholder="输入消息并按发送" style="width:100%;height:60px;border-radius:8px;padding:8px;border:none;resize:none;font-size:12px;"></textarea>
      <div style="text-align:right;margin-top:6px;"><button id="wd-auto-chat-send" style="padding:6px 10px;border:none;border-radius:8px;background:#4b90ff;color:#fff;cursor:pointer">发送</button></div>
    </div>
    <div id="wd-auto-log" style="background:rgba(0,0,0,0.3);border-radius:8px;padding:8px;
      height:120px;overflow-y:auto;font-size:11px;color:#ccc;line-height:1.6;"></div>
    <div style="text-align:right;margin-top:8px;">
      <span id="wd-auto-toggle" style="font-size:11px;color:#8e8e93;cursor:pointer;">最小化</span>
    </div>
  `;
  document.body.appendChild(panel);
  // 确保面板显示在右下角并且可见（防止被拖出屏幕或隐藏）
  panel.style.display = 'block';
  panel.style.right = '20px';
  panel.style.bottom = '20px';
  panel.style.left = 'auto';
  panel.style.zIndex = '2147483647';

  document.getElementById('wd-auto-toggle-run').addEventListener('click', () => {
    if (isRunning) stopAutomation(); else runAutomation();
  });

  document.getElementById('wd-auto-submit-run').addEventListener('click', () => {
    if (isRunning) stopAutomation(); else runSubmitAutomation();
  });

  // 谈话按钮：直接查找并点击页面上的“提交”按钮（无输入）
  document.getElementById('wd-auto-chat-run').addEventListener('click', async () => {
    log('🔎 谈话按钮触发：尝试查找并点击“提交”按钮');
    const submitBtn = findSubmitButton();
    if (!submitBtn) {
      log('⚠️ 未找到提交按钮');
      return;
    }
    // 点击提交并等待1s，再检查是否仍存在提交按钮
    await clickWorkdayButton(submitBtn, '提交');
    await sleep(1000);
    const still = !!findSubmitButton();
    if (still) log('⚠️ 提交按钮仍存在（可能未生效）'); else log('✅ 已触发提交，页面已改变或提交按钮消失');
  });

  // 保留但隐藏的聊天发送处理（已停用输入行为）
  document.getElementById('wd-auto-chat-send').addEventListener('click', () => {
    log('⚠️ 谈话发送已被停用');
  });
    // 尝试把消息放到页面的可编辑区域并触发保存/发送按钮（若存在）
    const target = document.querySelector('[contenteditable="true"], textarea, input[type="text"]');
    if (target) {
      try {
        if (target instanceof HTMLElement) {
          target.focus();
          // 对 contenteditable 区域使用 execCommand 插入文本
          if (target.getAttribute && target.getAttribute('contenteditable') === 'true') {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, txt);
          } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) { target.value = txt; }
            target.dispatchEvent(new Event('input', { bubbles: true }));
          }
          // 尝试找到发送/保存按钮并点击
          const sendBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
            const t = (b.getAttribute('title') || '') + '|' + (b.getAttribute('aria-label') || '') + '|' + (b.textContent || '');
            return /发送|保存|提交|Send|Save|Submit/.test(t);
          });
          if (sendBtn) {
            mouseClick(sendBtn);
            log('✅ 已尝试发送到页面');
          } else {
            log('⚠️ 未找到发送/保存按钮，消息已填入输入区');
          }
        }
      } catch (e) {
        log('⚠️ 尝试发送消息时出错');
      }
    } else {
      log('⚠️ 未找到页面输入区域，消息保留在日志中');
    }
    const emptied = document.getElementById('wd-auto-chat-input'); if (emptied) emptied.value = '';
  });

  let minimized = false;
  document.getElementById('wd-auto-toggle').addEventListener('click', () => {
    minimized = !minimized;
    panel.querySelectorAll(':scope > div:not(:last-child)').forEach(el => {
      el.style.display = minimized ? 'none' : '';
    });
    document.getElementById('wd-auto-toggle').textContent = minimized ? '展开' : '最小化';
    panel.style.width = minimized ? 'auto' : '280px';
  });

  let isDragging = false, startX, startY, startLeft, startBottom;
  panel.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON' || e.target.id === 'wd-auto-toggle') return;
    isDragging = true;
    startX = e.clientX; startY = e.clientY;
    const r = panel.getBoundingClientRect();
    startLeft = r.left; startBottom = window.innerHeight - r.bottom;
  });
  document.addEventListener('mousemove', e => {
    if (!isDragging) return;
    panel.style.left   = (startLeft + e.clientX - startX) + 'px';
    panel.style.right  = 'auto';
    panel.style.bottom = (startBottom - (e.clientY - startY)) + 'px';
  });
  document.addEventListener('mouseup', () => { isDragging = false; });
}

chrome.runtime.onMessage.addListener(request => {
  if (request.action === 'startWorkdayAuto') { createPanel(); runAutomation(); }
  if (request.action === 'startWorkdaySubmit') { createPanel(); runSubmitAutomation(); }
  if (request.action === 'stopAllActions')   { stopAutomation(); }
});

function init() {
  const href = window.location.href.toLowerCase();
  // Show panel on any Workday-related page to ensure visibility across different domains/hosts
  if (href.includes('workday')) {
    createPanel();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
