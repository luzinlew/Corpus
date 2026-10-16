#!/usr/bin/env node
"use strict";
// T-033 A: v1 (whole doc) vs v3 (whole doc) vs v3 (page chunks, glued per document). Offline, no keys.
// Production validation (cnKnowledgeClean) runs on every chunk response on its own (own 50-unit limit, own truncation flag),
// then accepted units are glued in chunk order. A second, DIAGNOSTIC view parses the complete units a truncated reply
// contained before the cut: the app does NOT do this (a truncated reply gives knowledge_missing, 0 units).
//   node analyze_chunks.cjs [--whole-dir out] [--chunks-dir out-chunks] [--json FILE] [--self-test]
const fs = require("fs"), path = require("path");
const A = require("./analyze.cjs");
const { MATS, H, evaluate, witnessTable, witnessContext, listCoverage, seedTerms, preservation, loadResponse, norm, flat, short, USD, logic, read } = A;
const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const R = __dirname, WHOLE = path.resolve(opt("--whole-dir", path.join(R, "out"))), CHD = path.resolve(opt("--chunks-dir", path.join(R, "out-chunks")));
const CM = read(path.join(R, "chunks", "chunk-manifest.json"));

// ---------- salvage of complete units from a truncated reply (diagnostic only) ----------
function salvageUnits(text) {
  const k = text.indexOf('"knowledge"'); if (k < 0) return [];
  let i = text.indexOf("[", k); if (i < 0) return [];
  const out = []; i++;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (text[i] !== "{") break;
    let depth = 0, str = false, esc = false, j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (str) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') str = true; else if (c === "{" || c === "[") depth++; else if (c === "}" || c === "]") { depth--; if (depth === 0) break; }
    }
    if (j >= text.length) break;                       // the cut object is not counted
    try { out.push(JSON.parse(text.slice(i, j + 1))); } catch (_) { break; }
    i = j + 1;
  }
  return out;
}
const textOf = resp => resp.content.filter(x => x.type === "text").map(x => x.text).join("");
function salvagedResp(resp) {
  let ok = true; try { JSON.parse(textOf(resp)); } catch (_) { ok = false; }
  if (ok) return { resp, salvaged: false, n: null };
  const units = salvageUnits(textOf(resp));
  return { resp: { ...resp, content: [{ type: "text", text: JSON.stringify({ knowledge: units }) }] }, salvaged: true, n: units.length };
}

// ---------- substantive blocks, exactly as production decides (per-block call) ----------
function substantiveIds(M) {
  return new Set(M.blocks.filter(b => logic.cnKnowledgeClean({ knowledge: [] }, [b], M.m).issues.some(x => x.startsWith("source_blocks_without_units:"))).map(b => b.id));
}

// ---------- glue chunk evaluations of one document ----------
const chunkOfPage = (parent, page) => CM.rows.find(r => r.parent === parent && r.pages.includes(page)).id;
function glue(M, parts) {           // parts: [{id, ev}]
  const per = [], units = [], byId = new Map(), contentSeen = new Map(), idDup = [], contentDup = [];
  for (const { id, ev } of parts) {
    ev.per.forEach(p => per.push({ ...p, i: id + "#" + p.i, chunk: id }));
    for (const u of ev.units) {
      if (byId.has(u.id)) { idDup.push({ id: u.id, chunks: [byId.get(u.id), id] }); continue; }
      byId.set(u.id, id); units.push(u);
      const key = u.type + "\0" + norm(flat(u.content));
      if (contentSeen.has(key) && contentSeen.get(key) !== id) contentDup.push({ type: u.type, content: short(flat(u.content), 60), chunks: [contentSeen.get(key), id] });
      else if (!contentSeen.has(key)) contentSeen.set(key, id);
    }
  }
  const sub = substantiveIds(M), linked = new Set(units.flatMap(u => u.sources.map(s => s.blockId)));
  const sum = k => parts.reduce((a, p) => a + (p.ev.summary[k] || 0), 0);
  return { per, units, topicsText: parts.map(p => p.ev.topicsText).join(" | "), idDup, contentDup,
    summary: { rawUnits: sum("rawUnits"), accepted: units.length, rejected: sum("rejected"), mergedDuplicatesWithinChunks: sum("mergedDuplicates"),
      relinked: sum("relinked"), beyondUnitLimit: sum("beyondUnitLimit"), quoteMismatchChunks: parts.filter(p => p.ev.summary.issues.includes("source_quote_mismatch")).length,
      truncatedChunks: parts.filter(p => p.ev.summary.truncated).map(p => p.id), acceptedByType: units.reduce((a, u) => (a[u.type] = (a[u.type] || 0) + 1, a), {}),
      unlinkedSubstantiveBlocks: [...sub].filter(id => !linked.has(id)).length, substantiveBlocks: sub.size } };
}

function crossChunkUnits(ev, M) {   // units whose sources lie in pages of different chunks
  return ev.units.filter(u => new Set(u.sources.map(s => chunkOfPage(M.n, s.page))).size > 1).map(u => ({ type: u.type, content: short(flat(u.content), 70), pages: [...new Set(u.sources.map(s => s.page))] }));
}
function statementPreservation(oldEv, newEv, M) {
  const p = preservation(oldEv, newEv, M); if (!p) return null;
  const lostIds = new Set(p.lost.map(r => r.id)), st = oldEv.units.filter(u => u.type === "statement");
  return { ...p, statementsOld: st.length, statementsKept: st.filter(u => !lostIds.has(u.id)).length,
    lostByPage: p.lost.reduce((a, r) => (a[r.page] = (a[r.page] || 0) + 1, a), {}) };
}

// ---------- main ----------
function run() {
  const res = { slicing: CM.slicing, requests: [], materials: [] };
  const wholeSum = fs.existsSync(path.join(WHOLE, "run-summary.json")) ? read(path.join(WHOLE, "run-summary.json")) : { calls: [] };
  const chSum = read(path.join(CHD, "run-summary.json"));
  for (const M of MATS) {
    const v1 = evaluate(loadResponse(path.join(H, "outline-v3-comparison/old-response-" + M.n + ".json"), M.n), M);
    v1.summary.usage = { input: M.ledger.usage.input_tokens, output: M.ledger.usage.output_tokens }; v1.summary.costUSD = M.ledger.actualUSD;
    const wr = loadResponse(path.join(WHOLE, "response-" + M.n + ".json"), M.n), wc = wholeSum.calls.find(c => c.n === M.n);
    if (wc) wr.usage = wc.usage;
    const w3 = evaluate(wr, M);
    const rows = CM.rows.filter(r => r.parent === M.n), prod = [], salv = [];
    for (const row of rows) {
      const resp = loadResponse(path.join(CHD, "response-" + row.id + ".json"), M.n), call = chSum.calls.find(c => c.n === row.id);
      if (call) resp.usage = call.usage;
      const ev = evaluate(resp, M), sv = salvagedResp(resp), evS = sv.salvaged ? evaluate(sv.resp, M) : ev;
      prod.push({ id: row.id, ev }); salv.push({ id: row.id, ev: evS });
      const u = resp.usage || {};
      res.requests.push({ id: row.id, file: M.name, pages: row.pages, inputTokens: u.input_tokens, outputTokens: u.output_tokens, stop: resp.stop_reason,
        costUSD: +USD(u.input_tokens, u.output_tokens).toFixed(7), parse: ev.summary.parseError || "ok", rawUnitsProd: ev.summary.rawUnits, acceptedProd: ev.summary.accepted,
        completeUnitsBeforeCut: sv.salvaged ? sv.n : null, acceptedIfSalvaged: evS.summary.accepted, rejected: evS.summary.rejected, dupWithinChunk: evS.summary.mergedDuplicates,
        beyond50: evS.summary.beyondUnitLimit, relinked: evS.summary.relinked, quoteMismatch: evS.summary.issues.includes("source_quote_mismatch"), limitedByModel: evS.summary.knowledge_limited,
        topics: ev.summary.topics, byTypeIfSalvaged: evS.summary.acceptedByType });
    }
    const gP = glue(M, prod), gS = glue(M, salv);
    const mat = { key: M.key, name: M.name, n: M.n, v1: v1.summary, v3whole: w3.summary, chunksProd: gP.summary, chunksSalvage: gS.summary,
      junction: { prod: { idDup: gP.idDup, contentDup: gP.contentDup }, salvage: { idDup: gS.idDup, contentDup: gS.contentDup } },
      crossChunk: { v1: crossChunkUnits(v1, M), v3whole: crossChunkUnits(w3, M) },
      preservation: { v3whole: statementPreservation(v1, w3, M), chunksProd: statementPreservation(v1, gP, M), chunksSalvage: statementPreservation(v1, gS, M) },
      list: { v1: listCoverage(v1, M), v3whole: listCoverage(w3, M), chunksProd: listCoverage(gP, M), chunksSalvage: listCoverage(gS, M) } };
    if (M.n === 1) {
      mat.witnessContext = witnessContext(M);
      const tab = ev => witnessTable(ev, M).map(r => { const h = r.hits.filter(x => x.via !== "indirect")[0] || r.hits[0]; return { page: r.page, name: r.name, status: r.status, chunk: h && String(h.idx).split("#")[0], citesWitnessBlock: h ? h.citesWitnessBlock : null, accepted: h ? h.validatorAccepted : null }; });
      mat.witnesses = { v1: tab(v1), v3whole: tab(w3), chunksProd: tab(gP), chunksSalvage: tab(gS) };
    } else {
      mat.seed = { v1: seedTerms(v1, M), v3whole: seedTerms(w3, M), chunksProd: seedTerms(gP, M), chunksSalvage: seedTerms(gS, M) };
      mat.termsIfSalvaged = gS.units.filter(u => u.type === "term").map(u => flat(u.content));
      mat.termsProd = gP.units.filter(u => u.type === "term").map(u => flat(u.content));
    }
    res.materials.push(mat);
  }
  res.totals = { calls: res.requests.length, inputTokens: res.requests.reduce((a, r) => a + r.inputTokens, 0), outputTokens: res.requests.reduce((a, r) => a + r.outputTokens, 0),
    costUSD: +res.requests.reduce((a, r) => a + r.costUSD, 0).toFixed(7), runnerSpentUSD: chSum.spentUSD_actual, truncated: res.requests.filter(r => r.stop !== "end_turn").map(r => r.id) };
  return res;
}

function print(res) {
  const L = s => console.log(s), cnt = (W, f) => W.filter(f).length;
  L("== T-033 A: v1 целиком | v3 целиком | v3 куски. Подстрока ≠ смысловое соответствие; число единиц ≠ полнота PDF. ==");
  L("«куски (приложение)» = что примет производственный валидатор: оборванный ответ → knowledge_missing, 0 единиц.");
  L("«куски (до обрыва)» = ДИАГНОСТИКА: целые единицы, выданные до обрыва, через тот же валидатор. Приложение так не делает.\n");
  L("### Запросы");
  res.requests.forEach(r => L("  " + r.id + " стр." + r.pages.join(",") + " in/out=" + r.inputTokens + "/" + r.outputTokens + " stop=" + r.stop + " $" + r.costUSD.toFixed(5) + " parse=" + r.parse +
    " | приложение: принято " + r.acceptedProd + " | до обрыва: целых " + (r.completeUnitsBeforeCut ?? "—") + ", принято " + r.acceptedIfSalvaged + " " + JSON.stringify(r.byTypeIfSalvaged) +
    ", отклонено " + r.rejected + ", дубли " + r.dupWithinChunk + ", >50 " + r.beyond50 + ", relinked " + r.relinked + ", mismatch " + r.quoteMismatch + ", topics " + r.topics));
  const t = res.totals; L("  ИТОГО: " + t.calls + " вызовов, in/out=" + t.inputTokens + "/" + t.outputTokens + ", $" + t.costUSD.toFixed(5) + " (раннер: $" + t.runnerSpentUSD.toFixed(5) + "); оборваны: " + (t.truncated.join(", ") || "нет"));
  for (const m of res.materials) {
    L("\n### " + m.key + ": " + m.name);
    for (const [tag, s] of [["v1 целиком", m.v1], ["v3 целиком", m.v3whole]]) L("  " + tag.padEnd(22) + " принято " + s.accepted + " " + JSON.stringify(s.acceptedByType) + " отклонено " + s.rejected + " stop=" + s.stop_reason + " out=" + s.usage.output + " $" + (+s.costUSD).toFixed(5));
    for (const [tag, s] of [["v3 куски (приложение)", m.chunksProd], ["v3 куски (до обрыва)", m.chunksSalvage]]) L("  " + tag.padEnd(22) + " принято " + s.accepted + " " + JSON.stringify(s.acceptedByType) + " отклонено " + s.rejected + " дубли внутри кусков " + s.mergedDuplicatesWithinChunks + " оборваны " + JSON.stringify(s.truncatedChunks) + " блоков без единиц " + s.unlinkedSubstantiveBlocks + "/" + s.substantiveBlocks);
    const j = m.junction; L("  стыки: дубли по id prod/диагн. " + j.prod.idDup.length + "/" + j.salvage.idDup.length + "; дубли по содержанию между кусками prod/диагн. " + j.prod.contentDup.length + "/" + j.salvage.contentDup.length + (j.salvage.contentDup.length ? " " + JSON.stringify(j.salvage.contentDup) : ""));
    L("  связи через границу кусков (единицы с источниками в двух кусках): v1 " + m.crossChunk.v1.length + ", v3 целиком " + m.crossChunk.v3whole.length + (m.crossChunk.v1.length + m.crossChunk.v3whole.length ? " " + JSON.stringify([...m.crossChunk.v1, ...m.crossChunk.v3whole]) : ""));
    for (const [tag, p] of [["v3 целиком", m.preservation.v3whole], ["куски (приложение)", m.preservation.chunksProd], ["куски (до обрыва)", m.preservation.chunksSalvage]]) if (p)
      L("  сохранность " + p.oldUnits + " единиц v1 → " + tag.padEnd(20) + ": строго " + p.strict + ", нестрого " + p.loose + ", потеряно " + p.lost.length + " " + JSON.stringify(p.lostByPage) + "; утверждений " + p.statementsKept + "/" + p.statementsOld);
    for (const [tag, Lc] of Object.entries(m.list)) if (Lc.kinds) L("  перечень (ДИАГНОСТИКА) " + tag.padEnd(14) + ": " + Object.entries(Lc.kinds).map(([k, v]) => k + " " + v.inContentOrQuote + "/" + v.total).join("; "));
    if (m.witnesses) {
      L("  21 пример (контекст один раз):");
      m.witnessContext.forEach((w, i) => { const s = k => m.witnesses[k][i]; L("    p" + w.page + " " + w.name.padEnd(28) + " v1: " + s("v1").status.padEnd(18) + " v3 целиком: " + s("v3whole").status.padEnd(18) + " куски(прил.): " + s("chunksProd").status.padEnd(18) + " куски(до обрыва): " + s("chunksSalvage").status + (s("chunksSalvage").chunk ? " [" + s("chunksSalvage").chunk + "]" : ""));
        L("        " + short(w.context, 170)); });
      for (const k of ["v1", "v3whole", "chunksProd", "chunksSalvage"]) { const W = m.witnesses[k]; L("    итого " + k.padEnd(14) + ": в content " + cnt(W, r => r.status.startsWith("в content")) + ", только quote " + cnt(W, r => r.status.startsWith("только в цит")) + ", в темах " + cnt(W, r => r.status === "в теме/terms") + ", отсутствует " + cnt(W, r => r.status === "отсутствует")); }
    }
    if (m.seed) {
      for (const k of ["v1", "v3whole", "chunksProd", "chunksSalvage"]) L("  свидетели " + k.padEnd(14) + ": " + m.seed[k].map(t => t.term + "=" + t.acceptedContent).join(", "));
      L("  терминов принято: приложение " + m.termsProd.length + ", до обрыва " + m.termsIfSalvaged.length);
    }
  }
}

function selfTest() {
  const ok = [], t = (n, c) => { ok.push([n, !!c]); console.log((c ? "PASS " : "FAIL ") + n); };
  const full = '{"knowledge":[{"type":"term","content":"A","sources":[{"block_id":"x","quote":"q}\\"]"}]},{"type":"term","content":"B","sources":[]},{"type":"te';
  const s = salvageUnits(full);
  t("salvage: 2 complete units, cut third ignored, braces/quotes inside strings handled", s.length === 2 && s[1].content === "B" && s[0].sources[0].quote === 'q}"]');
  t("salvage: no knowledge -> []", salvageUnits('{"topics":[]}').length === 0);
  const M = MATS[0], one = { id: "1-1", ev: evaluate(loadResponse(path.join(H, "outline-v3-comparison/old-response-1.json"), 1), M) };
  const g = glue(M, [one, { id: "1-2", ev: one.ev }]);
  t("glue: same units twice -> id duplicates counted, not doubled", g.units.length === one.ev.units.length && g.idDup.length === one.ev.units.length);
  const g1 = glue(M, [one]);
  t("glue: unlinked substantive blocks == production issue count (19 for v1)", one.ev.summary.issues.includes("source_blocks_without_units:" + g1.summary.unlinkedSubstantiveBlocks) && g1.summary.unlinkedSubstantiveBlocks === 19);
  t("chunkOfPage: page 3 -> 1-1, page 4 -> 1-2, page 8 -> 2-3", chunkOfPage(1, 3) === "1-1" && chunkOfPage(1, 4) === "1-2" && chunkOfPage(2, 8) === "2-3");
  const bad = ok.filter(x => !x[1]); console.log(bad.length ? "SELF-TEST FAILED" : "SELF-TEST PASSED (" + ok.length + ")"); process.exitCode = bad.length ? 1 : 0;
}

if (args.includes("--self-test")) selfTest();
else { const res = run(); print(res); const jf = opt("--json", null); if (jf) fs.writeFileSync(jf, JSON.stringify(res, null, 1) + "\n"); }
