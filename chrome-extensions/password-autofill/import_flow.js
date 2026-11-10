// 导入写入流程（插件后台与 Fabriq 页面悬浮窗共用）：金丝雀 → 其余 → 读回对账；覆盖前保存原值；失败即停，绝不自动重传。
// 依赖由调用方注入：read(endpoint) 只读；send(action, payload) 调后台；confirm(text)；progress(text)；lock(bool)；onSaved()。
(function (root) {
  'use strict';
  const core = root.MwaImportCore;

  function create({ read, send, confirm, progress, lock = () => {}, onSaved = () => {} }) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const writeOp = op => send('fabriqWrite', { op });

    async function readExisting(id) {
      let lastError;
      for (let i = 0; i < 3; i++) {
        try {
          const rows = await read(`/legacy/api/api/v1/indicator/${id}/datapoints/`);
          if (Array.isArray(rows)) return rows.map(d => ({ id: d.id, end_date: d.end_date, value: d.value }));
        } catch (error) { lastError = error; }
        await sleep(2500);
      }
      throw lastError || new Error(`读取 KPI ${id} 现有数据失败`);
    }
    const existingFor = async ids => { const out = {}; for (const id of ids) out[id] = await readExisting(id); return out; };

    // 读回有延迟：多次读取；读不全不等于丢失，也绝不据此重传。
    async function readBackAll(expected, attempts = 5, delay = 3000) {
      const ids = [...new Set(expected.map(r => r.id))];
      let last = { ok: false, missing: expected, mismatched: [], existing: {} };
      for (let i = 0; i < attempts; i++) {
        await sleep(delay);
        const existing = await existingFor(ids);
        last = { ...core.diffReadback(expected, existing), existing };
        if (last.ok) return last;
      }
      return last;
    }

    async function doImport(rows, teamId, note) {
      const resp = await writeOp({ type: 'import', csv: core.buildCsv(rows), teamId, note, today: new Date().toISOString().slice(0, 10) });
      if (!resp || resp.status === 0) throw new Error(`${note}：请求结果不明（${resp && resp.body}）。已停止且不会自动重传，请刷新预览核对线上数据`);
      const body = resp.body || {};
      if (resp.status !== 200 || body.success_count !== rows.length || body.errors_count) {
        throw new Error(`${note}：Fabriq 返回 ${resp.status}，成功 ${body.success_count ?? '?'} / ${rows.length}，错误 ${body.errors_count ?? '?'} ${JSON.stringify(body.errors || body).slice(0, 200)}`);
      }
    }

    const loadLog = async () => (await chrome.storage.local.get('mwaImportLog')).mwaImportLog || [];
    async function saveEntry(entry) {
      const list = await loadLog();
      const at = list.findIndex(e => e.id === entry.id);
      if (at >= 0) list[at] = entry; else list.unshift(entry);
      await chrome.storage.local.set({ mwaImportLog: list.slice(0, 100) });
      onSaved(entry);
    }

    async function runImport(ctx) {
      const rows = ctx.compared.rows.filter(r => r.status !== 'same');
      const skippedSame = ctx.compared.rows.length - rows.length;
      const nNew = rows.filter(r => r.status === 'new').length;
      const nOver = rows.length - nNew;
      const kpiCount = new Set(rows.map(r => r.id)).size;
      if (!confirm(`导入到团队 ${ctx.teamId}：\n新增 ${nNew} 行、覆盖 ${nOver} 行（${kpiCount} 个 KPI）；与线上相同的 ${skippedSame} 行跳过。\n\n流程：先导最多 3 行（金丝雀）并读回核对，通过后再导其余，最后读回对账。覆盖前已保存原值，可在“导入历史”里撤销。\n\n继续？`)) return;
      lock(true);
      const entry = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, time: new Date().toISOString(), file: ctx.file.name,
        sha256: ctx.sha256, teamId: ctx.teamId, status: 'running', skippedSame, note: '',
        rows: rows.map(r => ({ id: r.id, kpi: r.kpi, date: r.date, value: r.value, old: r.old ?? null, status: r.status })) };
      await saveEntry(entry);
      try {
        const canary = core.pickCanary(rows, 3);
        progress(`金丝雀：导入 ${canary.length} 行…`);
        await doImport(canary, ctx.teamId, '金丝雀');
        entry.wrote = true;
        progress('金丝雀：读回核对…');
        const check = await readBackAll(canary);
        if (!check.ok) throw new Error(`金丝雀读回不一致（缺 ${check.missing.length} 行，不一致 ${check.mismatched.length} 行），已停止，未导入其余行。请检查日期 / 值后重试`);
        const rest = rows.filter(r => !canary.includes(r));
        if (rest.length) { progress(`金丝雀通过。导入其余 ${rest.length} 行…`); await doImport(rest, ctx.teamId, '其余'); }
        progress('读回对账…');
        const full = await readBackAll(rows);
        for (const r of entry.rows) {
          const cur = (full.existing[r.id] || []).find(d => d.end_date === r.date);
          if (cur) r.dpId = String(cur.id);
        }
        entry.status = full.ok ? 'ok' : 'unverified';
        entry.note = full.ok ? `已核对 ${rows.length} 行` : `读回暂未核对全：缺 ${full.missing.length}、不一致 ${full.mismatched.length}。写入请求已成功，读回有延迟，请稍后刷新预览确认，不要重复导入`;
        progress(entry.note);
      } catch (error) {
        entry.status = 'failed';
        entry.note = error.message;
        progress(`已停止：${error.message}`);
      }
      await saveEntry(entry);
      lock(false);
    }

    async function undoEntry(entry) {
      progress('读取线上当前数据…');
      try {
        const ids = [...new Set(entry.rows.map(r => r.id))];
        const current = await existingFor(ids);
        const plan = core.planUndo(entry.rows, current);
        if (!plan.restore.length && !plan.remove.length) { progress(`没有可撤销的行：${plan.skipped.map(s => s.reason).slice(0, 3).join('；')}`); return; }
        const skippedText = plan.skipped.length ? `\n\n不处理 ${plan.skipped.length} 行：\n- ${plan.skipped.slice(0, 5).map(s => `${s.row.kpi} ${s.row.date}：${s.reason}`).join('\n- ')}` : '';
        if (!confirm(`撤销本次导入（团队 ${entry.teamId}）：\n还原 ${plan.restore.length} 行为导入前的值，\n删除 ${plan.remove.length} 条本次新增的数据点。${skippedText}\n\n继续？`)) { progress(''); return; }
        if (plan.restore.length) {
          progress(`还原 ${plan.restore.length} 行…`);
          await doImport(plan.restore, entry.teamId, '撤销-还原');
        }
        for (let i = 0; i < plan.remove.length; i++) {
          progress(`删除新增的数据点 ${i + 1}/${plan.remove.length}…`);
          const r = plan.remove[i];
          const out = await writeOp({ type: 'delete', teamId: entry.teamId, indicatorId: r.row.id, datapointId: r.datapointId, note: `${r.row.kpi} ${r.row.date}` });
          if (!out || out.status < 200 || out.status >= 300) throw new Error(`删除 ${r.row.kpi} ${r.row.date} 返回 ${out && out.status}，已停止`);
        }
        progress('读回核对撤销结果…');
        const after = await existingFor(ids);
        const bad = [
          ...plan.restore.filter(r => { const c = (after[r.id] || []).find(d => d.end_date === r.date); return !c || Math.abs(Number(c.value) - r.value) > 1e-9; }),
          ...plan.remove.filter(r => (after[r.row.id] || []).some(d => d.end_date === r.row.date)).map(r => r.row)];
        entry.status = 'undone';
        entry.note = bad.length ? `已撤销，但有 ${bad.length} 行读回暂未一致（读回有延迟，稍后刷新确认）` : `已撤销：还原 ${plan.restore.length} 行，删除 ${plan.remove.length} 条${plan.skipped.length ? `，跳过 ${plan.skipped.length} 行` : ''}`;
        progress(entry.note);
        await saveEntry(entry);
      } catch (error) {
        progress(`撤销已停止：${error.message}`);
      }
    }

    return { runImport, undoEntry, loadLog, existingFor };
  }

  root.MwaImportFlow = { create };
})(globalThis);
