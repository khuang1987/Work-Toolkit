console.log("📊 PowerBI Assistant Loaded");

// PowerBI 页面增强功能
// 预留未来功能扩展

document.addEventListener('keydown', (e) => {
    // 忽略输入框
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // [ 和 ]: 页面导航（预留功能）
    if (e.key === '[') {
        console.log("PBI: Previous Page");
        // 可以实现点击上一页按钮
    } else if (e.key === ']') {
        console.log("PBI: Next Page");
        // 可以实现点击下一页按钮
    }
});

console.log('[PBI Assistant] PowerBI 助手已加载');
