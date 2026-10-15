#!/usr/bin/env node
"use strict";
// Offline analyzer for outline v1 (old) vs v3 (new) responses. No network, no keys.
// Production cnKnowledgeBlocks/cnKnowledgeClean/cnKnowledgeVisuals are loaded exactly as tools/course_discovery_test.cjs does
// (require of tools/course_logic_test.cjs, which vm-extracts them from src/corpus.html). Repository is only read.
//   node analyze.cjs                      baseline: old responses only (new ones absent)
//   node analyze.cjs --new-dir out        old vs new (out/response-1.json, response-2.json, run-summary.json)
//   node analyze.cjs --synthetic          self-test of the analyzer on artificial "new" responses
//   options: --old old-response|evidence  --handoff DIR  --json FILE  --verbose
const fs = require("fs"), path = require("path"), assert = require("node:assert/strict");
const REPO = process.env.CORPUS_REPO || "/home/user/Corpus";
const { logic } = require(path.join(REPO, "tools/course_logic_test.cjs"));
const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const R = __dirname, H = path.resolve(opt("--handoff", path.join(R, "..", "handoff")));
const read = p => JSON.parse(fs.readFileSync(p, "utf8")), clone = x => JSON.parse(JSON.stringify(x));
const norm = x => String(x).replace(/\s+/gu, " ").trim().toLowerCase();
const flat = v => Array.isArray(v) ? v.map(flat).join(" ") : v && typeof v === "object" ? Object.values(v).map(flat).join(" ") : v == null ? "" : String(v);
const short = (s, n = 80) => { s = String(s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const USD = (i, o) => i * 0.10 / 1e6 + o * 0.50 / 1e6;

// ---------- data from the evidence (same selection as compare.cjs) ----------
const records = read(path.join(H, "evidence/backend-after-paid.json")).docs;
const plan = records.find(x => x.coll === "cplan" && x.data.planVersion === 2);
const draft = records.find(x => x.coll === "cdraft" && x.id === plan.id).data;
const docs = new Map(records.filter(x => x.coll === "ctext").map(x => [x.id, x.data]));
const witnesses = Object.entries(read(path.join(H, "evidence/omission-witnesses.json"))).flatMap(([p, ns]) => ns.map(name => ({ name, page: +p })));
const ledger = fs.readFileSync(path.join(H, "evidence/real-run-ledger.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse).filter(x => x.status === "completed" && x.task === "outline");
const MATS = [{ key: "Основа", name: "Kolju-tervikuna.pdf" }, { key: "Дополнение", name: "Ossa-cranii (1).pdf" }].map((x, i) => {
  const req = read(path.join(H, "outline-v3-comparison/request-" + (i + 1) + ".json")), input = JSON.parse(req.messages[0].content.split("INPUT:\n")[1]);
  const m = draft.mats.find(m => m.name === x.name), pages = m.chunks.flatMap(id => docs.get(id).pages), blocks = logic.cnKnowledgeBlocks(m, pages);
  assert.deepEqual(clone(blocks.map(b => ({ id: b.id, text: b.text, emphasis: b.emphasis }))), input.pages.flatMap(p => p.blocks), "blocks == request-" + (i + 1) + " INPUT");
  return { ...x, n: i + 1, m, pages, blocks, input, sent: new Set(input.pages.flatMap(p => p.blocks).map(b => b.id)), ledger: ledger[i] };
});

// ---------- response loading ----------
function wrap(obj, usage) { return { content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "(not recorded)", usage, model: "(not recorded)", _wrapped: true }; }
function loadResponse(file, matN, spent) {
  if (!file || !fs.existsSync(file)) return null;
  let r = read(file); if (r.knowledge && !r.content) r = wrap(r, spent && { input_tokens: spent.usage.input_tokens, output_tokens: spent.usage.output_tokens });
  return r;
}
function evaluate(resp, M) {
  const text = resp.content.filter(x => x.type === "text").map(x => x.text).join(""); let raw, parseError = "";
  try { raw = JSON.parse(text); } catch (_) { parseError = "invalid_json"; }
  const truncated = resp.stop_reason !== "end_turn" && resp.stop_reason !== "(not recorded)";
  const full = logic.cnKnowledgeClean(raw, M.blocks, M.m, { truncated });
  const entries = Array.isArray(raw && raw.knowledge) ? raw.knowledge : [], accepted = new Set(full.units.map(u => u.id)), seen = new Map();
  const per = entries.map((u, i) => {
    const one = logic.cnKnowledgeClean({ knowledge: [u] }, M.blocks, M.m), unit = one.units[0] || null;
    const unitIssues = one.issues.filter(x => !x.startsWith("source_blocks_without_units:") && x !== "empty_knowledge_for_text");
    const key = unit ? unit.type + "\0" + JSON.stringify(unit.content) : null; let dupOf = null;
    if (key && seen.has(key)) dupOf = seen.get(key); else if (key) seen.set(key, i);
    return { i, type: u && u.type, unit, id: unit && unit.id, rejected: !!one.rejected, reasons: one.rejected ? unitIssues : [], relinked: unitIssues.includes("source_quote_relinked"),
      beyondLimit: i >= 50, dupOf, accepted: !!unit && accepted.has(unit.id) && i < 50, contentText: norm(flat(u && u.content)), quotes: ((u && u.sources) || []).map(s => norm(s && s.quote || "")), rawBlockIds: ((u && u.sources) || []).map(s => s && s.block_id) };
  });
  const byType = list => list.reduce((a, t) => (a[t || "?"] = (a[t || "?"] || 0) + 1, a), {});
  const usage = resp.usage || {}, cost = usage.input_tokens != null ? USD(usage.input_tokens, usage.output_tokens || 0) : null;
  return { raw, parseError, full, per, units: clone(full.units), topicsText: norm(flat(raw && raw.topics)), rawN: entries.length,
    summary: { rawByType: byType(entries.map(u => u && u.type)), acceptedByType: byType(full.units.map(u => u.type)), rawUnits: entries.length, accepted: full.units.length, rejected: full.rejected,
      mergedDuplicates: full.mergedDuplicates, status: full.status, issues: clone(full.issues), parseError, knowledge_limited: raw && raw.knowledge_limited === true, truncated, stop_reason: resp.stop_reason,
      topics: Array.isArray(raw && raw.topics) ? raw.topics.length : 0, relinked: per.filter(p => p.relinked).length, beyondUnitLimit: Math.max(0, entries.length - 50),
      rejectedItems: per.filter(p => p.rejected).map(p => ({ index: p.i, type: p.type, reasons: p.reasons })), duplicateItems: per.filter(p => p.dupOf !== null).map(p => ({ index: p.i, duplicateOf: p.dupOf })),
      usage: { input: usage.input_tokens, output: usage.output_tokens, cache_creation: usage.cache_creation_input_tokens || 0, cache_read: usage.cache_read_input_tokens || 0 }, costUSD: cost,
      visualLocations: logic.cnKnowledgeVisuals(M.m, M.pages, 0).length } };
}
const blockOf = (M, id) => M.blocks.find(b => b.id === id);
const quotesOfUnit = (M, u) => u.sources.map(s => { const b = blockOf(M, s.blockId); return b ? b.text.slice(s.start - b.start, s.end - b.start) : ""; });

// ---------- (b) witnesses ----------
function witnessTable(ev, M) {
  return witnesses.map(w => {
    const nm = norm(w.name), wb = M.blocks.filter(b => b.page === w.page && norm(b.text).includes(nm));
    const row = { page: w.page, name: w.name, blocks: wb.map(b => ({ id: b.id, order: M.blocks.indexOf(b), kind: b.kind, emphasis: b.emphasis, sentInRequest: M.sent.has(b.id) })), status: "отсутствует", hits: [] };
    if (!ev) return row;
    const wids = new Set(wb.map(b => b.id)), words = nm.split(" ").filter(x => x.length >= 3);
    for (const p of ev.per) {
      const acceptedQuotes = p.unit ? quotesOfUnit(M, p.unit).map(norm) : [], quotes = [...p.quotes, ...acceptedQuotes];
      const inContent = p.contentText.includes(nm), inQuote = quotes.some(q => q.includes(nm));
      const citedIds = p.unit ? p.unit.sources.map(s => s.blockId) : p.rawBlockIds, citesWitnessBlock = citedIds.some(id => wids.has(id));
      if (citesWitnessBlock) row.sameBlockCitations = (row.sameBlockCitations || 0) + 1;
      const wordsAll = words.length > 1 && words.every(x => (p.contentText + " " + quotes.join(" ")).includes(x));
      if (inContent || inQuote) {
        const quoteOnWitnessBlock = p.unit ? p.unit.sources.some(s => { const b = blockOf(M, s.blockId); return wids.has(s.blockId) && norm(b.text.slice(s.start - b.start, s.end - b.start)).includes(nm); }) : null;
        row.hits.push({ via: inContent ? "content" : "quote", idx: p.i, id: p.id, type: p.type, citesWitnessBlock, quoteContainsNameInWitnessBlock: quoteOnWitnessBlock, relinked: p.relinked, validatorAccepted: p.accepted, rejectReasons: p.reasons });
      } else if (wordsAll) row.hits.push({ via: "indirect", idx: p.i, id: p.id, type: p.type, citesWitnessBlock, allWordsPresent: wordsAll, relinked: p.relinked, validatorAccepted: p.accepted });
    }
    const topic = ev.topicsText.includes(nm);
    row.status = row.hits.some(h => h.via === "content") ? "в content единицы" : row.hits.some(h => h.via === "quote") ? "только в цитате (quote)" : topic ? "в теме/terms" : row.hits.length ? "упомянут косвенно (в общей формулировке)" : "отсутствует";
    row.inTopics = topic;
    return row;
  });
}
function witnessContext(M) {
  return witnesses.map(w => { const nm = norm(w.name), b = M.blocks.find(b => b.page === w.page && norm(b.text).includes(nm)); if (!b) return { ...w, context: "" }; const t = norm(b.text), i = t.indexOf(nm), a = Math.max(0, i - 70), e = Math.min(t.length, i + nm.length + 70);
    return { ...w, block: b.id, context: (a ? "…" : "") + t.slice(a, e) + (e < t.length ? "…" : "") }; });
}

// ---------- (c) rough list diagnostic ----------
const SEED_TERMS = ["Margo frontalis", "Tuber parietale", "Glabella", "Arcus superciliaris", "Clivus"];
function roughItems(M) {
  const out = [], push = (kind, page, text) => { text = text.replace(/[.:;,\s]+$/u, "").replace(/^[\s(]+|[\s)]+$/gu, ""); if (text.length >= 3 && text.length <= 80) out.push({ kind, page, text, key: norm(text) }); };
  for (const b of M.blocks) {
    if (b.emphasis) { push("em", b.page, b.text); continue; }
    for (const ln of b.text.split("\n").map(s => s.trim()).filter(Boolean)) {
      let mm;
      if ((mm = ln.match(/^[-–—•*]\s*(.+?)(?:\s+[–—-]\s+.*)?$/u))) push("bullet", b.page, mm[1]);
      else if ((mm = ln.match(/^\d+[.)]\s*(.+)$/u))) push("numbered", b.page, mm[1]);
      else if (ln.length <= 60 && ln.split(/\s+/).length <= 5 && /^[\p{L}(]/u.test(ln) && !/[.!?]$/.test(ln.replace(/\.$/, "") === ln ? ln : "")) push("shortLine", b.page, ln);
    }
  }
  const seen = new Set(); return out.filter(x => { const k = x.kind + "|" + x.page + "|" + x.key; if (seen.has(k)) return false; seen.add(k); return true; });
}
function listCoverage(ev, M) {
  const items = roughItems(M); if (!ev) return { items: items.length, note: "no response" };
  const hay = ev.units.map(u => norm(flat(u.content)) + " | " + quotesOfUnit(M, u).map(norm).join(" | ")), contentOnly = ev.units.map(u => norm(flat(u.content)));
  const rep = it => hay.some(h => h.includes(it.key)), repC = it => contentOnly.some(h => h.includes(it.key)), kinds = {};
  for (const it of items) { const k = kinds[it.kind] = kinds[it.kind] || { total: 0, inContentOrQuote: 0, inContent: 0, pages: {} }, pg = k.pages[it.page] = k.pages[it.page] || [0, 0];
    k.total++; pg[0]++; if (rep(it)) { k.inContentOrQuote++; pg[1]++; } if (repC(it)) k.inContent++; }
  return { kinds, note: "DIAGNOSTIC ONLY: heuristic list of named elements (bullet/numbered/em/short plain lines), substring match; not completeness" };
}
function seedTerms(ev, M) {
  return SEED_TERMS.map(t => { const nm = norm(t), pgs = [...new Set(M.blocks.filter(b => norm(b.text).includes(nm)).map(b => b.page))];
    const r = { term: t, sourcePages: pgs, sourceMentions: M.blocks.filter(b => norm(b.text).includes(nm)).length, content: 0, quoteOnly: 0, topics: false, acceptedContent: 0 };
    if (ev) { for (const p of ev.per) { const c = p.contentText.includes(nm), q = p.quotes.some(x => x.includes(nm)); if (c) r.content++; else if (q) r.quoteOnly++; if (c && p.accepted) r.acceptedContent++; } r.topics = ev.topicsText.includes(nm); }
    return r; });
}

// ---------- (d) preservation ----------
function preservation(oldEv, newEv, M) {
  if (!oldEv || !newEv) return null;
  const canon = u => u.type + "\0" + JSON.stringify(u.content), nc = u => norm(flat(u.content)), overlap = (u, v) => u.sources.some(s => v.sources.some(t => s.blockId === t.blockId && s.start < t.end && t.start < s.end));
  const classify = (u, pool) => pool.some(v => canon(v) === canon(u)) ? "same type+content" : pool.some(v => nc(v) === nc(u)) ? "same content, other type" : pool.some(v => overlap(u, v)) ? "same source span, other wording" : "lost";
  const rows = oldEv.units.map(u => ({ id: u.id, type: u.type, page: u.sources[0].page, content: short(flat(u.content)), cls: classify(u, newEv.units) }));
  const back = newEv.units.map(v => classify(v, oldEv.units)), by = {}; rows.forEach(r => by[r.cls] = (by[r.cls] || 0) + 1);
  return { oldUnits: oldEv.units.length, strict: rows.filter(r => r.cls === "same type+content").length, loose: rows.filter(r => r.cls !== "lost").length, byClass: by, lost: rows.filter(r => r.cls === "lost"),
    newUnits: back.filter(c => c === "lost").length, newTotal: newEv.units.length };
}

// ---------- verdict ----------
function verdict(M, oldEv, newEv, oldW, newW, pres, oldL, newL) {
  if (!newEv) return null;
  const count = (w, f) => w.filter(f).length, rows = [];
  const add = (name, o, n, better) => rows.push({ metric: name, old: o, new: n, change: o === n ? "не изменилось" : better === "up" ? (n > o ? "улучшилось" : "ухудшилось") : better === "down" ? (n < o ? "улучшилось" : "ухудшилось") : "изменилось (без оценки)" });
  const os = oldEv.summary, ns = newEv.summary;
  add("принято единиц", os.accepted, ns.accepted, "neutral"); add("сырых единиц", os.rawUnits, ns.rawUnits, "neutral");
  add("отклонено валидатором", os.rejected, ns.rejected, "down"); add("слито дублей", os.mergedDuplicates, ns.mergedDuplicates, "down");
  add("единиц сверх лимита 50", os.beyondUnitLimit, ns.beyondUnitLimit, "down"); add("source_quote_mismatch (issue)", +os.issues.includes("source_quote_mismatch"), +ns.issues.includes("source_quote_mismatch"), "down");
  add("source_quote_relinked (единиц)", os.relinked, ns.relinked, "down"); add("knowledge_limited", +os.knowledge_limited, +ns.knowledge_limited, "down"); add("truncated", +os.truncated, +ns.truncated, "down");
  add("выходных токенов", os.usage.output, ns.usage.output, "neutral"); add("стоимость USD", +(os.costUSD || 0).toFixed(5), +(ns.costUSD || 0).toFixed(5), "neutral");
  if (M.n === 1) { add("из 21 примеров: имя в content", count(oldW, r => r.status.startsWith("в content")), count(newW, r => r.status.startsWith("в content")), "up");
    add("из 21: имя в content или quote (подстрока)", count(oldW, r => r.status.startsWith("в content") || r.status.startsWith("только в цит")), count(newW, r => r.status.startsWith("в content") || r.status.startsWith("только в цит")), "up");
    add("из 21: отсутствует", count(oldW, r => r.status === "отсутствует"), count(newW, r => r.status === "отсутствует"), "down"); }
  if (pres) { add("прежние единицы сохранены строго", pres.oldUnits, pres.strict, "up"); add("прежние единицы сохранены (нестрого)", pres.oldUnits, pres.loose, "up"); }
  if (oldL.kinds) for (const k of Object.keys(oldL.kinds)) add("перечень[" + k + "] в content/quote", oldL.kinds[k].inContentOrQuote + "/" + oldL.kinds[k].total, newL.kinds[k].inContentOrQuote + "/" + newL.kinds[k].total, "neutral");
  return rows;
}

// ---------- run ----------
function analyzeAll({ oldKind, newDir, newFiles, quiet }) {
  const out = { mode: newDir || newFiles ? "old-vs-new" : "baseline(old only)", materials: [] };
  for (const M of MATS) {
    const oldFile = oldKind === "evidence" ? path.join(H, "evidence/paid-response-" + M.n + "-outline.json") : path.join(H, "outline-v3-comparison/old-response-" + M.n + ".json");
    const oldResp = loadResponse(oldFile, M.n, M.ledger.response ? { usage: M.ledger.usage } : null); if (oldKind === "evidence") oldResp.usage = M.ledger.usage;
    const newFile = newFiles ? newFiles[M.n - 1] : newDir ? path.join(newDir, "response-" + M.n + ".json") : null, newResp = loadResponse(newFile, M.n);
    if (newResp && newDir && fs.existsSync(path.join(newDir, "run-summary.json"))) { const c = (read(path.join(newDir, "run-summary.json")).calls || []).find(x => x.n === M.n); if (c && c.usage) newResp.usage = c.usage; }
    const oldEv = evaluate(oldResp, M), newEv = newResp ? evaluate(newResp, M) : null;
    const oldW = witnessTable(oldEv, M), newW = M.n === 1 ? witnessTable(newEv, M) : null, pres = preservation(oldEv, newEv, M);
    const oldL = listCoverage(oldEv, M), newL = listCoverage(newEv, M);
    out.materials.push({ key: M.key, name: M.name, pages: M.pages.length, blocks: M.blocks.length, ledgerOld: { actualUSD: M.ledger.actualUSD, input: M.ledger.usage.input_tokens, output: M.ledger.usage.output_tokens },
      old: oldEv.summary, new: newEv && newEv.summary, witnessContext: M.n === 1 ? witnessContext(M) : null, witnessesOld: M.n === 1 ? oldW : null, witnessesNew: newW,
      seedOld: M.n === 2 ? seedTerms(oldEv, M) : null, seedNew: M.n === 2 ? seedTerms(newEv, M) : null, listOld: oldL, listNew: newL, preservation: pres,
      verdict: verdict(M, oldEv, newEv, oldW, newW, pres, oldL, newL), _ev: { oldEv, newEv } });
  }
  return out;
}
function printReport(res) {
  const L = s => console.log(s);
  L("== Outline v1 vs v3 analyzer (" + res.mode + "). Подстрока в тексте ≠ смысловое соответствие; число единиц ≠ полнота. ==");
  for (const m of res.materials) {
    L("\n### " + m.key + ": " + m.name + " (" + m.pages + " стр., " + m.blocks + " блоков)");
    for (const [tag, s] of [["старый", m.old], ["новый", m.new]]) { if (!s) { L("  " + tag + ": ответа нет"); continue; }
      L("  a) " + tag + ": stop=" + s.stop_reason + " tokens in/out=" + s.usage.input + "/" + s.usage.output + " cost=$" + (s.costUSD == null ? "?" : s.costUSD.toFixed(5)) + " limited=" + s.knowledge_limited + " truncated=" + s.truncated + " parse=" + (s.parseError || "ok"));
      L("     сырых=" + s.rawUnits + " " + JSON.stringify(s.rawByType) + " -> принято=" + s.accepted + " " + JSON.stringify(s.acceptedByType) + " rejected=" + s.rejected + " dup=" + s.mergedDuplicates + " relinked=" + s.relinked + " >50=" + s.beyondUnitLimit + " topics=" + s.topics);
      L("     issues: " + s.issues.join(", ") + (s.rejectedItems.length ? "\n     rejected: " + s.rejectedItems.map(r => "#" + r.index + ":" + r.type + "[" + r.reasons.join("+") + "]").join("; ") : "") + (s.duplicateItems.length ? "\n     duplicates: " + s.duplicateItems.map(d => "#" + d.index + "=#" + d.duplicateOf).join("; ") : "")); }
    L("     ledger старого вызова: $" + m.ledgerOld.actualUSD.toFixed(5) + " (" + m.ledgerOld.input + "/" + m.ledgerOld.output + ")");
    if (m.witnessContext) {
      L("  b) 21 пример. Контекст (≤200 симв.) — один раз. Статус «косвенно» = ЭВРИСТИКА (у многословного имени все слова есть в одной единице, не подряд), нужна ручная проверка; same_block = число сырых единиц, цитирующих блок с примером (не статус):");
      m.witnessContext.forEach(w => L("     p" + w.page + " " + w.name + " | блок " + w.block + " | " + short(w.context, 200)));
      for (const [tag, W] of [["старый", m.witnessesOld], ["новый", m.witnessesNew]]) { if (!W) continue; L("   статус (" + tag + "):");
        W.forEach(r => { const h = r.hits.filter(x => x.via !== "indirect")[0] || r.hits[0];
          L("     p" + r.page + " " + r.name.padEnd(28) + " " + r.status + (!h ? " same_block=" + (r.sameBlockCitations || 0) : "") + (h ? " | #" + h.idx + " " + h.type + " " + h.id + " cite_witness_block=" + h.citesWitnessBlock + (h.via === "indirect" ? "" : " name_in_quote_on_block=" + h.quoteContainsNameInWitnessBlock) + " relinked=" + h.relinked + " accepted=" + h.validatorAccepted : "")); });
        const c = {}; W.forEach(r => c[r.status] = (c[r.status] || 0) + 1); L("     итого: " + JSON.stringify(c)); }
    }
    if (m.seedOld) { L("  c) Ossa-cranii: единиц до/после: " + m.old.accepted + " / " + (m.new ? m.new.accepted : "—"));
      for (const [tag, S] of [["старый", m.seedOld], ["новый", m.seedNew]]) if (S) S.forEach(t => L("     " + tag + " " + t.term + ": в тексте стр." + t.sourcePages.join(",") + " (" + t.sourceMentions + " бл.); content=" + t.content + " (приняты " + t.acceptedContent + ") только-quote=" + t.quoteOnly + " topics=" + t.topics)); }
    for (const [tag, Lc] of [["старый", m.listOld], ["новый", m.listNew]]) if (Lc && Lc.kinds) { L("  c) перечень, ДИАГНОСТИКА (" + tag + "): " + Object.entries(Lc.kinds).map(([k, v]) => k + " " + v.inContentOrQuote + "/" + v.total + " (в content " + v.inContent + ")").join("; "));
      if (m.key === "Дополнение" || m.new) Object.entries(Lc.kinds).forEach(([k, v]) => L("       " + k + " по стр.: " + Object.entries(v.pages).map(([p, c]) => p + ":" + c[1] + "/" + c[0]).join(" "))); }
    if (m.preservation) { const p = m.preservation; L("  d) сохранность " + p.oldUnits + " прежних: строго " + p.strict + ", нестрого " + p.loose + " " + JSON.stringify(p.byClass) + "; потеряно " + p.lost.length + "; новых " + p.newUnits + " (из " + p.newTotal + ")");
      p.lost.forEach(r => L("       потеряна " + r.id + " p" + r.page + " " + r.type + ": " + r.content)); }
    if (m.verdict) { L("  e) вердикт (без оценки «успеха» по числу единиц):"); m.verdict.forEach(r => L("     " + r.metric.padEnd(44) + String(r.old).padStart(9) + " -> " + String(r.new).padEnd(9) + r.change)); }
  }
}
function stripPrivate(res) { return JSON.parse(JSON.stringify(res, (k, v) => k === "_ev" ? undefined : v)); }

// ---------- synthetic self-test ----------
function synthetic() {
  const M = MATS[0], old = JSON.parse(fs.readFileSync(path.join(H, "outline-v3-comparison/old-response-1.json"), "utf8"));
  const oldRaw = JSON.parse(old.content[0].text), mk = f => { const r = clone(old), raw = clone(oldRaw); f(raw); r.content = [{ type: "text", text: JSON.stringify(raw) }]; return r; };
  const uniqueQuote = (b, name) => { const i = b.text.toLowerCase().indexOf(name.toLowerCase()); let len = name.length; while (b.text.indexOf(b.text.substr(i, len), i + 1) >= 0 && i + len < b.text.length) len++; return b.text.substr(i, len); };
  const wb = n => M.blocks.find(b => norm(b.text).includes(n));
  const bOvale = wb("foramen ovale"), bSpin = wb("foramen spinosum"), bHyp = wb("canalis hypoglossi");
  const title = M.blocks[0];
  const scen = {
    mismatch: mk(r => r.knowledge.push({ type: "term", content: "Invented term", sources: [{ block_id: title.id, quote: "this exact sentence is not in any block" }] })),
    duplicate: mk(r => r.knowledge.push(clone(r.knowledge[0]))),
    limit: (() => { const used = new Set(oldRaw.knowledge.map(u => u.sources[0].quote)), pad = [];
      for (const b of M.blocks) { const t = b.text.replace(/\s+/g, " "); for (let i = 0; i + 14 <= t.length && pad.length < 34; i += 41) { const q = t.substr(i, 14); if (b.text.includes(q) && M.blocks.filter(x => x.text.includes(q)).length === 1 && b.text.indexOf(q, b.text.indexOf(q) + 1) < 0 && !used.has(q) && q.trim() === q) { pad.push({ type: "term", content: "pad " + pad.length + " " + q, sources: [{ block_id: b.id, quote: q }] }); used.add(q); } } }
      assert.ok(pad.length >= 30, "padding available: " + pad.length); return mk(r => r.knowledge.push(...pad.slice(0, 34))); })(),
    witnesses: mk(r => { r.knowledge.push({ type: "term", content: "Foramen ovale", sources: [{ block_id: bOvale.id, quote: uniqueQuote(bOvale, "foramen ovale") }] },
      { type: "statement", content: "The foramen spinosum transmits a vessel.", sources: [{ block_id: title.id, quote: title.text.trim() }] },
      { type: "statement", content: "A canal of the skull base.", sources: [{ block_id: bHyp.id, quote: uniqueQuote(bHyp, "canalis hypoglossi") }] });
      r.topics[0].terms = (r.topics[0].terms || []).concat(["jugum sphenoidale"]); })
  };
  const results = {};
  for (const [k, resp] of Object.entries(scen)) { const ev = evaluate(resp, M), W = witnessTable(ev, M); results[k] = { ev, W }; }
  const s = k => results[k].ev.summary, W = (k, n) => results[k].W.find(r => r.name === n);
  const A = [];
  const t = (name, cond) => { A.push([name, !!cond]); console.log((cond ? "PASS " : "FAIL ") + name); };
  t("mismatch: source_quote_mismatch issue + rejected=1, accepted stays 26", s("mismatch").issues.includes("source_quote_mismatch") && s("mismatch").rejected === 1 && s("mismatch").accepted === 26 && s("mismatch").rejectedItems[0].reasons.includes("source_quote_mismatch"));
  t("duplicate: mergedDuplicates=1, accepted 26, duplicateItems lists #26=#0", s("duplicate").mergedDuplicates === 1 && s("duplicate").accepted === 26 && s("duplicate").duplicateItems[0].index === 26 && s("duplicate").duplicateItems[0].duplicateOf === 0);
  t("limit: raw>50 -> unit_limit, accepted 50, beyondUnitLimit>=10", s("limit").rawUnits >= 60 && s("limit").issues.includes("unit_limit") && s("limit").accepted === 50 && s("limit").beyondUnitLimit >= 10);
  t("witnesses: foramen ovale -> in content, cited block ok, accepted", W("witnesses", "foramen ovale").status === "в content единицы" && W("witnesses", "foramen ovale").hits[0].citesWitnessBlock === true && W("witnesses", "foramen ovale").hits[0].validatorAccepted);
  t("witnesses: foramen spinosum -> in content but cites a different block (flagged)", W("witnesses", "foramen spinosum").status === "в content единицы" && W("witnesses", "foramen spinosum").hits[0].citesWitnessBlock === false);
  t("witnesses: canalis hypoglossi -> only in quote", W("witnesses", "canalis hypoglossi").status === "только в цитате (quote)");
  t("witnesses: jugum sphenoidale -> in topics/terms", W("witnesses", "jugum sphenoidale").status === "в теме/terms");
  t("witnesses: 16 stay 'отсутствует' (21 - 4 planted - 1 pre-existing weak 'processus alveolaris' candidate)", results.witnesses.W.filter(r => r.status === "отсутствует").length === 16);
  t("baseline old: no 'в content' / 'только в цитате' / 'в теме' for any of the 21 (20 absent + 1 weak indirect)", witnessTable(evaluate(old, M), M).filter(r => r.status === "отсутствует").length === 20);
  // full pipeline in a temp dir (files, summary) -> print a short compact view for 'mismatch'
  const dir = path.join(R, "synthetic_out"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "response-1.json"), JSON.stringify(scen.witnesses)); fs.copyFileSync(path.join(H, "outline-v3-comparison/old-response-2.json"), path.join(dir, "response-2.json"));
  const res = analyzeAll({ oldKind: "old-response", newDir: dir });
  t("old-vs-new pipeline: verdict rows + preservation 26/26 strict", res.materials[0].verdict.length > 8 && res.materials[0].preservation.strict === 26 && res.materials[0].preservation.newUnits === 3);
  const drop = clone(scen.mismatch); const raw = JSON.parse(drop.content[0].text); raw.knowledge.splice(0, 2); drop.content[0].text = JSON.stringify(raw);
  const pe = preservation(evaluate(old, M), evaluate(drop, M), M);
  t("preservation: removing 2 old units -> lost 2 (loose may still match by span)", pe.strict === 24 && pe.lost.length <= 2);
  for (const k of ["mismatch", "duplicate", "limit"]) { const x = s(k); console.log("  [" + k + "] raw=" + x.rawUnits + " accepted=" + x.accepted + " rejected=" + x.rejected + " dup=" + x.mergedDuplicates + " >50=" + x.beyondUnitLimit + " issues=" + x.issues.filter(i => !i.startsWith("source_blocks")).join(",")); }
  console.log("  [witnesses] statuses: " + JSON.stringify(results.witnesses.W.filter(r => r.status !== "отсутствует").map(r => r.name + " => " + r.status)));
  res.materials[0].verdict.slice(0, 12).forEach(r => console.log("  verdict " + r.metric.padEnd(44) + String(r.old).padStart(7) + " -> " + String(r.new).padEnd(7) + r.change));
  const bad = A.filter(a => !a[1]); console.log("\nSYNTHETIC " + (bad.length ? "FAILED: " + bad.map(a => a[0]).join("; ") : "CHECKS PASSED (" + A.length + ")")); process.exitCode = bad.length ? 1 : 0;
}

if (args.includes("--synthetic")) synthetic();
else {
  const newDir = opt("--new-dir", null) && path.resolve(opt("--new-dir")), res = analyzeAll({ oldKind: opt("--old", "old-response"), newDir: newDir && fs.existsSync(path.join(newDir, "response-1.json")) ? newDir : null });
  printReport(res);
  const jf = opt("--json", null); if (jf) fs.writeFileSync(jf, JSON.stringify(stripPrivate(res), null, 1) + "\n");
}
