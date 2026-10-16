#!/usr/bin/env node
"use strict";
// Offline checks of the plan «by groups» (T-037): a registry that does not fit the per-unit plan request is sent to the AI as groups of units
// (one source material, one page, at most 6 units), the AI answers with groups, and the app turns the groups back into units. Uses the production
// client functions (vm) and the production server validator and prompt. No browser, network or model.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const { logic, context, between, betweenServer } = require("./course_logic_test.cjs");
const clone = x => JSON.parse(JSON.stringify(x));
const edge = vm.createContext({ LANG_NAME: { en: "English", ru: "Russian", et: "Estonian" } });
vm.runInContext(stripTypeScriptTypes(betweenServer("const PL_TERMS", "function planPrompt(") + betweenServer("function planPrompt(", "// ---- the lesson task")) + "\nglobalThis.h={checkPlan,planPrompt};", edge);
const serverSays = input => edge.h.checkPlan({ purpose: "course", lang: "en", input });
const ctx = name => vm.runInContext(name, context);
const build = (raw, T) => ctx("cnKnowledgeGroupsPlanBuild")(raw, T);

/* ---- a synthetic registry ---- */
const TYPES = ["term", "statement", "definition", "statement", "process", "formula", "table", "term"];
function contentOf(type, i) {
  const w = "Item" + i + " is described here at some length so that the unit is as large as a real one";
  if (type === "term") return "Term number " + i;
  if (type === "process") return { steps: ["Step one of " + i + ": " + w, "Step two of " + i + ": " + w] };
  if (type === "formula") return { expression: "y" + i + " = a" + i + " * x + b", variables: [{ symbol: "a" + i, meaning: "slope of line " + i, unit: "1" }] };
  if (type === "table") return { caption: "Table " + i, headers: ["name", "value"], rows: [["alpha " + i, "1"], ["beta " + i, "2"]] };
  return w + ". " + w + ".";
}
/* plan: [{ mat, pages: [units on page 1, units on page 2, …] }]; returns the draft, with every material's registry stored in documents of at most 200 units */
function registry(plan, opts) {
  opts = opts || {};
  const docs = new Map(), mats = [];
  let n = 0;
  plan.forEach((spec, mi) => {
    const id = "mat-" + mi, mat = { id, name: spec.name || ("Material number " + mi + ".pdf"), role: mi === 0 ? "base" : "extra", kind: "pdf", pages: spec.pages.length, kdocs: [], kstatus: "processed" };
    const units = [];
    spec.pages.forEach((count, pi) => {
      for (let k = 0; k < count; k++) {
        const type = TYPES[n % TYPES.length], page = pi + 1, text = "block " + n;
        units.push({ id: "ku1_" + id + "_" + n.toString(36), version: 1, type, content: contentOf(type, n),
          sources: [{ materialId: id, blockId: "draft-gr.mat-" + mi + ":p" + page + ":b" + k, page, start: k * 20, end: k * 20 + 14, kind: "text_fragment", sourceOrder: { pageIndex: page, block: k } }],
          order: { pageIndex: page, page, block: k, offset: k * 20 }, extractionStatus: "extracted", sourceLinkStatus: "checked", verificationStatus: "unverified", coverageStatus: "not_in_plan" });
        n++;
      }
    });
    for (let v = 0; v < (spec.unresolved || 0); v++) {
      units.push({ id: "ku1_" + id + "_v" + v, version: 1, type: "visual", content: null, sources: [{ materialId: id, blockId: "draft-gr.mat-" + mi + ":v" + v, page: v + 1, start: null, end: null, kind: "visual_location", sourceOrder: { pageIndex: v + 1, block: 99 } }],
        order: { pageIndex: v + 1, page: v + 1, block: 99, offset: 0 }, extractionStatus: "unresolved", sourceLinkStatus: "location_only", verificationStatus: "unverified", coverageStatus: "not_in_plan" });
    }
    if (opts.shuffle) units.reverse();   // stored out of order: the app must sort by the source
    for (let i = 0, g = 1; i < units.length; i += 200, g++) {
      const did = "draft-gr." + id + ".ku1.g0." + g;
      mat.kdocs.push(did);
      docs.set(did, { kind: "course-knowledge", version: 1, materialId: id, outlineStatus: "processed", sourceProcessingStatus: "no_warning_detected", completeness: "not_proven", issues: [], units: units.slice(i, i + 200) });
    }
    mats.push(mat);
  });
  context.cnDocData = async (_c, id) => docs.get(id) || null;
  return { id: "draft-gr", name: "Groups", mats };
}
const planInput = d => logic.cnKnowledgePlanInput(d, { cancel: false, topics: [{ title: "Topic one", pages: [1, 2], m: { id: "mat-0" } }, { title: "Topic two", pages: [5], m: { id: "mat-1" } }], dt: {}, diagnostics: null });
function pagesOf(n, per) { return Array.from({ length: n }, (_, i) => typeof per === "function" ? per(i) : per); }
/* 431 units: three materials, pages of 1 to 9 units */
const SPEC431 = [{ pages: pagesOf(50, i => [3, 4, 2, 9, 1][i % 5]), unresolved: 3 }, { pages: pagesOf(40, i => [4, 3, 5, 2][i % 4]) }, { pages: pagesOf(30, i => [3, 4, 2][i % 3]).concat([4, 4, 3]) }];
const count = spec => spec.reduce((a, s) => a + s.pages.reduce((x, y) => x + y, 0), 0);

/* the answer of an AI: lessons of `per` groups, at most 6 lessons a part */
function aiAnswer(T, per, mutate) {
  const gids = T.inp.groups.map(g => g.id), lessons = [];
  for (let i = 0; i < gids.length; i += per) lessons.push({ title: "Lesson " + (lessons.length + 1), groups: gids.slice(i, i + per), rationale: "Groups kept together in the source order." });
  const parts = [];
  for (let i = 0; i < lessons.length; i += 6) parts.push({ name: "Part " + (parts.length + 1), lessons: lessons.slice(i, i + 6) });
  const raw = { parts };
  if (mutate) mutate(raw);
  return raw;
}
const codeOf = (fn, code) => assert.throws(fn, e => e && e.code === code, "expected " + code);
const unitsOfDoc = doc => doc.parts.flatMap(p => p.lessons.flatMap(l => l.knowledgeIds));

async function t1_big_registry_groups() {
  const d = registry(SPEC431, { shuffle: true }), total = count(SPEC431);
  assert.equal(total, 431);
  const T = await planInput(d);
  assert.equal(T.kind, "knowledge");
  assert.equal(T.inp.kind, "knowledge-groups-v1", "a registry of 431 units goes by groups, not as knowledge-v1");
  assert.equal(T.grouped, true);
  const json = JSON.stringify(T.inp);
  assert.ok(json.length <= 60000, "request " + json.length + " chars");
  console.log("  431 units: " + T.inp.groups.length + " groups, request " + json.length + " chars (a per-unit request would be about " + JSON.stringify(T.units.map(u => ({ id: u.id, type: u.type, content: u.content, sources: u.sources, order: u.order }))).length + "), plan document " + JSON.stringify(build(aiAnswer(T, 5), T)).length + " chars");
  assert.ok(T.inp.groups.length <= 250 && T.inp.groups.length >= 431 / 6);
  assert.equal(T.units.length, 431);
  assert.equal(serverSays(T.inp), "", "the function accepts the request: " + serverSays(T.inp));
  /* every unit exactly once, in the source order, groups of one material and one page, at most 6 units */
  const flat = T.groups.flatMap(g => g.ids);
  assert.deepEqual(clone(flat), clone(T.units.map(u => u.id)), "units of the groups = the eligible units in the source order");
  assert.equal(new Set(flat).size, 431);
  const byId = new Map(T.index.map(x => [x.id, x]));
  T.groups.forEach((g, i) => {
    assert.ok(g.ids.length >= 1 && g.ids.length <= 6, "group size " + g.ids.length);
    assert.equal(T.inp.groups[i].n, g.ids.length);
    assert.equal(T.inp.groups[i].id, "g" + (i + 1));
    const keys = new Set(g.ids.map(id => byId.get(id).sources[0].materialId + "|" + byId.get(id).sources[0].page));
    assert.equal(keys.size, 1, "a group lies on one page of one material");
    assert.equal(T.inp.groups[i].p, byId.get(g.ids[0]).sources[0].page);
    assert.equal(T.inp.materials[T.inp.groups[i].m], byId.get(g.ids[0]).sources[0].materialName.slice(0, 60));
    assert.ok(T.inp.groups[i].t.length >= 1 && T.inp.groups[i].t.length <= 3 && T.inp.groups[i].t.every(x => typeof x === "string" && x.length <= 80));
  });
  /* a page boundary always starts a new group; a page of 9 units makes two groups (6 + 3) */
  for (let i = 1; i < T.groups.length; i++) {
    const a = byId.get(T.groups[i - 1].ids.at(-1)).sources[0], b = byId.get(T.groups[i].ids[0]).sources[0];
    const samePage = a.materialId === b.materialId && a.page === b.page;
    if (samePage) assert.equal(T.groups[i - 1].ids.length, 6, "a group is cut only when it is full");
  }
  assert.equal(T.groups.filter(g => g.ids.length === 6).length, 10, "10 pages of 9 units give a full group of 6 each");
  /* nothing that must not go to the AI: ids, quotes, block ids, sources */
  assert.ok(!json.includes("ku1_") && !json.includes("blockId") && !json.includes("draft-gr.") && !json.includes('"sources"'), "no unit ids, block ids or sources in the request");
  /* the excluded visual units only as counters */
  assert.deepEqual(clone(T.inp.excluded), [{ m: 0, n: 3 }]);
  assert.equal(T.sourceAssessment.unresolvedVisuals, 3);
  assert.equal(T.index.length, 434, "the index keeps all 434 units");
  assert.ok(T.index.every(x => x.label.length <= 80), "short labels in the index");
}

async function t2_threshold() {
  /* the largest registry that still goes the old way; one unit more goes by groups */
  const build = async n => { const pages = pagesOf(Math.floor(n / 3), 3); if (n % 3) pages.push(n % 3); return (await planInput(registry([{ pages }]))); };
  let lo = 10, hi = 400;
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; const T = await build(mid); if (T.inp.kind === "knowledge-v1") lo = mid; else hi = mid; }
  const A = await build(lo), B = await build(hi);
  assert.equal(A.inp.kind, "knowledge-v1");
  assert.ok(JSON.stringify(A.inp).length <= 78000, "old path: as before, at most 78000");
  assert.ok(A.units.length >= 100, "the old path still takes " + A.units.length + " units");
  assert.equal(A.grouped, undefined);
  assert.equal(serverSays(A.inp), "", "the server takes it as before");
  assert.equal(B.inp.kind, "knowledge-groups-v1");
  /* the old request would have been over the limit */
  assert.ok(B.units.length === A.units.length + 1);
  assert.equal(ctx("CN_PL").planJson, 78000, "the switch is the old limit of the client");
  console.log("  old path holds up to " + A.units.length + " units (" + JSON.stringify(A.inp).length + " chars), groups from " + B.units.length);
}

async function t3_1200_and_limits() {
  /* 1200 units on pages of 5 = 240 groups */
  const spec = [{ pages: pagesOf(120, 5) }, { pages: pagesOf(120, 5) }];
  const T = await planInput(registry(spec));
  assert.equal(T.units.length, 1200);
  assert.equal(T.inp.groups.length, 240);
  const json = JSON.stringify(T.inp);
  assert.ok(json.length <= 60000, "1200 units: " + json.length + " chars");
  assert.equal(serverSays(T.inp), "");
  const doc = build(aiAnswer(T, 5), T);
  const size = JSON.stringify(doc).length;
  assert.ok(size <= 800000, "plan document of 1200 units: " + size);
  assert.equal(doc.coverage.expected, 1200); assert.equal(doc.coverage.planned, 1200);
  console.log("  1200 units: request " + json.length + " chars (" + T.inp.groups.length + " groups), plan document " + size + " chars");
  /* the plan document of 1200 units with 8 sources each and the longest names is over its limit: an explicit error, no silent cut */
  const heavy = registry([{ name: "N".repeat(120), pages: pagesOf(240, 5) }]);
  const store = context.cnDocData, heavyDocs = new Map();
  context.cnDocData = async (c, id) => { const x = await store(c, id); if (x) { x.units.forEach(u => { u.sources = Array.from({ length: 8 }, (_, i) => ({ ...u.sources[0], blockId: u.sources[0].blockId + "-" + i, start: i * 30, end: i * 30 + 14 })); }); } return x; };
  const TH = await planInput(heavy);
  assert.equal(TH.units.length, 1200);
  codeOf(() => build(aiAnswer(TH, 5), TH), "knowledge_too_large");
  context.cnDocData = store;
  /* more than 250 groups: an explicit error, nothing is cut */
  await assert.rejects(planInput(registry([{ pages: pagesOf(300, 1) }])), e => e && e.code === "knowledge_too_large");
  /* 251 groups are refused too, 250 are taken */
  const ok250 = await planInput(registry([{ pages: pagesOf(250, 1).concat([]) }, { pages: pagesOf(1, 1) }].slice(0, 1)));
  assert.equal(ok250.inp.groups.length, 250, "250 groups of a single unit: " + JSON.stringify(ok250.inp).length);
  await assert.rejects(planInput(registry([{ pages: pagesOf(251, 1) }])), e => e && e.code === "knowledge_too_large");
  /* the split of long lessons may not make more than 60 lessons: an explicit error, no lesson is dropped or merged */
  const g = T.inp.groups.map(x => x.id), over = { parts: [{ name: "P", lessons: [] }] };
  for (let i = 0; i < 24; i++) over.parts[0].lessons.push({ title: "Big " + i, groups: g.slice(i * 9, i * 9 + 9), rationale: "Nine groups of five units." });
  for (let i = 216; i < 240; i++) over.parts[0].lessons.push({ title: "Small " + i, groups: [g[i]], rationale: "A single group lesson." });
  codeOf(() => build(over, T), "knowledge_plan_invalid");
  /* more than 1200 units */
  await assert.rejects(planInput(registry([{ pages: pagesOf(121, 10) }])), e => e && e.code === "knowledge_too_large");
}

async function t4_answers() {
  const d = registry(SPEC431, { shuffle: true }), total = 431;
  const T = await planInput(d);
  const doc = build(aiAnswer(T, 5), T);
  const ids = unitsOfDoc(doc);
  assert.equal(ids.length, total); assert.equal(new Set(ids).size, total);
  assert.deepEqual(clone(ids), clone(T.units.map(u => u.id)), "source order kept");
  const lessons = doc.parts.flatMap(p => p.lessons);
  assert.ok(lessons.length <= 60 && lessons.every(l => l.knowledgeIds.length <= 40 && l.knowledgeIds.length >= 1));
  assert.equal(doc.planVersion, 2); assert.equal(doc.planKind, "knowledge");
  assert.equal(doc.grouped, true); assert.equal(doc.groupCount, T.groups.length);
  assert.deepEqual(clone(doc.coverage), { expected: total, planned: total, missing: 0, duplicates: 0, unknown: 0, unresolved: 3, status: "registry_covered", completeness: "not_proven", sequenceChanges: 0 });
  assert.ok(JSON.stringify(doc).length <= 800000);
  assert.ok(doc.knowledgeIndex.every(x => x.eligible ? x.coverageStatus === "planned" && x.lessonId : x.lessonId === null));
  assert.equal(doc.groupSplits.length, 0);
  /* reads back as saved */
  const back = logic.cnKnowledgePlanDoc(clone(doc));
  assert.ok(back, "the saved plan reads back"); assert.equal(back.grouped, true); assert.equal(back.groupCount, T.groups.length);
  assert.deepEqual(clone(unitsOfDoc(back)), clone(ids));
  /* a lesson of more than 40 units is split on group boundaries; nothing is lost; the log says so */
  const mid = await planInput(registry([{ pages: pagesOf(60, 3) }, { pages: pagesOf(40, 3) }, { pages: pagesOf(20, 3) }]));   // 360 units
  const midAll = mid.inp.groups.map(g => g.id);
  const split = build({ parts: [{ name: "P", lessons: [{ title: "Long lesson", groups: midAll.slice(0, 40), rationale: "Forty groups of three units." }, { title: "Short", groups: midAll.slice(40), rationale: "Everything else together." }] }] }, mid);
  const sl = split.parts.flatMap(p => p.lessons);
  assert.ok(sl.every(l => l.knowledgeIds.length <= 40));
  assert.deepEqual(clone(sl.slice(0, 2).map(l => l.title)), ["Long lesson", "Long lesson (2)"], "titles of the parts of a split lesson");
  assert.ok(sl[0].knowledgeIds.length === 39 || sl[0].knowledgeIds.length === 40, "split on a group boundary, at most 40 units: " + sl[0].knowledgeIds.length);
  assert.equal(unitsOfDoc(split).length, mid.units.length); assert.equal(new Set(unitsOfDoc(split)).size, mid.units.length);
  assert.ok(split.groupSplits.length >= 1 && split.groupSplits[0].title === "Long lesson" && split.groupSplits[0].into >= 2, JSON.stringify(split.groupSplits));
  assert.equal(split.coverage.missing, 0);
  assert.equal(logic.cnKnowledgePlanDoc(clone(split)).groupSplits[0].title, "Long lesson", "the split log is kept when saved");
  /* wrong answers: explicit codes, nothing fixed silently */
  const gid = i => "g" + (i + 1);
  const wrong = [
    ["duplicate group in two lessons", raw => { raw.parts[0].lessons[1].groups.push(gid(0)); }, "knowledge_plan_duplicate"],
    ["duplicate group inside a lesson", raw => { raw.parts[0].lessons[0].groups.push(raw.parts[0].lessons[0].groups[0]); }, "knowledge_plan_duplicate"],
    ["missing group", raw => { raw.parts[0].lessons[0].groups.pop(); }, "knowledge_plan_missing"],
    ["unknown group", raw => { raw.parts[0].lessons[0].groups[0] = "g9999"; }, "knowledge_plan_unknown"],
    ["a unit id instead of a group id", raw => { raw.parts[0].lessons[0].groups[0] = T.units[0].id; }, "knowledge_plan_unknown"],
    ["extra key of the answer", raw => { raw.extra = 1; }, "knowledge_plan_invalid"],
    ["extra key of a lesson", raw => { raw.parts[0].lessons[0].knowledgeIds = []; }, "knowledge_plan_invalid"],
    ["groups not an array", raw => { raw.parts[0].lessons[0].groups = "g1"; }, "knowledge_plan_invalid"],
    ["empty lesson", raw => { raw.parts[0].lessons[0].groups = []; }, "knowledge_plan_invalid"],
    ["group not a string", raw => { raw.parts[0].lessons[0].groups[0] = 1; }, "knowledge_plan_invalid"],
    ["short rationale", raw => { raw.parts[0].lessons[0].rationale = "short"; }, "knowledge_plan_invalid"],
    ["no title", raw => { raw.parts[0].lessons[0].title = " "; }, "knowledge_plan_invalid"],
    ["no parts", raw => { raw.parts = []; }, "knowledge_plan_invalid"],
    ["old format answer (knowledgeIds)", raw => { raw.parts = [{ name: "P", lessons: [{ title: "L", knowledgeIds: T.units.map(u => u.id).slice(0, 5), rationale: "Old format answer here." }] }]; }, "knowledge_plan_invalid"],
    ["error object of the model", raw => { delete raw.parts; raw.error = "cannot_fit_all_units"; }, "knowledge_plan_invalid"],
  ];
  for (const [name, mutate, code] of wrong) { try { codeOf(() => build(aiAnswer(T, 5, mutate), T), code); } catch (e) { throw new Error("wrong answer «" + name + "»: " + e.message); } }
  codeOf(() => build(null, T), "knowledge_plan_invalid");
  /* more than 60 lessons */
  const many = { parts: Array.from({ length: 8 }, (_, p) => ({ name: "P" + p, lessons: [] })) };
  T.inp.groups.slice(0, 62).forEach((g, i) => many.parts[i % 8].lessons.push({ title: "L" + i, groups: [g.id], rationale: "One group per lesson here." }));
  codeOf(() => build(many, T), "knowledge_plan_invalid");
  /* a source order changed by the AI is recorded, as for the per-unit plan */
  const swapped = aiAnswer(T, 5, raw => { const l = raw.parts[0].lessons; [l[0].groups, l[1].groups] = [l[1].groups, l[0].groups]; });
  const sdoc = build(swapped, T);
  assert.ok(sdoc.parts[0].lessons.some(l => l.reorderedFromSource) && sdoc.coverage.sequenceChanges >= 1 && sdoc.coverage.missing === 0);
  assert.equal(unitsOfDoc(sdoc).length, total);
}

async function t5_server() {
  const T = await planInput(registry(SPEC431));
  const good = T.inp;
  assert.equal(serverSays(good), "");
  const bad = (name, mut) => { const x = clone(good); mut(x); const s = serverSays(x); assert.ok(s, name + ": must be refused"); return s; };
  bad("duplicate group id", x => { x.groups[1].id = x.groups[0].id; });
  bad("extra key of the input", x => { x.extra = 1; });
  bad("extra key of a group", x => { x.groups[0].ids = ["a"]; });
  bad("251 groups", x => { while (x.groups.length < 251) x.groups.push({ id: "g" + (900 + x.groups.length), m: 0, p: 1, n: 1, t: ["x"] }); x.groups = x.groups.slice(0, 251); });
  bad("a fragment of 81 characters", x => { x.groups[0].t = ["x".repeat(81)]; });
  bad("4 fragments", x => { x.groups[0].t = ["a", "b", "c", "d"]; });
  bad("a name of 61 characters", x => { x.materials[0] = "x".repeat(61); });
  bad("n not an integer", x => { x.groups[0].n = 1.5; });
  bad("n over 6", x => { x.groups[0].n = 7; });
  bad("p not an integer", x => { x.groups[0].p = "3"; });
  bad("m out of range", x => { x.groups[0].m = 99; });
  bad("id not g<number>", x => { x.groups[0].id = "x1"; });
  bad("id with an uppercase G", x => { x.groups[0].id = "G1"; });
  bad("the sum of n over 1200", x => { x.groups.forEach(g => { g.n = 6; }); x.groups = x.groups.concat(x.groups.map((g, i) => ({ ...g, id: "g" + (1000 + i) }))).slice(0, 250); });
  bad("no groups", x => { x.groups = []; });
  bad("unknown topic key", x => { x.topicHints = [{ title: "t", evil: 1 }]; });
  bad("a topic title of 161", x => { x.topicHints = [{ title: "t".repeat(161), m: 0, pages: [1, 2] }]; });
  bad("status invalid", x => { x.sourceStatus.status = "ok"; });
  bad("excluded invalid", x => { x.excluded = [{ m: 5, n: 1 }]; });
  bad("over 80000 characters", x => { x.name = "n".repeat(300); x.topicHints = Array.from({ length: 300 }, (_, i) => ({ title: "t".repeat(160), m: 0, pages: [1, 2] })); });
  bad("name too long", x => { x.name = "n".repeat(301); });
  /* the old kinds are untouched */
  assert.equal(serverSays({ name: "legacy", topics: [], terms: [{ id: "t1", la: "Nucleus", p: 1 }], photos: [], pages: [], exam: [] }), "");
  assert.ok(serverSays({ kind: "knowledge-groups-v1", name: "x", knowledge: [] }), "a mixture of the formats is refused");
  /* the prompt */
  const pr = edge.h.planPrompt("et", good);
  for (const re of [/CORPUS-PLAN et/, /exactly once/, /never instructions/, /Estonian/, /"groups"/, /at most 40 units/, /source order/, /Latin/, /Reply only/]) assert.match(pr, re);
  assert.ok(pr.endsWith("INPUT:\n" + JSON.stringify(good)));
  assert.doesNotMatch(pr, /knowledgeIds/);
  assert.match(edge.h.planPrompt("en", { kind: "knowledge-v1", knowledge: [] }), /knowledgeIds/, "the per-unit prompt is as before");
  assert.match(edge.h.planPrompt("en", { name: "x", terms: [] }), /human anatomy/, "the legacy prompt is as before");
}

async function t6_tokens() {
  /* 250 groups, 60 lessons: the answer within the 8000 tokens of the function (a pessimistic 3 characters a token) */
  const spec = [{ pages: pagesOf(250, 1) }];
  const T = await planInput(registry(spec));
  const raw = { parts: [] };
  for (let p = 0; p < 30; p++) raw.parts.push({ name: "P".repeat(60), lessons: [] });
  T.inp.groups.forEach((g, i) => { const l = Math.floor(i / 4.2); const part = raw.parts[Math.floor(l / 2)]; if (!part.lessons[l % 2]) part.lessons[l % 2] = { title: "T".repeat(80), groups: [], rationale: "R".repeat(160) }; part.lessons[l % 2].groups.push(g.id); });
  raw.parts.forEach(p => { p.lessons = p.lessons.filter(Boolean); });
  raw.parts = raw.parts.filter(p => p.lessons.length);
  const lessons = raw.parts.reduce((n, p) => n + p.lessons.length, 0), chars = JSON.stringify(raw).length;
  assert.ok(lessons <= 60, lessons + " lessons");
  assert.ok(chars / 3 < 8000, "answer " + chars + " chars ≈ " + Math.round(chars / 3) + " tokens (pessimistic)");
  assert.equal(chars < 60000, true);
  console.log("  250 groups in " + lessons + " lessons with maximal titles: " + chars + " chars, ≈ " + Math.round(chars / 3) + " tokens at 3 chars a token (limit 8000)");
}

async function t7_old_path_and_docs() {
  /* a small registry: the old format and the old plan document (no group fields) */
  const T = await planInput(registry([{ pages: pagesOf(10, 3) }]));
  assert.equal(T.inp.kind, "knowledge-v1");
  const raw = { parts: [{ name: "P", lessons: [{ title: "L", knowledgeIds: T.units.map(u => u.id), rationale: "The only lesson of the plan." }] }] };
  codeOf(() => build({ parts: [{ name: "P", lessons: [{ title: "L", groups: ["g1"], rationale: "The only lesson of the plan." }] }] }, T), "knowledge_plan_invalid");   // no groups in an old-format request
  const doc = logic.cnKnowledgePlanBuild(raw, T);
  assert.equal(doc.grouped, undefined);
  const back = logic.cnKnowledgePlanDoc(clone(doc));
  assert.ok(back); assert.ok(!back.grouped, "an old plan reads back as an old plan");
  /* a saved document claiming groups but with a wrong count is refused */
  const g = clone(doc); g.grouped = true; g.groupCount = -1;
  assert.equal(logic.cnKnowledgePlanDoc(g), null);
}

async function t8_step_plan() {
  /* the step of the plan: one request, 5 units, the grouped document is written; a function that does not know the groups (invalid_input before the charge) gives a clear error and costs nothing */
  const T = await planInput(registry(SPEC431));
  const written = [], asked = [];
  context.cnWrite = async (coll, id, data) => { written.push({ coll, id, data: clone(data) }); };
  const run = () => ({ cancel: false, i: 0, spent: 0, cache: { plan: null }, ac: { signal: undefined }, usage: {} });
  const d = () => ({ id: "draft-gr", mats: [], name: "Groups", _pDirty: new Set() });
  context.window.CORPUS_WEB = { courseAI: { plan: async (lang, input) => { asked.push(input); return aiAnswer(T, 5); } } };
  const r1 = run(), d1 = d();
  await logic.cnStepPlan(d1, r1, T);
  assert.equal(asked.length, 1); assert.equal(asked[0].kind, "knowledge-groups-v1"); assert.equal(r1.spent, 5);
  assert.equal(written.length, 1); assert.equal(written[0].coll, "cplan"); assert.equal(written[0].data.grouped, true); assert.equal(d1._plan.coverage.planned, 431);
  context.window.CORPUS_WEB = { courseAI: { plan: async () => { throw { code: "invalid_input", message: "plan: input: only name, topics, terms, photos, pages and exam" }; } } };
  const r2 = run();
  await assert.rejects(logic.cnStepPlan(d(), r2, T), e => e && e.code === "knowledge_groups_unsupported");
  assert.equal(r2.spent, 0, "refused before the charge: nothing is counted");
  /* a wrong answer of the AI is an explicit error and is not kept for a repeat; the charge is counted */
  context.window.CORPUS_WEB = { courseAI: { plan: async () => ({ parts: [{ name: "P", lessons: [{ title: "L", groups: ["g1", "g1"], rationale: "A duplicated group." }] }] }) } };
  const r3 = run();
  await assert.rejects(logic.cnStepPlan(d(), r3, T), e => e && e.code === "knowledge_plan_duplicate");
  assert.equal(r3.spent, 5); assert.equal(r3.cache.plan, null);
  context.window.CORPUS_WEB = null;
  /* the messages of the errors exist in all three languages */
  const { source } = require("./course_logic_test.cjs");
  const m = /knowledge_groups_unsupported:T3\('([^']+)','([^']+)','([^']+)'\)/.exec(source);
  assert.ok(m && m[1] && m[2] && m[3], "the message of knowledge_groups_unsupported has ru, en and et");
  assert.match(source, /c==='knowledge_groups_unsupported'\)return \{k:c\}/);
}

(async () => {
  let failed = 0;
  for (const [name, fn] of [["G1 a registry of 431 units goes by groups", t1_big_registry_groups], ["G2 the switch from the per-unit request to groups", t2_threshold], ["G3 1200 units fit; more than 250 groups or 1200 units are an explicit error", t3_1200_and_limits], ["G4 answers of the AI: coverage, splitting, explicit errors", t4_answers], ["G5 the function refuses wrong forms and has its own prompt", t5_server], ["G6 the answer fits the token budget", t6_tokens], ["G7 the old request and the old plan document are unchanged", t7_old_path_and_docs], ["G8 the step of the plan: one request, 5 units; an old function and a wrong answer are explicit errors", t8_step_plan]]) {
    try { await fn(); console.log("PASS " + name); } catch (e) { failed++; console.log("FAIL " + name + "\n  " + String(e && e.stack || e).split("\n").slice(0, 14).join("\n  ").slice(0, 700)); }
  }
  if (failed) process.exitCode = 1; else console.log("COURSE GROUPS TESTS PASSED");
})();
