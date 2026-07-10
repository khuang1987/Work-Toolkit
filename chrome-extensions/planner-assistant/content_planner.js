// [Planner Assistant v1.2.0]
console.log("[Planner Assistant v1.2.0] Content Script Injected");

// --- Top Help Bar ---
function updateTopBar() {
    let bar = document.getElementById('planner-assistant-indicator');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'planner-assistant-indicator';
        document.body.appendChild(bar);
    }
    bar.innerHTML = `
        <span id="pa-version-tag">Assist v1.2.0</span>
        <span id="pa-help-text">
            [↓/↑]:卡片 | [1/2]:截止+1w/2w | [S]:开始(今) | [0]:重置
        </span>
    `;
}
updateTopBar();

// --- State ---
let currentTaskCard = null;
window._lastClickedTask = null;

const CONFIG = {
    selectors: {
        taskCard: '[role="dialog"], .task-details-pane, .ms-Panel-main, .taskEditPage',
        card: '.task-card, [role="listitem"]',
        bucket: '.bucket-column, .planner-bucket, [role="list"]',
        moveTargetPlan: 'TIER 3' // More flexible match
    }
};

// --- Helpers ---

function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
}

function parseDate(dateStr) {
    if (!dateStr) return new Date();
    const clean = dateStr.replace(/[^0-9/-]/g, '/');
    const d = new Date(clean);
    return isNaN(d.getTime()) ? new Date() : d;
}

function setNativeValue(element, value) {
    const lastValue = element.value;
    element.value = value;
    let tracker = element._valueTracker;
    if (tracker) tracker.setValue(lastValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
}

function findLabelElement(container, text) {
    const elements = Array.from(container.querySelectorAll('label, span, div, h3'));
    return elements.find(el => (el.innerText.trim() === text || el.innerText.trim().includes(text)) && el.children.length === 0);
}

// --- Injection ---

const observer = new MutationObserver(() => {
    const dialog = document.querySelector(CONFIG.selectors.taskCard);
    if (dialog && (dialog !== currentTaskCard || !dialog.querySelector('.pa-upgrade-t3-btn'))) {
        currentTaskCard = dialog;
        setTimeout(() => {
            injectInlineButtons(dialog);
            injectUpgradeButton(dialog);
            autoFillCompletedTaskDates(dialog);
        }, 600);
    } else if (!dialog) {
        currentTaskCard = null;
    }
});
observer.observe(document.body, { childList: true, subtree: true });

function injectInlineButtons(container) {
    const labels = ['开始日期', '截止日期', 'Start date', 'Due date'];
    labels.forEach(lText => {
        const label = findLabelElement(container, lText);
        if (label && label.parentElement) {
            const inputContainer = label.parentElement.querySelector('.ms-TextField-wrapper') || label.parentElement;
            const input = inputContainer.querySelector('input');
            if (input && !inputContainer.parentElement.querySelector('.pa-inline-btn-row')) {
                const row = document.createElement('div');
                row.className = 'pa-inline-btn-row';
                [{ l: '-2', v: -2 }, { l: '-1', v: -1 }, { l: '今', v: 0, c: 'today' }, { l: '+1', v: 1 }, { l: '+2', v: 2 }].forEach(opt => {
                    const btn = document.createElement('button');
                    btn.className = 'pa-inline-date-btn' + (opt.c ? ' ' + opt.c : '');
                    btn.innerText = opt.l;
                    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); offsetDateInInput(input, opt.v, opt.l === '今'); };
                    row.appendChild(btn);
                });
                inputContainer.insertAdjacentElement('afterend', row);
            }
        }
    });
}

/**
 * 修复注入位置：将按钮放入 Task Dialog 的 Header
 */
function injectUpgradeButton(container) {
    if (container.querySelector('.pa-upgrade-t3-btn')) return;

    // Try to find a header container (Fluent UI Ms-Panel header)
    const headerTitle = container.querySelector('.ms-Panel-headerText, h2, [role="heading"]');
    if (headerTitle) {
        console.log("[Planner Assistant] Found header, injecting Upgrade button");
        const btn = document.createElement('button');
        btn.className = 'pa-upgrade-t3-btn';
        btn.innerText = '🚀 升级 T3';
        btn.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            upgradeTask(container);
        };
        // Insert it right after the title text or in the same header row
        headerTitle.parentElement.appendChild(btn);
    } else {
        // Fallback for different layouts
        const topBar = container.querySelector('.ms-Panel-navigation, .ms-Panel-commands');
        if (topBar) {
            const btn = document.createElement('button');
            btn.className = 'pa-upgrade-t3-btn';
            btn.innerText = '🚀 升级 T3';
            btn.onclick = (e) => { upgradeTask(container); };
            topBar.prepend(btn);
        }
    }
}

// --- Logic ---

async function upgradeTask(container) {
    showToast("正在执行 T3 升级流程...");

    // 1. Find the '...' menu button
    const moreBtn = container.querySelector('button[aria-label*="More"], button[aria-label*="更多"], .close-button + button, .ms-Panel-navigation button:last-child');
    if (!moreBtn) {
        showToast("未找到 '...' 菜单");
        return;
    }

    moreBtn.click();
    await new Promise(r => setTimeout(r, 600));

    // 2. Find 'Move task' in the context menu
    const moveItem = Array.from(document.querySelectorAll('button, .ms-ContextualMenu-itemText'))
        .find(el => el.innerText.includes('移动任务') || el.innerText.includes('Move task'));

    if (!moveItem) {
        showToast("未找到 '移动任务' 选项");
        return;
    }

    moveItem.click();
    await new Promise(r => setTimeout(r, 1000)); // Wait for dialog to open

    // 3. Select Plan
    const moveDialog = document.querySelector('[role="dialog"], .ms-Dialog-main');
    if (moveDialog) {
        console.log("[Planner Assistant] Move dialog detected");
        const planDropdown = moveDialog.querySelector('[role="combobox"]');
        if (planDropdown) {
            planDropdown.click();
            await new Promise(r => setTimeout(r, 800)); // Wait for options list

            const options = Array.from(document.querySelectorAll('[role="option"], .ms-Dropdown-item'));
            const target = options.find(opt => opt.innerText.includes('TIER 3') || opt.innerText.includes('Tier 3'));

            if (target) {
                target.click();
                showToast("已选中 T3 目标，正在确认...");
                await new Promise(r => setTimeout(r, 800));

                // 4. Click Move button
                const confirmBtn = Array.from(moveDialog.querySelectorAll('button'))
                    .find(b => b.innerText.includes('移动') || b.innerText.includes('Move') || b.classList.contains('ms-Button--primary'));

                if (confirmBtn) {
                    confirmBtn.click();
                    showToast("升级成功！任务已移至 T3");
                }
            } else {
                showToast("计划列表中未找到 TIER 3 看板");
            }
        }
    }
}

async function offsetDateInInput(input, days, isStrictToday = false) {
    let baseDate = isStrictToday || !input.value ? new Date() : parseDate(input.value);
    if (!isStrictToday) baseDate.setDate(baseDate.getDate() + days);
    const newStr = formatDate(baseDate);
    input.focus();
    setNativeValue(input, newStr);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    showToast(`日期更新: ${newStr}`);
    await setProgressInProgress(currentTaskCard);
}

async function smartSetDueDate(container, days) {
    const startLabel = findLabelElement(container, '开始日期') || findLabelElement(container, 'Start date');
    if (startLabel && startLabel.parentElement) {
        const startInput = startLabel.parentElement.querySelector('input') || startLabel.parentElement.nextElementSibling?.querySelector('input');
        if (startInput && !startInput.value) { setDate(container, '开始日期', 0); await new Promise(r => setTimeout(r, 500)); }
    }
    setDate(container, '截止日期', days);
}

function setDate(container, labelText, daysFromNow) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + daysFromNow);
    const dateStr = formatDate(targetDate);
    const label = findLabelElement(container, labelText) || findLabelElement(container, labelText.includes('开始') ? 'Start date' : 'Due date');
    if (label && label.parentElement) {
        const input = label.parentElement.querySelector('input') || label.parentElement.nextElementSibling?.querySelector('input');
        if (input) { setNativeValue(input, dateStr); input.dispatchEvent(new Event('change', { bubbles: true })); }
    }
}

async function setProgressInProgress(container) {
    const label = findLabelElement(container, '进度') || findLabelElement(container, 'Progress');
    if (!label) return;
    const dropdown = label.parentElement.querySelector('[role="combobox"]');
    if (dropdown) {
        const currentStatus = dropdown.innerText.trim();
        if (currentStatus.includes('正在进行') || currentStatus.includes('In progress')) return;
        dropdown.click();
        await new Promise(r => setTimeout(r, 600));
        const options = Array.from(document.querySelectorAll('[role="option"]'));
        const target = options.find(opt => opt.innerText.includes('正在进行') || opt.innerText.includes('In progress'));
        if (target) target.click();
    }
}

/**
 * 自动填充已完成任务的日期
 * 如果任务已完成但开始时间或截止日期为空，则自动补齐
 */
async function autoFillCompletedTaskDates(container) {
    // 检查任务进度状态
    const progressLabel = findLabelElement(container, '进度') || findLabelElement(container, 'Progress');
    if (!progressLabel) return;
    
    const dropdown = progressLabel.parentElement.querySelector('[role="combobox"]');
    if (!dropdown) return;
    
    const currentStatus = dropdown.innerText.trim();
    const isCompleted = currentStatus.includes('已完成') || currentStatus.includes('Completed');
    
    if (!isCompleted) return;
    
    console.log("[Planner Assistant] 检测到已完成任务，检查日期...");
    
    // 获取开始日期和截止日期输入框
    const startLabel = findLabelElement(container, '开始日期') || findLabelElement(container, 'Start date');
    const dueLabel = findLabelElement(container, '截止日期') || findLabelElement(container, 'Due date');
    
    let startInput = null;
    let dueInput = null;
    
    if (startLabel && startLabel.parentElement) {
        startInput = startLabel.parentElement.querySelector('input') || startLabel.parentElement.nextElementSibling?.querySelector('input');
    }
    
    if (dueLabel && dueLabel.parentElement) {
        dueInput = dueLabel.parentElement.querySelector('input') || dueLabel.parentElement.nextElementSibling?.querySelector('input');
    }
    
    // 检查是否需要填充日期
    const needStartDate = startInput && !startInput.value;
    const needDueDate = dueInput && !dueInput.value;
    
    if (!needStartDate && !needDueDate) {
        console.log("[Planner Assistant] 日期已完整，无需补充");
        return;
    }
    
    // 获取任务创建时间和完成时间
    const { createdDate, completedDate } = await getTaskDates(container);
    
    if (!createdDate && !completedDate) {
        console.log("[Planner Assistant] 无法获取任务时间信息");
        return;
    }
    
    // 填充开始日期（使用创建时间）
    if (needStartDate && createdDate) {
        const dateStr = formatDate(createdDate);
        setNativeValue(startInput, dateStr);
        startInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log(`[Planner Assistant] 已设置开始日期: ${dateStr}`);
        showToast(`✅ 已补充开始日期: ${dateStr}`);
        await new Promise(r => setTimeout(r, 300));
    }
    
    // 填充截止日期（使用完成时间）
    if (needDueDate && completedDate) {
        const dateStr = formatDate(completedDate);
        setNativeValue(dueInput, dateStr);
        dueInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log(`[Planner Assistant] 已设置截止日期: ${dateStr}`);
        showToast(`✅ 已补充截止日期: ${dateStr}`);
    }
}

/**
 * 获取任务的创建时间和完成时间
 */
async function getTaskDates(container) {
    let createdDate = null;
    let completedDate = null;
    
    // 尝试从活动历史中获取时间信息
    // 查找"活动"或"Activity"标签
    const activityLabels = Array.from(container.querySelectorAll('span, div, button'))
        .filter(el => el.innerText && (el.innerText.trim() === '活动' || el.innerText.trim() === 'Activity'));
    
    if (activityLabels.length > 0) {
        // 点击活动标签展开历史记录
        const activityTab = activityLabels.find(el => el.tagName === 'BUTTON' || el.closest('button'));
        if (activityTab) {
            const btn = activityTab.tagName === 'BUTTON' ? activityTab : activityTab.closest('button');
            if (btn && !btn.getAttribute('aria-selected')) {
                btn.click();
                await new Promise(r => setTimeout(r, 800));
            }
        }
    }
    
    // 查找活动历史记录
    const activityItems = Array.from(container.querySelectorAll('.activity-item, [class*="activity"], [class*="history"]'));
    
    // 查找创建时间（通常是最早的记录）
    const createdItem = activityItems.find(item => 
        item.innerText.includes('创建了') || 
        item.innerText.includes('created') ||
        item.innerText.includes('Created task')
    );
    
    if (createdItem) {
        const dateMatch = extractDateFromText(createdItem.innerText);
        if (dateMatch) createdDate = dateMatch;
    }
    
    // 查找完成时间
    const completedItem = activityItems.find(item => 
        item.innerText.includes('标记为已完成') || 
        item.innerText.includes('marked as completed') ||
        item.innerText.includes('Completed')
    );
    
    if (completedItem) {
        const dateMatch = extractDateFromText(completedItem.innerText);
        if (dateMatch) completedDate = dateMatch;
    }
    
    // 如果活动历史中找不到，尝试从其他地方获取
    if (!createdDate || !completedDate) {
        // 查找所有时间戳
        const timeElements = Array.from(container.querySelectorAll('time, [datetime], .timestamp, [class*="date"]'));
        
        for (const el of timeElements) {
            const datetime = el.getAttribute('datetime') || el.innerText;
            if (datetime) {
                const date = new Date(datetime);
                if (!isNaN(date.getTime())) {
                    if (!createdDate) createdDate = date;
                    completedDate = date; // 最新的时间作为完成时间
                }
            }
        }
    }
    
    return { createdDate, completedDate };
}

/**
 * 从文本中提取日期
 */
function extractDateFromText(text) {
    // 匹配各种日期格式
    const patterns = [
        /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/,  // 2024-01-15 or 2024/01/15
        /(\d{1,2})[/-](\d{1,2})[/-](\d{4})/,  // 01-15-2024 or 01/15/2024
        /(\d{4})年(\d{1,2})月(\d{1,2})日/      // 2024年1月15日
    ];
    
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            let year, month, day;
            if (pattern.source.startsWith('(\\d{4})')) {
                [, year, month, day] = match;
            } else if (pattern.source.includes('年')) {
                [, year, month, day] = match;
            } else {
                [, month, day, year] = match;
            }
            const date = new Date(year, parseInt(month) - 1, day);
            if (!isNaN(date.getTime())) return date;
        }
    }
    
    // 尝试直接解析
    const date = new Date(text);
    return isNaN(date.getTime()) ? null : date;
}

async function resetTask(container) {
    showToast("正在重置...");
    ['开始日期', '截止日期'].forEach(labelStr => {
        const label = findLabelElement(container, labelStr);
        if (label && label.parentElement) {
            const input = label.parentElement.querySelector('input');
            if (input) { setNativeValue(input, ""); input.dispatchEvent(new Event('change', { bubbles: true })); }
        }
    });
    await new Promise(r => setTimeout(r, 600));
    const label = findLabelElement(container, '进度');
    if (label) {
        const drp = label.parentElement.querySelector('[role="combobox"]');
        if (drp) {
            drp.click(); await new Promise(r => setTimeout(r, 600));
            const opts = Array.from(document.querySelectorAll('[role="option"]'));
            const t = opts.find(o => o.innerText.includes('未开始'));
            if (t) t.click();
        }
    }
}

// --- Navigation ---

function navigate(direction) {
    const buckets = Array.from(document.querySelectorAll(CONFIG.selectors.bucket));
    if (!buckets.length) return;
    const activeCard = window._lastClickedTask || document.querySelector(':focus')?.closest(CONFIG.selectors.card);
    let target = null;
    if (!activeCard) {
        target = document.querySelector(CONFIG.selectors.card);
    } else {
        const currentBucket = activeCard.closest(CONFIG.selectors.bucket);
        const cards = Array.from(currentBucket.querySelectorAll(CONFIG.selectors.card));
        const index = cards.indexOf(activeCard);
        if (direction === 'down') {
            if (index < cards.length - 1) target = cards[index + 1];
            else {
                const bIdx = buckets.indexOf(currentBucket);
                if (bIdx < buckets.length - 1) target = buckets[bIdx + 1].querySelector(CONFIG.selectors.card);
            }
        } else if (direction === 'up') {
            if (index > 0) target = cards[index - 1];
            else {
                const bIdx = buckets.indexOf(currentBucket);
                if (bIdx > 0) {
                    const prevCards = buckets[bIdx - 1].querySelectorAll(CONFIG.selectors.card);
                    target = prevCards[prevCards.length - 1];
                }
            }
        }
    }
    if (target) {
        if (currentTaskCard) {
            const close = currentTaskCard.querySelector('button[aria-label*="Close"], button[aria-label*="关闭"], .close-button');
            if (close) close.click();
        }
        setTimeout(() => { target.focus(); target.click(); window._lastClickedTask = target; target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 150);
    }
}

document.addEventListener('click', (e) => {
    const card = e.target.closest(CONFIG.selectors.card);
    if (card) window._lastClickedTask = card;
});

document.addEventListener('keydown', (e) => {
    const isTyping = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!isTyping) { e.preventDefault(); navigate(e.key === 'ArrowDown' ? 'down' : 'up'); }
        return;
    }
    if (isTyping) return;
    if (currentTaskCard) {
        if (e.key === 's' || e.key === 'S') setDate(currentTaskCard, '开始日期', 0);
        if (e.key === '1') smartSetDueDate(currentTaskCard, 7);
        if (e.key === '2') smartSetDueDate(currentTaskCard, 14);
        if (e.key === '0') resetTask(currentTaskCard);
    }
});

function showToast(msg) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed; bottom:50px; left:50%; transform:translateX(-50%); background:#333; color:white; padding:5px 15px; border-radius:10px; z-index:999999; font-size:12px;';
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
}
