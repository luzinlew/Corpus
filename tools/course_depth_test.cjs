#!/usr/bin/env node
"use strict";
// T-047: deeper lessons, no lessons about headings. Offline: production client functions (vm) from src/corpus.html and the production
// function source (lessonPrompt / checkLesson / the token limits) from supabase/functions/corpus-ai/index.ts. No browser, network or model.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const { logic, context, between, betweenServer, source, serverSource } = require("./course_logic_test.cjs");
const clone = x => JSON.parse(JSON.stringify(x));
const ctx = name => vm.runInContext(name, context);
vm.runInContext(between("const cnMatIds=", "\n"), context);

// the function's own lesson code
const fn = vm.createContext({});
vm.runInContext(stripTypeScriptTypes("const PL_STR=300,PL_Q=600,LANG_NAME={ru:'Russian',en:'English',et:'Estonian'};" +
  "const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v),isStr=(v,n)=>typeof v==='string'&&v.length<=n,isId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(v);" +
  "function onlyKeys(o,keys){return Object.keys(o).every(k=>keys.includes(k));}" +
  betweenServer("const LS_TERMS =", "function lessonPrompt(") + betweenServer("function lessonPrompt(", "// One call to the Claude Messages API")) +
  "\nglobalThis.h={checkLesson,lessonPrompt,LS_MAX_TOKENS,LS_KNOWLEDGE_MAX_TOKENS:typeof LS_KNOWLEDGE_MAX_TOKENS==='undefined'?null:LS_KNOWLEDGE_MAX_TOKENS};", fn);

let n = 0; const ok = async (name, f) => { try { await f(); n++; console.log("PASS " + name); } catch (e) { console.log("FAIL " + name + "\n  " + String(e && e.message || e).split("\n")[0].slice(0, 400)); process.exitCode = 1; } };

/* ---------- heading_only ---------- */
const material = { id: "mat-h", name: "Heads.pdf", role: "base", kind: "pdf", pages: 1 };
const src = (kind, start, end, blockId) => [{ materialId: material.id, blockId: blockId || "b" + start, page: 1, start, end, kind, sourceOrder: { pageIndex: 1, block: start } }];
const unit = (id, type, content, sources, at) => ({ id, version: 1, type, content, sources, order: { pageIndex: 1, page: 1, block: at, offset: at }, extractionStatus: "extracted", sourceLinkStatus: "checked", verificationStatus: "unverified", coverageStatus: "not_in_plan" });
const LONG = "Fossa cranii media ja posterior´i vaheline piir – crista partis petrosae ossis temporalis ja dorsum sellae";
async function planOf(units) {
  const mat = { ...material, kdocs: ["draft-h.mat-h.ku1.g0.1"], kstatus: "processed" };
  const docs = new Map([[mat.kdocs[0], { kind: "course-knowledge", version: 1, materialId: mat.id, outlineStatus: "processed", sourceProcessingStatus: "no_warning_detected", completeness: "not_proven", issues: [], units: clone(units) }]]);
  context.cnDocData = async (_c, id) => docs.get(id) || null;
  return logic.cnKnowledgePlanInput({ id: "draft-h", name: "Heads", mats: [mat] }, { cancel: false, topics: [], dt: {}, diagnostics: null });
}
const units = [
  unit("ku1_head", "statement", "KOLJU TERVIKUNA", src("emphasis_fragment", 0, 15), 0),
  unit("ku1_long", "statement", LONG, src("emphasis_fragment", 20, 20 + LONG.length), 1),
  unit("ku1_term", "term", "Basis cranii interna", src("text_fragment", 300, 320), 2),    // a plain term: stays (T-057: an emphasised definition-less one is a heading)
  unit("ku1_plain", "statement", "Koljupõhi", src("text_fragment", 400, 409), 3),            // short, but not a heading block
  unit("ku1_part", "statement", "Koljupõhi osa", src("emphasis_fragment", 500, 560), 4),     // the quote is only a part of a longer block
  unit("ku1_def", "statement", "Foramen magnum – suur ava.", src("emphasis_fragment", 600, 626), 5),
  unit("ku1_sent", "statement", "Nervus vagus on X kraniaalnärv.", src("emphasis_fragment", 700, 731), 6),
  unit("ku1_colon", "statement", "Koljupõhja avad:", src("emphasis_fragment", 800, 816), 7),
  unit("ku1_eq", "statement", "F = m a", src("emphasis_fragment", 900, 907), 8),
  unit("ku1_dash", "statement", "Os — luu", src("emphasis_fragment", 950, 958), 9),
];
let plan;
const run = async () => { plan = plan || await planOf(units); return plan; };
const ixOf = id => plan.index.find(x => x.id === id);
const exOf = id => plan.inp.excluded.find(x => x.id === id);
(async () => {
await ok("heading_only: a statement equal to its one emphasised quote, at most 6 words, is excluded with the reason heading_only", async () => {
  await run();
  assert.ok(!plan.units.some(u => u.id === "ku1_head"), "not a lesson unit");
  assert.ok(!plan.inp.knowledge.some(u => u.id === "ku1_head"));
  assert.equal(exOf("ku1_head") && exOf("ku1_head").reason, "heading_only");
  assert.equal(ixOf("ku1_head").eligible, false, "visible in the index as not eligible");
});
await ok("heading_only: a long statement, a term, a short non-emphasis statement and a quote that is only a part stay", async () => {
  await run();
  for (const id of ["ku1_long", "ku1_term", "ku1_plain", "ku1_part", "ku1_def", "ku1_sent", "ku1_colon", "ku1_eq", "ku1_dash"]) { assert.ok(plan.units.some(u => u.id === id), id + " stays a lesson unit"); assert.ok(!exOf(id), id); assert.equal(ixOf(id).eligible, true); }
});
await ok("heading_only: coverage counts the unit as not eligible; the others stay planned", async () => {
  await run();
  assert.equal(plan.units.length, 9);
  assert.equal(plan.index.filter(x => !x.eligible).length, 1);
});
await ok("heading_only: a material of headings only stops with a clear error (knowledge_empty), not silently", async () => {
  await assert.rejects(planOf([unit("ku1_h1", "statement", "KOLJU TERVIKUNA", src("emphasis_fragment", 0, 15), 0), unit("ku1_h2", "statement", "FOSSA CRANII", src("emphasis_fragment", 20, 32), 1)]), e => e && e.code === "knowledge_empty");
});
await ok("heading_only: the reason survives the saved plan (cnKnowledgePlanDoc round trip) and the index stays not eligible", async () => {
  await run();
  const raw = { parts: [{ name: "P", lessons: [{ title: "L", knowledgeIds: plan.units.map(u => u.id), rationale: "Everything in source order." }] }] };
  const built = ctx("cnKnowledgePlanBuild")(raw, plan);
  const reloaded = ctx("cnKnowledgePlanDoc")(clone(built));
  assert.ok(reloaded, "the saved plan reloads");
  const h = reloaded.knowledgeIndex.find(x => x.id === "ku1_head");
  assert.equal(h.reason, "heading_only"); assert.equal(h.eligible, false); assert.equal(h.coverageStatus, "not_eligible"); assert.equal(h.lessonId, null);
  assert.ok(reloaded.knowledgeIndex.filter(x => x.eligible).every(x => !("reason" in x)), "no reason on lesson units");
  assert.equal(reloaded.coverage.expected, 9);
  const old = clone(built); old.knowledgeIndex.forEach(x => delete x.reason);
  assert.ok(ctx("cnKnowledgePlanDoc")(old), "a plan saved before T-047 (no reason) reads as before");
});
await ok("heading_only: the function accepts the plan input with the new reason", async () => {
  await run();
  const edge = vm.createContext({ LANG_NAME: { en: "English", ru: "Russian", et: "Estonian" } });
  vm.runInContext(stripTypeScriptTypes(betweenServer("const PL_TERMS", "function planPrompt(")) + "\nglobalThis.h={checkPlan};", edge);
  assert.equal(edge.h.checkPlan({ purpose: "course", lang: "en", input: plan.inp }), "");
});

/* ---------- claim limit ---------- */
const lim = ctx("cnKnowledgeClaimLimit");
const promptOf = (k, depth) => fn.h.lessonPrompt("en", { kind: "knowledge-v1", title: "T", units: Array.from({ length: k }, (_, i) => ({ id: "u" + i })), sourceBlocks: [], ...(depth ? { lessonDepth: depth } : {}) });
const perUnit = p => +/at most (\d+) claims per unit/.exec(p)[1];
await ok("claim limit: max(1,min(4,floor(40/n))): 1..10 units → 4, 12 → 3, 13 → 3, 20 → 2, 21 → 1, 40 → 1; the same number in the client and in the prompt of the function", async () => {
  for (const [k, want] of [[1, 4], [10, 4], [12, 3], [13, 3], [20, 2], [21, 1], [36, 1], [40, 1]]) {
    assert.equal(lim(k), want, "client n=" + k);
    assert.equal(lim(k, true), Math.max(1, Math.min(7, Math.floor(32 / k))), "client without lessonDepth n=" + k);
    assert.equal(perUnit(promptOf(k, 2)), want, "function n=" + k);
  }
});
await ok("intro: the prompt of the deeper lesson allows 6 intro claims, forbids repeating the unit's name, asks for relations, keeps Latin names", async () => {
  const p = promptOf(12, 2);
  assert.match(p, /at most 6 intro claims/);
  assert.match(p, /Do not repeat the name or wording of a unit/);
  assert.match(p, /context_fragment/);
  assert.match(p, /including Latin terms; never translate them/);
  assert.match(p, /language of the user/);
});
await ok("compatibility: input without lessonDepth (an older client, whose validator allows min(7,floor(32/n)) claims) gets the old prompt numbers", async () => {
  const p = promptOf(12);
  assert.equal(perUnit(p), 2); assert.match(p, /at most 4 short intro claims/);
  assert.equal(perUnit(promptOf(2)), 7);
});
await ok("function: lessonDepth is an accepted key with the value 2 only", async () => {
  const base = { kind: "knowledge-v1", title: "T", units: [{ id: "u1", type: "term", content: "x", sourceBlockIds: ["b1"], order: { materialIndex: 0, pageIndex: 1, block: 0, offset: 0 }, verificationStatus: "unverified" }],
    sourceBlocks: [{ id: "b1", materialId: "m1", sourceName: "s", page: 1, order: { materialIndex: 0, pageIndex: 1, block: 0, offset: 0 }, text: "x" }], sourceStatus: { status: "no_warning_detected", completeness: "not_proven" } };
  assert.equal(fn.h.checkLesson({ purpose: "course", lang: "en", input: base }), "");
  assert.equal(fn.h.checkLesson({ purpose: "course", lang: "en", input: { ...base, lessonDepth: 2 } }), "");
  assert.match(fn.h.checkLesson({ purpose: "course", lang: "en", input: { ...base, lessonDepth: 3 } }), /lessonDepth/);
});
await ok("tokens: the lesson of knowledge-v1 gets 8000 output tokens, the legacy lesson keeps 4000", async () => {
  assert.equal(fn.h.LS_KNOWLEDGE_MAX_TOKENS, 8000);
  assert.equal(fn.h.LS_MAX_TOKENS, 4000);
  assert.match(serverSource, /body\.input\?\.kind === "knowledge-v1" \? LS_KNOWLEDGE_MAX_TOKENS : LS_MAX_TOKENS/);
});

/* ---------- the client validator ---------- */
const blocks = Array.from({ length: 3 }, (_, i) => ({ id: "b" + i, materialId: "m1", sourceName: "S", page: 1, text: "Source sentence number " + i + " about the skull." }));
const mkPrepared = k => ({ units: Array.from({ length: k }, (_, i) => ({ id: "u" + i, sourceBlockIds: ["b" + (i % 3)] })), blocks });
const claim = (b, i) => ({ text: "Claim " + i, evidence: [{ blockId: "b" + b, quote: "Source sentence number " + b }] });
await ok("validator: accepts exactly limit claims per unit (n=12 → 3) and 6 intro claims, nothing is reported", async () => {
  const prep = mkPrepared(12), raw = { intro: Array.from({ length: 6 }, (_, i) => claim(0, i)), units: prep.units.map((u, i) => ({ id: u.id, claims: Array.from({ length: 3 }, (_, j) => claim(i % 3, j)) })) };
  const r = logic.cnKnowledgeLessonClean(raw, prep);
  assert.equal(r.generationStatus, "ai"); assert.deepEqual(clone(r.issues), []);
  assert.equal(r.intro.length, 6); assert.ok([...r.units.values()].every(c => c.length === 3));
});
await ok("validator: more than limit claims (4 at n=12, 2 at n=24, 7 intro) are cut to the limit and reported claim_limit → partial", async () => {
  const prep = mkPrepared(12), raw = { intro: [claim(0, 0)], units: prep.units.map((u, i) => ({ id: u.id, claims: Array.from({ length: 4 }, (_, j) => claim(i % 3, j)) })) };
  const r = logic.cnKnowledgeLessonClean(raw, prep);
  assert.ok(r.issues.includes("claim_limit")); assert.equal(r.generationStatus, "partial"); assert.ok([...r.units.values()].every(c => c.length === 3));
  const prep24 = mkPrepared(24), r24 = logic.cnKnowledgeLessonClean({ intro: [claim(0, 0)], units: prep24.units.map((u, i) => ({ id: u.id, claims: Array.from({ length: 2 }, (_, j) => claim(i % 3, j)) })) }, prep24);
  assert.ok(r24.issues.includes("claim_limit")); assert.ok([...r24.units.values()].every(c => c.length === 1));
  const ri = logic.cnKnowledgeLessonClean({ intro: Array.from({ length: 7 }, (_, i) => claim(0, i)), units: [] }, mkPrepared(1));
  assert.ok(ri.issues.includes("claim_limit")); assert.equal(ri.intro.length, 6);
});
await ok("size: a full lesson of 40 units x 1 claim + 6 intro claims of 500 characters (30-40k characters) is not dropped as response_size_limit; the limit itself still holds", async () => {
  assert.ok(ctx("CN_KLESSON").outputChars >= 40000, "outputChars " + ctx("CN_KLESSON").outputChars);
  const quotes = b => ["", " about", " about the"].map(t => ({ blockId: b, quote: "Source sentence number " + b.slice(1) + t }));
  const long = i => ({ text: ("Claim " + i + " ").padEnd(500, "x"), evidence: quotes("b0") });
  const prep = mkPrepared(40), raw = { intro: Array.from({ length: 6 }, (_, i) => long(i)), units: prep.units.map(u => ({ id: u.id, claims: [{ ...long(0), evidence: quotes(u.sourceBlockIds[0]) }] })) };
  const len = JSON.stringify(raw).length;
  assert.ok(len > 30000 && len < 40000, String(len));
  assert.equal(logic.cnKnowledgeLessonClean(raw, prep).generationStatus, "ai", "not dropped as response_size_limit");
  assert.ok(logic.cnKnowledgeLessonClean({ ...raw, pad: "x".repeat(ctx("CN_KLESSON").outputChars) }, prep).issues.includes("response_size_limit"), "the limit itself still holds");
});
await ok("client request: the lesson input carries lessonDepth 2 (so that the function writes the deeper prompt)", async () => {
  assert.match(source.slice(source.indexOf("async function cnKnowledgeLessonPrepare("), source.indexOf("function cnKnowledgeLessonClean(")), /lessonDepth:2/);
});

/* ---------- a new client against an older function ---------- */
await ok("older function: 400 invalid_input «lesson: …» on lessonDepth → one repeat without it, old limits (min(7,32/n), 4 intro), no second repeat, the flag holds for the session", async () => {
  const call = ctx("cnKnowledgeLessonCall");
  const mk = k => ({ ...mkPrepared(k), input: { kind: "knowledge-v1", title: "T", units: [], lessonDepth: 2 } });
  const seen = []; let refuse = true;
  const invoke = async input => { seen.push(clone(input)); if (refuse && input.lessonDepth === 2) throw { code: "invalid_input", message: "lesson: knowledge input has an invalid shape" }; return { intro: Array.from({ length: 4 }, (_, i) => claim(0, i)), units: mkPrepared(12).units.map((u, i) => ({ id: u.id, claims: Array.from({ length: 2 }, (_, j) => claim(i % 3, j)) })) }; };
  const p1 = mk(12), r1 = await call(p1, invoke);
  assert.equal(seen.length, 2); assert.equal(seen[0].lessonDepth, 2); assert.ok(!("lessonDepth" in seen[1]));
  assert.equal(r1.result.generationStatus, "ai", "4 intro and 2 claims per unit are within the old limits: " + JSON.stringify(r1.result.issues));
  assert.equal(ctx("CN_DEPTH_OFF"), true);
  const p2 = mk(12), r2 = await call(p2, invoke);
  assert.equal(seen.length, 3, "the next lesson goes straight without lessonDepth"); assert.ok(!("lessonDepth" in seen[2]));
  const tooMany = await call(mk(12), async () => ({ intro: Array.from({ length: 5 }, (_, i) => claim(0, i)), units: mkPrepared(12).units.map((u, i) => ({ id: u.id, claims: [claim(i % 3, 0)] })) }));
  assert.ok(tooMany.result.issues.includes("claim_limit") && tooMany.result.intro.length === 4, "5 intro claims are cut to the old 4");
  const sevenOne = await call(mk(2), async () => ({ intro: [claim(0, 0)], units: mkPrepared(2).units.map((u, i) => ({ id: u.id, claims: Array.from({ length: 7 }, (_, j) => claim(i, j)) })) }));
  assert.equal(sevenOne.result.generationStatus, "ai", "7 claims per unit are fine for 2 units without lessonDepth");
  vm.runInContext("CN_DEPTH_OFF=false", context);
  // another error, or a 400 of another task, is not retried
  for (const err of [{ code: "invalid_input", message: "plan: x" }, { code: "quota_exceeded", message: "lesson: x" }, { code: "unavailable", message: "lesson: x" }]) {
    let calls = 0;
    await assert.rejects(call(mk(2), async () => { calls++; throw err; }), e => e === err);
    assert.equal(calls, 1);
  }
  assert.equal(ctx("CN_DEPTH_OFF"), false);
  // the call that failed did not reach cnSpend: the caller spends only after cnKnowledgeLessonCall returns
  assert.match(source.slice(source.indexOf("async function cnBldKnowledgeOne("), source.indexOf("async function cnBldLegacyOne(")), /const called=await cnKnowledgeLessonCall\(prepared,[^;]*;cnUsageAdd\(b,called.raw\);cnSpend\(d,b,2\)/);
});

/* ---------- a lesson reply cut short ---------- */
await ok("truncated lesson: the whole units and the closed intro are kept, the unfinished unit is dropped, the lesson is partial with truncated_partial, no new request", async () => {
  const partialOf = ctx("cnKnowledgeLessonPartial");
  const prep = mkPrepared(4), full = { intro: [claim(0, 0), claim(1, 1)], units: prep.units.map((u, i) => ({ id: u.id, claims: [claim(i % 3, 0), claim(i % 3, 1)] })) };
  const text = JSON.stringify(full), cut = text.slice(0, text.indexOf('{"id":"u2"') + 25);
  const r = partialOf({ code: "invalid_json", truncated: true, text: cut }, prep);
  assert.equal(r.generationStatus, "partial"); assert.equal(r.intro.length, 2);
  assert.deepEqual([...r.units.keys()], ["u0", "u1"]); assert.ok(r.issues.includes("truncated_partial"));
  assert.equal(r.units.get("u0").length, 2);
  assert.equal(partialOf({ code: "invalid_json", truncated: false, text: cut }, prep), null, "a spoiled (not cut-short) reply is not read");
  assert.equal(partialOf({ code: "invalid_json", truncated: true, text: '{"intro":[{"text":"a","evi' }, prep), null, "nothing whole: the old fallback");
  const noUnits = partialOf({ code: "invalid_json", truncated: true, text: JSON.stringify({ intro: full.intro }).slice(0, -1) + ',"units":[{"id":"u0","cla' }, prep);
  assert.equal(noUnits.generationStatus, "partial"); assert.equal(noUnits.units.size, 0); assert.equal(noUnits.intro.length, 2);
  const allWhole = { intro: full.intro, units: full.units }, wholeText = JSON.stringify(allWhole).slice(0, -1);   // the cut fell after the last unit
  const rw = partialOf({ code: "invalid_json", truncated: true, text: wholeText }, prep);
  assert.equal(rw.generationStatus, "ai", "everything whole and valid: not marked partial"); assert.equal(rw.units.size, 4); assert.ok(!rw.issues.includes("truncated_partial"));
  assert.match(source.slice(source.indexOf("async function cnBldKnowledgeOne("), source.indexOf("async function cnBldLegacyOne(")), /cnKnowledgeLessonPartial\(e,prepared\)/);
});
/* ---------- T-057: headings arriving as text_fragment / as terms ---------- */
const esrc = (start, len, extra) => [{ materialId: material.id, blockId: "b" + start, page: 1, start, end: start + len, kind: "text_fragment", sourceOrder: { pageIndex: 1, block: start }, ...(extra || {}) }];
const units2 = [
  unit("k2_up", "statement", "BASIS CRANII EXTERNA", esrc(0, 20, { emBlock: true }), 0),            // heading as text_fragment, marked by its block
  unit("k2_up_old", "statement", "BASIS CRANII INTERNA", esrc(30, 20), 1),                           // a registry before emBlock: whole line in capitals
  unit("k2_th", "term", "Sissejuhatus", esrc(60, 12, { emBlock: true }), 2),                          // a term-heading, nothing defines it
  unit("k2_th_old", "term", "FOSSA CRANII MEDIA", esrc(80, 18), 3),
  unit("k2_tw", "term", "Foramen magnum", esrc(100, 14, { emBlock: true }), 4),                       // a real term: a statement speaks about it
  unit("k2_tw_def", "statement", "Foramen magnum – suur ava.", esrc(120, 26), 5),
  unit("k2_td", "term", "Atlas", esrc(150, 5, { emBlock: true }), 6),                                 // a real term with a definition unit
  unit("k2_td_def", "definition", "Atlas on esimene kaelalüli, mis kannab koljut.", esrc(160, 45), 7),
  unit("k2_abbr", "term", "ATP", esrc(210, 3), 8),                                                    // one capital word without a flag: not a heading
  unit("k2_notem", "statement", "Keskmine osa", esrc(220, 12), 9),                                    // short, but its block is not emphasised
  unit("k2_part", "term", "Keskmine", esrc(240, 8, { emBlock: true }), 10),                           // the term is less than... its quote is whole but another unit names it
  unit("k2_part_def", "statement", "Keskmine osa jääb kõrva taha.", esrc(250, 30), 11),
  unit("k2_fossa", "term", "Fossa cranii anterior", esrc(340, 21, { emBlock: true }), 13),           // an emphasised anatomical label with no definition: knowledge, stays
  unit("k2_eesm", "term", "Eesmine osa", esrc(400, 11, { emBlock: true }), 15),                        // a part (pars anterior) with no definition: knowledge, stays
  unit("k2_os", "term", "Os frontale", esrc(370, 11, { emBlock: true }), 14),
  unit("k2_fact", "statement", "Foramen magnum – suur ava.", esrc(300, 26, { emBlock: true }), 12),   // a short fact in an emphasised block: stays
];
await ok("T-057: headings as text_fragment (flagged block, capitals) and definition-less terms are excluded with heading_only", async () => {
  plan = await planOf(units2);
  for (const id of ["k2_up", "k2_up_old", "k2_th", "k2_th_old"]) { assert.ok(!plan.units.some(u => u.id === id), id + " is no lesson unit"); assert.equal(exOf(id) && exOf(id).reason, "heading_only", id); assert.equal(ixOf(id).eligible, false); }
});
await ok("T-057: a term with a definition, an abbreviation, a non-emphasised short statement and a short fact stay", async () => {
  plan = await planOf(units2);
  for (const id of ["k2_tw", "k2_tw_def", "k2_td", "k2_td_def", "k2_abbr", "k2_notem", "k2_part", "k2_part_def", "k2_fact", "k2_fossa", "k2_eesm", "k2_os"]) { assert.ok(plan.units.some(u => u.id === id), id + " stays"); assert.ok(!exOf(id), id); }
});
await ok("T-057: a material of emphasised terms only (a list of structures, no statement at all) keeps every term", async () => {
  const list = ["Os frontale", "Os parietale", "Os occipitale"].map((c, i) => unit("k3_" + i, "term", c, esrc(i * 20, c.length, { emBlock: true }), i));
  const p3 = await planOf(list);
  assert.equal(p3.units.length, 3); assert.equal(p3.inp.excluded.length, 0);
});
await ok("T-057: cnKnowledgeClean marks a quote that is the whole emphasised block (emBlock) and nothing else", async () => {
  const m = { id: "mat-c" }, blocks = logic.cnKnowledgeBlocks(m, [{ n: 1, text: "BASIS CRANII EXTERNA\nForamen magnum on suur ava koljupõhjas.", em: ["BASIS CRANII EXTERNA", "Foramen magnum"] }]);
  const head = blocks.find(b => b.text === "BASIS CRANII EXTERNA"), em2 = blocks.find(b => b.text === "Foramen magnum"), rest = blocks.find(b => !b.emphasis);
  const k = logic.cnKnowledgeClean({ knowledge: [
    { type: "statement", content: "BASIS CRANII EXTERNA", sources: [{ block_id: head.id, quote: "BASIS CRANII EXTERNA" }] },
    { type: "term", content: "Foramen", sources: [{ block_id: em2.id, quote: "Foramen" }] },
    { type: "statement", content: "suur ava", sources: [{ block_id: rest.id, quote: "suur ava" }] }] }, blocks, m);
  assert.equal(k.units.length, 3);
  assert.equal(k.units.find(u => u.content === "BASIS CRANII EXTERNA").sources[0].emBlock, true);
  assert.equal(k.units.find(u => u.content === "Foramen").sources[0].emBlock, undefined, "a part of a block");
  assert.equal(k.units.find(u => u.content === "suur ava").sources[0].emBlock, undefined);
});
await ok("T-057: lesson.issues keeps the codes of a partial lesson (compact, codes only) and an old lesson reads as before", async () => {
  const seg = source.slice(source.indexOf("async function cnBldKnowledgeOne("), source.indexOf("async function cnBldLegacyOne("));
  assert.match(seg, /p\.issues=iss/, "the saved lesson takes the issue codes");
  assert.match(seg, /cnIssuesCap\(/);
  const prep = mkPrepared(2), raw = { intro: [claim(0, 0)], units: [{ id: prep.units[0].id, claims: Array.from({ length: 9 }, (_, j) => claim(0, j)) }] };
  const r = logic.cnKnowledgeLessonClean(raw, prep);
  assert.equal(r.generationStatus, "partial"); assert.ok(r.issues.includes("claim_limit") && r.issues.includes("unit_output_missing"), JSON.stringify(r.issues));
  const meta = logic.cnKnowledgeLessonMetaClean;
  const base = { lessonVersion: 2, knowledgeIds: ["u0"], generationStatus: "partial", sourceStatus: "no_warning_detected", sourceSnapshotStatus: "not_applicable", sourceBlocks: [], knowledgeUnits: [{ id: "u0", type: "term", content: "Atlas", sources: [{ materialId: "m", blockId: "b0", page: 1, start: 0, end: 5 }], extractionStatus: "extracted", sourceLinkStatus: "checked", verificationStatus: "unverified", generationStatus: "fallback", claims: [] }] };
  const o = meta({ ...base, issues: ["claim_limit", "truncated_partial", "x".repeat(200), 5, "bad code!"] }, null);
  assert.deepEqual(o && o.issues, ["claim_limit", "truncated_partial"], "only short code strings");
  const old = meta({ ...base }, null);
  assert.ok(old && !("issues" in old), "an old lesson has no issues field");
});
console.log(n + " depth checks passed" + (process.exitCode ? " WITH FAILURES" : ""));
if (!process.exitCode) console.log("COURSE DEPTH TESTS PASSED");
})();
