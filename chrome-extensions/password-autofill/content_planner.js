// [Planner Assistant v2.0.33]
console.log("[Planner Assistant v2.0.33] Content Script Injected");

// --- State ---
let currentTaskCard = null;
window._lastClickedTask = null;
window._hasClickedAnyTask = false; // 跟踪是否点击过任何任务

const CONFIG = {
    selectors: {
        taskCard: '[role="dialog"], .task-details-pane, .ms-Panel-main, .taskEditPage',
        card: '.task-card, [role="listitem"]',
        bucket: '.bucket-column, .planner-bucket, [role="list"]',
        moveTargetPlan: 'TIER 3'
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
    if (element.getAttribute('contenteditable') === 'true') {
        // 对于 contenteditable 元素，使用 innerHTML 并将换行符转换为 <br>
        const lastValue = element.innerHTML;
        // 将 \n 转换为 <br> 以在 contenteditable 中正确显示换行
        const htmlValue = value.replace(/\n/g, '<br>');
        element.innerHTML = htmlValue;
        let tracker = element._valueTracker;
        if (tracker) tracker.setValue(lastValue);
        element.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
        // 对于普通 input 元素
        const lastValue = element.value;
        element.value = value;
        let tracker = element._valueTracker;
        if (tracker) tracker.setValue(lastValue);
        element.dispatchEvent(new Event("input", { bubbles: true }));
    }
}

function findLabelElement(container, text) {
    const elements = Array.from(container.querySelectorAll('label, span, div, h3'));
    return elements.find(el => (el.innerText.trim() === text || el.innerText.trim().includes(text)) && el.children.length === 0);
}

function showToast(msg) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed; bottom:50px; left:50%; transform:translateX(-50%); background:#333; color:white; padding:5px 15px; border-radius:10px; z-index:999999; font-size:12px;';
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
}

async function getTemplate() {
    return new Promise((resolve) => {
        chrome.storage.sync.get(['taskTemplate'], (result) => {
            const template = result.taskTemplate || '1. 问题描述:\n\n2. 批次号:\n\n3. 发生日期:\n\n4. 产品编号:\n\n5. 设备号:\n\n6. 已采取的措施及效果:\n\n7. 参与调试人员:\n\n8. 其它说明:\n';
            resolve(template);
        });
    });
}

function locateNotesField(container) {
    const selectors = [
        '[role="textbox"][aria-labelledby="notes-label"]',
        '.notes-editor[contenteditable="true"]',
        '[aria-placeholder*="在此处键入说明"]'
    ];
    
    for (const selector of selectors) {
        const field = container.querySelector(selector);
        if (field && field.getAttribute('contenteditable') === 'true') {
            return field;
        }
    }
    
    return null;
}

// 防止并发执行的标志
let _fillTemplateInProgress = false;

async function fillTemplate() {
    console.log('[PA] fillTemplate: Starting...');
    
    // 防止并发执行
    if (_fillTemplateInProgress) {
        console.log('[PA] fillTemplate: Already in progress, skipping...');
        showToast('⚠️ 模板填充正在进行中');
        return;
    }
    
    _fillTemplateInProgress = true;
    
    try {
        // 验证任务对话框是否打开
        const taskDialog = document.querySelector(CONFIG.selectors.taskCard);
        if (!taskDialog) {
            console.log('[PA] fillTemplate: No task dialog open');
            showToast('❌ 请先打开任务对话框');
            return;
        }
        
        // 保存对话框引用用于后续验证
        const originalDialog = taskDialog;
        
        // 获取模板内容
        console.log('[PA] fillTemplate: Getting template content...');
        const templateContent = await getTemplate();
        console.log('[PA] fillTemplate: Template content retrieved:', templateContent);
        
        // 重新验证对话框是否还是同一个（防止用户在等待期间切换了任务）
        const currentDialog = document.querySelector(CONFIG.selectors.taskCard);
        if (!currentDialog || currentDialog !== originalDialog) {
            console.log('[PA] fillTemplate: Dialog changed during operation, aborting');
            showToast('⚠️ 任务已切换，已取消填充');
            return;
        }
        
        // 定位备注字段
        console.log('[PA] fillTemplate: Locating notes field...');
        const notesField = locateNotesField(currentDialog);
        
        if (!notesField) {
            console.log('[PA] fillTemplate: Notes field not found');
            showToast('❌ 未找到备注字段');
            return;
        }
        
        // 检查备注字段是否已有内容
        const currentContent = notesField.textContent || notesField.innerText || '';
        const hasContent = currentContent.trim().length > 0;
        
        if (hasContent) {
            console.log('[PA] fillTemplate: Notes field has existing content, asking for confirmation...');
            const confirmed = confirm('备注字段已有内容，是否清除并填充模板？\n\n点击"确定"将覆盖现有内容\n点击"取消"将保留现有内容');
            
            if (!confirmed) {
                console.log('[PA] fillTemplate: User cancelled template fill');
                showToast('ℹ️ 已取消填充');
                return;
            }
            
            // 确认对话框后再次验证对话框是否还是同一个
            const dialogAfterConfirm = document.querySelector(CONFIG.selectors.taskCard);
            if (!dialogAfterConfirm || dialogAfterConfirm !== originalDialog) {
                console.log('[PA] fillTemplate: Dialog changed after confirmation, aborting');
                showToast('⚠️ 任务已切换，已取消填充');
                return;
            }
        }
        
        console.log('[PA] fillTemplate: Inserting template...');
        
        // 最后一次验证：确保备注字段仍然属于原始对话框
        if (!originalDialog.contains(notesField)) {
            console.log('[PA] fillTemplate: Notes field no longer in original dialog, aborting');
            showToast('⚠️ 任务已切换，已取消填充');
            return;
        }
        
        // 使用 setNativeValue 将模板内容插入字段
        setNativeValue(notesField, templateContent);
        
        console.log('[PA] fillTemplate: Template inserted successfully');
        showToast('✅ 已填充模板内容');
        
    } catch (error) {
        console.error('[PA] fillTemplate: Error occurred:', error);
        showToast('❌ 填充模板失败');
    } finally {
        // 确保标志被重置
        _fillTemplateInProgress = false;
    }
}

// --- Injection ---

// 页面加载时立即创建悬浮面板和助手按钮
setTimeout(() => {
    if (!document.querySelector('.pa-floating-panel')) {
        // 加载主题设置
        chrome.storage.sync.get(['panelTheme'], (result) => {
            const theme = (result && result.panelTheme) || 'dark';
            injectUpgradeButton(null, theme);
        });
    }
}, 1000);

// 监听主题变化
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.panelTheme) {
        const newTheme = changes.panelTheme.newValue;
        const panel = window._floatingPanel;
        const titleBar = window._titleBar;
        
        if (panel) {
            if (newTheme === 'light') {
                panel.classList.add('light-theme');
                // 更新背景色和边框
                panel.style.background = 'rgba(255, 255, 255, 0.95)';
                panel.style.border = '2px solid rgba(0, 0, 0, 0.1)';
                if (titleBar) {
                    titleBar.style.color = '#1d1d1f';
                }
            } else {
                panel.classList.remove('light-theme');
                // 恢复深色背景和边框
                panel.style.background = 'rgba(0, 0, 0, 0.9)';
                panel.style.border = '2px solid rgba(255, 255, 255, 0.3)';
                if (titleBar) {
                    titleBar.style.color = 'white';
                }
            }
        }
    }
});

// 监听用户手动点击任务卡片
document.addEventListener('click', (e) => {
    const taskCard = e.target.closest(CONFIG.selectors.card);
    if (taskCard) {
        window._lastClickedTask = taskCard;
        window._hasClickedAnyTask = true;
        updateNavigationButtonStates();
    }
}, true);

const observer = new MutationObserver(() => {
    const dialog = document.querySelector(CONFIG.selectors.taskCard);
    if (dialog && (dialog !== currentTaskCard || !dialog.querySelector('.pa-header-buttons'))) {
        currentTaskCard = dialog;
        setTimeout(() => {
            injectInlineButtons(dialog);
        }, 600);
        // 启用升级问题按钮
        updateUpgradeButtonState(true);
        // 启用填充模板按钮
        updateFillTemplateButtonState(true);
    } else if (!dialog) {
        currentTaskCard = null;
        // 禁用升级问题按钮
        updateUpgradeButtonState(false);
        // 禁用填充模板按钮
        updateFillTemplateButtonState(false);
    }
});
observer.observe(document.body, { childList: true, subtree: true });

// 更新升级问题按钮的状态
function updateUpgradeButtonState(enabled) {
    const upgradeBtn = window._upgradeBtn;
    if (upgradeBtn) {
        upgradeBtn.disabled = !enabled;
        if (enabled) {
            upgradeBtn.style.opacity = '1';
            upgradeBtn.style.cursor = 'pointer';
        } else {
            upgradeBtn.style.opacity = '0.5';
            upgradeBtn.style.cursor = 'not-allowed';
        }
    }
    
    // 同时更新执行和完成按钮的状态
    const startBtn = window._startBtn;
    const completeBtn = window._completeBtn;
    
    if (startBtn) {
        startBtn.disabled = !enabled;
        startBtn.style.opacity = enabled ? '1' : '0.5';
        startBtn.style.cursor = enabled ? 'pointer' : 'not-allowed';
    }
    
    if (completeBtn) {
        completeBtn.disabled = !enabled;
        completeBtn.style.opacity = enabled ? '1' : '0.5';
        completeBtn.style.cursor = enabled ? 'pointer' : 'not-allowed';
    }
}

// 更新填充模板按钮的状态
function updateFillTemplateButtonState() {
    const fillTemplateBtn = window._fillTemplateBtn;
    if (!fillTemplateBtn) return;

    // 检查任务对话框是否打开
    const taskDialog = document.querySelector(CONFIG.selectors.taskCard);
    const isDialogOpen = taskDialog !== null;

    // 根据对话框状态更新按钮（CSS 会处理视觉样式）
    fillTemplateBtn.disabled = !isDialogOpen;
}


// 更新导航按钮的状态
function updateNavigationButtonStates() {
    const prevBtn = window._prevBtn;
    const nextBtn = window._nextBtn;
    
    if (!prevBtn || !nextBtn) return;
    
    // 如果还没有点击过任何任务，禁用"上一个"按钮
    if (!window._hasClickedAnyTask) {
        prevBtn.disabled = true;
        prevBtn.style.opacity = '0.5';
        prevBtn.style.cursor = 'not-allowed';
    } else {
        prevBtn.disabled = false;
        prevBtn.style.opacity = '1';
        prevBtn.style.cursor = 'pointer';
    }
    
    // "下一个"按钮始终可用
    nextBtn.disabled = false;
    nextBtn.style.opacity = '1';
    nextBtn.style.cursor = 'pointer';
}

// --- Keyboard Shortcuts ---
// 使用捕获阶段监听，优先级更高
document.addEventListener('keydown', (e) => {
    const target = e.target;
    
    // 如果在输入框中，只允许 Ctrl 组合键
    const isInputField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    
    // Ctrl + 左箭头 - 上一个任务
    if (e.ctrlKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        console.log('[PA] Ctrl+← 触发');
        // 如果没有当前任务，先打开第一个
        if (!currentTaskCard && !window._hasClickedAnyTask) {
            openNextTask(null);
        } else if (currentTaskCard) {
            openPrevTask(currentTaskCard);
        }
    }
    
    // Ctrl + 右箭头 - 下一个任务
    if (e.ctrlKey && e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        console.log('[PA] Ctrl+→ 触发');
        openNextTask(currentTaskCard);
    }
    
    // 如果不在输入框中，支持单键快捷键
    if (!isInputField) {
        // P 键 - 上一个任务 (Previous)
        if (e.key === 'p' || e.key === 'P') {
            e.preventDefault();
            e.stopPropagation();
            console.log('[PA] P 键触发');
            // 如果没有当前任务，先打开第一个
            if (!currentTaskCard && !window._hasClickedAnyTask) {
                openNextTask(null);
            } else if (currentTaskCard) {
                openPrevTask(currentTaskCard);
            }
        }
        
        // N 键 - 下一个任务 (Next)
        if (e.key === 'n' || e.key === 'N') {
            e.preventDefault();
            e.stopPropagation();
            console.log('[PA] N 键触发');
            openNextTask(currentTaskCard);
        }
        
        // 数字键 1-4 - 快速筛选
        if (e.key === '1') {
            e.preventDefault();
            e.stopPropagation();
            console.log('[PA] 1 键触发 - 全部');
            applyFilter(null, null); // 清除所有筛选
        }
        
        if (e.key === '2') {
            e.preventDefault();
            e.stopPropagation();
            console.log('[PA] 2 键触发 - 晚点');
            applyFilter('dueDate', '晚点');
        }
        
        if (e.key === '3') {
            e.preventDefault();
            e.stopPropagation();
            console.log('[PA] 3 键触发 - 无日期');
            applyFilter('dueDate', '无日期');
        }
        
        if (e.key === '4') {
            e.preventDefault();
            e.stopPropagation();
            console.log('[PA] 4 键触发 - 未开始');
            applyFilter('progress', '未开始');
        }
    }
}, true); // 使用捕获阶段

console.log('[PA] 键盘监听器已注册 - N:下一个, P:上一个, 1-4:筛选');


function injectInlineButtons(container) {
    const labels = ['开始日期', '截止日期', 'Start date', 'Due date'];
    labels.forEach(lText => {
        const label = findLabelElement(container, lText);
        if (label && label.parentElement) {
            if (label.closest('.pa-label-button-wrapper')) {
                return;
            }
            
            const inputContainer = label.parentElement.querySelector('.ms-TextField-wrapper') || label.parentElement;
            const input = inputContainer.querySelector('input');
            if (input) {
                const inputParent = input.closest('.ms-TextField-wrapper') || input.parentElement;
                if (inputParent) {
                    const oldRows = Array.from(inputParent.parentElement.querySelectorAll('.pa-inline-btn-row'));
                    oldRows.forEach(row => {
                        if (!row.closest('.pa-label-button-wrapper')) {
                            row.remove();
                        }
                    });
                }
                
                const row = document.createElement('div');
                row.className = 'pa-inline-btn-row';
                [{ l: '-1', v: -1 }, { l: '今', v: 0, c: 'today' }, { l: '+1', v: 1 }].forEach(opt => {
                    const btn = document.createElement('button');
                    btn.className = 'pa-inline-date-btn' + (opt.c ? ' ' + opt.c : '');
                    btn.innerText = opt.l;
                    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); offsetDateInInput(input, opt.v, opt.l === '今'); };
                    row.appendChild(btn);
                });
                
                const wrapper = document.createElement('div');
                wrapper.className = 'pa-label-button-wrapper';
                
                label.parentNode.insertBefore(wrapper, label);
                wrapper.appendChild(label);
                wrapper.appendChild(row);
            }
        }
    });
}

function injectUpgradeButton(container, theme = 'dark') {
    if (document.querySelector('.pa-floating-panel')) {
        return;
    }
    
    const floatingPanel = document.createElement('div');
    floatingPanel.className = theme === 'light' ? 'pa-floating-panel light-theme' : 'pa-floating-panel';
    
    // 根据主题设置背景色和边框
    const bgColor = theme === 'light' ? 'rgba(255, 255, 255, 0.95)' : 'rgba(0, 0, 0, 0.9)';
    const borderColor = theme === 'light' ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.3)';
    
    floatingPanel.style.cssText = `position: fixed; top: 40%; right: 20px; z-index: 10000000; background: ${bgColor}; border-radius: 10px; padding: 12px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); cursor: move; user-select: none; backdrop-filter: blur(10px); min-width: 240px; max-width: 280px; max-height: 242px; border: 2px solid ${borderColor}; display: block; width: fit-content; height: auto;`;
    
    // 保存面板引用以便主题切换
    window._floatingPanel = floatingPanel;
    
    const titleBar = document.createElement('div');
    titleBar.className = 'pa-panel-title';
    titleBar.style.color = theme === 'light' ? '#1d1d1f' : 'white';
    titleBar.innerText = '🤖 Planner Assistant';
    
    // 保存标题栏引用以便主题切换时更新颜色
    window._titleBar = titleBar;
    
    const filterSection = document.createElement('div');
    filterSection.className = 'pa-filter-section';
    filterSection.style.cssText = 'margin-bottom: 8px; display: flex; gap: 4px;';
    
    const filterButtons = [
        { label: '🔄 全部', filterType: null, filterValue: null },
        { label: '⚠️ 晚点', filterType: 'dueDate', filterValue: '晚点' },
        { label: '📅 无日期', filterType: 'dueDate', filterValue: '无日期' },
        { label: '🔵 未开始', filterType: 'progress', filterValue: '未开始' }
    ];
    
    filterButtons.forEach(config => {
        const filterBtn = document.createElement('button');
        filterBtn.className = 'pa-filter-btn';
        filterBtn.innerText = config.label;
        filterBtn.style.cssText = 'flex: 1; padding: 5px 4px; font-size: 10px; background: rgba(255, 255, 255, 0.1); color: white; border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px; cursor: pointer; transition: all 0.2s; white-space: nowrap;';
        
        filterBtn.onmouseover = () => {
            filterBtn.style.background = 'rgba(255, 255, 255, 0.2)';
            filterBtn.style.borderColor = 'rgba(255, 255, 255, 0.4)';
        };
        filterBtn.onmouseout = () => {
            filterBtn.style.background = 'rgba(255, 255, 255, 0.1)';
            filterBtn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
        };
        
        filterBtn.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            await applyFilter(config.filterType, config.filterValue);
        };
        filterBtn.onmousedown = (e) => {
            e.stopPropagation();
        };
        
        filterSection.appendChild(filterBtn);
    });
    
    const btnContainer = document.createElement('div');
    btnContainer.className = 'pa-header-buttons';
    btnContainer.style.cssText = 'display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0;';
    
    // 导航按钮行
    const navRow = document.createElement('div');
    navRow.style.cssText = 'display: flex; gap: 8px;';
    
    const prevBtn = document.createElement('button');
    prevBtn.className = 'pa-prev-task-btn';
    prevBtn.innerHTML = '<span class="btn-text">⬅️ 上一个</span><span class="btn-shortcut">N</span>';
    prevBtn.style.cssText = 'flex: 1; position: relative;';
    prevBtn.disabled = true;
    prevBtn.onclick = (e) => {
        e.preventDefault(); 
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (!prevBtn.disabled) {
            openPrevTask(container);
        }
    };
    prevBtn.onmousedown = (e) => {
        e.stopPropagation();
    };
    
    const nextBtn = document.createElement('button');
    nextBtn.className = 'pa-next-task-btn';
    nextBtn.innerHTML = '<span class="btn-text">➡️ 下一个</span><span class="btn-shortcut">F</span>';
    nextBtn.style.cssText = 'flex: 1; position: relative;';
    nextBtn.onclick = (e) => {
        e.preventDefault(); 
        e.stopPropagation();
        e.stopImmediatePropagation();
        openNextTask(container);
    };
    nextBtn.onmousedown = (e) => {
        e.stopPropagation();
    };
    
    window._prevBtn = prevBtn;
    window._nextBtn = nextBtn;
    
    navRow.appendChild(prevBtn);
    navRow.appendChild(nextBtn);
    
    // 模板填充和执行按钮行
    const fillStartRow = document.createElement('div');
    fillStartRow.style.cssText = 'display: flex; gap: 8px;';
    
    const fillTemplateBtn = document.createElement('button');
    fillTemplateBtn.className = 'pa-fill-template-btn';
    fillTemplateBtn.innerText = '📝 模板填充';
    fillTemplateBtn.style.cssText = 'flex: 1;';
    fillTemplateBtn.onclick = (e) => {
        e.preventDefault(); 
        e.stopPropagation();
        e.stopImmediatePropagation();
        fillTemplate();
    };
    fillTemplateBtn.onmousedown = (e) => {
        e.stopPropagation();
    };
    window._fillTemplateBtn = fillTemplateBtn;
    
    const startBtn = document.createElement('button');
    startBtn.className = 'pa-start-task-btn';
    startBtn.innerText = '▶️ 执行';
    startBtn.disabled = true;
    startBtn.style.cssText = 'flex: 1;';
    startBtn.onclick = (e) => {
        e.preventDefault(); 
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (!startBtn.disabled) {
            startTask(container);
        }
    };
    startBtn.onmousedown = (e) => {
        e.stopPropagation();
    };
    
    fillStartRow.appendChild(fillTemplateBtn);
    fillStartRow.appendChild(startBtn);
    
    // 升级和完成按钮行（升级在左，完成在右）
    const upgradeCompleteRow = document.createElement('div');
    upgradeCompleteRow.style.cssText = 'display: flex; gap: 8px;';
    
    const upgradeBtn = document.createElement('button');
    upgradeBtn.className = 'pa-upgrade-t3-btn';
    upgradeBtn.innerText = '🚀 升级问题';
    upgradeBtn.disabled = true;
    upgradeBtn.style.cssText = 'flex: 1;';
    upgradeBtn.onclick = (e) => {
        e.preventDefault(); 
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (!upgradeBtn.disabled) {
            const currentDialog = document.querySelector(CONFIG.selectors.taskCard);
            if (currentDialog) {
                upgradeTask(currentDialog);
            } else {
                showToast('❌ 未找到打开的任务');
            }
        }
    };
    upgradeBtn.onmousedown = (e) => {
        e.stopPropagation();
    };
    
    const completeBtn = document.createElement('button');
    completeBtn.className = 'pa-complete-task-btn';
    completeBtn.innerText = '✅ 完成';
    completeBtn.disabled = true;
    completeBtn.style.cssText = 'flex: 1;';
    completeBtn.onclick = (e) => {
        e.preventDefault(); 
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (!completeBtn.disabled) {
            completeTask(container);
        }
    };
    completeBtn.onmousedown = (e) => {
        e.stopPropagation();
    };
    
    upgradeCompleteRow.appendChild(upgradeBtn);
    upgradeCompleteRow.appendChild(completeBtn);
    
    // 保存按钮引用
    window._upgradeBtn = upgradeBtn;
    window._startBtn = startBtn;
    window._completeBtn = completeBtn;
    
    // 添加所有行到容器
    btnContainer.appendChild(navRow);
    btnContainer.appendChild(fillStartRow);
    btnContainer.appendChild(upgradeCompleteRow);
    
    floatingPanel.appendChild(titleBar);
    floatingPanel.appendChild(filterSection);
    floatingPanel.appendChild(btnContainer);
    
    floatingPanel.onclick = (e) => {
        e.stopPropagation();
    };
    floatingPanel.onmousedown = (e) => {
        e.stopPropagation();
    };
    
    document.body.appendChild(floatingPanel);
    
    let isDragging = false;
    let currentX;
    let currentY;
    let initialX;
    let initialY;
    let xOffset = 0;
    let yOffset = 0;
    
    titleBar.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
    
    function dragStart(e) {
        if (e.target === titleBar || e.target.closest('.pa-panel-title')) {
            initialX = e.clientX - xOffset;
            initialY = e.clientY - yOffset;
            isDragging = true;
            floatingPanel.style.cursor = 'grabbing';
        }
    }
    
    function drag(e) {
        if (isDragging) {
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            xOffset = currentX;
            yOffset = currentY;
            
            setTranslate(currentX, currentY, floatingPanel);
        }
    }
    
    function dragEnd(e) {
        if (isDragging) {
            initialX = currentX;
            initialY = currentY;
            isDragging = false;
            floatingPanel.style.cursor = 'move';
        }
    }
    
    function setTranslate(xPos, yPos, el) {
        el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`;
    }
    
    createToolbarToggleButton(floatingPanel);
}


function createToolbarToggleButton(floatingPanel, retryCount = 0) {
    if (document.querySelector('.pa-toolbar-toggle-btn')) {
        return;
    }
    
    // 最多重试5次，每次间隔增加
    if (retryCount >= 5) {
        console.log('[Planner Assistant] Share button not found after 5 attempts, toolbar button will not be created');
        return;
    }
    
    let shareButton = Array.from(document.querySelectorAll('button'))
        .find(btn => {
            const text = btn.innerText || btn.getAttribute('aria-label') || '';
            return text.includes('共享') || text.includes('Share');
        });
    
    if (!shareButton) {
        const buttons = document.querySelectorAll('button .ms-Button-label');
        for (const label of buttons) {
            if (label.innerText.includes('共享') || label.innerText.includes('Share')) {
                shareButton = label.closest('button');
                break;
            }
        }
    }
    
    if (!shareButton) {
        // 静默重试，不产生警告
        const retryDelay = 1000 + (retryCount * 500); // 递增延迟：1s, 1.5s, 2s, 2.5s, 3s
        setTimeout(() => createToolbarToggleButton(floatingPanel, retryCount + 1), retryDelay);
        return;
    }
    
    const toggleButton = document.createElement('button');
    toggleButton.className = 'pa-toolbar-toggle-btn';
    toggleButton.setAttribute('type', 'button');
    toggleButton.setAttribute('aria-label', 'Tier Meeting Assistant');
    toggleButton.setAttribute('title', 'Tier Meeting Assistant');
    
    const shareButtonStyles = window.getComputedStyle(shareButton);
    toggleButton.style.cssText = `
        background: ${shareButtonStyles.background};
        border: ${shareButtonStyles.border};
        border-radius: ${shareButtonStyles.borderRadius};
        color: ${shareButtonStyles.color};
        cursor: pointer;
        font-size: ${shareButtonStyles.fontSize};
        font-family: ${shareButtonStyles.fontFamily};
        padding: ${shareButtonStyles.padding};
        margin: ${shareButtonStyles.margin};
        height: ${shareButtonStyles.height};
        min-width: ${shareButtonStyles.minWidth};
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        transition: all 0.2s;
    `;
    
    toggleButton.innerHTML = `
        <span class="ms-Button-textContainer">
            <span class="ms-Button-label">
                <span style="font-size: 16px; margin-right: 4px;">🎯</span>助手
            </span>
        </span>
    `;
    
    toggleButton.style.background = 'rgba(0, 120, 212, 0.1)';
    
    toggleButton.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        if (floatingPanel.style.display === 'none') {
            floatingPanel.style.display = 'block';
            toggleButton.style.background = 'rgba(0, 120, 212, 0.1)';
        } else {
            floatingPanel.style.display = 'none';
            toggleButton.style.background = shareButtonStyles.background;
        }
    };
    
    toggleButton.onmouseover = () => {
        if (floatingPanel.style.display === 'none') {
            toggleButton.style.background = shareButtonStyles.getPropertyValue('background-color') || 'rgba(255, 255, 255, 0.1)';
        }
    };
    toggleButton.onmouseout = () => {
        if (floatingPanel.style.display === 'none') {
            toggleButton.style.background = shareButtonStyles.background;
        }
    };
    
    const shareButtonParent = shareButton.parentElement;
    if (shareButtonParent) {
        shareButtonParent.insertBefore(toggleButton, shareButton);
    }
}

async function applyFilter(filterType, filterValue) {
    if (filterValue === null) {
        showToast(`正在清除所有筛选...`);
    } else {
        showToast(`正在应用筛选: ${filterValue}...`);
    }
    
    try {
        // 先关闭任何打开的task对话框
        const openDialog = document.querySelector(CONFIG.selectors.taskCard);
        if (openDialog) {
            const closeBtn = openDialog.querySelector('button[aria-label*="Close"], button[aria-label*="关闭"], .close-button, button[title*="关闭"], button[title*="Close"]');
            if (closeBtn) {
                console.log('[Filter] Closing open task dialog first');
                closeBtn.click();
                await new Promise(r => setTimeout(r, 500)); // 等待对话框关闭
            }
        }
        
        const filterButton = Array.from(document.querySelectorAll('button, [role="button"]'))
            .find(btn => {
                const text = btn.innerText || btn.getAttribute('aria-label') || '';
                return text.includes('筛选器') || text.includes('Filter');
            });
        
        if (!filterButton) {
            showToast('❌ 未找到筛选器按钮');
            return;
        }
        
        filterButton.click();
        await new Promise(r => setTimeout(r, 300));
        
        const filterPanel = document.querySelector('[role="dialog"], [role="menu"], .ms-Panel, .ms-ContextualMenu, .filter-panel, [class*="callout"], [class*="Callout"]');
        if (!filterPanel) {
            showToast('❌ 筛选面板未打开');
            return;
        }
        
        const clearAllButton = Array.from(document.querySelectorAll('button, [role="button"]'))
            .find(btn => {
                const text = btn.innerText || btn.textContent || '';
                return text.includes('全部清除') || text.includes('Clear all');
            });
        
        if (clearAllButton) {
            clearAllButton.click();
            await new Promise(r => setTimeout(r, 300));
        }
        
        if (filterValue === null) {
            showToast('✅ 已清除所有筛选');
            filterButton.click();
            // 重置导航状态
            window._hasClickedAnyTask = false;
            window._lastClickedTask = null;
            updateNavigationButtonStates();
            return;
        }
        
        let categoryName = '';
        if (filterType === 'dueDate') {
            categoryName = '截止日期';
        } else if (filterType === 'progress') {
            categoryName = '进度';
        } else if (filterType === 'startDate') {
            categoryName = '开始日期';
        }
        
        const categoryOption = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="button"], .ms-ContextualMenu-link, span, div'))
            .find(el => {
                const text = el.innerText || el.textContent || '';
                const trimmedText = text.trim();
                return trimmedText === categoryName || 
                       (trimmedText.includes(categoryName) && trimmedText.length < 20);
            });
        
        if (!categoryOption) {
            showToast(`❌ 未找到${categoryName}选项`);
            return;
        }
        
        const categoryButton = categoryOption.tagName === 'BUTTON' ? categoryOption : categoryOption.closest('button, [role="menuitem"]');
        if (categoryButton) {
            categoryButton.click();
        } else {
            categoryOption.click();
        }
        
        await new Promise(r => setTimeout(r, 300));
        
        console.log(`[Filter Debug] Looking for: "${filterValue}"`);
        let filterValueOption = null;
        
        const allMenus = document.querySelectorAll('[role="menu"], .ms-ContextualMenu, [class*="callout"], [class*="Callout"]');
        console.log(`[Filter Debug] Found ${allMenus.length} menus`);
        
        for (let i = 0; i < allMenus.length; i++) {
            const menu = allMenus[i];
            
            const options = Array.from(menu.querySelectorAll(
                '[role="option"], [role="menuitemcheckbox"], [role="menuitem"], ' +
                '.ms-ContextualMenu-link, .ms-ContextualMenu-item, ' +
                'button, li, div[class*="item"]'
            ));
            console.log(`[Filter Debug] Menu ${i + 1}: ${options.length} options`);
            
            for (const el of options) {
                const text = el.innerText || el.textContent || '';
                const trimmedText = text.trim();
                
                if (trimmedText && trimmedText.length < 50) {
                    console.log(`[Filter Debug]   - "${trimmedText}"`);
                }
                
                if (trimmedText === filterValue) {
                    filterValueOption = el;
                    console.log(`[Filter Debug] ✅ Found match!`);
                    break;
                }
            }
            
            if (filterValueOption) {
                break;
            }
        }
        
        if (!filterValueOption) {
            showToast(`❌ 未找到选项: ${filterValue}`);
            console.log(`[Filter Debug] ❌ No match found for "${filterValue}"`);
            return;
        }
        
        console.log(`[Filter Debug] Clicking option:`, filterValueOption);
        console.log(`[Filter Debug] Option details:`, {
            tagName: filterValueOption.tagName,
            role: filterValueOption.getAttribute('role'),
            ariaChecked: filterValueOption.getAttribute('aria-checked'),
            innerHTML: filterValueOption.innerHTML
        });
        
        // 如果是 li 元素，查找内部的 button 或可点击元素
        let clickTarget = filterValueOption;
        if (filterValueOption.tagName === 'LI') {
            console.log(`[Filter Debug] Element is LI, looking for clickable child`);
            const button = filterValueOption.querySelector('button, [role="menuitemcheckbox"], [role="menuitem"]');
            if (button) {
                console.log(`[Filter Debug] Found clickable child:`, button);
                clickTarget = button;
            }
        }
        
        const checkboxInput = clickTarget.querySelector('input[type="checkbox"]');
        if (checkboxInput) {
            console.log(`[Filter Debug] Found checkbox input, clicking it`);
            checkboxInput.click();
        } else {
            console.log(`[Filter Debug] No checkbox input, clicking element directly`);
            clickTarget.click();
        }
        
        await new Promise(r => setTimeout(r, 300));
        
        // 验证是否成功 - 检查 clickTarget 而不是原始元素
        const isChecked = clickTarget.getAttribute('aria-checked') === 'true';
        console.log(`[Filter Debug] After click, aria-checked: ${isChecked}`);
        
        if (!isChecked) {
            console.log(`[Filter Debug] ⚠️ Click may have failed, trying alternative methods`);
            // 尝试使用 MouseEvent
            console.log(`[Filter Debug] Trying MouseEvent`);
            clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 50));
            clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 50));
            clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await new Promise(r => setTimeout(r, 300));
            
            const isNowChecked = clickTarget.getAttribute('aria-checked') === 'true';
            console.log(`[Filter Debug] After MouseEvent, aria-checked: ${isNowChecked}`);
        }
        
        await new Promise(r => setTimeout(r, 500));
        
        showToast(`✅ 已应用筛选: ${filterValue}`);
        
        // 重置导航状态
        window._hasClickedAnyTask = false;
        window._lastClickedTask = null;
        updateNavigationButtonStates();
        
    } catch (error) {
        console.error('[Planner Assistant] Error applying filter:', error);
        showToast('❌ 筛选应用失败');
    }
}


function flashTaskCard(card) {
    if (!card) return;
    
    card.style.transition = 'all 0.4s ease';
    card.style.boxShadow = '0 0 30px 8px rgba(0, 120, 212, 1), 0 0 60px 15px rgba(0, 120, 212, 0.5)';
    card.style.transform = 'scale(1.08)';
    card.style.border = '3px solid rgba(0, 120, 212, 0.8)';
    card.style.zIndex = '9999';
    
    setTimeout(() => {
        card.style.boxShadow = '';
        card.style.transform = '';
        card.style.border = '';
        card.style.zIndex = '';
    }, 400);
}

function flashTaskDialog() {
    const dialog = document.querySelector(CONFIG.selectors.taskCard);
    if (!dialog) return;
    
    const flash = document.createElement('div');
    flash.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: linear-gradient(135deg, rgba(0, 120, 212, 0.3), rgba(0, 180, 255, 0.3));
        pointer-events: none;
        z-index: 999999;
        animation: flashAnimation 0.8s ease-out;
        border-radius: 8px;
    `;
    
    dialog.style.position = 'relative';
    dialog.appendChild(flash);
    
    setTimeout(() => {
        flash.remove();
    }, 800);
}

async function openPrevTask(container) {
    // 如果还没有点击过任何任务，不执行操作
    if (!window._hasClickedAnyTask) {
        showToast("⚠️ 请先点击一个任务");
        return;
    }
    
    let currentCard = window._lastClickedTask;
    
    if (!currentCard) {
        showToast("⚠️ 未找到当前任务");
        return;
    }
    
    const currentBucket = currentCard.closest(CONFIG.selectors.bucket);
    if (!currentBucket) {
        showToast("⚠️ 未找到当前存储桶");
        return;
    }
    
    const cards = Array.from(currentBucket.querySelectorAll(CONFIG.selectors.card));
    const currentIndex = cards.indexOf(currentCard);
    
    if (currentIndex === -1) {
        showToast("⚠️ 未找到任务卡片");
        return;
    }
    
    let prevCard = null;
    
    if (currentIndex > 0) {
        prevCard = cards[currentIndex - 1];
    } else {
        const buckets = Array.from(document.querySelectorAll(CONFIG.selectors.bucket));
        const bucketIndex = buckets.indexOf(currentBucket);
        
        if (bucketIndex > 0) {
            const prevBucket = buckets[bucketIndex - 1];
            const prevBucketCards = Array.from(prevBucket.querySelectorAll(CONFIG.selectors.card));
            if (prevBucketCards.length > 0) {
                prevCard = prevBucketCards[prevBucketCards.length - 1];
            }
        }
    }
    
    if (!prevCard) {
        showToast("✅ 已经是第一个任务了");
        return;
    }
    
    // 关闭当前对话框，增加延迟确保状态完全清理
    const currentDialog = document.querySelector(CONFIG.selectors.taskCard);
    if (currentDialog) {
        const closeBtn = currentDialog.querySelector('button[aria-label*="Close"], button[aria-label*="关闭"], .close-button, button[title*="关闭"], button[title*="Close"]');
        if (closeBtn) {
            closeBtn.click();
            // 增加延迟到500ms，确保Planner完全清理前一个任务的状态
            await new Promise(r => setTimeout(r, 500));
        }
    }
    
    flashTaskCard(prevCard);
    await new Promise(r => setTimeout(r, 450));
    
    prevCard.focus();
    prevCard.click();
    window._lastClickedTask = prevCard;
    window._hasClickedAnyTask = true;
    updateNavigationButtonStates();
    prevCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    setTimeout(() => {
        flashTaskDialog();
    }, 600);
    
    showToast("⬅️ 已打开上一个任务");
}

async function openNextTask(container) {
    let currentCard = window._lastClickedTask;
    
    // 如果还没有点击过任何任务，从第一个任务开始
    if (!currentCard) {
        const allCards = Array.from(document.querySelectorAll(CONFIG.selectors.card));
        if (allCards.length > 0) {
            const firstCard = allCards[0];
            
            flashTaskCard(firstCard);
            await new Promise(r => setTimeout(r, 450));
            
            firstCard.focus();
            firstCard.click();
            window._lastClickedTask = firstCard;
            window._hasClickedAnyTask = true;
            updateNavigationButtonStates();
            firstCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            setTimeout(() => {
                flashTaskDialog();
            }, 600);
            
            showToast("➡️ 已打开第一个任务");
            return;
        } else {
            showToast("⚠️ 未找到任务卡片");
            return;
        }
    }
    
    const currentBucket = currentCard.closest(CONFIG.selectors.bucket);
    if (!currentBucket) {
        showToast("⚠️ 未找到当前存储桶");
        return;
    }
    
    const cards = Array.from(currentBucket.querySelectorAll(CONFIG.selectors.card));
    const currentIndex = cards.indexOf(currentCard);
    
    if (currentIndex === -1) {
        showToast("⚠️ 未找到任务卡片");
        return;
    }
    
    let nextCard = null;
    
    if (currentIndex < cards.length - 1) {
        nextCard = cards[currentIndex + 1];
    } else {
        const buckets = Array.from(document.querySelectorAll(CONFIG.selectors.bucket));
        const bucketIndex = buckets.indexOf(currentBucket);
        
        if (bucketIndex < buckets.length - 1) {
            const nextBucket = buckets[bucketIndex + 1];
            nextCard = nextBucket.querySelector(CONFIG.selectors.card);
        }
    }
    
    if (!nextCard) {
        showToast("✅ 已经是最后一个任务了");
        return;
    }
    
    // 关闭当前对话框，增加延迟确保状态完全清理
    const currentDialog = document.querySelector(CONFIG.selectors.taskCard);
    if (currentDialog) {
        const closeBtn = currentDialog.querySelector('button[aria-label*="Close"], button[aria-label*="关闭"], .close-button, button[title*="关闭"], button[title*="Close"]');
        if (closeBtn) {
            closeBtn.click();
            // 增加延迟到500ms，确保Planner完全清理前一个任务的状态
            await new Promise(r => setTimeout(r, 500));
        }
    }
    
    flashTaskCard(nextCard);
    await new Promise(r => setTimeout(r, 450));
    
    nextCard.focus();
    nextCard.click();
    window._lastClickedTask = nextCard;
    window._hasClickedAnyTask = true;
    updateNavigationButtonStates();
    nextCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    setTimeout(() => {
        flashTaskDialog();
    }, 600);
    
    showToast("➡️ 已打开下一个任务");
}

async function upgradeTask(container) {
    if (!container) {
        showToast("❌ 未找到任务对话框");
        console.log('[PA] upgradeTask: container 为 null');
        return;
    }

    showToast("正在打开移动任务菜单...");

    // 查找更多按钮（三个点的图标）- 使用 path 的 d 属性匹配
    const moreBtn = Array.from(container.querySelectorAll('button'))
        .find(btn => {
            const svg = btn.querySelector('svg');
            if (!svg) return false;
            const path = svg.querySelector('path');
            if (!path) return false;
            const d = path.getAttribute('d');
            // 匹配三个圆点的 path（包含三个 "1.25 1.25" 的圆）
            return d && d.includes('1.25 1.25') && d.includes('2.5 0');
        });

    if (!moreBtn) {
        // 备用方案：查找所有按钮，找最后一个小按钮
        const allButtons = Array.from(container.querySelectorAll('button'));
        const smallButtons = allButtons.filter(btn => {
            const rect = btn.getBoundingClientRect();
            return rect.width < 50 && rect.height < 50 && btn.querySelector('svg');
        });
        
        if (smallButtons.length > 0) {
            console.log('[PA] 使用备用方案，找到', smallButtons.length, '个小按钮');
            const lastSmallBtn = smallButtons[smallButtons.length - 1];
            console.log('[PA] 尝试点击最后一个小按钮');
            lastSmallBtn.click();
            await new Promise(r => setTimeout(r, 600));
        } else {
            showToast("❌ 未找到更多按钮");
            console.log('[PA] 未找到更多按钮，容器中的所有按钮:', allButtons.length);
            return;
        }
    } else {
        console.log('[PA] 找到更多按钮（通过 SVG path），点击...');
        moreBtn.click();
        await new Promise(r => setTimeout(r, 600));
    }

    // 查找"移动任务"选项
    const moveItem = Array.from(document.querySelectorAll('.ms-ContextualMenu-itemText, button, [role="menuitem"]'))
        .find(el => {
            const text = el.innerText || el.textContent || '';
            return text.includes('移动任务') || text.includes('Move task');
        });

    if (!moveItem) {
        showToast("❌ 未找到移动任务选项");
        console.log('[PA] 未找到移动任务选项，可用选项:', 
            Array.from(document.querySelectorAll('.ms-ContextualMenu-itemText')).map(el => el.innerText));
        return;
    }

    console.log('[PA] 找到移动任务选项:', moveItem.innerText);
    // 如果是 span，点击父元素
    const clickTarget = moveItem.tagName === 'SPAN' ? moveItem.closest('button, [role="menuitem"]') || moveItem.parentElement : moveItem;
    clickTarget.click();
    await new Promise(r => setTimeout(r, 1000));

    // 查找移动对话框
    const moveDialog = document.querySelector('[role="dialog"], .ms-Dialog-main');
    if (!moveDialog) {
        showToast("❌ 未找到移动对话框");
        return;
    }

    console.log('[PA] 移动对话框已打开');

    // 查找计划选择器控件（包含下拉箭头的整个区域）
    let planControl = moveDialog.querySelector('.planControl');
    
    // 如果对话框内没找到，在整个文档中查找
    if (!planControl) {
        console.log('[PA] 对话框内未找到 planControl，在整个文档中查找...');
        planControl = document.querySelector('.planControl');
    }

    if (!planControl) {
        showToast("❌ 未找到计划选择器");
        console.log('[PA] 未找到计划选择器');
        return;
    }

    console.log('[PA] 找到计划选择器，点击打开下拉...');
    planControl.click();
    await new Promise(r => setTimeout(r, 2000)); // 等待2秒让下拉列表加载

    // 先尝试直接查找 TIER 3 选项（可能已经在列表中）
    let tier3Option = Array.from(document.querySelectorAll('.planPickerItem'))
        .find(item => {
            const title = item.getAttribute('title') || item.innerText || '';
            return title.includes('TIER 3') || title.includes('Tier 3');
        });

    if (tier3Option) {
        console.log('[PA] 直接找到 TIER 3 选项（无需搜索）:', tier3Option.getAttribute('title'));
        const optionContainer = tier3Option.closest('.planPickerOption') || tier3Option.parentElement;
        if (optionContainer) {
            optionContainer.click();
        } else {
            tier3Option.click();
        }
        await new Promise(r => setTimeout(r, 300));
        showToast("✅ 已选择 TIER 3，请点击移动按钮");
        return;
    }

    // 如果没找到，使用搜索功能
    console.log('[PA] 未直接找到 TIER 3，使用搜索...');
    
    // 查找搜索输入框
    let searchInput = document.querySelector('input[placeholder*="搜索计划"]');
    if (!searchInput) {
        searchInput = document.querySelector('input[type="text"][placeholder*="搜索"]');
    }
    if (!searchInput) {
        searchInput = document.querySelector('input[id*="TextField"]');
    }
    if (!searchInput) {
        const allInputs = Array.from(document.querySelectorAll('input[type="text"]'));
        searchInput = allInputs.find(input => {
            const rect = input.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
    }

    if (!searchInput) {
        showToast("❌ 未找到搜索框");
        console.log('[PA] 未找到搜索框');
        return;
    }

    console.log('[PA] 找到搜索框，输入 "tier 3"...');
    searchInput.focus();
    await new Promise(r => setTimeout(r, 200));
    searchInput.value = 'tier 3';
    setNativeValue(searchInput, 'tier 3');

    // 轮询查找 TIER 3 选项，最长等待 4 秒
    const maxWaitTime = 4000;
    const checkInterval = 300;
    const maxAttempts = Math.floor(maxWaitTime / checkInterval);
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, checkInterval));
        
        tier3Option = Array.from(document.querySelectorAll('.planPickerItem'))
            .find(item => {
                const title = item.getAttribute('title') || item.innerText || '';
                return title.includes('TIER 3') || title.includes('Tier 3');
            });
        
        if (tier3Option) {
            console.log(`[PA] 找到 TIER 3 选项（第 ${attempt + 1} 次尝试）:`, tier3Option.getAttribute('title'));
            const optionContainer = tier3Option.closest('.planPickerOption') || tier3Option.parentElement;
            if (optionContainer) {
                optionContainer.click();
            } else {
                tier3Option.click();
            }
            await new Promise(r => setTimeout(r, 300));
            showToast("✅ 已选择 TIER 3，请点击移动按钮");
            return;
        }
    }

    // 超时未找到
    showToast("❌ 搜索超时，未找到 TIER 3 选项");
    console.log('[PA] 搜索超时（4秒），未找到 TIER 3 选项');
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
}

// 执行任务：设置进度为"正在进行"，开始日期为今天，截止日期为7天后
async function startTask(container) {
    const dialog = document.querySelector(CONFIG.selectors.taskCard);
    if (!dialog) {
        showToast("⚠️ 未找到任务对话框");
        return;
    }
    
    showToast("正在执行任务...");
    console.log("[PA Debug] === 开始执行任务 ===");
    
    try {
        // 1. 设置进度为"正在进行"
        const progressLabel = findLabelElement(dialog, '进度') || findLabelElement(dialog, 'Progress');
        if (progressLabel) {
            const dropdown = progressLabel.parentElement.querySelector('[role="combobox"]');
            if (dropdown) {
                const currentStatus = dropdown.innerText.trim();
                if (!currentStatus.includes('正在进行') && !currentStatus.includes('In progress')) {
                    dropdown.click();
                    await new Promise(r => setTimeout(r, 600));
                    
                    const options = Array.from(document.querySelectorAll('[role="option"]'));
                    const target = options.find(opt => 
                        opt.innerText.includes('正在进行') || opt.innerText.includes('In progress')
                    );
                    
                    if (target) {
                        target.click();
                        await new Promise(r => setTimeout(r, 300));
                    }
                }
            }
        }
        
        // 2. 设置开始日期为今天
        console.log("[PA Debug] === 设置开始日期 ===");
        const startLabels = ['开始日期', 'Start date'];
        for (const labelText of startLabels) {
            const label = findLabelElement(dialog, labelText);
            console.log("[PA Debug] 找到label:", label);
            
            if (label) {
                // 如果label在wrapper中，需要从wrapper的父元素查找input
                const wrapper = label.closest('.pa-label-button-wrapper');
                console.log("[PA Debug] wrapper:", wrapper);
                const searchRoot = wrapper ? wrapper.parentElement : label.parentElement;
                console.log("[PA Debug] searchRoot:", searchRoot);
                
                if (searchRoot) {
                    // 如果searchRoot本身就是.ms-TextField-wrapper，直接使用；否则查找子元素
                    const inputContainer = searchRoot.classList.contains('ms-TextField-wrapper') 
                        ? searchRoot 
                        : searchRoot.querySelector('.ms-TextField-wrapper');
                    console.log("[PA Debug] inputContainer:", inputContainer);
                    const input = inputContainer ? inputContainer.querySelector('input') : null;
                    console.log("[PA Debug] input:", input);
                    console.log("[PA Debug] input.value before:", input ? input.value : 'null');
                    
                    if (input) {
                        await offsetDateInInput(input, 0, true);
                        console.log("[PA Debug] input.value after:", input.value);
                        await new Promise(r => setTimeout(r, 200));
                    }
                }
                break;
            }
        }
        
        // 3. 设置截止日期为7天后
        console.log("[PA Debug] === 设置截止日期 ===");
        const dueLabels = ['截止日期', 'Due date'];
        for (const labelText of dueLabels) {
            const label = findLabelElement(dialog, labelText);
            console.log("[PA Debug] 找到label:", label);
            
            if (label) {
                // 如果label在wrapper中，需要从wrapper的父元素查找input
                const wrapper = label.closest('.pa-label-button-wrapper');
                console.log("[PA Debug] wrapper:", wrapper);
                const searchRoot = wrapper ? wrapper.parentElement : label.parentElement;
                console.log("[PA Debug] searchRoot:", searchRoot);
                
                if (searchRoot) {
                    // 如果searchRoot本身就是.ms-TextField-wrapper，直接使用；否则查找子元素
                    const inputContainer = searchRoot.classList.contains('ms-TextField-wrapper') 
                        ? searchRoot 
                        : searchRoot.querySelector('.ms-TextField-wrapper');
                    console.log("[PA Debug] inputContainer:", inputContainer);
                    const input = inputContainer ? inputContainer.querySelector('input') : null;
                    console.log("[PA Debug] input:", input);
                    console.log("[PA Debug] input.value before:", input ? input.value : 'null');
                    
                    if (input) {
                        // 先设置为今天，然后加7天
                        const today = new Date();
                        const futureDate = new Date(today);
                        futureDate.setDate(today.getDate() + 7);
                        const dateStr = formatDate(futureDate);
                        console.log("[PA Debug] 设置日期为:", dateStr);
                        input.focus();
                        setNativeValue(input, dateStr);
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        input.blur();
                        console.log("[PA Debug] input.value after:", input.value);
                        await new Promise(r => setTimeout(r, 200));
                    }
                }
                break;
            }
        }
        
        console.log("[PA Debug] === 执行任务完成 ===");
        showToast("✅ 任务已设置为执行中");
    } catch (error) {
        console.error('[Planner Assistant] Error starting task:', error);
        showToast("❌ 执行任务失败");
    }
}

// 完成任务：设置截止日期为今天，进度为"已完成"
async function completeTask(container) {
    const dialog = document.querySelector(CONFIG.selectors.taskCard);
    if (!dialog) {
        showToast("⚠️ 未找到任务对话框");
        return;
    }
    
    showToast("正在完成任务...");
    
    try {
        // 1. 设置开始日期为今天（如果为空）
        const startLabels = ['开始日期', 'Start date'];
        for (const labelText of startLabels) {
            const label = findLabelElement(dialog, labelText);
            if (label) {
                // 如果label在wrapper中，需要从wrapper的父元素查找input
                const wrapper = label.closest('.pa-label-button-wrapper');
                const searchRoot = wrapper ? wrapper.parentElement : label.parentElement;
                
                if (searchRoot) {
                    // 如果searchRoot本身就是.ms-TextField-wrapper，直接使用；否则查找子元素
                    const inputContainer = searchRoot.classList.contains('ms-TextField-wrapper') 
                        ? searchRoot 
                        : searchRoot.querySelector('.ms-TextField-wrapper');
                    const input = inputContainer ? inputContainer.querySelector('input') : null;
                    
                    if (input && (!input.value || input.value.trim() === '')) {
                        await offsetDateInInput(input, 0, true);
                        await new Promise(r => setTimeout(r, 200));
                    }
                }
                break;
            }
        }
        
        // 2. 设置截止日期为今天（使用 offsetDateInInput）
        const dueLabels = ['截止日期', 'Due date'];
        for (const labelText of dueLabels) {
            const label = findLabelElement(dialog, labelText);
            if (label) {
                // 如果label在wrapper中，需要从wrapper的父元素查找input
                const wrapper = label.closest('.pa-label-button-wrapper');
                const searchRoot = wrapper ? wrapper.parentElement : label.parentElement;
                
                if (searchRoot) {
                    // 如果searchRoot本身就是.ms-TextField-wrapper，直接使用；否则查找子元素
                    const inputContainer = searchRoot.classList.contains('ms-TextField-wrapper') 
                        ? searchRoot 
                        : searchRoot.querySelector('.ms-TextField-wrapper');
                    const input = inputContainer ? inputContainer.querySelector('input') : null;
                    
                    if (input) {
                        await offsetDateInInput(input, 0, true);
                        await new Promise(r => setTimeout(r, 300));
                    }
                }
                break;
            }
        }
        
        // 3. 设置进度为"已完成"
        const progressLabel = findLabelElement(dialog, '进度') || findLabelElement(dialog, 'Progress');
        if (progressLabel) {
            const dropdown = progressLabel.parentElement.querySelector('[role="combobox"]');
            if (dropdown) {
                const currentStatus = dropdown.innerText.trim();
                if (!currentStatus.includes('已完成') && !currentStatus.includes('Completed')) {
                    dropdown.click();
                    await new Promise(r => setTimeout(r, 600));
                    
                    const options = Array.from(document.querySelectorAll('[role="option"]'));
                    const target = options.find(opt => 
                        opt.innerText.includes('已完成') || opt.innerText.includes('Completed')
                    );
                    
                    if (target) {
                        target.click();
                        await new Promise(r => setTimeout(r, 300));
                    }
                }
            }
        }
        
        showToast("✅ 任务已标记为完成");
    } catch (error) {
        console.error('[Planner Assistant] Error completing task:', error);
        showToast("❌ 完成任务失败");
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
