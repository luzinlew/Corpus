#!/usr/bin/env node
"use strict";
// Offline checks of the limits of the knowledge registry (T-032): the client must not accept what the server refuses (formula limits), must not
// merge more than 8 sources into one unit, and must not drop visual units silently. Uses the production client functions (vm) and the production
// server validators. No browser, network or model.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const { logic, context, between, betweenServer } = require("./course_logic_test.cjs");
const clone = x => JSON.parse(JSON.stringify(x));
const edge = vm.createContext({ LANG_NAME: { en: "English", ru: "Russian", et: "Estonian" } });
vm.runInContext(stripTypeScriptTypes(betweenServer("const PL_TERMS", "function planPrompt(")) + "\nglobalThis.h={checkPlan};", edge);
vm.runInContext(between("const cnMatIds=", "\n"), context);
const ctx = name => vm.runInContext(name, context);
const material = { id: "mat-lim", name: "Limits.pdf", role: "base", kind: "pdf", pages: 1 };

/* the plan input of the client for the given units, checked by the production validator of the function */
async function planInputOf(units, extraMats, issues) {
  const mat = { ...material, kdocs: ["draft-lim.mat-lim.ku1.g0.1"], kstatus: "processed" };
  const docs = new Map([[mat.kdocs[0], { kind: "course-knowledge", version: 1, materialId: mat.id, outlineStatus: "processed", sourceProcessingStatus: "no_warning_detected", completeness: "not_proven", issues: issues || [], units: clone(units) }]]);
  context.cnDocData = async (_c, id) => docs.get(id) || null;
  const run = { cancel: false, topics: [], dt: {}, diagnostics: null };
  return logic.cnKnowledgePlanInput({ id: "draft-lim", name: "Limits", mats: [mat].concat(extraMats || []) }, run);
}
const serverSays = input => edge.h.checkPlan({ purpose: "course", lang: "en", input });
function blockOf(id, text, i) { return { id, materialId: material.id, page: 1, pageIndex: 1, order: i, start: 0, end: text.length, text, emphasis: false, kind: "page_text" }; }

async function defect1() {
  const text = "Line A. Line B. Line C. Line D. Line E.";
  const blocks = [blockOf("b1", text, 0)];
  const src = q => [{ block_id: "b1", quote: q }];
  const vars = (n, symbolLen) => Array.from({ length: n }, (_, i) => ({ symbol: "s".repeat(symbolLen - 1) + (i % 10), meaning: "m", unit: "u" }));
  const raw = { knowledge: [
    { type: "term", content: "Line A", sources: src("Line A.") },
    { type: "formula", content: { expression: "x".repeat(400), variables: vars(20, 40) }, sources: src("Line B.") },      // exactly the limits of the function
    { type: "formula", content: { expression: "x".repeat(401) }, sources: src("Line C.") },                                  // over the expression limit
    { type: "formula", content: { expression: "y = 2x", variables: vars(21, 5) }, sources: src("Line D.") },                // over the variables limit
    { type: "formula", content: { expression: "z = 3x", variables: vars(1, 41) }, sources: src("Line E.") },                // over the symbol limit
  ], knowledge_limited: false };
  const cleaned = logic.cnKnowledgeClean(raw, blocks, material);
  assert.deepEqual(clone(cleaned.units.map(u => u.type)), ["term", "formula"], "only the term and the formula at the server's limits are accepted");
  assert.equal(cleaned.rejected, 3);
  assert.ok(cleaned.issues.includes("unit_content_limit"), "the refusal is explicit: " + JSON.stringify(cleaned.issues));
  assert.equal(cleaned.status, "incomplete", "the registry is marked incomplete");
  const plan = await planInputOf(cleaned.units);
  assert.equal(serverSays(plan.inp), "", "the plan of the accepted units is accepted by the function");
  /* every client-accepted content, at and above the limits of every type, must be accepted by the function; a bare formula string is a shape the function refuses */
  const unitOf = (type, content) => ({ id: "ku1_x", version: 1, type, content, sources: [{ materialId: material.id, blockId: "b1", page: 1, start: 0, end: 4, kind: "text_fragment", sourceOrder: { pageIndex: 1, block: 0 } }], order: { pageIndex: 1, page: 1, block: 0, offset: 0 }, extractionStatus: "extracted", sourceLinkStatus: "checked", verificationStatus: "unverified", coverageStatus: "not_in_plan" });
  const cases = [
    ["term", "t".repeat(2400)], ["term", "t".repeat(2401)], ["statement", "s"], ["definition", "d".repeat(2400)],
    ["process", { steps: Array.from({ length: 50 }, () => "s".repeat(40)) }], ["process", { steps: ["s".repeat(400)] }], ["process", { steps: ["s".repeat(401)] }], ["process", { steps: Array.from({ length: 51 }, () => "s") }],
    ["formula", "E = mc^2"], ["formula", "e".repeat(400)], ["formula", "e".repeat(401)], ["formula", { expression: "e".repeat(400) }], ["formula", { expression: "e".repeat(401) }],
    ["formula", { expression: "a", variables: vars(20, 40) }], ["formula", { expression: "a", variables: vars(21, 3) }], ["formula", { expression: "a", variables: vars(1, 41) }],
    ["formula", { expression: "a", variables: [{ symbol: "x", meaning: "m".repeat(240), unit: "u".repeat(80) }] }], ["formula", { expression: "a", variables: [{ symbol: "x", meaning: "m".repeat(241) }] }],
    ["table", { caption: "c".repeat(300), headers: Array.from({ length: 20 }, () => "h".repeat(240)), rows: Array.from({ length: 100 }, () => Array.from({ length: 20 }, () => "c".repeat(240))) }],
    ["table", { headers: ["a"], rows: [["c".repeat(241)]] }], ["table", { headers: Array.from({ length: 21 }, () => "h"), rows: [Array.from({ length: 21 }, () => "c")] }], ["table", { headers: ["a"], rows: Array.from({ length: 101 }, () => ["c"]) }], ["table", { caption: "c".repeat(301), headers: ["a"], rows: [["c"]] }],
    ["visual", { caption: "c".repeat(300), labels: Array.from({ length: 40 }, () => "l".repeat(160)) }], ["visual", { labels: ["l".repeat(161)] }], ["visual", { labels: Array.from({ length: 41 }, () => "l") }], ["visual", { caption: "c".repeat(301) }],
  ];
  const diverge = [];
  for (const [type, content] of cases) {
    const accepted = ctx("cnKnowledgeContent")(type, content);
    if (!accepted) continue;
    const mat = { id: material.id, name: "Limits.pdf", role: "base", pages: 1, registryStatus: "processed", outlineStatus: "processed", sourceProcessingStatus: "no_warning_detected", issues: [] };
    const unit = unitOf(type, clone(accepted.value));
    const input = { kind: "knowledge-v1", name: "n", topicHints: [], knowledge: [{ id: unit.id, type, content: unit.content, sources: unit.sources.map(s => ({ ...s, materialName: "Limits.pdf" })), order: { materialIndex: 0, pageIndex: 1, block: 0, offset: 0 }, extractionStatus: "extracted", sourceLinkStatus: "checked", verificationStatus: "unverified" }], excluded: [],
      sourceStatus: { status: "no_warning_detected", completeness: "not_proven", registryStatus: "processed", incompleteMaterials: 0, reviewMaterials: 0, unresolvedVisuals: 0, unprocessedVisuals: 0, materials: [mat] } };
    const verdict = serverSays(input);
    if (verdict) diverge.push([type, JSON.stringify(content).slice(0, 60), verdict]);
  }
  assert.deepEqual(diverge, [], "client accepts what the function refuses: " + JSON.stringify(diverge));
}

async function defect2() {
  const blocks = Array.from({ length: 11 }, (_, i) => blockOf("d" + i, "Same line of text " + i, i));
  const raw = { knowledge: blocks.map(b => ({ type: "definition", content: "The same claim.", sources: [{ block_id: b.id, quote: "Same line of text" }] })), knowledge_limited: false };
  const cleaned = logic.cnKnowledgeClean(raw, blocks, material);
  const total = cleaned.units.reduce((n, u) => n + u.sources.length, 0);
  assert.ok(cleaned.units.every(u => u.sources.length <= 8), "no unit has more than 8 sources: " + JSON.stringify(cleaned.units.map(u => u.sources.length)));
  assert.equal(total, 11, "every source is kept");
  assert.ok(cleaned.issues.includes("duplicate_not_merged_source_limit"), JSON.stringify(cleaned.issues));
  assert.equal(cleaned.status, "incomplete");
  assert.equal(new Set(cleaned.units.map(u => u.id)).size, cleaned.units.length, "distinct ids");
  /* chunks of the outline: the same id in two chunks with 5 sources each */
  const mk = (from) => ({ units: [{ ...clone(cleaned.units[0]), id: "ku1_same", sources: Array.from({ length: 5 }, (_, i) => ({ materialId: material.id, blockId: "c" + (from + i), page: 1, start: 0, end: 4, kind: "text_fragment", sourceOrder: { pageIndex: 1, block: from + i } })) }], issues: [] });
  const a = mk(0), b = mk(10);
  logic.cnKnowledgeMergeUnits([a, b]);
  const all = a.units.concat(b.units);
  assert.ok(all.every(u => u.sources.length <= 8), "merged chunks stay within 8: " + JSON.stringify(all.map(u => u.sources.length)));
  assert.equal(all.reduce((n, u) => n + u.sources.length, 0), 10, "no source is lost across chunks");
  assert.equal(new Set(all.map(u => u.id)).size, all.length);
  assert.ok(a.issues.concat(b.issues).includes("duplicate_not_merged_source_limit"));
  /* the plan of such a registry is built: every id once, accepted by the function, readable again */
  const plan = await planInputOf(cleaned.units);
  assert.equal(serverSays(plan.inp), "");
  const ids = plan.inp.knowledge.map(u => u.id);
  const raw2 = { parts: [{ name: "P", lessons: [{ title: "All", knowledgeIds: ids, rationale: "All of the equal claims together." }] }] };
  const doc = logic.cnKnowledgePlanBuild(raw2, plan);
  assert.equal(doc.coverage.expected, ids.length); assert.equal(doc.coverage.planned, ids.length); assert.equal(doc.coverage.missing, 0);
  assert.ok(logic.cnKnowledgePlanDoc(clone(doc)), "the saved plan reads back");
}

async function defect4() {
  /* the codes of D1 and D2 are explained on the plan screen (registry diagnostics) */
  vm.runInContext(between("function cnKnowledgePlanInner(", "\nfunction cnPlanInner("), context);
  const term = { id: "ku1_t", version: 1, type: "term", content: "A term", sources: [{ materialId: material.id, blockId: "b", page: 1, start: 0, end: 6, kind: "text_fragment", sourceOrder: { pageIndex: 1, block: 0 } }], order: { pageIndex: 1, page: 1, block: 0, offset: 0 }, extractionStatus: "extracted", sourceLinkStatus: "checked", verificationStatus: "unverified", coverageStatus: "not_in_plan" };
  const plan = await planInputOf([term], [], ["unit_content_limit", "duplicate_not_merged_source_limit"]);
  const doc = logic.cnKnowledgePlanBuild({ parts: [{ name: "P", lessons: [{ title: "L", knowledgeIds: ["ku1_t"], rationale: "The only unit of the registry." }] }] }, plan);
  const html = ctx("cnKnowledgePlanInner")({ _open: new Set() }, doc);
  assert.ok(html.includes("Limits.pdf: Some units were not accepted: their content is longer than a plan allows (formula: expression up to 400 characters, up to 20 variables, symbol up to 40). They are not in the registry."), "unit_content_limit is explained");
  assert.ok(html.includes("Limits.pdf: The same unit was found in more than 8 places: its sources are split between several units, no source is lost."), "duplicate_not_merged_source_limit is explained");
  assert.ok(!html.includes("unit_content_limit") && !html.includes("duplicate_not_merged_source_limit"), "no raw code on the screen");
  const plain = await planInputOf([term], [], []);
  assert.ok(!ctx("cnKnowledgePlanInner")({ _open: new Set() }, logic.cnKnowledgePlanBuild({ parts: [{ name: "P", lessons: [{ title: "L", knowledgeIds: ["ku1_t"], rationale: "The only unit of the registry." }] }] }, plain)).includes("Some units were not accepted"));
}

async function defect3() {
  const mkPages = n => Array.from({ length: n }, (_, i) => ({ n: i + 1, text: "", em: [], diag: { known: true, visual: true } }));
  const mat = { id: "mat-pics", name: "Pictures.pdf", role: "pics", kind: "pdf", pages: 250, chunks: ["x"], kdocs: [] };
  const docs = new Map(), written = [];
  context.cnWrite = async (coll, id, data) => { docs.set(coll + "/" + id, clone(data)); written.push(id); };
  context.cnDocData = async (coll, id) => docs.get(coll + "/" + id) || null;
  context.cnDelIds = () => {};
  const draft = { id: "draft-pics", mats: [mat] };
  const pages = mkPages(250);
  const state = await logic.cnKnowledgePersist(draft, {}, [], [], [], [{ m: mat, pages }], null);
  const loaded = await logic.cnKnowledgeOf(mat, draft.id);
  const visuals = loaded.units.filter(u => u.type === "visual");
  assert.equal(visuals.length, 250, "all 250 visual locations are stored and read back (docs: " + mat.kdocs.length + ")");
  assert.equal(new Set(visuals.map(u => u.id)).size, 250);
  assert.ok(mat.kdocs.every(id => docs.get("ctext/" + id).units.length <= 200), "a stored document holds at most 200 units");
  assert.equal(state.status, "incomplete");
  assert.equal(mat.kstatus, "incomplete");
  /* deleting the material deletes every registry document */
  assert.deepEqual(clone(ctx("cnMatIds")(mat)).filter(x => x.includes(".ku1.")).sort(), clone(mat.kdocs).sort());
  /* the plan input: many excluded visuals are an explicit error, not a cut */
  const big = { ...mat, kdocs: [] }, textMat = { ...material, id: "mat-text", role: "base", kdocs: ["draft-big.mat-text.ku1.g0.1"], kstatus: "processed" };
  const term = { id: "ku1_t", version: 1, type: "term", content: "A term", sources: [{ materialId: "mat-text", blockId: "b", page: 1, start: 0, end: 6, kind: "text_fragment", sourceOrder: { pageIndex: 1, block: 0 } }], order: { pageIndex: 1, page: 1, block: 0, offset: 0 }, extractionStatus: "extracted", sourceLinkStatus: "checked", verificationStatus: "unverified", coverageStatus: "not_in_plan" };
  const manyVisual = n => logic.cnKnowledgeVisuals({ id: "mat-big" }, mkPages(n));
  const store = new Map([[textMat.kdocs[0], { kind: "course-knowledge", version: 1, materialId: "mat-text", outlineStatus: "processed", sourceProcessingStatus: "no_warning_detected", completeness: "not_proven", issues: [], units: [term] }]]);
  const bigDocs = [];
  for (let i = 0, units = clone(manyVisual(2401)); i < units.length; i += 200) {
    const id = "draft-big.mat-big.ku1.g0." + (i / 200 + 1); bigDocs.push(id);
    store.set(id, { kind: "course-knowledge", version: 1, materialId: "mat-big", outlineStatus: "incomplete", sourceProcessingStatus: "review_required", completeness: "not_proven", issues: ["visual_unresolved"], units: units.slice(i, i + 200) });
  }
  big.id = "mat-big"; big.kdocs = bigDocs; big.kstatus = "incomplete";
  context.cnDocData = async (_c, id) => store.get(id) || null;
  await assert.rejects(logic.cnKnowledgePlanInput({ id: "draft-big", name: "Big", mats: [textMat, big] }, { cancel: false, topics: [], dt: {}, diagnostics: null }), e => e && e.code === "knowledge_too_large");
}

(async () => {
  let failed = 0;
  for (const [name, fn] of [["D1 formula limits equal on client and server", defect1], ["D2 at most 8 sources per unit after merging duplicates", defect2], ["D3 visual units beyond 200 are stored, not cut", defect3], ["D4 the codes of D1 and D2 are explained on the plan screen", defect4]]) {
    try { await fn(); console.log("PASS " + name); } catch (e) { failed++; console.log("FAIL " + name + "\n  " + String(e && e.message || e).split("\n")[0].slice(0, 400)); }
  }
  if (failed) process.exitCode = 1; else console.log("COURSE LIMITS TESTS PASSED");
})();
