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
  unit("ku1_term", "term", "BASIS CRANII INTERNA", src("emphasis_fragment", 300, 320), 2),
  unit("ku1_plain", "statement", "Koljupõhi", src("text_fragment", 400, 409), 3),            // short, but not a heading block
  unit("ku1_part", "statement", "Koljupõhi osa", src("emphasis_fragment", 500, 560), 4),     // the quote is only a part of a longer block
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
  for (const id of ["ku1_long", "ku1_term", "ku1_plain", "ku1_part"]) { assert.ok(plan.units.some(u => u.id === id), id + " stays a lesson unit"); assert.ok(!exOf(id), id); assert.equal(ixOf(id).eligible, true); }
});
await ok("heading_only: coverage counts the unit as not eligible; the others stay planned", async () => {
  await run();
  assert.equal(plan.units.length, 4);
  assert.equal(plan.index.filter(x => !x.eligible).length, 1);
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
await ok("claim limit: max(1,min(4,floor(64/n))): 12 units → 4, 24 → 2, 36 → 1, 1 → 4, 40 → 1; the same number in the client and in the prompt of the function", async () => {
  for (const [k, want] of [[1, 4], [12, 4], [16, 4], [17, 3], [24, 2], [32, 2], [36, 1], [40, 1]]) {
    assert.equal(lim(k), want, "client n=" + k);
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
await ok("tokens: the lesson of knowledge-v1 gets 6000 output tokens, the legacy lesson keeps 4000", async () => {
  assert.equal(fn.h.LS_KNOWLEDGE_MAX_TOKENS, 6000);
  assert.equal(fn.h.LS_MAX_TOKENS, 4000);
  assert.match(serverSource, /body\.input\?\.kind === "knowledge-v1" \? LS_KNOWLEDGE_MAX_TOKENS : LS_MAX_TOKENS/);
});

/* ---------- the client validator ---------- */
const blocks = Array.from({ length: 3 }, (_, i) => ({ id: "b" + i, materialId: "m1", sourceName: "S", page: 1, text: "Source sentence number " + i + " about the skull." }));
const mkPrepared = k => ({ units: Array.from({ length: k }, (_, i) => ({ id: "u" + i, sourceBlockIds: ["b" + (i % 3)] })), blocks });
const claim = (b, i) => ({ text: "Claim " + i, evidence: [{ blockId: "b" + b, quote: "Source sentence number " + b }] });
await ok("validator: accepts exactly limit claims per unit (n=12 → 4) and 6 intro claims, nothing is reported", async () => {
  const prep = mkPrepared(12), raw = { intro: Array.from({ length: 6 }, (_, i) => claim(0, i)), units: prep.units.map((u, i) => ({ id: u.id, claims: Array.from({ length: 4 }, (_, j) => claim(i % 3, j)) })) };
  const r = logic.cnKnowledgeLessonClean(raw, prep);
  assert.equal(r.generationStatus, "ai"); assert.deepEqual(clone(r.issues), []);
  assert.equal(r.intro.length, 6); assert.ok([...r.units.values()].every(c => c.length === 4));
});
await ok("validator: more than limit claims (5 at n=12, 3 at n=24, 7 intro) are cut to the limit and reported claim_limit → partial", async () => {
  const prep = mkPrepared(12), raw = { intro: [claim(0, 0)], units: prep.units.map((u, i) => ({ id: u.id, claims: Array.from({ length: 5 }, (_, j) => claim(i % 3, j)) })) };
  const r = logic.cnKnowledgeLessonClean(raw, prep);
  assert.ok(r.issues.includes("claim_limit")); assert.equal(r.generationStatus, "partial"); assert.ok([...r.units.values()].every(c => c.length === 4));
  const prep24 = mkPrepared(24), r24 = logic.cnKnowledgeLessonClean({ intro: [claim(0, 0)], units: prep24.units.map((u, i) => ({ id: u.id, claims: Array.from({ length: 3 }, (_, j) => claim(i % 3, j)) })) }, prep24);
  assert.ok(r24.issues.includes("claim_limit")); assert.ok([...r24.units.values()].every(c => c.length === 2));
  const ri = logic.cnKnowledgeLessonClean({ intro: Array.from({ length: 7 }, (_, i) => claim(0, i)), units: [] }, mkPrepared(1));
  assert.ok(ri.issues.includes("claim_limit")); assert.equal(ri.intro.length, 6);
});
await ok("size: a full lesson of 40 units x 1 claim + 6 intro claims of 500 characters (30-36k characters) is not dropped as response_size_limit; the limit itself still holds", async () => {
  assert.ok(ctx("CN_KLESSON").outputChars >= 36000, "outputChars " + ctx("CN_KLESSON").outputChars);
  const quotes = b => ["", " about", " about the"].map(t => ({ blockId: b, quote: "Source sentence number " + b.slice(1) + t }));
  const long = i => ({ text: ("Claim " + i + " ").padEnd(500, "x"), evidence: quotes("b0") });
  const prep = mkPrepared(40), raw = { intro: Array.from({ length: 6 }, (_, i) => long(i)), units: prep.units.map(u => ({ id: u.id, claims: [{ ...long(0), evidence: quotes(u.sourceBlockIds[0]) }] })) };
  const len = JSON.stringify(raw).length;
  assert.ok(len > 30000 && len < 36000, String(len));
  assert.equal(logic.cnKnowledgeLessonClean(raw, prep).generationStatus, "ai", "not dropped as response_size_limit");
  assert.ok(logic.cnKnowledgeLessonClean({ ...raw, pad: "x".repeat(ctx("CN_KLESSON").outputChars) }, prep).issues.includes("response_size_limit"), "the limit itself still holds");
});
await ok("client request: the lesson input carries lessonDepth 2 (so that the function writes the deeper prompt)", async () => {
  assert.match(source.slice(source.indexOf("async function cnKnowledgeLessonPrepare("), source.indexOf("function cnKnowledgeLessonClean(")), /lessonDepth:2/);
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
  assert.match(source.slice(source.indexOf("async function cnBldKnowledgeOne("), source.indexOf("async function cnBldLegacyOne(")), /cnKnowledgeLessonPartial\(e,prepared\)/);
});
console.log(n + " depth checks passed" + (process.exitCode ? " WITH FAILURES" : ""));
if (!process.exitCode) console.log("COURSE DEPTH TESTS PASSED");
})();
