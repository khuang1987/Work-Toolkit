// Workday 职务申请批量助手：记住当前表单值 → 批量新开标签页按序号递增填写 → 停在“提交”前由用户手动提交
(() => {
  if (window.__wdReqLoaded) return;
  window.__wdReqLoaded = true;

  const STORE_KEY = 'wdReqTemplate';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const norm = s => (s || '').replace(/\s+/g, ' ').replace(/[*＊]/g, '').trim();

  function isReqPage() {
    const h = document.querySelector('[data-automation-id="pageHeaderTitleText"], h1, h2');
    const t = (h && h.textContent) || document.title || '';
    // 助手面板自身含「职务申请」标签，需从页面文本中剔除，避免误判
    const dockText = document.getElementById('wd-auto-panel')?.innerText || '';
    const body = (document.body?.innerText || '').replace(dockText, '').slice(0, 3000);
    return /职务申请|職務申請|Job Requisition/i.test(t) || /职务申请|Job Requisition/i.test(body);
  }

  // ── 字段扫描 ──
  function fieldContainer(label) {
    return label.closest('li') || label.closest('[data-automation-id$="FormField"], [data-automation-id^="formField"]') || label.parentElement?.parentElement;
  }

  function scanFields() {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('label[data-automation-id="formLabel"], [data-automation-id="formLabel"]').forEach(label => {
      const name = norm(label.textContent);
      if (!name || seen.has(name)) return;
      const box = fieldContainer(label);
      if (!box) return;
      seen.add(name);
      out.push({ name, box });
    });
    return out;
  }

  function readField(box) {
    const pills = [...box.querySelectorAll('[data-automation-id="selectedItem"]')];
    if (pills.length) {
      return { type: 'prompt', value: pills.map(p => norm(p.getAttribute('title') || p.textContent)) };
    }
    const radios = [...box.querySelectorAll('input[type="radio"]')];
    if (radios.length) {
      const c = radios.find(r => r.checked);
      if (!c) return { type: 'radio', value: '' };
      const lab = c.id && document.querySelector(`label[for="${CSS.escape(c.id)}"]`);
      return { type: 'radio', value: norm(lab ? lab.textContent : c.parentElement?.textContent) };
    }
    const cbs = [...box.querySelectorAll('input[type="checkbox"]')];
    if (cbs.length === 1) return { type: 'checkbox', value: cbs[0].checked };
    const ta = box.querySelector('textarea');
    if (ta) return { type: 'text', value: ta.value };
    const sel = box.querySelector('button[aria-haspopup="listbox"]');
    if (sel) return { type: 'select', value: norm(sel.textContent) };
    const inp = box.querySelector('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([data-automation-id="searchBox"])');
    if (inp) return { type: 'text', value: inp.value };
    return null;
  }

  function captureTemplate() {
    const fields = [];
    let seq = null;
    for (const { name, box } of scanFields()) {
      const r = readField(box);
      if (!r) continue;
      if (r.value === '' || (Array.isArray(r.value) && !r.value.length)) continue;
      // 识别序号字段（如 機器操作員 II-2）
      if (!seq && r.type === 'text' && /^(.*\S)-(\d+)$/.test(r.value) && /名称|名稱|Title/i.test(name)) {
        const m = r.value.match(/^(.*\S)-(\d+)$/);
        seq = { field: name, base: m[1], last: parseInt(m[2], 10) };
      }
      fields.push({ name, type: r.type, value: r.value });
    }
    return { url: location.href, savedAt: new Date().toISOString(), fields, seq };
  }

  // ── 填写 ──
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function click(el) {
    el.scrollIntoView({ block: 'center' });
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  }

  function key(el, k) {
    const code = k === 'Enter' ? 13 : 0;
    ['keydown', 'keypress', 'keyup'].forEach(t =>
      el.dispatchEvent(new KeyboardEvent(t, { key: k, code: k, keyCode: code, which: code, bubbles: true })));
  }

  async function waitFor(fn, timeout = 8000, step = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function searchKey(v) {
    const code = v.match(/^(\d{3,})\s*-/);
    if (code) return code[1];
    const paren = v.match(/\((\d{4,})\)/);
    if (paren) return paren[1];
    return v.length > 40 ? v.slice(0, 40) : v;
  }

  async function fillPrompt(box, values) {
    const current = (readField(box)?.value || []).map(norm);
    for (const v of values) {
      if (current.some(c => c === v || c.includes(v) || v.includes(c))) continue;
      const input = box.querySelector('input[data-automation-id="searchBox"], input');
      if (!input) return false;
      input.focus();
      setNativeValue(input, searchKey(v));
      key(input, 'Enter');
      const opt = await waitFor(() => {
        const opts = [...document.querySelectorAll('[data-automation-id="promptOption"], [data-automation-id="menuItem"]')]
          .filter(o => o.offsetParent);
        if (!opts.length) return null;
        return opts.find(o => norm(o.getAttribute('data-automation-label') || o.textContent) === v)
          || opts.find(o => { const t = norm(o.textContent); return t.includes(v) || v.includes(t); })
          || (opts.length === 1 ? opts[0] : null);
      }, 8000);
      if (!opt) return false;
      click(opt);
      await sleep(900);
    }
    return true;
  }

  async function fillRadio(box, value) {
    const radios = [...box.querySelectorAll('input[type="radio"]')];
    for (const r of radios) {
      const lab = r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`);
      if (norm(lab ? lab.textContent : r.parentElement?.textContent) === value) {
        if (!r.checked) { click(lab || r); await sleep(600); }
        return true;
      }
    }
    return false;
  }

  async function fillSelect(box, value) {
    const btn = box.querySelector('button[aria-haspopup="listbox"]');
    if (!btn) return false;
    if (norm(btn.textContent) === value) return true;
    click(btn);
    const opt = await waitFor(() => [...document.querySelectorAll('[role="option"]')]
      .find(o => o.offsetParent && norm(o.textContent) === value), 5000);
    if (!opt) { key(btn, 'Escape'); return false; }
    click(opt);
    await sleep(600);
    return true;
  }

  async function fillText(box, value) {
    const el = box.querySelector('textarea') ||
      box.querySelector('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([data-automation-id="searchBox"])');
    if (!el) return false;
    if (el.value === value) return true;
    el.focus();
    setNativeValue(el, value);
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.blur();
    await sleep(300);
    return true;
  }

  async function fillField(box, f) {
    if (f.type === 'prompt') return fillPrompt(box, f.value);
    if (f.type === 'radio') return fillRadio(box, f.value);
    if (f.type === 'select') return fillSelect(box, f.value);
    if (f.type === 'checkbox') {
      const cb = box.querySelector('input[type="checkbox"]');
      if (cb && cb.checked !== f.value) { click(cb); await sleep(400); }
      return true;
    }
    return fillText(box, String(f.value));
  }

  function highlightSubmit() {
    const btn = [...document.querySelectorAll('button')].find(b =>
      b.getAttribute('data-automation-button-type') === 'submit' || /^(提交|Submit)$/.test(norm(b.textContent)));
    if (btn) {
      btn.style.outline = '3px solid #ff9f0a';
      btn.style.outlineOffset = '3px';
      btn.scrollIntoView({ block: 'center' });
    }
  }

  async function runFill(tpl, index) {
    const title = tpl.seq ? `${tpl.seq.base}-${index}` : null;
    log(`▶ 开始填写${title ? `：${title}` : ''}`);
    // 等待表单出现
    const ok = await waitFor(() => scanFields().length >= 3, 30000, 500);
    if (!ok) { log('⚠️ 未检测到表单字段'); return; }
    await sleep(1200);

    const pending = tpl.fields.map(f => ({ ...f, value: tpl.seq && f.name === tpl.seq.field ? title : f.value }));
    const failed = new Set();
    // 多轮：部分字段在前面字段填好后才出现
    for (let pass = 1; pass <= 4 && pending.length; pass++) {
      const map = new Map(scanFields().map(x => [x.name, x.box]));
      for (let i = 0; i < pending.length; i++) {
        const f = pending[i];
        const box = map.get(f.name);
        if (!box) continue;
        let done = false;
        try { done = await fillField(box, f); } catch (e) { console.warn('[WD Req]', f.name, e); }
        if (done) { pending.splice(i--, 1); failed.delete(f.name); }
        else failed.add(f.name);
      }
      if (pending.length) await sleep(1500);
    }
    if (pending.length) log(`⚠️ 未填/需人工检查：${pending.map(f => f.name).join('、')}`);
    else log('✅ 全部字段已填写');
    highlightSubmit();
    log('⏸ 已停在“提交”前，请人工核对后自行提交');
    document.title = `✅ ${title || '职务申请'} 待提交`;
  }

  // ── 面板：并入 Workday 助手面板（content_workday.js 创建）的「职务申请」页 ──
  function log(msg) {
    console.log('[WD Req]', msg);
    const el = document.getElementById('wd-auto-log');
    if (!el) return;
    const d = document.createElement('div');
    d.textContent = msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }

  async function loadTpl() {
    const r = await chrome.storage.local.get(STORE_KEY);
    return r[STORE_KEY] || null;
  }

  async function refreshInfo() {
    const tpl = await loadTpl();
    const info = document.getElementById('wd-req-info');
    const start = document.getElementById('wd-req-start');
    if (!info) return;
    if (!tpl) { info.textContent = '尚未记住模板'; return; }
    info.textContent = `模板 ${tpl.fields.length} 个字段` + (tpl.seq ? `｜${tpl.seq.base}-${tpl.seq.last}` : '｜未识别序号字段');
    if (tpl.seq && start && !start.dataset.touched) start.value = tpl.seq.last + 1;
  }

  function createPanel() {
    const section = document.getElementById('wd-sec-req');
    if (!section || document.getElementById('wd-req-info')) return !!section;
    section.innerHTML = `
      <p id="wd-req-info" class="mwa-hint">…</p>
      <div class="mwa-field">起始序号 <input id="wd-req-start" class="mwa-inp num" type="number" min="1" value="3">
        份数 <input id="wd-req-count" class="mwa-inp num" type="number" min="1" max="20" value="2"></div>
      <div class="mwa-actions">
        <button id="wd-req-save" class="mwa-btn gray" type="button">记住当前值</button>
        <button id="wd-req-run" class="mwa-btn" type="button">批量创建</button>
      </div>
      <button id="wd-req-fillhere" class="mwa-btn green block" type="button">在本页按起始序号填写</button>
      <p class="mwa-hint" style="margin:8px 0 0">只填写，不会点击“提交”或“保存备用”</p>`;

    document.getElementById('wd-req-start').addEventListener('input', e => { e.target.dataset.touched = '1'; });

    document.getElementById('wd-req-save').addEventListener('click', async () => {
      const tpl = captureTemplate();
      if (tpl.fields.length < 3) { log('⚠️ 当前页面未识别到足够字段'); return; }
      await chrome.storage.local.set({ [STORE_KEY]: tpl });
      log(`💾 已记住 ${tpl.fields.length} 个字段`);
      tpl.fields.forEach(f => console.log('[WD Req]', f.name, '=', f.value));
      const start = document.getElementById('wd-req-start');
      delete start.dataset.touched;
      refreshInfo();
    });

    document.getElementById('wd-req-run').addEventListener('click', async () => {
      const tpl = await loadTpl();
      if (!tpl) { log('⚠️ 请先“记住当前值”'); return; }
      const start = parseInt(document.getElementById('wd-req-start').value, 10) || 1;
      const count = Math.min(20, parseInt(document.getElementById('wd-req-count').value, 10) || 1);
      const indexes = Array.from({ length: count }, (_, i) => start + i);
      const res = await chrome.runtime.sendMessage({ action: 'wdReqBatchOpen', url: tpl.url, indexes });
      log(`🚀 已打开 ${res?.opened || 0} 个标签页：${indexes.map(i => tpl.seq ? `${tpl.seq.base}-${i}` : i).join('、')}`);
      if (tpl.seq) {
        tpl.seq.last = start + count - 1;
        await chrome.storage.local.set({ [STORE_KEY]: tpl });
        delete document.getElementById('wd-req-start').dataset.touched;
        refreshInfo();
      }
    });

    document.getElementById('wd-req-fillhere').addEventListener('click', async () => {
      const tpl = await loadTpl();
      if (!tpl) { log('⚠️ 请先“记住当前值”'); return; }
      runFill(tpl, parseInt(document.getElementById('wd-req-start').value, 10) || 1);
    });

    refreshInfo();
    return true;
  }

  // 面板由 content_workday.js 创建，稍后再挂载职务申请页。
  async function mountPanel() {
    for (let i = 0; i < 60 && !createPanel(); i++) await sleep(500);
  }

  // ── 启动 ──
  async function boot() {
    mountPanel();
    // 是否为批量打开的标签页
    let job = null;
    try { job = await chrome.runtime.sendMessage({ action: 'wdReqGetJob' }); } catch (e) { /* ignore */ }

    const ready = await waitFor(() => isReqPage(), job?.index ? 45000 : 20000, 800);
    if (!ready) {
      // Workday 为单页应用，路由变化后再检测
      setTimeout(boot, 5000);
      return;
    }
    await mountPanel();
    const dock = globalThis.MwaDock?.get('wd-auto-panel');
    dock?.selectTab?.('req');
    if (job?.index) {
      dock?.setCollapsed(false);
      const tpl = await loadTpl();
      if (tpl) runFill(tpl, job.index);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
