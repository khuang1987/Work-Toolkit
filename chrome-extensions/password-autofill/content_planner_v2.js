// [Planner Assistant v2.0.19]
console.log("[Planner Assistant v2.0.19] Content Script Injected");

// --- State ---
let currentTaskCard = null;
window._lastClickedTask = null;

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

function showToast(msg) {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed; bottom:50px; left:50%; transform:translateX(-50%); background:#333; color:white; padding:5px 15px; border-radius:10px; z-index:999999; font-size:12px;';
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
}

// --- Injection ---

// 页面加载时立即创建悬浮面板和助手按钮
setTimeout(() => {
    if (!document.querySelector('.pa-floating-panel')) {
        console.log("[Planner Assistant] Creating floating panel on page load");
        injectUpgradeButton(null);
    }
}, 1000);

const observer = new MutationObserver(() => {
    const dialog = document.querySelector(CONFIG.selectors.taskCard);
    if (dialog && (dialog !== currentTaskCard || !dialog.querySelector('.pa-header-buttons'))) {
        currentTaskCard = dialog;
        setTimeout(() => {
            injectInlineButtons(dialog);
        }, 600);
    } else if (!dialog) {
        currentTaskCard = null;
    }
});
observer.observe(document.body, { childList: true, subtree: true });

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
    }
    
    if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (currentTaskCard) {
            openPrevTask(currentTaskCard);
        }
    }
    
    if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (currentTaskCard) {
            openNextTask(currentTaskCard);
        }
    }
});


function injectInlineButtons(container) {
    console.log("[Planner Assistant] injectInlineButtons called");
    const labels = ['开始日期', '截止日期', 'Start date', 'Due date'];
    labels.forEach(lText => {
        const label = findLabelElement(container, lText);
        console.log(`[Planner Assistant] Looking for label: ${lText}, found:`, label);
        if (label && label.parentElement) {
            if (label.closest('.pa-label-button-wrapper')) {
                console.log(`[Planner Assistant] Label ${lText} already in wrapper, skipping`);
                return;
            }
            
            const inputContainer = label.parentElement.querySelector('.ms-TextField-wrapper') || label.parentElement;
            const input = inputContainer.querySelector('input');
            console.log(`[Planner Assistant] Found input for ${lText}:`, input);
            if (input) {
                const inputParent = input.closest('.ms-TextField-wrapper') || input.parentElement;
                if (inputParent) {
                    const oldRows = Array.from(inputParent.parentElement.querySelectorAll('.pa-inline-btn-row'));
                    console.log(`[Planner Assistant] Found ${oldRows.length} old button rows to clean`);
                    oldRows.forEach(row => {
                        if (!row.closest('.pa-label-button-wrapper')) {
                            console.log(`[Planner Assistant] Removing old button row`);
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
                console.log(`[Planner Assistant] Injected buttons for ${lText}`);
            }
        }
    });
}

function injectUpgradeButton(container) {
    console.log("[Planner Assistant] injectUpgradeButton called");
    if (document.querySelector('.pa-floating-panel')) {
        console.log("[Planner Assistant] Floating panel already exists, skipping");
        return;
    }

    console.log("[Planner Assistant] Creating draggable floating panel");
    
    const floatingPanel = document.createElement('div');
    floatingPanel.className = 'pa-floating-panel';
    floatingPanel.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 10000000; background: rgba(0, 0, 0, 0.9); border-radius: 10px; padding: 12px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); cursor: move; user-select: none; backdrop-filter: blur(10px); min-width: 240px; max-width: 280px; max-height: 200px; border: 2px solid rgba(255, 255, 255, 0.3); display: block; width: fit-content; height: auto;';
    
    const titleBar = document.createElement('div');
    titleBar.className = 'pa-panel-title';
    titleBar.style.cssText = 'color: white; font-size: 12px; font-weight: bold; margin-bottom: 8px; text-align: center; padding: 3px; cursor: move; letter-spacing: 0.5px;';
    titleBar.innerText = '🎯 Tier Meeting Assistant';
    
    const filterSection = document.createElement('div');
    filterSection.className = 'pa-filter-section';
    filterSection.style.cssText = 'margin-bottom: 8px; display: flex; gap: 4px;';
    
    const filterButtons = [
        { label: '🔄 全部', filterType: null, filterValue: null },
        { label: '⚠️ 晚点', filterType: 'dueDate', filterValue: '晚点' },
        { label: '📊 本周', filterType: 'dueDate', filterValue: '本周' },
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
    btnContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0;';
    
    const navRow = document.createElement('div');
    navRow.style.cssText = 'display: flex; gap: 6px;';
    
    const prevBtn = document.createElement('button');
    prevBtn.className = 'pa-prev-task-btn';
    prevBtn.innerText = '⬅️ 上一个';
    prevBtn.style.cssText = 'flex: 1;';
    prevBtn.onclick = (e) => {
        e.preventDefault(); 
        e.stopPropagation();
        e.stopImmediatePropagation();
        openPrevTask(container);
    };
    prevBtn.onmousedown = (e) => {
        e.stopPropagation();
    };
    
    const nextBtn = document.createElement('button');
    nextBtn.className = 'pa-next-task-btn';
    nextBtn.innerText = '➡️ 下一个';
    nextBtn.style.cssText = 'flex: 1;';
    nextBtn.onclick = (e) => {
        e.preventDefault(); 
        e.stopPropagation();
        e.stopImmediatePropagation();
        openNextTask(container);
    };
    nextBtn.onmousedown = (e) => {
        e.stopPropagation();
    };
    
    navRow.appendChild(prevBtn);
    navRow.appendChild(nextBtn);
    
    const upgradeBtn = document.createElement('button');
    upgradeBtn.className = 'pa-upgrade-t3-btn';
    upgradeBtn.innerText = '🚀 升级 T3';
    upgradeBtn.onclick = (e) => {
        e.preventDefault(); 
        e.stopPropagation();
        e.stopImmediatePropagation();
        upgradeTask(container);
    };
    upgradeBtn.onmousedown = (e) => {
        e.stopPropagation();
    };
    
    btnContainer.appendChild(navRow);
    btnContainer.appendChild(upgradeBtn);
    
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
    
    console.log("[Planner Assistant] Floating panel created successfully");
    
    createToolbarToggleButton(floatingPanel);
}


function createToolbarToggleButton(floatingPanel, retryCount = 0) {
    if (document.querySelector('.pa-toolbar-toggle-btn')) {
        console.log('[Planner Assistant] Toggle button already exists');
        return;
    }
    
    if (retryCount >= 3) {
        console.warn('[Planner Assistant] Failed to find share button after 3 retries, giving up');
        return;
    }
    
    let shareButton = Array.from(document.querySelectorAll('button'))
        .find(btn => {
            const text = btn.innerText || btn.getAttribute('aria-label') || '';
            return text.includes('共享') || text.includes('Share');
        });
    
    if (!shareButton) {
        console.log('[Planner Assistant] Trying to find share button by structure');
        const buttons = document.querySelectorAll('button .ms-Button-label');
        for (const label of buttons) {
            if (label.innerText.includes('共享') || label.innerText.includes('Share')) {
                shareButton = label.closest('button');
                console.log('[Planner Assistant] Found share button by label structure');
                break;
            }
        }
    }
    
    if (!shareButton) {
        console.warn(`[Planner Assistant] Share button not found, retrying in 2 seconds... (attempt ${retryCount + 1}/3)`);
        setTimeout(() => createToolbarToggleButton(floatingPanel, retryCount + 1), 2000);
        return;
    }
    
    console.log('[Planner Assistant] Found share button, creating toggle button');
    
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
        console.log('[Planner Assistant] Toggle button created successfully (before share button)');
    } else {
        console.warn('[Planner Assistant] Cannot insert toggle button, share button has no parent');
    }
}

async function applyFilter(filterType, filterValue) {
    console.log(`[Planner Assistant] Applying filter: ${filterType} = ${filterValue}`);
    
    if (filterValue === null) {
        showToast(`正在清除所有筛选...`);
    } else {
        showToast(`正在应用筛选: ${filterValue}...`);
    }
    
    try {
        const filterButton = Array.from(document.querySelectorAll('button, [role="button"]'))
            .find(btn => {
                const text = btn.innerText || btn.getAttribute('aria-label') || '';
                return text.includes('筛选器') || text.includes('Filter');
            });
        
        if (!filterButton) {
            showToast('❌ 未找到筛选器按钮');
            console.error('[Planner Assistant] Filter button not found');
            return;
        }
        
        console.log('[Planner Assistant] Found filter button:', filterButton);
        
        filterButton.click();
        console.log('[Planner Assistant] Clicked filter button, waiting 300ms...');
        await new Promise(r => setTimeout(r, 300));
        
        const filterPanel = document.querySelector('[role="dialog"], [role="menu"], .ms-Panel, .ms-ContextualMenu, .filter-panel, [class*="callout"], [class*="Callout"]');
        if (!filterPanel) {
            showToast('❌ 筛选面板未打开');
            console.error('[Planner Assistant] Filter panel not found');
            return;
        }
        
        console.log('[Planner Assistant] Found filter panel:', filterPanel);
        
        const clearAllButton = Array.from(document.querySelectorAll('button, [role="button"]'))
            .find(btn => {
                const text = btn.innerText || btn.textContent || '';
                return text.includes('全部清除') || text.includes('Clear all');
            });
        
        if (clearAllButton) {
            console.log('[Planner Assistant] Found "Clear All" button, clicking it');
            clearAllButton.click();
            await new Promise(r => setTimeout(r, 300));
        } else {
            console.warn('[Planner Assistant] "Clear All" button not found');
        }
        
        if (filterValue === null) {
            showToast('✅ 已清除所有筛选');
            filterButton.click();
            return;
        }
        
        let categoryName = '';
        if (filterType === 'dueDate') {
            categoryName = '截止日期';
        } else if (filterType === 'progress') {
            categoryName = '进度';
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
            console.error(`[Planner Assistant] ${categoryName} option not found`);
            return;
        }
        
        console.log(`[Planner Assistant] Found ${categoryName} option:`, categoryOption);
        
        const categoryButton = categoryOption.tagName === 'BUTTON' ? categoryOption : categoryOption.closest('button, [role="menuitem"]');
        if (categoryButton) {
            console.log('[Planner Assistant] Clicking category button');
            categoryButton.click();
        } else {
            console.log('[Planner Assistant] Clicking category option directly');
            categoryOption.click();
        }
        
        console.log('[Planner Assistant] Waiting 300ms for submenu to expand...');
        await new Promise(r => setTimeout(r, 300));
        console.log('[Planner Assistant] Submenu should be expanded now');
        
        console.log(`[Planner Assistant] Looking for filter value: "${filterValue}"`);
        
        let filterValueOption = null;
        
        const allMenus = document.querySelectorAll('[role="menu"], .ms-ContextualMenu, [class*="callout"], [class*="Callout"]');
        console.log(`[Planner Assistant] Found ${allMenus.length} menus after category click`);
        
        for (let i = 0; i < allMenus.length; i++) {
            const menu = allMenus[i];
            console.log(`[Planner Assistant] Checking menu ${i + 1}/${allMenus.length}`);
            
            const options = Array.from(menu.querySelectorAll(
                '[role="option"], [role="menuitemcheckbox"], [role="menuitem"], ' +
                '.ms-ContextualMenu-link, .ms-ContextualMenu-item, ' +
                'button, li, div[class*="item"]'
            ));
            console.log(`[Planner Assistant] Found ${options.length} potential options in menu ${i + 1}`);
            
            for (const el of options) {
                const text = el.innerText || el.textContent || '';
                const trimmedText = text.trim();
                
                if (trimmedText === filterValue) {
                    filterValueOption = el;
                    console.log(`[Planner Assistant] ✅ Found exact match in menu ${i + 1}!`);
                    break;
                }
            }
            
            if (filterValueOption) {
                break;
            }
        }
        
        if (!filterValueOption) {
            showToast(`❌ 未找到选项: ${filterValue}`);
            console.error(`[Planner Assistant] Filter value option not found: ${filterValue}`);
            return;
        }
        
        console.log('[Planner Assistant] Found filter value option:', filterValueOption);
        
        console.log(`[Planner Assistant] Clicking target option: "${filterValue}"`);
        
        const checkboxInput = filterValueOption.querySelector('input[type="checkbox"]');
        if (checkboxInput) {
            console.log('[Planner Assistant] Found checkbox input, clicking it');
            checkboxInput.click();
        } else {
            console.log('[Planner Assistant] No checkbox input found, clicking element directly');
            filterValueOption.click();
        }
        
        await new Promise(r => setTimeout(r, 500));
        
        showToast(`✅ 已应用筛选: ${filterValue}`);
        console.log(`[Planner Assistant] Filter applied successfully: ${filterValue}`);
        
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
    console.log("[Planner Assistant] 打开上一个任务");
    
    let currentCard = window._lastClickedTask;
    
    if (!currentCard) {
        console.log("[Planner Assistant] No _lastClickedTask, trying to find from all cards");
        const allCards = Array.from(document.querySelectorAll(CONFIG.selectors.card));
        if (allCards.length > 0) {
            currentCard = allCards[0];
            console.log("[Planner Assistant] Using first card as fallback");
        }
    }
    
    if (!currentCard) {
        showToast("⚠️ 未找到当前任务，请先点击一个任务卡片");
        return;
    }
    
    console.log("[Planner Assistant] Current card:", currentCard);
    
    const currentBucket = currentCard.closest(CONFIG.selectors.bucket);
    if (!currentBucket) {
        showToast("⚠️ 未找到当前存储桶");
        return;
    }
    
    console.log("[Planner Assistant] Current bucket:", currentBucket);
    
    const cards = Array.from(currentBucket.querySelectorAll(CONFIG.selectors.card));
    const currentIndex = cards.indexOf(currentCard);
    
    console.log(`[Planner Assistant] Found ${cards.length} cards, current index: ${currentIndex}`);
    
    if (currentIndex === -1) {
        if (cards.length > 0) {
            currentCard = cards[0];
            console.log("[Planner Assistant] Current card not in list, using first card");
        } else {
            showToast("⚠️ 未找到任务卡片");
            return;
        }
    }
    
    let prevCard = null;
    const actualIndex = cards.indexOf(currentCard);
    
    if (actualIndex > 0) {
        prevCard = cards[actualIndex - 1];
        console.log("[Planner Assistant] Prev card in same bucket");
    } else {
        const buckets = Array.from(document.querySelectorAll(CONFIG.selectors.bucket));
        const bucketIndex = buckets.indexOf(currentBucket);
        console.log(`[Planner Assistant] First card in bucket, trying prev bucket. Current bucket index: ${bucketIndex}/${buckets.length}`);
        
        if (bucketIndex > 0) {
            const prevBucket = buckets[bucketIndex - 1];
            const prevBucketCards = Array.from(prevBucket.querySelectorAll(CONFIG.selectors.card));
            if (prevBucketCards.length > 0) {
                prevCard = prevBucketCards[prevBucketCards.length - 1];
                console.log("[Planner Assistant] Found prev bucket with card");
            }
        }
    }
    
    if (!prevCard) {
        showToast("✅ 已经是第一个任务了");
        return;
    }
    
    console.log("[Planner Assistant] Prev card:", prevCard);
    
    const currentDialog = document.querySelector(CONFIG.selectors.taskCard);
    if (currentDialog) {
        const closeBtn = currentDialog.querySelector('button[aria-label*="Close"], button[aria-label*="关闭"], .close-button, button[title*="关闭"], button[title*="Close"]');
        if (closeBtn) {
            console.log("[Planner Assistant] Closing current dialog");
            closeBtn.click();
            await new Promise(r => setTimeout(r, 300));
        } else {
            console.warn("[Planner Assistant] Close button not found in current dialog");
        }
    } else {
        console.warn("[Planner Assistant] No dialog currently open");
    }
    
    flashTaskCard(prevCard);
    await new Promise(r => setTimeout(r, 450));
    
    console.log("[Planner Assistant] Opening prev task");
    prevCard.focus();
    prevCard.click();
    window._lastClickedTask = prevCard;
    prevCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    setTimeout(() => {
        flashTaskDialog();
    }, 600);
    
    showToast("⬅️ 已打开上一个任务");
}

async function openNextTask(container) {
    console.log("[Planner Assistant] 打开下一个任务");
    
    let currentCard = window._lastClickedTask;
    
    if (!currentCard) {
        console.log("[Planner Assistant] No _lastClickedTask, trying to find from all cards");
        const allCards = Array.from(document.querySelectorAll(CONFIG.selectors.card));
        if (allCards.length > 0) {
            currentCard = allCards[0];
            console.log("[Planner Assistant] Using first card as fallback");
        }
    }
    
    if (!currentCard) {
        showToast("⚠️ 未找到当前任务，请先点击一个任务卡片");
        return;
    }
    
    console.log("[Planner Assistant] Current card:", currentCard);
    
    const currentBucket = currentCard.closest(CONFIG.selectors.bucket);
    if (!currentBucket) {
        showToast("⚠️ 未找到当前存储桶");
        return;
    }
    
    console.log("[Planner Assistant] Current bucket:", currentBucket);
    
    const cards = Array.from(currentBucket.querySelectorAll(CONFIG.selectors.card));
    const currentIndex = cards.indexOf(currentCard);
    
    console.log(`[Planner Assistant] Found ${cards.length} cards, current index: ${currentIndex}`);
    
    if (currentIndex === -1) {
        if (cards.length > 0) {
            currentCard = cards[0];
            console.log("[Planner Assistant] Current card not in list, using first card");
        } else {
            showToast("⚠️ 未找到任务卡片");
            return;
        }
    }
    
    let nextCard = null;
    const actualIndex = cards.indexOf(currentCard);
    
    if (actualIndex < cards.length - 1) {
        nextCard = cards[actualIndex + 1];
        console.log("[Planner Assistant] Next card in same bucket");
    } else {
        const buckets = Array.from(document.querySelectorAll(CONFIG.selectors.bucket));
        const bucketIndex = buckets.indexOf(currentBucket);
        console.log(`[Planner Assistant] Last card in bucket, trying next bucket. Current bucket index: ${bucketIndex}/${buckets.length}`);
        
        if (bucketIndex < buckets.length - 1) {
            const nextBucket = buckets[bucketIndex + 1];
            nextCard = nextBucket.querySelector(CONFIG.selectors.card);
            console.log("[Planner Assistant] Found next bucket with card");
        }
    }
    
    if (!nextCard) {
        showToast("✅ 已经是最后一个任务了");
        return;
    }
    
    console.log("[Planner Assistant] Next card:", nextCard);
    
    const currentDialog = document.querySelector(CONFIG.selectors.taskCard);
    if (currentDialog) {
        const closeBtn = currentDialog.querySelector('button[aria-label*="Close"], button[aria-label*="关闭"], .close-button, button[title*="关闭"], button[title*="Close"]');
        if (closeBtn) {
            console.log("[Planner Assistant] Closing current dialog");
            closeBtn.click();
            await new Promise(r => setTimeout(r, 300));
        } else {
            console.warn("[Planner Assistant] Close button not found in current dialog");
        }
    } else {
        console.warn("[Planner Assistant] No dialog currently open");
    }
    
    flashTaskCard(nextCard);
    await new Promise(r => setTimeout(r, 450));
    
    console.log("[Planner Assistant] Opening next task");
    nextCard.focus();
    nextCard.click();
    window._lastClickedTask = nextCard;
    nextCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    setTimeout(() => {
        flashTaskDialog();
    }, 600);
    
    showToast("➡️ 已打开下一个任务");
}

async function upgradeTask(container) {
    showToast("正在执行 T3 升级流程...");

    const moreBtn = container.querySelector('button[aria-label*="More"], button[aria-label*="更多"], .close-button + button, .ms-Panel-navigation button:last-child');
    if (!moreBtn) {
        showToast("未找到 '...' 菜单");
        return;
    }

    moreBtn.click();
    await new Promise(r => setTimeout(r, 600));

    const moveItem = Array.from(document.querySelectorAll('button, .ms-ContextualMenu-itemText'))
        .find(el => el.innerText.includes('移动任务') || el.innerText.includes('Move task'));

    if (!moveItem) {
        showToast("未找到 '移动任务' 选项");
        return;
    }

    moveItem.click();
    await new Promise(r => setTimeout(r, 1000));

    const moveDialog = document.querySelector('[role="dialog"], .ms-Dialog-main');
    if (moveDialog) {
        console.log("[Planner Assistant] Move dialog detected");
        
        const searchInput = moveDialog.querySelector('input[type="text"], input[placeholder*="搜索"], input[placeholder*="Search"]');
        if (searchInput) {
            console.log("[Planner Assistant] Found search input, typing 'tier 3'");
            searchInput.focus();
            searchInput.value = 'tier 3';
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            searchInput.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(r => setTimeout(r, 800));
        }
        
        const planDropdown = moveDialog.querySelector('[role="combobox"]');
        if (planDropdown) {
            planDropdown.click();
            await new Promise(r => setTimeout(r, 800));

            const options = Array.from(document.querySelectorAll('[role="option"], .ms-Dropdown-item'));
            const target = options.find(opt => opt.innerText.includes('TIER 3') || opt.innerText.includes('Tier 3'));

            if (target) {
                target.click();
                showToast("已选中 T3 目标，正在确认...");
                await new Promise(r => setTimeout(r, 800));

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
}
