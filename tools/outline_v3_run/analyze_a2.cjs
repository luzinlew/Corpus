#!/usr/bin/env node
"use strict";
// T-035 A2: v1 whole | v3 whole | v3 by 3 pages | v3 by 1 page. Offline, no keys, no network.
// Every reply is checked by the production validator of the checked-out branch (T-034: whole units of a cut-short reply are kept,
// cnKnowledgePartial) on the blocks of its own chunk, as the app does; "without T-034" = a cut-short reply gives 0 units (the old app).
//   node analyze_a2.cjs [--json FILE] [--self-test]
const fs = require("fs"), path = require("path");
const A = require("./analyze.cjs"), C = require("./analyze_chunks.cjs");
const { MATS, H, evaluate, witnessTable, witnessContext, listCoverage, seedTerms, loadResponse, norm, flat, short, USD, logic, read } = A;
const { glue, statementPreservation } = C;
const ctx = require(path.join(process.env.CORPUS_REPO || "/home/user/Corpus", "tools/course_logic_test.cjs")).context;
if (typeof ctx.cnKnowledgePartial !== "function") throw new Error("the checked-out src/corpus.html has no cnKnowledgePartial (T-034)");
const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const R = __dirname, textOf = r => r.content.filter(x => x.type === "text").map(x => x.text).join("");
const SETS = [{ key: "x3", label: "v3 по 3 стр.", man: "chunks", out: "out-chunks" }, { key: "x1", label: "v3 по 1 стр.", man: "chunks1", out: "out-chunks1" }];

// one chunk reply → {prod: as the T-034 app, old: as the app before T-034}
function evalChunk(resp, M, pages) {
  const Mc = { ...M, blocks: M.blocks.filter(b => pages.includes(b.page)) }, text = textOf(resp);
  let ok = true; try { JSON.parse(text); } catch (_) { ok = false; }
  const old = evaluate(resp, Mc);
  if (ok) return { prod: old, old, cut: false, partial: null };
  const part = ctx.cnKnowledgePartial({ code: "invalid_json", truncated: true, text }, Mc.blocks, Mc.m), s = ctx.cnKnowledgeSalvage(text);
  const prod = part ? evaluate({ ...resp, content: [{ type: "text", text: JSON.stringify({ knowledge: s.knowledge }) }] }, Mc) : old;
  if (part && prod.units.length !== part.units.length) throw new Error("analyzer and app disagree on a cut-short reply");
  return { prod, old, cut: true, partial: part ? part.units.length : 0 };
}
const multiPage = ev => ev.units.filter(u => new Set(u.sources.map(s => s.page)).size > 1).map(u => ({ type: u.type, content: short(flat(u.content), 60), pages: [...new Set(u.sources.map(s => s.page))] }));
const pagesOfUnit = u => [...new Set(u.sources.map(s => s.page))];

function run() {
  const res = { requests: {}, materials: [], quota: {} };
  const whole = read(path.join(R, "out/run-summary.json"));
  const sets = SETS.map(S => ({ ...S, cm: read(path.join(R, S.man, "chunk-manifest.json")), sum: read(path.join(R, S.out, "run-summary.json")) }));
  for (const S of sets) res.requests[S.key] = [];
  for (const M of MATS) {
    const v1 = evaluate(loadResponse(path.join(H, "outline-v3-comparison/old-response-" + M.n + ".json"), M.n), M);
    v1.summary.usage = { input: M.ledger.usage.input_tokens, output: M.ledger.usage.output_tokens }; v1.summary.costUSD = M.ledger.actualUSD;
    const wr = loadResponse(path.join(R, "out/response-" + M.n + ".json"), M.n), wc = whole.calls.find(c => c.n === M.n); wr.usage = wc.usage;
    const w3 = evalChunk(wr, M, M.blocks.map(b => b.page));
    const V = { v1: { label: "v1 целиком", ev: v1, calls: 1 }, w3: { label: "v3 целиком", ev: w3.prod, evOld: w3.old, calls: 1, cut: w3.cut ? 1 : 0 } };
    for (const S of sets) {
      const parts = [], partsOld = [];
      for (const row of S.cm.rows.filter(r => r.parent === M.n)) {
        const resp = loadResponse(path.join(R, S.out, "response-" + row.id + ".json"), M.n), call = S.sum.calls.find(c => c.n === row.id); resp.usage = call.usage;
        const e = evalChunk(resp, M, row.pages), u = resp.usage, inputChars = row.inputChars;
        parts.push({ id: row.id, ev: e.prod }); partsOld.push({ id: row.id, ev: e.old });
        res.requests[S.key].push({ id: row.id, file: M.key, pages: row.pages.join(","), blocks: row.blocks, inputChars, inTok: u.input_tokens, outTok: u.output_tokens, stop: resp.stop_reason,
          usd: +USD(u.input_tokens, u.output_tokens).toFixed(6), outTokPer1kChars: +(u.output_tokens / inputChars * 1000).toFixed(0), raw: e.prod.summary.rawUnits, accepted: e.prod.units.length,
          acceptedWithoutT034: e.old.units.length, rejected: e.prod.summary.rejected, dupInChunk: e.prod.summary.mergedDuplicates, over50: e.prod.summary.beyondUnitLimit,
          unitLimit: e.prod.summary.issues.includes("unit_limit"), cut: e.cut, rejectReasons: e.prod.summary.rejectedItems.map(x => x.reasons.join("+")) });
      }
      V[S.key] = { label: S.label, ev: glue(M, parts), evOld: glue(M, partsOld), calls: parts.length, cut: res.requests[S.key].filter(r => r.file === M.key && r.cut).length };
    }
    const mat = { key: M.key, name: M.name, variants: {} };
    for (const [k, v] of Object.entries(V)) {
      const ev = v.ev, s = ev.summary, units = ev.units;
      const row = { label: v.label, calls: v.calls, cutReplies: v.cut || 0, units: units.length, unitsWithoutT034: v.evOld ? v.evOld.units.length : units.length,
        byType: units.reduce((a, u) => (a[u.type] = (a[u.type] || 0) + 1, a), {}), rejected: s.rejected, multiPageUnits: multiPage(ev).length,
        junctionContentDup: ev.contentDup ? ev.contentDup.length : 0, junctionIdDup: ev.idDup ? ev.idDup.length : 0,
        list: Object.fromEntries(Object.entries(listCoverage(ev, M).kinds || {}).map(([kk, x]) => [kk, x.inContentOrQuote + "/" + x.total])) };
      if (k !== "v1") { const p = statementPreservation(v1, ev, M); row.v1Strict = p.strict; row.v1Loose = p.loose; row.v1Lost = p.lost.length; row.v1Statements = p.statementsKept + "/" + p.statementsOld;
        row.v1LostByPage = p.lostByPage; row.v1LostIds = p.lost.map(x => x.id); }
      if (M.n === 1) {
        row.witnesses = witnessTable(ev, M).map(r => { const h = r.hits.filter(x => x.via !== "indirect")[0] || null;
          return { page: r.page, name: r.name, block: r.blocks.map(b => b.id).join("/"), status: r.status, via: h && h.via, accepted: h ? h.validatorAccepted : false, citesWitnessBlock: h ? h.citesWitnessBlock : false, quoteOnBlock: h ? h.quoteContainsNameInWitnessBlock : false, chunk: h && String(h.idx).split("#")[0] }; });
        row.found = row.witnesses.filter(w => w.status === "в content единицы" || w.status.startsWith("только в цит")).length;
      } else row.seed = seedTerms(ev, M).map(t => t.term + "=" + t.acceptedContent);
      if (k === "x3") row.multiPage = multiPage(ev);
      mat.variants[k] = row;
    }
    if (M.n === 1) mat.witnessContext = witnessContext(M);
    // v1 units spanning pages / x1 lost units whose page is not the page of a lost v1 unit's sources
    mat.v1MultiPage = multiPage(v1);
    mat.lostInX1NotInX3 = mat.variants.x1.v1LostIds.filter(id => !mat.variants.x3.v1LostIds.includes(id)).map(id => { const u = v1.units.find(x => x.id === id); return { type: u.type, pages: pagesOfUnit(u), content: short(flat(u.content), 70) }; });
    mat.lostInX3NotInX1 = mat.variants.x3.v1LostIds.filter(id => !mat.variants.x1.v1LostIds.includes(id)).length;
    res.materials.push(mat);
  }
  for (const S of sets) { const rq = res.requests[S.key]; res.quota[S.key] = { calls: rq.length, inTok: rq.reduce((a, r) => a + r.inTok, 0), outTok: rq.reduce((a, r) => a + r.outTok, 0), usd: +rq.reduce((a, r) => a + r.usd, 0).toFixed(6), runnerUSD: S.sum.spentUSD_actual }; }
  res.quota.whole = { calls: 2, inTok: whole.calls.reduce((a, c) => a + c.usage.input_tokens, 0), outTok: whole.calls.reduce((a, c) => a + c.usage.output_tokens, 0), usd: +whole.spentUSD_actual.toFixed(6) };
  return res;
}

function print(res) {
  const L = s => console.log(s);
  L("== T-035 A2. Валидатор приложения ветки T-034 (целые единицы оборванного ответа принимаются), блоки своего куска. Подстрока ≠ смысл; число единиц ≠ полнота PDF. ==");
  for (const k of ["x3", "x1"]) {
    L("\n### Запросы " + (k === "x1" ? "v3 по 1 стр." : "v3 по 3 стр.") + " (стр. | блоков | вход симв. | in/out токены | stop | $ | вых.ток/1000 симв. | сырых→принято (без T-034) | откл. | дубли | >50 | причины)");
    res.requests[k].forEach(r => L("  " + r.id.padEnd(5) + " " + r.file.padEnd(10) + " стр." + r.pages.padEnd(7) + String(r.blocks).padStart(3) + " " + String(r.inputChars).padStart(5) + "  " + r.inTok + "/" + r.outTok + " " + r.stop.padEnd(10) + " $" + r.usd.toFixed(5) + "  " + String(r.outTokPer1kChars).padStart(5) + "   " + r.raw + "→" + r.accepted + " (" + r.acceptedWithoutT034 + ")  " + r.rejected + "  " + r.dupInChunk + "  " + r.over50 + (r.unitLimit ? " unit_limit" : "") + (r.rejectReasons.length ? "  " + r.rejectReasons.join(",") : "")));
  }
  L("\n### Стоимость и квота приложения (1 единица квоты = 1 запрос outline)");
  for (const [k, q] of Object.entries(res.quota)) L("  " + k.padEnd(6) + " запросов " + q.calls + ", in/out " + q.inTok + "/" + q.outTok + ", $" + q.usd.toFixed(5) + (q.runnerUSD != null ? " (раннер $" + q.runnerUSD.toFixed(5) + ")" : ""));
  for (const m of res.materials) {
    L("\n### " + m.key + ": " + m.name);
    for (const [k, v] of Object.entries(m.variants)) L("  " + v.label.padEnd(14) + " запросов " + String(v.calls).padStart(2) + ", оборвано " + v.cutReplies + ", единиц " + String(v.units).padStart(3) + " (без T-034 " + v.unitsWithoutT034 + ") " + JSON.stringify(v.byType) + ", откл. " + v.rejected + ", многостр. единиц " + v.multiPageUnits + ", дубли на стыках: по содержанию " + v.junctionContentDup + " / по id " + v.junctionIdDup
      + (v.v1Strict != null ? "\n                 из 26 v1: строго " + v.v1Strict + ", нестрого " + v.v1Loose + ", потеряно " + v.v1Lost + " " + JSON.stringify(v.v1LostByPage) + ", утверждений " + v.v1Statements : "")
      + (v.found != null ? "\n                 21 пример найден: " + v.found : "") + (v.seed ? "\n                 свидетели: " + v.seed.join(", ") : "") + "\n                 перечень (ДИАГНОСТИКА): " + JSON.stringify(v.list));
    L("  v1: единиц с источниками на нескольких страницах: " + m.v1MultiPage.length + "; v3 по 3 стр.: " + m.variants.x3.multiPageUnits + (m.variants.x3.multiPage.length ? " " + JSON.stringify(m.variants.x3.multiPage) : ""));
    L("  единицы v1, потерянные при 1 стр., но не при 3 стр.: " + m.lostInX1NotInX3.length + (m.lostInX1NotInX3.length ? " " + JSON.stringify(m.lostInX1NotInX3) : "") + "; наоборот: " + m.lostInX3NotInX1);
    if (m.witnessContext) {
      L("  21 пример: стр. | имя | блок | v1 | v3 целиком | по 3 | по 1 (via, принят, цитата из того же блока)");
      m.witnessContext.forEach((w, i) => { const g = k => m.variants[k].witnesses[i], st = x => x.status === "в content единицы" ? "content" : x.status.startsWith("только") ? "quote" : x.status === "отсутствует" ? "—" : x.status.slice(0, 10);
        const d = g("x1"); L("    p" + w.page + " " + w.name.padEnd(28) + " " + String(w.block).padEnd(16) + " " + st(g("v1")).padEnd(8) + st(g("w3")).padEnd(8) + st(g("x3")).padEnd(8) + st(d).padEnd(8) + (d.via ? "принят=" + d.accepted + " тот же блок=" + d.citesWitnessBlock + " имя в цитате=" + d.quoteOnBlock : ""));
        L("        " + short(w.context, 160)); });
    }
  }
}

function selfTest() {
  const ok = [], t = (n, c) => { ok.push(!!c); console.log((c ? "PASS " : "FAIL ") + n); };
  const M = MATS[0], old = loadResponse(path.join(H, "outline-v3-comparison/old-response-1.json"), 1), raw = JSON.parse(textOf(old));
  const cut = JSON.stringify(raw), k = cut.indexOf(JSON.stringify(raw.knowledge[5]));
  const e = evalChunk({ ...old, stop_reason: "max_tokens", content: [{ type: "text", text: cut.slice(0, k + 10) }] }, M, M.blocks.map(b => b.page));
  t("cut reply: app keeps the 5 whole units, without T-034 0", e.cut && e.prod.units.length === 5 && e.old.units.length === 0 && e.partial === 5);
  const w = evalChunk(old, M, M.blocks.map(b => b.page));
  t("whole reply: same with and without T-034 (26)", !w.cut && w.prod.units.length === 26 && w.old.units.length === 26);
  const p1 = evalChunk(old, M, [1]);
  t("chunk blocks only: units citing other pages are rejected (unknown_source_block)", p1.prod.summary.issues.includes("unknown_source_block") && p1.prod.units.every(u => u.sources.every(s => s.page === 1)));
  console.log(ok.every(Boolean) ? "SELF-TEST PASSED (" + ok.length + ")" : "SELF-TEST FAILED"); process.exitCode = ok.every(Boolean) ? 0 : 1;
}
if (args.includes("--self-test")) selfTest();
else { const res = run(); print(res); const jf = opt("--json", null); if (jf) fs.writeFileSync(jf, JSON.stringify(res, null, 1) + "\n"); }
