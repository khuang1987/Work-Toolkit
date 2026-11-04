// 右下角可折叠悬浮面板（亮色 iOS 风格），默认折叠为圆角图标，供 Cornerstone / Workday 等页面共用。
(() => {
  if (globalThis.MwaDock) return;

  const STYLE_ID = 'mwa-dock-style';
  const css = `
  .mwa-dock{position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","Microsoft YaHei",sans-serif;color:#1c1c1e;text-align:left;letter-spacing:0;text-transform:none}
  .mwa-dock *,.mwa-dock *::before,.mwa-dock *::after{box-sizing:border-box;font-family:inherit;letter-spacing:0}
  .mwa-dock [hidden]{display:none!important}
  .mwa-dock-fab{position:relative;display:none;width:48px;height:48px;margin:0;padding:0;border:1px solid rgba(60,60,67,.14);border-radius:12px;background:#fff;box-shadow:0 6px 20px rgba(0,0,0,.18);cursor:pointer;transition:transform .15s}
  .mwa-dock-fab:hover{transform:scale(1.06)}
  .mwa-dock-fab img{display:block;width:100%;height:100%;border-radius:11px;object-fit:cover}
  .mwa-dock.collapsed .mwa-dock-fab{display:block}
  .mwa-dock.collapsed .mwa-dock-card{display:none}
  .mwa-dock.active .mwa-dock-fab::after{content:"";position:absolute;top:-4px;right:-4px;width:13px;height:13px;border-radius:50%;background:#34c759;border:2px solid #fff}
  .mwa-dock-card{width:288px;max-width:calc(100vw - 32px);background:rgba(255,255,255,.95);-webkit-backdrop-filter:saturate(180%) blur(24px);backdrop-filter:saturate(180%) blur(24px);border:1px solid rgba(60,60,67,.12);border-radius:18px;box-shadow:0 14px 44px rgba(0,0,0,.2);overflow:hidden;animation:mwa-dock-pop .22s cubic-bezier(.2,.8,.2,1);transform-origin:100% 100%}
  @keyframes mwa-dock-pop{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}
  .mwa-dock-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(60,60,67,.1)}
  .mwa-dock-ico{width:24px;height:24px;border-radius:6px;flex:none;border:1px solid rgba(60,60,67,.12)}
  .mwa-dock-title{font-size:14px;font-weight:600;white-space:nowrap}
  .mwa-dock-status{flex:1;min-width:0;text-align:right;font-size:12px;color:#8e8e93;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mwa-dock-min{flex:none;width:26px;height:26px;padding:0;border:0;border-radius:50%;background:rgba(120,120,128,.16);color:#3a3a3c;font-size:16px;line-height:26px;cursor:pointer}
  .mwa-dock-min:hover{background:rgba(120,120,128,.26)}
  .mwa-dock-body{padding:12px;max-height:min(70vh,520px);overflow:auto}
  .mwa-dock .mwa-btn{appearance:none;border:0;border-radius:10px;padding:8px 12px;background:#007aff;color:#fff;font-size:13px;font-weight:600;line-height:1.3;cursor:pointer;transition:filter .15s,transform .05s}
  .mwa-dock .mwa-btn:hover{filter:brightness(1.07)}
  .mwa-dock .mwa-btn:active{transform:scale(.97)}
  .mwa-dock .mwa-btn:disabled{opacity:.5;cursor:default}
  .mwa-dock .mwa-btn.green{background:#34c759}
  .mwa-dock .mwa-btn.orange{background:#ff9500}
  .mwa-dock .mwa-btn.indigo{background:#5856d6}
  .mwa-dock .mwa-btn.danger{background:#ff3b30}
  .mwa-dock .mwa-btn.gray{background:rgba(120,120,128,.16);color:#007aff}
  .mwa-dock .mwa-btn.block{display:block;width:100%}
  .mwa-dock .mwa-inp{width:100%;border:0;border-radius:8px;background:rgba(120,120,128,.12);padding:7px 9px;color:#1c1c1e;font-size:13px;outline:none;color-scheme:light}
  .mwa-dock .mwa-inp:focus{box-shadow:0 0 0 2px rgba(0,122,255,.45)}
  .mwa-dock .mwa-inp.num{width:58px;flex:none;text-align:center;padding:7px 4px}
  .mwa-dock .mwa-hint{margin:0 0 10px;color:#6c6c70;font-size:12px;line-height:1.5}
  .mwa-dock .mwa-actions{display:flex;gap:8px;align-items:center;margin-bottom:8px}
  .mwa-dock .mwa-actions .mwa-btn{flex:1;min-width:0}
  .mwa-dock .mwa-field{display:flex;align-items:center;gap:6px;margin-bottom:8px;color:#3a3a3c;font-size:12px}
  .mwa-dock .mwa-seg{display:flex;gap:2px;padding:2px;margin-bottom:10px;border-radius:9px;background:rgba(120,120,128,.12)}
  .mwa-dock .mwa-seg button{flex:1;border:0;border-radius:7px;background:transparent;padding:5px 8px;color:#1c1c1e;font-size:12px;font-weight:500;cursor:pointer}
  .mwa-dock .mwa-seg button.on{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.16);font-weight:600}
  .mwa-dock .mwa-log{height:96px;margin-top:10px;padding:8px;overflow:auto;border-radius:10px;background:rgba(120,120,128,.1);color:#3a3a3c;font-size:11.5px;line-height:1.55}
  .mwa-dock .mwa-list{overflow:hidden;border-radius:12px;background:rgba(120,120,128,.08)}
  .mwa-dock .mwa-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px}
  .mwa-dock .mwa-row+.mwa-row{border-top:1px solid rgba(60,60,67,.1)}
  .mwa-dock .mwa-row .mwa-btn{flex:none;width:96px}
  .mwa-dock .mwa-row > span{color:#1c1c1e;font-size:13px}
  `;

  const docks = new Map();

  function make(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    children.forEach(child => node.append(child));
    return node;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    (document.head || document.documentElement).append(make('style', { id: STYLE_ID, textContent: css }));
  }

  function create({ id, title, icon, collapsed = true }) {
    if (docks.has(id) && document.getElementById(id)) return docks.get(id);
    injectStyle();
    const iconUrl = icon ? chrome.runtime.getURL(icon) : '';
    const fab = make('button', { type: 'button', className: 'mwa-dock-fab', title: `展开${title}` });
    fab.setAttribute('aria-label', `展开${title}`);
    if (iconUrl) fab.append(make('img', { src: iconUrl, alt: '' }));
    const status = make('span', { className: 'mwa-dock-status' });
    const min = make('button', { type: 'button', className: 'mwa-dock-min', textContent: '–', title: '收起为图标' });
    min.setAttribute('aria-label', `收起${title}`);
    const body = make('div', { className: 'mwa-dock-body' });
    const head = make('div', { className: 'mwa-dock-head' },
      ...(iconUrl ? [make('img', { className: 'mwa-dock-ico', src: iconUrl, alt: '' })] : []),
      make('span', { className: 'mwa-dock-title', textContent: title }), status, min);
    const card = make('div', { className: 'mwa-dock-card' }, head, body);
    const root = make('div', { id, className: 'mwa-dock' + (collapsed ? ' collapsed' : '') }, fab, card);
    const api = {
      root, body, status,
      isCollapsed: () => root.classList.contains('collapsed'),
      setCollapsed(value) { root.classList.toggle('collapsed', !!value); },
      setActive(value) { root.classList.toggle('active', !!value); }
    };
    fab.addEventListener('click', () => api.setCollapsed(false));
    min.addEventListener('click', () => api.setCollapsed(true));
    docks.set(id, api);
    document.body.append(root);
    return api;
  }

  globalThis.MwaDock = { create, get: id => docks.get(id) || null, make };
})();
