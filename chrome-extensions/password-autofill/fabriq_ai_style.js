// Fabriq AI 栏 / 对比弹窗 / 页面按钮的样式（由 content_fabriq_ai.js 注入）。
(() => {
  'use strict';
  const build = ({ BAR_ID, PANEL_ID, COMPARE_ID }) => `
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
  #${PANEL_ID} .mwa-status .mwa-msg{white-space:pre-line}
  #${PANEL_ID} .mwa-hbtns{display:inline-flex;align-items:center;gap:6px}
  #${PANEL_ID} header{position:relative}
  #${PANEL_ID} .mwa-tool{border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#475569;border-radius:8px;padding:2px 8px}
  #${PANEL_ID} .mwa-tool:hover,#${PANEL_ID} .mwa-tool[aria-expanded=true]{background:#e2e8f0}
  #${PANEL_ID} .mwa-menu{position:absolute;top:calc(100% - 4px);right:12px;z-index:5;min-width:200px;padding:6px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;box-shadow:0 10px 30px #0f172a2e}
  #${PANEL_ID} .mwa-menu-item{display:flex;width:100%;align-items:center;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:#1f2937;font:inherit;text-align:left;cursor:pointer}
  #${PANEL_ID} .mwa-menu-item:hover{background:#eff6ff;color:#1d4ed8}
  #${PANEL_ID} .mwa-menu [hidden]{display:flex!important;opacity:.4;pointer-events:none}

  #${PANEL_ID} .mwa-section{margin-top:14px}
  #${PANEL_ID} .mwa-optimize,#${PANEL_ID} .mwa-direction{margin-top:22px;padding-top:18px;border-top:1px solid #d9dde3}
  #${PANEL_ID} .mwa-mod-b>.mwa-section h3{margin:0 0 10px}
  #${PANEL_ID} .mwa-cap{margin:10px 0 4px;font-size:12px;color:#64748b}
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
  #${PANEL_ID} .mwa-mod.open .mwa-mod-h{background:#eef2f7;color:#0f172a;box-shadow:inset 3px 0 0 #2563eb;border-bottom:1px solid #dbe3ee}
  #${PANEL_ID} .mwa-mod.open .mwa-mod-h small{color:#64748b}
  #${PANEL_ID} .mwa-mod.open .mwa-sign{background:#fff;border-color:#94a3b8;color:#334155}
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
  #${PANEL_ID} .mwa-optimize .mwa-actions{margin-bottom:18px}
  #${PANEL_ID} .mwa-optimize .mwa-big{margin-top:6px}
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

  globalThis.MwaFabriqStyle = { build };
})();
