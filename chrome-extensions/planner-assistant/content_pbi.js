console.log("📊 PowerBI Assistant Loaded");

// Placeholder for future PowerBI features
document.addEventListener('keydown', (e) => {
    // Page Navigation using [ and ]
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === '[') {
        console.log("PBI: Previous Page");
        // Implement click on prev page button
    } else if (e.key === ']') {
        console.log("PBI: Next Page");
        // Implement click on next page button
    }
});
