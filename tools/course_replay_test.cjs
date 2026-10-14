#!/usr/bin/env node
"use strict";
// Production helpers with an in-memory backend and AI counter. No browser/network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { logic, context, between } = require("./course_logic_test.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
vm.runInContext(between("function cnBldMerge(", "\nconst cnKnowledgePlanBlocked=") + "\n" + between("async function cnBldClaim(", "\nasync function cnBldStart(") + "\n" +
  between("async function cnBldRun(", "\n/* ---- рисунок ---- */"), context);
const helpers = vm.runInContext("({cnBldRun,cnBldClaim,cnBldRecover,cnBldDone,cnBldEst})", context);
const knowledgeHelpers = vm.runInContext("({cnKnowledgeVisualCandidate,cnKnowledgeClaimLimit})", context);

function oneUnitPlan(material, unit, visuals = []) {
  const doc = syntheticPlan(), lesson = doc.parts[0].lessons[0];
  lesson.knowledgeIds = [unit.id]; doc.parts[0].lessons = [lesson];
  const ref = (u, eligible) => ({ ...clone(u), label: typeof u.content === "string" ? u.content : "Visual source", eligible,
    sources: u.sources.map(s => ({ ...s, materialName: s.materialId === material.id ? material.name : "Illustrations" })),
    order: { ...u.order, materialIndex: 0, offset: u.order.offset || 0 }, coverageStatus: eligible ? "planned" : "unresolved", lessonId: eligible ? lesson.id : null });
  doc.knowledgeIndex = [ref(unit, true), ...visuals.map(u => ref(u, false))];
  doc.coverage.expected = doc.coverage.planned = 1;
  return doc;
}

async function discoveryAndContextTests() {
  const material = { id: "physics", name: "Energy notes", kind: "pdf", role: "base" };
  const pages = [{ n: 1, text: "ENERGY\nEnergy is a conserved quantity.\nComponents\nStored energy can be transferred.\n", em: ["ENERGY", "Components"], diag: { visual: false } },
    { n: 2, text: "DIFFERENT TOPIC\nThis belongs to another page.", em: ["DIFFERENT TOPIC"], diag: { visual: false } }];
  const blocks = logic.cnKnowledgeBlocks(material, pages), primary = blocks.find(b => b.text.includes("conserved quantity"));
  const raw = { knowledge: [{ type: "definition", content: "Energy is a conserved quantity.", sources: [{ block_id: primary.id, quote: "Energy is a conserved quantity." }] }] };
  const found = logic.cnKnowledgeClean(raw, blocks, material).units[0];
  const wrongPointer = clone(raw); wrongPointer.knowledge[0].sources[0].block_id = blocks[0].id;
  const repaired = logic.cnKnowledgeClean(wrongPointer, blocks, material);
  assert.equal(repaired.units.length, 1);
  assert.equal(repaired.units[0].sources[0].blockId, primary.id);
  assert.equal(repaired.units[0].id, found.id, "unique citation repair uses the real source anchor");
  assert.equal(repaired.units[0].verificationStatus, "unverified");
  assert.equal(repaired.status, "incomplete");
  assert.ok(repaired.issues.includes("source_quote_relinked"));
  assert.equal(logic.cnKnowledgeClean(wrongPointer, blocks.concat({ ...primary, id: "second-copy" }), material).units.length, 0, "ambiguous cross-block repair is forbidden");
  const unknown = clone(raw); unknown.knowledge[0].sources[0].block_id = "unknown";
  assert.equal(logic.cnKnowledgeClean(unknown, blocks, material).units.length, 0, "unknown source IDs remain errors");
  const empty = logic.cnKnowledgeClean({ knowledge: [], knowledge_limited: false }, blocks, material);
  assert.equal(empty.status, "incomplete");
  assert.ok(empty.issues.includes("empty_knowledge_for_text"));
  const gap = logic.cnKnowledgeClean(raw, blocks.concat({ ...blocks[0], id: "unlinked", emphasis: false, text: "An independent source passage with an important condition and an ordered relationship. ".repeat(2) }), material);
  assert.ok(gap.issues.includes("source_blocks_without_units:1"));

  const pictures = { id: "figures", name: "Physics diagrams", kind: "pdf", role: "pics" };
  const picturePages = [{ n: 5, text: "ENERGY\nCaption next to a diagram", em: [], diag: { visual: true } }, { n: 6, text: "", em: [], diag: { visual: true } }];
  const visuals = logic.cnKnowledgeVisuals(pictures, picturePages);
  context.cnKnowledgeOf = async () => ({ status: "processed", docs: [{}], units: [found] });
  context.cnPagesOf = async m => m.id === pictures.id ? picturePages : pages;
  const plan = oneUnitPlan(material, found, visuals), draft = { id: "source-test", mats: [material, pictures], _plan: plan };
  const prepared = await logic.cnKnowledgeLessonPrepare(draft, {}, { l: plan.parts[0].lessons[0] });
  assert.equal(prepared.units.length, 1, "context does not inflate the assigned registry");
  assert.ok(prepared.blocks.some(b => b.text.includes("Stored energy can be transferred")));
  assert.equal(prepared.blocks.some(b => b.text.includes("another page")), false);
  assert.ok(prepared.units[0].sources.some(s => s.kind === "context_fragment"));
  assert.ok(prepared.warnings.some(w => w.code === "visual_caption_candidate"));
  assert.equal(logic.cnKnowledgeVisualRef(draft, prepared).ref, "g:figures:5");
  assert.equal(logic.cnKnowledgeVisualRef(draft, prepared).unresolved, true);
  assert.match(logic.cnKnowledgeLessonStatusHtml({ sourceWarnings: prepared.warnings }), /image content was not recognized/);
  const loaded = new Map([[material.id, { m: material, pages }]]);
  context.cnPagesOf = async () => picturePages.concat({ ...picturePages[0], n: 7 });
  draft._plan.knowledgeIndex.push(...logic.cnKnowledgeVisuals(pictures, [{ ...picturePages[0], n: 7 }]).map(u => ({ ...u, eligible: false })));
  assert.equal(await knowledgeHelpers.cnKnowledgeVisualCandidate(draft, prepared.units, loaded), null, "tied caption matches are not guessed");
  context.cnPagesOf = async () => [{ ...picturePages[0], text: "" }, picturePages[1]];
  assert.equal(await knowledgeHelpers.cnKnowledgeVisualCandidate(draft, prepared.units, loaded), null, "an uncaptioned raster is not semantically matched");

  const contextBlock = prepared.blocks.find(b => b.text.includes("Stored energy can be transferred"));
  const response = { intro: [{ text: "Energy is conserved.", evidence: [{ blockId: primary.id, quote: "Energy is a conserved quantity." }] }],
    units: [{ id: found.id, claims: Array.from({ length: 7 }, () => ({ text: "x".repeat(500), evidence: [{ blockId: contextBlock.id, quote: "Stored energy can be transferred." }] })) }] };
  const result = logic.cnKnowledgeLessonClean(response, prepared);
  assert.equal(result.generationStatus, "ai", "supported same-page context claims are accepted");
  assert.ok(logic.cnKnowledgeClaimText(result.units.get(found.id)).length <= 4000, "valid explanation cannot be cut by card persistence");
  const plate = { lessonVersion: 2, knowledgeIds: [found.id], generationStatus: "ai", knowledgeUnits: [{ ...prepared.units[0], extractionStatus: "extracted", sourceLinkStatus: "checked", generationStatus: "ai", claims: result.units.get(found.id) }], knowledgeIntroEvidence: result.intro };
  const reloaded = logic.cnKnowledgeLessonMetaClean(clone(plate));
  assert.ok(reloaded, "longer explanation and context evidence survive serialization");
  assert.equal(reloaded.knowledgeUnits[0].claims.length, 7);
  const bad = clone(response); bad.units[0].claims[0].evidence[0].quote = "not present";
  assert.equal(logic.cnKnowledgeLessonClean(bad, prepared).generationStatus, "partial");
  assert.equal(knowledgeHelpers.cnKnowledgeClaimLimit(1), 7);
  assert.equal(knowledgeHelpers.cnKnowledgeClaimLimit(40), 1);
  console.log("DISCOVERY/CONTEXT/VISUAL TESTS PASSED: empty registry, unique/ambiguous pointers, unlinked blocks, contextual citations, claim budget, caption candidate/tie/unresolved, lesson reload");
}

async function replayEvidence(directory) {
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
  const backend = read("backend-after-paid.json"), records = backend.docs;
  const savedPlan = records.find(x => x.coll === "cplan" && x.data.planVersion === 2);
  const draft = { id: savedPlan.id, ...clone(records.find(x => x.coll === "cdraft" && x.id === savedPlan.id).data), _plan: logic.cnPlanDoc(savedPlan.data) };
  const docs = new Map(records.filter(x => x.coll === "ctext").map(x => [x.id, x.data]));
  const pagesOf = m => (m.chunks || []).flatMap(id => docs.get(id)?.pages || []);
  const calls = fs.readFileSync(path.join(directory, "real-run-ledger.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse).filter(x => x.status === "completed");
  assert.equal(calls.length, 5);
  const input = row => JSON.parse(row.request.messages[0].content.split("INPUT:\n")[1]);
  const output = row => JSON.parse(row.response.content.filter(x => x.type === "text").map(x => x.text).join(""));
  const sourceMaterials = draft.mats.filter(m => ["base", "extra"].includes(m.role));
  const replayed = sourceMaterials.map((m, i) => {
    const blocks = logic.cnKnowledgeBlocks(m, pagesOf(m)), sent = input(calls[i]).pages.flatMap(p => p.blocks);
    assert.deepEqual(clone(blocks.map(b => ({ id: b.id, text: b.text, emphasis: b.emphasis }))), sent, "saved extraction and sent source blocks match exactly; no shortening in these PDFs");
    return { m, blocks, result: logic.cnKnowledgeClean(output(calls[i]), blocks, m) };
  });
  assert.equal(replayed[0].result.units.length, 26);
  assert.equal(replayed[0].result.rejected, 0);
  assert.ok(replayed[0].result.issues.includes("source_quote_relinked"));
  assert.equal(replayed[1].result.units.length, 0);
  assert.equal(replayed[1].result.status, "incomplete");
  assert.ok(replayed[1].result.issues.includes("empty_knowledge_for_text"));
  const oldEmpty = docs.get(sourceMaterials[1].kdocs[0]), oldEmptyJSON = JSON.stringify(oldEmpty);
  const loadedEmpty = logic.cnKnowledgeDocClean(oldEmpty);
  assert.equal(loadedEmpty.outlineStatus, "incomplete", "old empty records are diagnosed on read, without a database migration");
  assert.ok(loadedEmpty.issues.includes("empty_knowledge_for_text"));
  assert.equal(JSON.stringify(oldEmpty), oldEmptyJSON, "loading must not mutate the saved record");
  const witnesses = read("omission-witnesses.json"), normalize = s => s.replace(/\s+/g, " ").toLowerCase();
  const source = normalize(replayed[0].blocks.map(b => b.text).join("")), registry = normalize(JSON.stringify(replayed[0].result.units.map(u => u.content)));
  const absent = Object.values(witnesses).flat().filter(w => !registry.includes(normalize(w)));
  assert.ok(Object.values(witnesses).flat().every(w => source.includes(normalize(w))), "all 21 witnesses existed in the actual outline input");
  assert.equal(absent.length, 21, "model omissions cannot be invented back into the registry by a validator");
  context.cnDocData = async (_coll, id) => docs.get(id) || null;
  context.cnKnowledgeOf = logic.cnKnowledgeOf;
  context.cnPagesOf = async m => pagesOf(m);
  const lessons = logic.cnBldList(draft).slice(0, 2), stats = [];
  for (const [i, it] of lessons.entries()) {
    const prepared = await logic.cnKnowledgeLessonPrepare(draft, {}, it), oldInput = input(calls[i + 3]);
    assert.equal(logic.cnKnowledgeLessonClean(output(calls[i + 3]), prepared).generationStatus, "ai", "saved real lesson still validates with the richer context");
    const visual = logic.cnKnowledgeVisualRef(draft, prepared);
    assert.equal(visual?.ref, "g:" + draft.mats.find(m => m.role === "pics").id + ":" + (i + 2));
    assert.equal(visual.unresolved, true);
    stats.push({ lesson: it.l.id, oldBlocks: oldInput.sourceBlocks.length, newBlocks: prepared.blocks.length,
      oldSourceChars: oldInput.sourceBlocks.reduce((n, b) => n + b.text.length, 0), newSourceChars: prepared.blocks.reduce((n, b) => n + b.text.length, 0),
      oldInputChars: JSON.stringify(oldInput).length, newInputChars: prepared.inputChars, visualCandidate: visual.ref,
      witnessesNowInContext: Object.values(witnesses).flat().filter(w => normalize(prepared.blocks.map(b => b.text).join("")).includes(normalize(w))) });
  }
  assert.equal(stats[1].oldSourceChars, 151);
  assert.equal(stats[1].newSourceChars, 1775);
  console.log("REAL EVIDENCE REPLAY: " + JSON.stringify({ registryAccepted: replayed.map(x => x.result.units.length), issues: replayed.map(x => x.result.issues), stillAbsentWitnesses: absent, lessonContexts: stats }, null, 2));
}

function syntheticPlan() {
  const lessons = [1, 2, 3].map(i => ({ id: "lesson" + i, title: "Topic " + i, rationale: "Learn this concept before the following topic.", knowledgeIds: ["unit" + i], reorderedFromSource: false }));
  return { planVersion: 2, planKind: "knowledge", at: 123, parts: [{ id: "part1", name: "Foundations", lessons }],
    knowledgeIndex: lessons.map((l, i) => ({ id: l.knowledgeIds[0], type: "statement", label: "Source claim " + i,
      sources: [{ materialId: "source", materialName: "Physics notes", blockId: "block" + i, page: i + 1, start: 0, end: 10, kind: "text_fragment", sourceOrder: { pageIndex: i + 1, block: 0 } }],
      order: { materialIndex: 0, pageIndex: i + 1, block: 0, offset: 0 }, extractionStatus: "extracted", sourceLinkStatus: "checked", verificationStatus: "unverified", eligible: true, coverageStatus: "planned", lessonId: l.id })),
    sourceAssessment: { status: "no_warning_detected", completeness: "not_proven", registryStatus: "processed", materials: [] },
    coverage: { expected: 3, planned: 3, missing: 0, duplicates: 0, unknown: 0, status: "registry_covered" },
    bld: { at: 123, base: 123, spent: 0, parts: {}, ls: {}, pa: {}, run: null } };
}

async function main() {
  let stored, calls = [];
  const drafts = new Map();
  Object.assign(context, { CDRAFTS: drafts, CN_DEV: "offline", setInterval: () => 1, clearInterval: () => {}, cnBPaint: () => {}, cnBldFree: () => {},
    cnDocData: async () => clone(stored), cnWrite: async (_coll, _id, data) => { stored = clone(data); }, S: { plates: [] } });
  context.cnBldOne = async (d, b, { l }) => {
    calls.push(l.id);
    const p = { id: "plate-" + l.id, cb: d.id + "|" + d._plan.at + "|" + l.id, lessonVersion: 2, generationStatus: "ai", knowledgeIds: l.knowledgeIds.slice(), knowledgeUnits: l.knowledgeIds.map(id => ({ id, generationStatus: "ai" })) };
    context.S.plates.push(p);
    d._plan.bld.spent += 2;
    d._plan.bld.ls[l.id] = { st: "ok", outcome: "ai", pid: p.id, nf: 0, nt: 0, np: 1 };
    await context.cnWrite("cplan", d.id, d._plan);
    if (calls.length === 2) b.pause = true;
    return null;
  };
  const draft = { id: "offline-draft", _plan: logic.cnPlanDoc(syntheticPlan()) };
  assert.ok(draft._plan);
  drafts.set(draft.id, draft); stored = clone(draft._plan);
  await helpers.cnBldRun(draft, { pause: false, cancel: false, log: [] });
  assert.deepEqual(calls, ["lesson1", "lesson2"]);
  // Save → reload through the actual v2 decoder → progress → resume.
  const reloaded = { id: draft.id, _plan: logic.cnPlanDoc(clone(stored)) };
  drafts.set(draft.id, reloaded);
  assert.equal(helpers.cnBldDone(reloaded), 2);
  assert.equal(helpers.cnBldEst(reloaded), 2);
  assert.equal(reloaded._plan.bld.spent, 4);
  await helpers.cnBldClaim(reloaded);
  await helpers.cnBldRun(reloaded, { pause: false, cancel: false, log: [] });
  assert.deepEqual(calls, ["lesson1", "lesson2", "lesson3"], "ready lessons incur no second AI call");
  assert.equal(helpers.cnBldDone(reloaded), 3);
  assert.equal(helpers.cnBldEst(reloaded), 0);
  const beforeRetry = calls.length;
  await logic.cnBldStart(reloaded, "lesson1");
  assert.equal(calls.length, beforeRetry, "retry cannot erase a ready lesson");

  // Interrupted progress write: reuse an already saved lesson by exact assignment.
  reloaded._plan.bld.ls = {};
  helpers.cnBldRecover(reloaded);
  assert.equal(helpers.cnBldDone(reloaded), 3);
  reloaded._plan.bld.ls = {};
  context.S.plates[0].knowledgeIds = ["wrong-unit"];
  context.S.plates[1].cb = "another-draft|123|lesson2";
  context.S.plates[2].cb = draft.id + "|999|lesson3";
  helpers.cnBldRecover(reloaded);
  assert.equal(helpers.cnBldDone(reloaded), 0, "wrong assignment, draft or plan is never reused");

  await discoveryAndContextTests();
  if (process.argv[2]) {
    const backend = JSON.parse(fs.readFileSync(path.join(process.argv[2], "backend-after-paid.json"), "utf8"));
    const records = Array.isArray(backend.docs) ? backend.docs : Object.values(backend.docs);
    const saved = records.map(x => x.data ?? x).find(x => x.planVersion === 2 && Object.keys(x.bld?.ls || {}).length === 2);
    assert.ok(saved, "real saved plan with two completed records must exist");
    const real = { _plan: logic.cnPlanDoc(saved) };
    assert.ok(real._plan);
    assert.equal(helpers.cnBldDone(real), 2);
    assert.equal(helpers.cnBldEst(real), 10);
    console.log("REAL EVIDENCE: 2/7 restored; only 5 lessons remain (no AI called)");
    await replayEvidence(process.argv[2]);
  }
  console.log("BUILD RESUME TESTS PASSED: save/reload/resume, ready retry guard, interrupted-write recovery, stale assignment rejection");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
