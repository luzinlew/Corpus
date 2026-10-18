#!/usr/bin/env node
"use strict";

// Offline tests for the Course helpers embedded in src/corpus.html.
// Extracts the production functions so these checks need no browser, database or AI API.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
let TEST_LOCALE = "en";

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "corpus.html"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "supabase", "functions", "corpus-ai", "index.ts"), "utf8");
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.notEqual(a, -1, `missing source marker: ${start}`);
  assert.notEqual(b, -1, `missing source marker: ${end}`);
  return source.slice(a, b);
}
function betweenServer(start, end) {
  const a = serverSource.indexOf(start), b = serverSource.indexOf(end, a);
  assert.notEqual(a, -1, `missing server source marker: ${start}`);
  assert.notEqual(b, -1, `missing server source marker: ${end}`);
  return serverSource.slice(a, b);
}

const context = vm.createContext({
  CN_LIM: { pageChars: 60000, items: 50000, mats: 20, pages: 400, txtBytes: 4 * 1048576 },
  CN_DIAG: { shortChars: 80 },
  CN_PL: { parts: 30, lessons: 60, perLesson: 40, outPages: 40, outJson: 36000, topics: 300, planJson: 78000, knowledge: 1200, doc: 800000, mats: 20 },
  CN_KNOWLEDGE_VERSION: 1, CN_KNOWLEDGE_PROMPT_VERSION: 3, CN_KNOWLEDGE_MAX_UNITS: 50, CN_KNOWLEDGE_MAX_CONTENT: 2400, CN_KNOWLEDGE_MAX_RESPONSE_CHARS: 60000,
  CN_KNOWLEDGE_PLAN_VERSION: 2, CN_KNOWLEDGE_PLAN_MAX_UNITS: 1200, CN_KNOWLEDGE_PLAN_MAX_EXCLUDED: 2400, CN_KNOWLEDGE_PLAN_MAX_RESPONSE_CHARS: 60000,
  CN_KNOWLEDGE_TYPES: ["term", "definition", "statement", "process", "formula", "table", "visual"],
  CR_LANGS: ["ru", "en", "et"],
  LANG: "en",
  T3: (ru, en) => TEST_LOCALE === "ru" ? ru : en,
  cnLangOk: value => ["ru", "en", "et"].includes(value) ? value : "",
  esc: value => String(value ?? "").replace(/[&<>\"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]),
  cnNorm: value => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
  cnLatin: value => /^[A-Za-z][A-Za-z .'-]*$/.test(String(value ?? "").trim()) ? String(value).trim() : "",
  cnDocData: async () => null, cnNameOf: value => String(value ?? "Material"), cnRPaint: () => {},
  cnUsageAdd: () => {}, cnFp: () => "fixture-fp", toast: () => {},
  cnPlanOk0: () => true,
  cnNReq: n => String(n),
  crNL: n => String(n), plx: n => String(n), CN_CHK1: "check",
  clearTimeout: () => {},
  window: { CORPUS_WEB: null },
  S: { db: true }, cnDirty: () => {}, cnSave: async () => {}, cnT: () => ({}), cnDelIds: () => {}, cnWrite: async () => {},
});
const code = [
  between("const CN_OUT=", "\n/* сокращения в начале названия"),
  between("const cnStrs=", "\n/* a draft from the cloud"),
  between("function cnAuditClean(", "\n/* the role «exam»"),
  between("function cnExtractDiag(", "\nasync function cnPageText"),
  between("function cnKnowledgeHash(", "\nfunction cnOutClean"),
  between("function cnKnowledgeOutlineInput(", "\nasync function cnKnowledgePersist"),
  between("async function cnKnowledgePersist(", "\nasync function cnStepOutline"),
  between("function cnOutClean(", "\n/* Preserve Latin"),
  between("const cnBldOutcomeFor=", "\nfunction cnBldOutcome"),
  between("function cnBldOutcome(", "\n/* the record of the cloud"),
  between("function cnBldStatus(", "\nconst CN_KLESSON="),
  between("function cnPagesCheck(", "\nasync function cnPagesOf"),
  between("function cnDiagRanges(", "\nfunction cnMatAuditHtml"),
  between("function cnMatAuditHtml(", "\nfunction cnMatHtml"),
  between("function cnDiagClean(", "\nfunction cnPlanDoc"),
  between("async function cnKnowledgePlanInput(", "\n/* (г) свод терминов"),
  between("function cnKnowledgePlanInner(", "\nfunction cnPlanInner"),
  between("function cnPlanDoc(", "\nfunction cnPlanLoad"),
  between("async function cnStepPlan(", "\n/* ---- экран шага 2 ---- */"),
  between("async function cnPagesOf(", "\nasync function cnQsOf"),
  between("function cnPlanClean(", "\nfunction cnPlanCoverage"),
  between("function cnPlanCoverage(", "\n/* Остаток AI-плана"),
  between("function cnPlanBuild(", "\n/* запасной план"),
  between("function cnPlanBar(", "\nfunction cnPlanHtml"),
  between("const cnKnowledgePlanBlocked=", "\nconst cnBldIssues="),
  between("async function cnBldStart(", "\n/* «Обновить рисунки"),
  between("async function cnBldRefreshStart(", "\nasync function cnBldRefreshRun"),
  between("function cnBldInner(", "\nfunction cnBldBar"),
  between("async function cnBldOne(", "\nfunction cnCourseName"),
  between("async function cnBuildGo(", "\nfunction cnMountBuild"),
  between("const cnHasLessonSource=", "\nasync function cnBldText"),
  between("function cnLessonClean(", "\nconst cnSrcShort"),
  between("function cnBldErrCode(", "\nasync function cnBldKnowledgeOne"),
  between("const CN_KLESSON=", "\n/* in memory:"),
  between("function lessonStr(", "\nfunction cleanLessonPlate"),
].join("\n") + "\nglobalThis.__courseLogic={CN_KLESSON,cnKnowledgeHash,cnKnowledgeBlocks,cnKnowledgeClean,cnKnowledgeVisuals,cnKnowledgeDocClean,cnKnowledgeOf,cnKnowledgeRefsClean,cnKnowledgeOutlineInput,cnKnowledgePageStatus,cnKnowledgeMergeUnits,cnKnowledgePersist,cnKnowledgePlanInput,cnKnowledgePlanBuild,cnKnowledgePlanDoc,cnKnowledgePlanInner,cnPlanDoc,cnPlanBar,cnStepPlan,cnKnowledgePlanBlocked,cnBldRoute,cnBldList,cnBldStart,cnBldRefreshStart,cnBldInner,cnBldOne,cnBuildGo,cnOutClean,cnAuditClean,cnExtractDiag,cnPageHasVisual,cnStorePage,cnPageAudit,cnCourseDiagnostics,cnDiagClean,cnDiagHtml,cnMatAuditHtml,cnBldOutcomeFor,cnBldOutcome,cnBldDoc,cnBldStatus,cnBldFallbackReason,cnBldAttachEvidence,cnPagesCheck,cnPagesOf,cnPlanBuild,cnHasLessonSource,cnLessonClean,cnBldErrCode,cnKnowledgeContentText,cnKnowledgeLessonLabel,cnKnowledgeLessonWarnings,cnKnowledgeLessonPrepare,cnKnowledgeLessonClean,cnKnowledgeLessonCall,cnKnowledgeLessonStatusHtml,cnKnowledgeUnitInfoHtml,cnKnowledgeVisualRef,cnKnowledgeClaimText,cnKnowledgeFallbackText,cnKnowledgeSourceSnapshotsClean,cnKnowledgeLessonMetaClean};";
vm.runInContext(code, context, { filename: "src/corpus.html" });
const logic = context.__courseLogic;
const PAGE_TEXT_LIMIT = 60000;
const PAGE_ITEM_LIMIT = 50000;

function codeOf(fn, expected) {
  assert.throws(fn, error => error && error.code === expected);
}
function planIds(doc) {
  return JSON.parse(JSON.stringify(doc.parts.flatMap(part => part.lessons.flatMap(lesson => lesson.terms.map(term => term.id)))));
}

async function main() {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "course_knowledge_stage_a.json"), "utf8"));
  const fixtureBlocks = logic.cnKnowledgeBlocks(fixture.material, fixture.pages);
  const blockFor = (page, quote) => fixtureBlocks.find(block => block.page === page && block.text.includes(quote));
  const mockOutline = {
    topics: fixture.legacyOutline.topics,
    knowledge: fixture.expectedUnits.map(unit => ({
      type: unit.type, content: unit.content,
      sources: [{ block_id: blockFor(unit.page, unit.quote).id, quote: unit.quote }],
    })),
    knowledge_limited: false,
  };
  const fixtureItems = fixture.pages.map(p => ({ ...p, blocks: fixtureBlocks.filter(b => b.page === p.n) }));
  const sourceChars = JSON.stringify(logic.cnKnowledgeOutlineInput(fixture.material, { items: fixtureItems })).length;
  const responseChars = JSON.stringify(mockOutline).length;
  const knowledge = logic.cnKnowledgeClean(mockOutline, fixtureBlocks, fixture.material);
  assert.equal(knowledge.status, "processed", JSON.stringify({ issues: knowledge.issues, rejected: knowledge.rejected }));
  assert.equal(knowledge.completeness, "not_proven");
  assert.equal(knowledge.units.length, 10, "exact duplicate is merged while contradictory claims remain separate");
  assert.equal(knowledge.mergedDuplicates, 1);
  assert.equal(knowledge.rejected, 0);
  const unitTypes = new Set(knowledge.units.map(unit => unit.type));
  assert.deepEqual([...unitTypes].sort(), ["definition", "formula", "process", "statement", "table", "term", "visual"]);
  const russian = knowledge.units.find(unit => unit.content === "Вода кипит при 100 °C при нормальном давлении.");
  const estonian = knowledge.units.find(unit => unit.content === "Vesi keeb normaalsel rõhul 100 °C juures.");
  const termUnit = knowledge.units.find(unit => unit.type === "term");
  const definitionUnit = knowledge.units.find(unit => unit.type === "definition");
  assert.equal(russian.sources[0].page, 2, "source language and source page are preserved");
  assert.equal(estonian.sources[0].page, 2);
  assert.equal(russian.order.page, 2, "source order follows page order");
  assert.ok(termUnit.order.offset < definitionUnit.order.offset, "units on one page retain their fragment order");
  assert.equal(logic.cnKnowledgePageStatus(fixture.pages), "review_required", "an unresolved or visually flagged source keeps extraction status separate");
  const formula = knowledge.units.find(unit => unit.type === "formula");
  assert.deepEqual(JSON.parse(JSON.stringify(formula.content.variables.map(x => x.unit))), ["m/s", "m", "s"]);
  const table = knowledge.units.find(unit => unit.type === "table");
  assert.deepEqual(JSON.parse(JSON.stringify(table.content.rows)), [["solid", "S"], ["liquid", "L"]]);
  assert.equal(knowledge.units.every(unit => unit.version === 1 && unit.verificationStatus === "unverified" && unit.sourceLinkStatus === "checked" && unit.coverageStatus === "not_in_plan"), true);
  knowledge.units.forEach(unit => unit.sources.forEach(ref => {
    const block = fixtureBlocks.find(x => x.id === ref.blockId);
    assert.ok(block && block.materialId === ref.materialId && ref.start >= block.start && ref.end <= block.end);
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(knowledge.units.filter(x => x.content === "At 1 atm, water boils at 100 °C.")[0].sources.map(x => x.page))), [7, 8], "duplicate evidence from separate pages is retained");
  assert.equal(knowledge.units.filter(x => x.type === "statement" && x.order.page === 7).length, 2, "contradictory statements stay separate");
  const repeatedKnowledge = logic.cnKnowledgeClean(mockOutline, fixtureBlocks, fixture.material);
  assert.deepEqual(JSON.parse(JSON.stringify(knowledge.units.map(x => x.id))), JSON.parse(JSON.stringify(repeatedKnowledge.units.map(x => x.id))), "IDs are stable for unchanged source and content");
  const paraphrase = logic.cnKnowledgeClean({ knowledge: [{ type: "definition", content: "Density is mass divided by volume.", sources: [{ block_id: definitionUnit.sources[0].blockId, quote: "Density is mass per unit volume." }] }] }, fixtureBlocks, fixture.material);
  assert.equal(paraphrase.units[0].id, definitionUnit.id, "a stable source anchor keeps the ID when generated wording varies");
  const crossChunkFirst = { units: [JSON.parse(JSON.stringify(knowledge.units[0]))], issues: [] };
  const crossChunkSecond = { units: [JSON.parse(JSON.stringify(knowledge.units[0]))], issues: [] };
  crossChunkSecond.units[0].sources[0].page = 99;
  crossChunkSecond.units[0].sources[0].blockId = "second-chunk";
  logic.cnKnowledgeMergeUnits([crossChunkFirst, crossChunkSecond]);
  assert.equal(crossChunkFirst.units[0].sources.length, 2, "identical units from separate outline chunks retain both source links");
  assert.deepEqual(JSON.parse(JSON.stringify(crossChunkSecond.units)), []);
  const legacy = logic.cnOutClean(fixture.legacyOutline, fixture.pages.map(p => ({ n: p.n, text: p.text, em: p.em })));
  assert.deepEqual(JSON.parse(JSON.stringify(legacy[0].terms)), ["Density"], "the compatible legacy terms projection remains available");
  const firstPageBlocks = fixtureBlocks.filter(block => block.page === 1);
  const wire = logic.cnKnowledgeOutlineInput(fixture.material, { items: [{ n: 1, blocks: firstPageBlocks, em: ["Key concepts", "Density"], text: fixture.pages[0].text }] });
  assert.equal(Object.hasOwn(wire.pages[0], "text"), false, "source text is sent once in its referenced block");
  assert.equal(wire.pages[0].blocks.map(block => block.text).join(""), fixture.pages[0].text, "emphasized source spans partition page text without duplication");
  assert.equal(wire.pages[0].blocks.filter(block => block.emphasis).map(block => block.text).join("\n"), "Key concepts\nDensity");
  assert.deepEqual(JSON.parse(JSON.stringify(wire.pages[0].em)), [], "matched emphasis is metadata, not duplicated source text");
  const separateEmphasis = logic.cnKnowledgeBlocks(fixture.material, [{ n: 10, text: "Visible paragraph", em: ["OCR heading"] }]);
  assert.deepEqual(JSON.parse(JSON.stringify(separateEmphasis.map(block => [block.text, block.emphasis, block.kind]))), [["Visible paragraph", false, "page_text"], ["OCR heading", true, "emphasis_text"]], "emphasis fragments missing from extracted page text remain a separate cited source block");

  const visualCandidates = logic.cnKnowledgeVisuals(fixture.material, fixture.pages, 1);
  assert.equal(visualCandidates.length, 3, "captioned page, image-only page and uploaded image get location-only visual units");
  assert.equal(visualCandidates.every(x => x.type === "visual" && x.content === null && x.extractionStatus === "unresolved" && x.verificationStatus === "unverified"), true);
  assert.equal(visualCandidates[0].sources[0].page, 6);
  assert.equal(visualCandidates[1].sources[0].page, 9);
  assert.equal(visualCandidates[2].sources[0].photoIndex, 0);
  for (const unit of visualCandidates) {
    assert.deepEqual(JSON.parse(JSON.stringify(unit.visualState)), { detection: "detected", caption: "not_assessed", lessonUse: "not_checked" });
  }

  const invalidUnits = [
    { type: "claim", content: "Unknown type", sources: [{ block_id: blockFor(1, "Density").id, quote: "Density" }] },
    { type: "statement", content: "Unknown block", sources: [{ block_id: "missing-block", quote: "Density" }] },
    { type: "statement", content: "Unsupported quote", sources: [{ block_id: blockFor(1, "Density").id, quote: "not in the source" }] },
  ];
  const invalidRegistry = logic.cnKnowledgeClean({ knowledge: invalidUnits }, fixtureBlocks, fixture.material);
  assert.equal(invalidRegistry.status, "incomplete");
  assert.equal(invalidRegistry.units.length, 0);
  assert.equal(invalidRegistry.rejected, 3);
  assert.ok(invalidRegistry.issues.includes("invalid_type"));
  assert.ok(invalidRegistry.issues.includes("unknown_source_block"));
  assert.ok(invalidRegistry.issues.includes("source_quote_mismatch"));
  const ambiguousCitation = logic.cnKnowledgeClean({ knowledge: [{ type: "term", content: "At 1 atm", sources: [{ block_id: blockFor(7, "At 1 atm").id, quote: "At 1 atm" }] }] }, fixtureBlocks, fixture.material);
  assert.equal(ambiguousCitation.status, "incomplete");
  assert.ok(ambiguousCitation.issues.includes("ambiguous_source_quote"), "non-unique citation spans are not presented as precise provenance");
  const malformed = logic.cnKnowledgeClean({ knowledge: [{ type: "table", content: { headers: ["A", "B"], rows: [["only one"]] }, sources: [{ block_id: blockFor(5, "State | Symbol").id, quote: "State | Symbol" }] }] }, fixtureBlocks, fixture.material);
  assert.equal(malformed.status, "incomplete");
  assert.ok(malformed.issues.includes("invalid_content"));
  assert.equal(logic.cnKnowledgeClean({ knowledge: [] }, fixtureBlocks, fixture.material, { truncated: true }).status, "incomplete", "a truncated response cannot be treated as a valid full response");
  assert.equal(logic.cnKnowledgeClean({ knowledge: [], knowledge_limited: true }, fixtureBlocks, fixture.material).status, "incomplete", "the output cap is explicit");
  assert.equal(logic.cnKnowledgeClean(null, fixtureBlocks, fixture.material, { transportError: "invalid_json" }).status, "incomplete");
  const oversized = logic.cnKnowledgeClean({ knowledge: [], note: "x".repeat(60001) }, fixtureBlocks, fixture.material);
  assert.equal(oversized.status, "incomplete");
  assert.ok(oversized.issues.includes("response_size_limit"));
  const inventedVisual = logic.cnKnowledgeClean({ knowledge: [{ type: "visual", content: { caption: "unseen image details", labels: [] }, sources: [{ block_id: blockFor(6, "Diagram: energy flow").id, quote: "Diagram: energy flow" }] }] }, fixtureBlocks, fixture.material);
  assert.equal(inventedVisual.status, "incomplete");
  assert.ok(inventedVisual.issues.includes("visual_text_not_cited"));
  assert.deepEqual(JSON.parse(JSON.stringify(logic.cnKnowledgeRefsClean(undefined))), [], "legacy drafts without registry references remain readable");
  assert.deepEqual(JSON.parse(JSON.stringify(logic.cnKnowledgeRefsClean(["foreign.material.ku1.g0.1", "draft.fixture-mixed-source.ku1.g0.1"], "draft", fixture.material.id))), ["draft.fixture-mixed-source.ku1.g0.1"], "registry cleanup cannot follow a cross-material reference");
  const stored = { kind: "course-knowledge", version: 1, materialId: fixture.material.id, outlineStatus: "processed", sourceProcessingStatus: "review_required", units: knowledge.units, model: "mock-model", inputChars: 900, outputChars: 600, inputTokens: 800, outputTokens: 450, maxOutputTokens: 4096 };
  assert.equal(logic.cnKnowledgeDocClean(stored).completeness, "not_proven");
  context.cnDocData = async (_coll, id) => id === "registry-1" ? stored : null;
  const loadedRegistry = await logic.cnKnowledgeOf({ kdocs: ["registry-1"] });
  assert.equal(loadedRegistry.status, "incomplete", "source review status survives sidecar loading");
  assert.equal(loadedRegistry.units.length, knowledge.units.length);
  assert.equal((await logic.cnKnowledgeOf({})).status, "unavailable", "old saved courses without KnowledgeUnits still load");

  const persistedDocs = new Map(), deletedDocs = [];
  context.cnWrite = async (coll, id, data) => persistedDocs.set(coll + "/" + id, JSON.parse(JSON.stringify(data)));
  context.cnDelIds = ids => deletedDocs.push(...ids);
  context.cnDocData = async (coll, id) => persistedDocs.get(coll + "/" + id) || null;
  const persistMaterial = { ...fixture.material, kind: "text", chunks: ["source-chunk"], kdocs: [] };
  const persistDraft = { id: "draft-fixture", mats: [persistMaterial] };
  const persistPages = fixture.pages.map(page => ({ ...page, blocks: fixtureBlocks.filter(block => block.page === page.n) }));
  const persistJob = { m: persistMaterial, items: persistPages, blocks: fixtureBlocks };
  const persistedState = await logic.cnKnowledgePersist(persistDraft, {}, [persistJob], [{ knowledge, inputChars: sourceChars, outputChars: responseChars, model: "mock-model", inputTokens: 800, outputTokens: 450 }], [{ m: persistMaterial, pages: fixture.pages }], [], null);
  assert.equal(persistedState.status, "incomplete", "visual review remains independent from a structurally valid outline result");
  assert.equal(persistMaterial.kdocs.length, 1);
  assert.equal(persistMaterial.kstatus, "incomplete");
  assert.equal(deletedDocs.length, 0);
  const sidecar = persistedDocs.get("ctext/" + persistMaterial.kdocs[0]);
  assert.equal(sidecar.kind, "course-knowledge");
  assert.equal(sidecar.version, 1);
  assert.equal(sidecar.outlineStatus, "processed");
  assert.equal(sidecar.sourceProcessingStatus, "review_required");
  assert.equal(sidecar.completeness, "not_proven");
  assert.equal(sidecar.model, "mock-model");
  assert.equal(sidecar.inputTokens, 800);
  assert.equal(sidecar.outputTokens, 450);
  assert.equal((await logic.cnKnowledgeOf(persistMaterial, persistDraft.id)).units.length, knowledge.units.length + 2);
  const savedVisuals = (await logic.cnKnowledgeOf(persistMaterial, persistDraft.id)).units.filter(u => u.type === "visual" && u.extractionStatus === "unresolved");
  assert.deepEqual(JSON.parse(JSON.stringify(savedVisuals)), JSON.parse(JSON.stringify(logic.cnKnowledgeVisuals(persistMaterial, fixture.pages))), "visual IDs, source pages and independent states survive actual persistence helpers");

  assert.ok(sourceChars > 0 && responseChars > 0);
  console.log(`SYNTHETIC KNOWLEDGE FIXTURE: ${knowledge.units.length} accepted units, ${knowledge.mergedDuplicates} duplicate merged, input ${sourceChars} chars, mock response ${responseChars} chars (outline cap: 4096 tokens)`);

  assert.equal(logic.cnHasLessonSource({ text: "" }), false);
  assert.equal(logic.cnHasLessonSource({ text: " \n " }), false);
  assert.equal(logic.cnHasLessonSource({ text: "source passage" }), true);

  const blocks = [
    { id: "s1", materialId: "mat-a", name: "Lecture.pdf", page: 1, text: "Water moves through a porous membrane." },
    { id: "s2", materialId: "mat-a", name: "Lecture.pdf", page: 2, text: "Heat moves through the surrounding fluid." },
  ];
  const lesson = { terms: [
    { id: "t1", la: "Water" }, { id: "t2", la: "Heat" },
    { id: "t3", la: "Salt" }, { id: "t4", la: "Sugar" },
  ] };
  const answer = quote => ({ intro: [quote], notes: {}, q: [], evidence: { intro: [quote], notes: {}, q: [] } });
  codeOf(() => logic.cnLessonClean(answer(blocks[0].text), lesson, []), "empty_source");
  codeOf(() => logic.cnLessonClean(answer("This sentence is absent from the source."), lesson, blocks), "invalid_json");
  codeOf(() => logic.cnLessonClean(answer("membrane. Heat moves"), lesson, blocks), "invalid_json");
  const clean = logic.cnLessonClean(answer(blocks[0].text), lesson, blocks);
  assert.deepEqual(JSON.parse(JSON.stringify(clean.evidence.intro[0])), {
    blockId: "s1", materialId: "mat-a", sourceName: "Lecture.pdf", page: 1,
    quote: "Water moves through a porous membrane.",
  });

  const mixed = logic.cnLessonClean({
    intro: ["Water moves through a porous membrane.", "Rejected text."], notes: { t2: "Heat moves through the surrounding fluid." },
    q: [{ q: "Which material moves through a porous membrane?", ans: "t1", opts: ["t2", "t3", "t4"] }],
    evidence: {
      intro: [blocks[0].text, "No such quote exists in the source."],
      notes: { t2: blocks[1].text }, q: [blocks[0].text],
    },
  }, lesson, blocks);
  assert.deepEqual(JSON.parse(JSON.stringify(mixed.intro)), ["Water moves through a porous membrane."]);
  assert.equal(mixed.evidence.intro.length, 1, "rejected AI text must not receive evidence");
  assert.equal(mixed.evidence.notes.t2.materialId, "mat-a");
  assert.equal(mixed.evidence.notes.t2.page, 2);
  assert.equal(mixed.evidence.q[0].quote, blocks[0].text);
  const saved = { intro: mixed.intro.slice() };
  assert.equal(logic.cnBldAttachEvidence(saved, mixed), true);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.evidence)), JSON.parse(JSON.stringify(mixed.evidence)));

  let rejected = null;
  try { rejected = logic.cnLessonClean(answer("This claim has no matching source quotation."), lesson, blocks); }
  catch (error) { assert.equal(error && error.code, "invalid_json"); }
  assert.equal(rejected, null, "a lesson with no accepted citations must fall back");
  const fallback = { st: "ok", outcome: logic.cnBldOutcomeFor("ok", rejected), nt: rejected ? 0 : 1 };
  const aiSuccess = { st: "ok", outcome: logic.cnBldOutcomeFor("ok", mixed), nt: 0 };
  const buildError = { st: "err", outcome: logic.cnBldOutcomeFor("err", null), nt: 0 };
  assert.equal(logic.cnBldOutcome(fallback), "fallback");
  assert.equal(logic.cnBldOutcome(aiSuccess), "ai");
  assert.equal(logic.cnBldOutcome(buildError), "error");
  assert.deepEqual(JSON.parse(JSON.stringify(logic.cnBldStatus(fallback, 0))), { kind: "fallback", pill: "Local fallback", tone: "chk" });
  assert.match(logic.cnBldFallbackReason("truncated_response"), /response was cut short/);
  assert.match(logic.cnBldFallbackReason("response_size_limit"), /exceeded the safe size/);
  assert.match(logic.cnBldFallbackReason("ai_unavailable"), /AI was unavailable/);
  assert.deepEqual(JSON.parse(JSON.stringify(logic.cnBldStatus(aiSuccess, 0))), { kind: "ai", pill: "AI text", tone: "ok" });
  assert.equal(logic.cnBldStatus({ st: "ok", outcome: "partial" }, 0).kind, "partial", "partial v2 generation stays visibly distinct from a complete AI lesson");
  assert.deepEqual(JSON.parse(JSON.stringify(logic.cnBldStatus(buildError, 0))), { kind: "error", pill: "Build error", tone: "bad" });
  assert.equal(logic.cnBldOutcome({ st: "ok", nt: 1 }), "fallback", "legacy fallback records stay distinguishable");
  assert.equal(logic.cnBldOutcome({ st: "err" }), "error", "legacy build errors stay distinguishable");
  assert.equal(logic.cnBldDoc({ ls: { oldFallback: { st: "ok", nt: 1 } } }).ls.oldFallback.outcome, "fallback");
  assert.equal(logic.cnBldDoc({ ls: { oldError: { st: "err" } } }).ls.oldError.outcome, "error");

  const rejectedFallback = { intro: ["Local static copy." ] };
  assert.equal(logic.cnBldAttachEvidence(rejectedFallback, rejected), false);
  assert.equal(Object.hasOwn(rejectedFallback, "evidence"), false, "rejected text must not receive evidence");

  codeOf(() => logic.cnPagesCheck({ kind: "pdf", role: "base", pages: 2 }, [
    { n: 1, text: "Readable extracted material.", em: [] },
  ]), "extract_incomplete");
  const blankPage = logic.cnPagesCheck({ kind: "pdf", role: "base", pages: 1, chars: 0 }, [
    { n: 1, text: "", em: [], diag: logic.cnExtractDiag("", 0, false, true) },
  ]);
  assert.equal(logic.cnPageAudit(blankPage[0], false).empty, true, "an empty page is retained for diagnostics");
  const shortPage = logic.cnPageAudit({ n: 1, text: "A brief note.", diag: logic.cnExtractDiag("A brief note.", 3, false, true) }, true);
  assert.equal(shortPage.short, true, "short text is a warning candidate, not a parse failure");
  const cappedText = "x".repeat(PAGE_TEXT_LIMIT + 1);
  const cappedStored = logic.cnStorePage(3, cappedText, [], { itemLimit: true, visual: true, operatorUnknown: false });
  const cappedMeta = cappedStored.diag;
  assert.equal(cappedStored.text.length, PAGE_TEXT_LIMIT, "stored page text respects the configured cap");
  assert.equal(cappedMeta.charLimit, true);
  assert.equal(cappedMeta.itemLimit, true);
  assert.equal(logic.cnExtractDiag("short", PAGE_ITEM_LIMIT + 1, false, true).itemLimit, true, "item-count limit is detected before slicing");
  assert.equal(logic.cnPageHasVisual({ fnArray: [7] }, { paintImageXObject: 7 }), true);
  assert.equal(logic.cnPageHasVisual({ fnArray: [8] }, { paintImageXObject: 7 }), false);
  assert.equal(logic.cnPageHasVisual({ fnArray: [7] }, {}), null, "unknown operator mappings stay unknown");
  const cappedPage = logic.cnPageAudit({ n: 1, text: cappedText.slice(0, PAGE_TEXT_LIMIT), diag: cappedMeta }, true);
  assert.equal(cappedPage.extractionTruncated, true, "extraction limits remain visible after text is clipped");
  assert.equal(cappedPage.visual, true, "raster image presence is kept as a review signal");

  const syntheticSource = [{ m: { id: "fixture-a", name: "Lesson.txt", role: "base" }, pages: [
    { n: 1, text: "", diag: logic.cnExtractDiag("", 0, false, true) },
    { n: 2, text: "A brief note.", diag: logic.cnExtractDiag("A brief note.", 3, false, true) },
    { n: 3, text: "x".repeat(120), diag: cappedMeta },
  ] }];
  const diag = logic.cnCourseDiagnostics(syntheticSource, [], [{ m: { id: "fixture-a" }, pages: [2] }]);
  assert.deepEqual(JSON.parse(JSON.stringify(diag.source)), { pages: 3, review: 3, empty: 1, short: 1, truncated: 1, visual: 1, unknown: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(diag.outline)), { pages: 3, linked: 1, unlinked: 2, truncated: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(diag.materials[0].warnings)), [[1, "eu"], [2, "s"], [3, "xvu"]]);
  const audit = logic.cnAuditClean({ pages: 3, empty: [1, 1, -1, 4], short: [2], truncated: [3], visual: [], unknown: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(audit)), { pages: 3, empty: [1], short: [2], truncated: [3], visual: [], unknown: [] });
  TEST_LOCALE = "ru";
  const materialHtml = logic.cnMatAuditHtml({ kind: "pdf", status: "ready", audit: { pages: 3, empty: [1], short: [2], truncated: [3], visual: [3], unknown: [] } });
  TEST_LOCALE = "en";
  assert.match(materialHtml, /страница требует проверки/);
  assert.match(materialHtml, /текст мог быть извлечён не полностью/);
  assert.match(materialHtml, /не включено в текстовый разбор/);
  TEST_LOCALE = "ru";
  const summaryHtml = logic.cnDiagHtml({ diagnostics: diag, coverage: { expected: 4, planned: 4, missing: 0 } }, false);
  TEST_LOCALE = "en";
  assert.match(summaryHtml, /требует проверки/);
  assert.match(summaryHtml, /Страница не связана с темой outline/);
  assert.match(summaryHtml, /текст мог быть извлечён не полностью/);
  assert.match(summaryHtml, /Покрытие реестра планом уроков/);
  assert.match(summaryHtml, /не доказывают полноту/);
  await assert.rejects(
    logic.cnPagesOf({ kind: "pdf", role: "base", pages: 1, chunks: ["missing"] }),
    error => error && error.code === "extract_incomplete",
  );
  assert.equal(logic.cnBldErrCode({ code: "extract_incomplete" }), "extract");

  const T = {
    order: ["t1", "t2", "t3"].map((id, i) => ({ id, la: `Term ${id}`, p: 2, src: "f" })),
    pics: new Map(), cut: [], diagnostics: diag, inp: { topics: [{ terms: ["t1", "t2", "t3"] }] },
  };
  const missing = logic.cnPlanBuild({ parts: [{ name: "A", lessons: [{ title: "one", terms: ["t1"] }] }] }, T);
  assert.deepEqual(planIds(missing), ["t1", "t2", "t3"]);
  assert.deepEqual(JSON.parse(JSON.stringify(missing.coverage)), { expected: 3, planned: 3, missing: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(missing.diagnostics.registry)), { expected: 3, planned: 3, missing: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(logic.cnDiagClean(missing.diagnostics).outline)), { pages: 3, linked: 1, unlinked: 2, truncated: 0 });

  const repeated = logic.cnPlanBuild({ parts: [{ name: "A", lessons: [{ title: "one", terms: ["t1", "t1", "t2"] }] }] }, T);
  assert.deepEqual(planIds(repeated), ["t1", "t2", "t3"]);
  assert.deepEqual(JSON.parse(JSON.stringify(repeated.coverage)), { expected: 3, planned: 3, missing: 0 });
  codeOf(() => logic.cnPlanBuild({ parts: [{ name: "A", lessons: [{ terms: ["t1", "stray"] }] }] }, T), "invalid_plan_ids");

  const unresolved = logic.cnKnowledgeVisuals(fixture.material, fixture.pages, 1);
  const toRef = unit => ({ id: unit.id, type: unit.type, label: String(typeof unit.content === "string" ? unit.content : JSON.stringify(unit.content ?? "")).replace(/\s+/g, " ").slice(0, 220),
    sources: unit.sources.map(s => ({ materialId: s.materialId, materialName: fixture.material.name, page: s.page ?? null, blockId: s.blockId, start: s.start ?? null, end: s.end ?? null, kind: s.kind || "", sourceOrder: s.sourceOrder || null })),
    order: { materialIndex: 0, pageIndex: unit.order.pageIndex, block: unit.order.block || 0, offset: unit.order.offset || 0 }, extractionStatus: unit.extractionStatus,
    sourceLinkStatus: unit.sourceLinkStatus, verificationStatus: unit.verificationStatus, eligible: unit.extractionStatus === "extracted" && unit.sourceLinkStatus === "checked" && unit.content !== null });
  const planIndex = knowledge.units.concat(unresolved).map(toRef);
  const eligibleUnits = planIndex.filter(x => x.eligible);
  assert.deepEqual([...new Set(eligibleUnits.map(x => x.type))].sort(), ["definition", "formula", "process", "statement", "table", "term", "visual"]);
  const material = { ...fixture.material, role: "base", kind: "pdf", pages: fixture.pages.length, kstatus: "incomplete", kdocs: ["course-fixture." + fixture.material.id + ".ku1.g0.1"] };
  const sidecars = new Map([[material.kdocs[0], { kind: "course-knowledge", version: 1, materialId: material.id, outlineStatus: "processed", sourceProcessingStatus: "review_required", completeness: "not_proven", issues: ["source_requires_review"], units: knowledge.units.concat(unresolved) }]]);
  context.cnDocData = async (_coll, id) => sidecars.get(id) || null;
  const inputDraft = { id: "course-fixture", name: "Mixed subject", mats: [material] };
  const inputRun = { cancel: false, topics: [{ title: "Introductory topic", pages: [1], m: material }], dt: {}, diagnostics: diag };
  const knowledgePlan = await logic.cnKnowledgePlanInput(inputDraft, inputRun);
  assert.equal(knowledgePlan.kind, "knowledge");
  assert.equal(knowledgePlan.inp.kind, "knowledge-v1");
  assert.equal(knowledgePlan.inp.knowledge.length, eligibleUnits.length, "only extracted, source-linked units are sent as plan candidates");
  assert.equal(knowledgePlan.inp.excluded.length, unresolved.length, "unresolved visual locations stay separate from teachable units");
  assert.equal(knowledgePlan.sourceAssessment.status, "review_required");
  assert.equal(knowledgePlan.sourceAssessment.completeness, "not_proven");
  assert.equal(Object.hasOwn(knowledgePlan.inp.knowledge[0], "text"), false, "the full source block is not copied into the plan payload");
  assert.equal(knowledgePlan.inp.knowledge[0].verificationStatus, "unverified");

  const idsByType = type => eligibleUnits.filter(u => u.type === type).map(u => u.id);
  const groupedRaw = { parts: [{ name: "Foundations", lessons: [
    { title: "Core vocabulary", knowledgeIds: [...idsByType("term"), ...idsByType("definition")], rationale: "Definitions give the learner names and meanings first." },
    { title: "Processes and equations", knowledgeIds: [...idsByType("process"), ...idsByType("formula")], rationale: "The process uses the formula as its next step." },
    { title: "Structured references", knowledgeIds: [...idsByType("table"), ...idsByType("visual")], rationale: "Tables and diagrams consolidate the related concepts." },
    { title: "Source claims", knowledgeIds: idsByType("statement"), rationale: "Review the source claims after learning their context." },
  ] }] };
  const planT = { ...knowledgePlan, diagnostics: diag };
  const builtKnowledgePlan = logic.cnKnowledgePlanBuild(groupedRaw, planT);
  assert.equal(builtKnowledgePlan.planVersion, 2);
  assert.equal(builtKnowledgePlan.planKind, "knowledge");
  assert.equal(builtKnowledgePlan.coverage.expected, eligibleUnits.length);
  assert.equal(builtKnowledgePlan.coverage.planned, eligibleUnits.length);
  assert.equal(builtKnowledgePlan.coverage.missing, 0);
  assert.equal(builtKnowledgePlan.coverage.unresolved, unresolved.length);
  assert.equal(builtKnowledgePlan.parts[0].lessons[1].knowledgeIds.every(id => ["process", "formula"].includes(planIndex.find(x => x.id === id).type)), true, "related process and formula units stay grouped");
  assert.equal(builtKnowledgePlan.parts[0].lessons.some(l => l.reorderedFromSource), true, "pedagogical reorder is retained with its lesson rationale");
  assert.ok(builtKnowledgePlan.parts[0].lessons.every(l => l.rationale.length >= 12));
  const missingRaw = JSON.parse(JSON.stringify(groupedRaw));missingRaw.parts[0].lessons[0].knowledgeIds.pop();
  codeOf(() => logic.cnKnowledgePlanBuild(missingRaw, planT), "knowledge_plan_missing");
  const duplicateRaw = JSON.parse(JSON.stringify(groupedRaw));duplicateRaw.parts[0].lessons[1].knowledgeIds.push(duplicateRaw.parts[0].lessons[0].knowledgeIds[0]);
  codeOf(() => logic.cnKnowledgePlanBuild(duplicateRaw, planT), "knowledge_plan_duplicate");
  const unknownRaw = JSON.parse(JSON.stringify(groupedRaw));unknownRaw.parts[0].lessons[0].knowledgeIds[0] = "foreign-id";
  codeOf(() => logic.cnKnowledgePlanBuild(unknownRaw, planT), "knowledge_plan_unknown");
  const noRationaleRaw = JSON.parse(JSON.stringify(groupedRaw));delete noRationaleRaw.parts[0].lessons[0].rationale;
  codeOf(() => logic.cnKnowledgePlanBuild(noRationaleRaw, planT), "knowledge_plan_invalid");

  const roundTripRaw = JSON.parse(JSON.stringify(builtKnowledgePlan));
  const roundTrip = logic.cnPlanDoc(roundTripRaw);
  assert.equal(roundTrip.planVersion, 2, "new format survives the saved cplan shape and is recognized on reload");
  assert.deepEqual(JSON.parse(JSON.stringify(roundTrip.parts[0].lessons[0].knowledgeIds)), JSON.parse(JSON.stringify(builtKnowledgePlan.parts[0].lessons[0].knowledgeIds)));
  assert.equal(roundTrip.coverage.planned, eligibleUnits.length);
  assert.equal(roundTrip.knowledgeIndex.filter(x => x.eligible).every(x => x.coverageStatus === "planned" && typeof x.lessonId === "string"), true, "per-unit coverage and lesson linkage survive reload");
  assert.equal(roundTrip.knowledgeIndex.filter(x => !x.eligible).every(x => x.coverageStatus === "unresolved" && x.lessonId === null), true, "unresolved visuals retain a separate coverage status");
  const brokenSaved = JSON.parse(JSON.stringify(roundTripRaw));brokenSaved.parts[0].lessons[0].knowledgeIds.pop();
  assert.equal(logic.cnPlanDoc(brokenSaved), null, "reload rejects persisted coverage loss instead of dropping it silently");
  assert.equal(logic.cnPlanDoc({ ...roundTripRaw, planVersion: 3 }), null, "an unknown future plan version is not read as a legacy terms plan");
  const oldSaved = logic.cnPlanDoc({ parts: [{ id: "old-part", name: "Old", lessons: [{ id: "old-lesson", title: "Legacy", terms: [{ id: "t7", la: "Nucleus", p: 1, src: "f" }] }] }] });
  assert.equal(oldSaved.parts[0].lessons[0].terms[0].la, "Nucleus", "legacy terms plan still loads in its old shape");
  assert.equal(oldSaved.planVersion, undefined);
  const v2PlanBar = logic.cnPlanBar({ _plan: roundTrip });
  assert.match(v2PlanBar, /data-cn="build"/, "the plan screen exposes the v2 lesson builder");
  assert.match(v2PlanBar, /Build lessons|Open lessons/);
  TEST_LOCALE = "ru";
  const knowledgeHtml = logic.cnKnowledgePlanInner({ _open: new Set() }, roundTrip);
  TEST_LOCALE = "en";
  assert.match(knowledgeHtml, /не подтверждает полноту исходных материалов/);
  assert.match(knowledgeHtml, /не доказывает смысловую корректность/);
  assert.match(knowledgeHtml, /неразрешённых или исключённых единиц/);

  const persistedPlan = new Map();let planCalls = 0,lessonCalls = 0;
  context.window.CORPUS_WEB = { courseAI: { plan: async () => { planCalls++; return groupedRaw; }, lesson: async () => { lessonCalls++; return {}; } } };
  context.cnWrite = async (coll, id, data) => { persistedPlan.set(coll + "/" + id, JSON.parse(JSON.stringify(data))); };
  const planDraft = { id: "saved-knowledge-plan", name: "Mixed subject", mats: [material], bldAt: 0, courseId: "" };
  const planRun = { cancel: false, ac: { signal: {} }, cache: { plan: null }, spent: 0, dt: {} };
  await logic.cnStepPlan(planDraft, planRun, planT);
  assert.equal(planCalls, 1, "one existing plan call creates the entire KnowledgeUnit plan");
  assert.equal(persistedPlan.has("cplan/saved-knowledge-plan"), true, "the normal cplan document is used");
  const reloaded = logic.cnPlanDoc(persistedPlan.get("cplan/saved-knowledge-plan"));
  assert.equal(reloaded.planVersion, 2);
  assert.equal(logic.cnKnowledgePlanBlocked(reloaded), true);
  assert.equal(logic.cnBldList({ _plan: reloaded }).length, reloaded.parts.flatMap(p => p.lessons).length, "v2 lessons with knowledgeIds enter the new builder queue");
  const selectedIds = eligibleUnits.map(x => x.id);
  const allPlan = JSON.parse(JSON.stringify(reloaded)), allLesson = { id: "stage-c-all", title: "Mixed subject", knowledgeIds: selectedIds };
  allPlan.parts = [{ id: "all-part", name: "All types", lessons: [allLesson] }];
  allPlan.knowledgeIndex.filter(x => x.eligible).forEach(x => { x.coverageStatus = "planned"; x.lessonId = allLesson.id; });
  const lessonDraft = { id: inputDraft.id, mats: [material], _plan: allPlan };
  context.cnKnowledgeOf = async () => ({ status: "incomplete", docs: sidecars.get(material.kdocs[0]) ? [sidecars.get(material.kdocs[0])] : [], units: knowledge.units.concat(unresolved) });
  context.cnPagesOf = async () => fixture.pages;
  const prepared = await logic.cnKnowledgeLessonPrepare(lessonDraft, {}, { l: allLesson, p: allPlan.parts[0], pi: 0, li: 0 });
  assert.equal(prepared.input.kind, "knowledge-v1");
  assert.equal(prepared.input.units.length, selectedIds.length);
  assert.equal(prepared.sourceStatus, "review_required", "an incomplete source registry remains visible in lesson metadata");
  assert.equal(prepared.input.sourceStatus.completeness, "not_proven");
  assert.ok(prepared.blocks.length > 0 && prepared.blocks.every(x => x.text.length <= logic.CN_KLESSON.blockChars));
  const allTypes = new Set(prepared.units.map(x => x.type));
  assert.deepEqual([...allTypes].sort(), ["definition", "formula", "process", "statement", "table", "term", "visual"], "one universal lesson can carry all supported unit types");
  const processUnit = prepared.units.find(x => x.type === "process");
  assert.deepEqual(JSON.parse(JSON.stringify(processUnit.content.steps)), ["Open the valve.", "Measure the flow.", "Record the result."], "process steps retain source order");
  const formulaUnit = prepared.units.find(x => x.type === "formula");
  assert.equal(formulaUnit.content.expression, "v = d / t");
  assert.deepEqual(JSON.parse(JSON.stringify(formulaUnit.content.variables.map(x => [x.symbol, x.unit]))), [["v", "m/s"], ["d", "m"], ["t", "s"]]);
  const tableUnit = prepared.units.find(x => x.type === "table");
  assert.deepEqual(JSON.parse(JSON.stringify(tableUnit.content.rows)), [["solid", "S"], ["liquid", "L"]]);
  const visualUnit = prepared.units.find(x => x.type === "visual");
  assert.equal(logic.cnKnowledgeVisualRef(lessonDraft, prepared).ref, "g:fixture-mixed-source:6", "a resolved visual uses the saved source page");
  const unresolvedVisual = logic.cnKnowledgeVisualRef(lessonDraft, { units: [], warnings: [{ code: "visual_unresolved", id: "unresolved-image", sources: [{ materialId: material.id, page: 9 }] }] });
  assert.deepEqual(JSON.parse(JSON.stringify(unresolvedVisual)), { ref: "g:fixture-mixed-source:9", unitId: "unresolved-image", unresolved: true }, "an unresolved visual points to its source page without inventing a caption");
  TEST_LOCALE = "ru";
  const unresolvedHtml = logic.cnKnowledgeLessonStatusHtml({ sourceStatus: "review_required", visualStatus: "source_page_shown_unresolved", sourceWarnings: [{ code: "visual_unresolved", sources: [{ materialId: material.id, materialName: material.name, page: 9 }] }] });
  TEST_LOCALE = "en";
  assert.match(unresolvedHtml, /Визуальный объект требует проверки/);
  assert.match(unresolvedHtml, /Полнота исходного документа не подтверждена/);
  assert.match(unresolvedHtml, /не доказывают его смысловую корректность/);

  const savedPagesOf = context.cnPagesOf;
  context.cnPagesOf = async () => fixture.pages.filter(p => p.n !== processUnit.sources[0].page);
  await assert.rejects(logic.cnKnowledgeLessonPrepare(lessonDraft, {}, { l: allLesson }), e => e && e.code === "missing_source");
  context.cnPagesOf = async () => fixture.pages.map(p => p.n === 1 ? { ...p, text: p.text + "x".repeat(6001) } : p);
  await assert.rejects(logic.cnKnowledgeLessonPrepare(lessonDraft, {}, { l: allLesson }), e => e && e.code === "lesson_limit", "oversized pages stop explicitly instead of slicing source text");
  context.cnPagesOf = savedPagesOf;

  const quoteFor = unit => {
    const block = prepared.blocks.find(x => unit.sourceBlockIds.includes(x.id));
    assert.ok(block, "each assigned unit maps to a listed source block");
    return { blockId: block.id, quote: block.text.slice(0, Math.min(220, block.text.length)) };
  };
  const mockLesson = {
    intro: [{ text: prepared.blocks[0].text.slice(0, 180), evidence: [{ blockId: prepared.blocks[0].id, quote: prepared.blocks[0].text.slice(0, 180) }] }],
    units: prepared.units.map(u => ({ id: u.id, claims: [{ text: logic.cnKnowledgeContentText(u.type, u.content).slice(0, 500), evidence: [quoteFor(u)] }] })),
  };
  let routedLessonCalls = 0;
  const oneCall = await logic.cnKnowledgeLessonCall(prepared, async input => { routedLessonCalls++; assert.equal(input.units.length, prepared.units.length); return mockLesson; });
  assert.equal(routedLessonCalls, 1, "one existing lesson API call covers the whole KnowledgeUnit set, not one call per unit");
  assert.equal(oneCall.result.generationStatus, "ai");
  assert.equal(oneCall.result.units.size, prepared.units.length);
  const badQuote = JSON.parse(JSON.stringify(mockLesson));badQuote.units[0].claims[0].evidence[0].quote = "a citation that does not occur in any source block";
  const badKnowledge = logic.cnKnowledgeLessonClean(badQuote, prepared);
  assert.equal(badKnowledge.generationStatus, "partial");
  assert.equal(badKnowledge.units.get(prepared.units[0].id).length, 0, "invalid quote is rejected without fallback citation");
  assert.ok(badKnowledge.issues.includes("claim_without_valid_citation"));
  const noClaims = logic.cnKnowledgeLessonClean({}, prepared);
  assert.equal(noClaims.generationStatus, "fallback", "a response with no validated claims is explicitly a fallback");
  const extraClaims = JSON.parse(JSON.stringify(mockLesson));extraClaims.units[0].claims = Array.from({ length: 8 }, () => extraClaims.units[0].claims[0]);
  const limitedClaims = logic.cnKnowledgeLessonClean(extraClaims, prepared);
  assert.equal(limitedClaims.generationStatus, "partial");
  assert.ok(limitedClaims.issues.includes("claim_limit"), "claims beyond the response budget are reported as partial, not hidden");
  const unknownAnswer = JSON.parse(JSON.stringify(mockLesson));unknownAnswer.units.push({ id: "foreign-unit", claims: [{ text: "unsupported", evidence: [quoteFor(prepared.units[0])] }] });
  const unknownAnswerClean = logic.cnKnowledgeLessonClean(unknownAnswer, prepared);
  assert.equal(unknownAnswerClean.generationStatus, "partial");
  assert.ok(unknownAnswerClean.issues.includes("unknown_unit_output"));
  const oversizedAnswer = logic.cnKnowledgeLessonClean({ ...mockLesson, padding: "x".repeat(logic.CN_KLESSON.outputChars) }, prepared);
  assert.equal(oversizedAnswer.generationStatus, "fallback");
  assert.ok(oversizedAnswer.issues.includes("response_size_limit"), "oversized model output is not accepted as complete");
  const partialRaw = JSON.parse(JSON.stringify(mockLesson));partialRaw.units.pop();
  const partial = logic.cnKnowledgeLessonClean(partialRaw, prepared);
  assert.equal(partial.generationStatus, "partial");
  assert.equal(partial.units.size, prepared.units.length - 1, "missing AI unit remains missing from accepted AI text and is rendered from the registry fallback");
  assert.ok(prepared.units.some(x => !partial.units.has(x.id)), "the assigned original KnowledgeUnit remains available for local fallback");

  const savedLesson = { lessonVersion: 2, knowledgeIds: prepared.units.map(x => x.id), generationStatus: partial.generationStatus, sourceStatus: prepared.sourceStatus, sourceCompleteness: "not_proven", sourceWarnings: prepared.warnings,
    visualStatus: "source_page_shown_unresolved", knowledgeIntroEvidence: partial.intro,
    knowledgeUnits: prepared.units.map(u => ({ id: u.id, type: u.type, content: u.content, sources: u.sources, extractionStatus: "extracted", sourceLinkStatus: "checked", verificationStatus: "unverified", generationStatus: partial.units.has(u.id) ? "ai" : "fallback", claims: partial.units.get(u.id) || [] })) };
  const persistedLesson = logic.cnKnowledgeLessonMetaClean(savedLesson, false);
  assert.ok(persistedLesson, "v2 lesson metadata passes the existing plate sanitizer");
  assert.deepEqual(JSON.parse(JSON.stringify(persistedLesson.knowledgeIds)), JSON.parse(JSON.stringify(selectedIds)));
  assert.equal(persistedLesson.knowledgeUnits.length, selectedIds.length);
  assert.equal(persistedLesson.knowledgeUnits.some(x => x.generationStatus === "fallback"), true);
  assert.equal(persistedLesson.sourceCompleteness, "not_proven");
  const importedLesson = logic.cnKnowledgeLessonMetaClean(persistedLesson, true);
  assert.equal(importedLesson.sourceStatus, "review_required", "reloaded exports without source files require a source review");
  assert.ok(importedLesson.sourceWarnings.some(x => x.code === "source_refs_not_included"));
  assert.equal(importedLesson.knowledgeUnits.flatMap(x => x.claims).every(c => c.evidence.length > 0 && c.evidence.every(e => typeof e.quote === "string" && e.quote.length > 0)), true, "each accepted AI claim keeps its own source citations after reload");
  const snapshotIds = new Set(prepared.units.flatMap(u => u.sources.map(s => s.blockId)));
  const sourceSnapshots = fixtureBlocks.filter(b => snapshotIds.has(b.id)).map(b => ({ id: b.id, materialId: b.materialId, sourceName: fixture.material.name, page: b.page, start: b.start, end: b.end, order: { pageIndex: b.pageIndex, block: b.order }, text: b.text }));
  const exportedWithSources = logic.cnKnowledgeLessonMetaClean({ ...savedLesson, sourceBlocks: sourceSnapshots, sourceSnapshotStatus: "complete" }, false);
  assert.ok(exportedWithSources && exportedWithSources.sourceSnapshotStatus === "complete", "export keeps validated snapshots for referenced source blocks");
  const importedWithSources = logic.cnKnowledgeLessonMetaClean(exportedWithSources, true);
  assert.equal(importedWithSources.sourceSnapshotStatus, "complete", "import preserves complete source snapshots");
  assert.ok(importedWithSources.sourceWarnings.some(x => x.code === "source_files_not_included"), "original files remain explicitly absent after import");
  for (const unit of importedWithSources.knowledgeUnits) for (const ref of unit.sources) {
    const snapshot = importedWithSources.sourceBlocks.find(b => b.id === ref.blockId && b.materialId === ref.materialId);
    assert.ok(snapshot && snapshot.page === ref.page && snapshot.text.slice(ref.start - snapshot.start, ref.end - snapshot.start), `source reference ${ref.blockId} resolves after import`);
  }
  const brokenSnapshot = logic.cnKnowledgeLessonMetaClean({ ...exportedWithSources, sourceBlocks: [] }, true);
  assert.equal(brokenSnapshot.sourceSnapshotStatus, "missing", "a missing snapshot cannot be labeled complete");
  assert.ok(brokenSnapshot.sourceWarnings.some(x => x.code === "source_refs_not_included"));
  assert.match(logic.cnKnowledgeUnitInfoHtml(importedWithSources, { knowledgeId: importedWithSources.knowledgeIds[0] }), /Saved source excerpts/);

  const savedState = { folders: [], decks: [], plates: [], cards: [] };
  let generatedCalls = 0, generatedId = 0;
  const buildSandbox = vm.createContext({
    CN_KLESSON: logic.CN_KLESSON, CN_BLD: { lsStep: 100, ptStep: 10000 }, LANG: "en", S: { ...savedState, assets: null }, window: { CORPUS_WEB: { courseAI: { lesson: async (_lang, input) => { generatedCalls++; assert.equal(input.units.length, prepared.units.length); return mockLesson; } } } },
    T3: (_ru, en) => en, cnKnowledgeLessonPrepare: async () => JSON.parse(JSON.stringify(prepared)),
    cnKnowledgeVisualRef: () => null, cnKnowledgeLessonCall: async (p, invoke) => { const raw = await invoke(p.input); return { raw, result: logic.cnKnowledgeLessonClean(raw, p) }; },
    cnUsageAdd: () => {}, cnSpend: () => {}, cnBPaint: () => {}, cnCourseName: () => "Synthetic course", cnLangOk: () => "en",
    newId: prefix => prefix + "-stagec-" + (++generatedId), persist: () => {}, cnSave: () => {},
    folderById: id => buildSandbox.S.folders.find(x => x.id === id), deckById: id => buildSandbox.S.decks.find(x => x.id === id),
    decksInFolder: id => buildSandbox.S.decks.filter(x => x.folderId === id),
    cnBldRecord: (d, _b, lesson, record) => { d._plan.bld.ls[lesson.id] = record; return null; },
    cleanLessonCard: () => {}, normCard: card => card, cardsOfPlate: id => buildSandbox.S.cards.filter(c => c.plateId === id),
    removeCard: id => { buildSandbox.S.cards = buildSandbox.S.cards.filter(c => c.id !== id); },
    dropPlate: id => { buildSandbox.S.plates = buildSandbox.S.plates.filter(p => p.id !== id); },
    packAdd: cards => buildSandbox.S.cards.push(...cards),
    cnKnowledgeClaimText: logic.cnKnowledgeClaimText, cnKnowledgeFallbackText: logic.cnKnowledgeFallbackText, cnKnowledgeLessonLabel: logic.cnKnowledgeLessonLabel,
  });
  vm.runInContext(between("async function cnBldKnowledgeOne(", "\nasync function cnBldLegacyOne") + "\nglobalThis.__buildKnowledgeOne=cnBldKnowledgeOne;", buildSandbox);
  const buildDoc = { id: "saved-lesson-course", courseId: "", _plan: { at: 123, bld: { base: 123, parts: {}, ls: {} }, parts: allPlan.parts } };
  const buildState = { cancel: false, ac: { signal: {} }, dt: {}, spent: 0, i: 0 };
  await buildSandbox.__buildKnowledgeOne(buildDoc, buildState, { l: allLesson, p: allPlan.parts[0], pi: 0, li: 0 });
  assert.equal(generatedCalls, 1, "the actual v2 builder makes one lesson call for all assigned units");
  await buildSandbox.__buildKnowledgeOne(buildDoc, buildState, { l: allLesson, p: allPlan.parts[0], pi: 0, li: 0 });
  assert.equal(generatedCalls, 1, "a direct repeat of the ready v2 builder makes no second AI call");
  assert.equal(buildSandbox.S.plates.length, 1);
  const savedPlate = buildSandbox.S.plates[0];
  assert.equal(savedPlate.lessonVersion, 2);
  assert.equal(savedPlate.generationStatus, "ai");
  assert.deepEqual(JSON.parse(JSON.stringify(savedPlate.knowledgeIds)), JSON.parse(JSON.stringify(selectedIds)));
  assert.equal(savedPlate.knowledgeUnits.length, selectedIds.length);
  assert.ok(savedPlate.knowledgeUnits.every(x => x.verificationStatus === "unverified"));
  const reloadedSavedPlate = logic.cnKnowledgeLessonMetaClean(savedPlate, false);
  assert.ok(reloadedSavedPlate && reloadedSavedPlate.knowledgeUnits.length === selectedIds.length, "a generated plate reloads with all KnowledgeUnit IDs and evidence metadata");
  const displayedUnit = savedPlate.knowledgeUnits.find(x => x.claims.length), displayCard = buildSandbox.S.cards.find(c => c.knowledgeId === displayedUnit.id && c.plateId === savedPlate.id);
  const unitInfoHtml = logic.cnKnowledgeUnitInfoHtml(savedPlate, displayCard);
  assert.ok(unitInfoHtml.includes(displayedUnit.claims[0].text) && unitInfoHtml.includes(displayedUnit.claims[0].evidence[0].quote), "the reader shows each AI claim beside its own evidence");
  const introHtml = logic.cnKnowledgeLessonStatusHtml(savedPlate);
  assert.ok(introHtml.includes(savedPlate.knowledgeIntroEvidence[0].text) && introHtml.includes(savedPlate.knowledgeIntroEvidence[0].evidence[0].quote), "intro text and citations remain paired in the reader");
  buildSandbox.window.CORPUS_WEB.courseAI.lesson = async (_lang, input) => { generatedCalls++; assert.equal(input.units.length, prepared.units.length); return partialRaw; };
  const partialBuildDoc = { id: "saved-partial-course", courseId: buildDoc.courseId, _plan: { at: 456, bld: { base: 456, parts: {}, ls: {} }, parts: allPlan.parts } };
  await buildSandbox.__buildKnowledgeOne(partialBuildDoc, { cancel: false, ac: { signal: {} }, dt: {}, spent: 0, i: 0 }, { l: allLesson, p: allPlan.parts[0], pi: 0, li: 0 });
  assert.equal(generatedCalls, 2);
  const partialPlate = buildSandbox.S.plates.find(p => p.cb.startsWith("saved-partial-course|"));
  assert.equal(partialPlate.generationStatus, "partial", "partially supported lesson is saved with an explicit partial status");
  assert.equal(partialPlate.knowledgeUnits.length, selectedIds.length, "partial output does not drop assigned KnowledgeUnits");
  const fallbackUnit = partialPlate.knowledgeUnits.find(x => x.generationStatus === "fallback");
  assert.ok(fallbackUnit && fallbackUnit.claims.length === 0, "fallback source content has no fabricated AI evidence");
  const fallbackCard = buildSandbox.S.cards.find(c => c.knowledgeId === fallbackUnit.id && c.plateId === partialPlate.id);
  assert.match(fallbackCard.note, /No AI explanation was saved/);
  const beforeMissingSource = generatedCalls;
  buildSandbox.cnKnowledgeLessonPrepare = async () => { throw { code: "missing_source" }; };
  const errorBuildDoc = { id: "missing-source-course", courseId: buildDoc.courseId, _plan: { at: 789, bld: { base: 789, parts: {}, ls: {} }, parts: allPlan.parts } };
  await buildSandbox.__buildKnowledgeOne(errorBuildDoc, { cancel: false, ac: { signal: {} }, dt: {}, spent: 0, i: 0 }, { l: allLesson, p: allPlan.parts[0], pi: 0, li: 0 });
  assert.equal(generatedCalls, beforeMissingSource, "an unavailable source blocks the AI call");
  assert.equal(errorBuildDoc._plan.bld.ls[allLesson.id].st, "err");
  assert.equal(errorBuildDoc._plan.bld.ls[allLesson.id].err, "missing_source");

  // Candidate selection stays separate from rendering and recognition.
  buildSandbox.cnKnowledgeLessonPrepare = async () => ({ ...JSON.parse(JSON.stringify(prepared)), warnings: [{ code: "visual_unresolved" }, { code: "visual_caption_candidate" }] });
  buildSandbox.cnKnowledgeVisualRef = () => ({ ref: "g:figures:5", unresolved: true });
  buildSandbox.cnBldPic = async () => ({ blob: "mock-image", w: 100, h: 100, page: 5, name: "Original source page" });
  buildSandbox.akUpload = async () => ({ id: "mock-asset" });
  buildSandbox.lessonPage = Number.isSafeInteger;
  buildSandbox.S.assets = { delete: async () => {} };
  buildSandbox.window.CORPUS_WEB.courseAI.lesson = async () => { generatedCalls++; return mockLesson; };
  const visualDraft = { id: "visual-candidate-course", courseId: buildDoc.courseId, _plan: { at: 790, bld: { base: 790, parts: {}, ls: {} }, parts: allPlan.parts } };
  await buildSandbox.__buildKnowledgeOne(visualDraft, { cancel: false, ac: { signal: {} }, dt: {} }, { l: allLesson, p: allPlan.parts[0], pi: 0, li: 0 });
  const visualPlate = buildSandbox.S.plates.find(p => p.cb.startsWith(visualDraft.id + "|"));
  assert.equal(visualPlate.assetId, "mock-asset");
  assert.equal(visualPlate.page, 5);
  assert.equal(visualPlate.visualStatus, "source_page_shown_unresolved");
  assert.ok(visualPlate.sourceWarnings.some(w => w.code === "visual_caption_candidate"));
  assert.ok(logic.cnKnowledgeLessonMetaClean(visualPlate).sourceWarnings.some(w => w.code === "visual_caption_candidate"), "candidate uncertainty survives reload");
  assert.equal(generatedCalls, beforeMissingSource + 1, "rendering the source page adds no AI/vision call");
  buildSandbox.cnBldPic = async () => { throw { code: "orig" }; };
  const unavailableVisualDraft = { id: "unavailable-visual-course", courseId: buildDoc.courseId, _plan: { at: 791, bld: { base: 791, parts: {}, ls: {} }, parts: allPlan.parts } };
  await buildSandbox.__buildKnowledgeOne(unavailableVisualDraft, { cancel: false, ac: { signal: {} }, dt: {} }, { l: allLesson, p: allPlan.parts[0], pi: 0, li: 0 });
  const unavailablePlate = buildSandbox.S.plates.find(p => p.cb.startsWith(unavailableVisualDraft.id + "|"));
  assert.equal(unavailablePlate.visualStatus, "source_object_unavailable");
  assert.equal(unavailablePlate.assetId, undefined);
  assert.ok(unavailablePlate.sourceWarnings.some(w => w.code === "visual_unavailable"));
  assert.equal(generatedCalls, beforeMissingSource + 2);

  const route = [];
  await logic.cnBldRoute({ _plan: reloaded }, () => route.push("knowledge-v2"), () => route.push("legacy-v1"));
  await logic.cnBldRoute({ _plan: oldSaved }, () => route.push("knowledge-v2"), () => route.push("legacy-v1"));
  assert.deepEqual(route, ["knowledge-v2", "legacy-v1"], "version 1 remains routed to the existing legacy generator");
  assert.match(source.slice(source.indexOf("async function cnBldOne("), source.indexOf("function cnCourseName(")), /cnBldRoute\(d,\(\)=>cnBldKnowledgeOne\(d,b,it\),\(\)=>cnBldLegacyOne\(d,b,it\)\)/);
  const legacyBuilder = source.slice(source.indexOf("async function cnBldLegacyOne("), source.indexOf("async function cnBldOne("));
  assert.match(legacyBuilder, /cnBldPic\(d,b,l\.pic,l\.terms\)/);
  assert.match(legacyBuilder, /cnBldText\(d,b,l\)/);
  assert.match(legacyBuilder, /cnBldCommit\(d,b,it/);
  assert.match(source.slice(source.indexOf("async function cnBldRefreshStart("), source.indexOf("async function cnBldRefreshRun(")), /cnKnowledgePlanBlocked/);
  assert.match(source.slice(source.indexOf("async function cnBldKnowledgeOne("), source.indexOf("async function cnBldLegacyOne(")), /cnKnowledgeLessonCall\(prepared,input=>W\.courseAI\.lesson\(LANG,input/);
  assert.match(source.slice(source.indexOf("async function buildExport("), source.indexOf("async function saveExport(")), /cnKnowledgeLessonMetaClean\(p\)/, "existing export path carries v2 lesson metadata");
  assert.match(source.slice(source.indexOf("async function buildExport("), source.indexOf("async function saveExport(")), /cnKnowledgeExportSourceBlocks\(p\)/, "v2 export resolves and embeds referenced source excerpts");
  assert.match(source.slice(source.indexOf("function cleanLessonPlate("), source.indexOf("function cleanLessonCard(")), /cnKnowledgeLessonMetaClean\(sp,true\)/, "existing import path reloads v2 metadata and marks source files for review");
  assert.match(source, /const CONTENT_KEYS=\[[^\]]*'knowledgeId'/, "exported v2 cards retain their KnowledgeUnit linkage");
  assert.equal(lessonCalls, 0, "offline generation helper tests do not call a real or mocked remote API");
  assert.match(source.slice(source.indexOf("const CN_KLESSON="), source.indexOf("function cnKnowledgeContentText(")), /outputChars:40000/);
  assert.match(serverSource, /LS_MAX_TOKENS = 4000, LS_KNOWLEDGE_MAX_TOKENS = 8000/);
  assert.match(serverSource, /if \(input\?\.kind === "knowledge-v1"\) return/);
  assert.match(serverSource, /u\.content === null \|\| u\.content === undefined \|\| JSON\.stringify\(u\.content\)\.length > 3000/);
  assert.match(source, /truncated_response/);
  const writesBeforeInvalid = persistedPlan.size;
  context.window.CORPUS_WEB.courseAI.plan = async () => { planCalls++; return missingRaw; };
  const invalidPlanRun = { cancel: false, ac: { signal: {} }, cache: { plan: null }, spent: 0, dt: {} };
  await assert.rejects(logic.cnStepPlan({ id: "invalid-knowledge-plan", name: "Mixed subject", mats: [material] }, invalidPlanRun, planT), error => error && error.code === "knowledge_plan_missing");
  assert.equal(persistedPlan.size, writesBeforeInvalid, "an incomplete AI answer is not saved or converted to fallback lessons");
  assert.equal(invalidPlanRun.cache.plan, null, "invalid cached plan data is cleared before retry");
  const promptStart = serverSource.indexOf("function planPrompt("), promptEnd = serverSource.indexOf("// ---- the lesson task", promptStart);
  assert.notEqual(promptStart, -1);assert.ok(promptEnd > promptStart);
  const promptSource = serverSource.slice(promptStart, promptEnd).replace("function planPrompt(lang: string, input: any): string", "function planPrompt(lang, input)");
  const promptContext = vm.createContext({ LANG_NAME: { ru: "Russian", en: "English", et: "Estonian" } });
  vm.runInContext(promptSource + "\nglobalThis.__planPrompt=planPrompt;", promptContext);
  const universalPrompt = promptContext.__planPrompt("en", { kind: "knowledge-v1", knowledge: [{ id: "ku1_x", type: "definition" }], excluded: [] });
  assert.match(universalPrompt, /any subject and language/);
  assert.match(universalPrompt, /knowledgeIds/);
  assert.match(universalPrompt, /rationale/);
  assert.match(universalPrompt, /excluded/);
  assert.doesNotMatch(universalPrompt, /human anatomy|Latin anatomical names/);
  const legacyPrompt = promptContext.__planPrompt("en", { name: "legacy", terms: [{ id: "t1", la: "Nucleus", p: 1 }] });
  assert.match(legacyPrompt, /human anatomy/);
  assert.match(serverSource, /if \(inp\.kind === "knowledge-v1"\) return checkKnowledgePlanInput\(inp\)/);
  assert.match(serverSource, /PL_KNOWLEDGE = 1200/);
  assert.match(serverSource, /PL_MAX_TOKENS = 8000/);
  if (typeof stripTypeScriptTypes === "function") {
    const serverHelpers = betweenServer("const PL_TERMS =", "function checkOutline(");
    const serverCheck = betweenServer("function checkPlan(", "function planPrompt(");
    const checkerContext = vm.createContext({ LANG_NAME: { ru: "Russian", en: "English", et: "Estonian" } });
    vm.runInContext(stripTypeScriptTypes(serverHelpers + "\n" + serverCheck) + "\nglobalThis.__checkPlan=checkPlan;", checkerContext);
    const validBody = { purpose: "course", lang: "en", input: knowledgePlan.inp };
    assert.equal(checkerContext.__checkPlan(validBody), "", "the Deno input validator accepts the generated, source-linked knowledge payload");
    const badRef = JSON.parse(JSON.stringify(validBody));badRef.input.knowledge[0].sources[0].materialId = "unknown-material";
    assert.match(checkerContext.__checkPlan(badRef), /unknown material/);
    const badType = JSON.parse(JSON.stringify(validBody));badType.input.knowledge[0].type = "claim";
    assert.match(checkerContext.__checkPlan(badType), /invalid typed unit/);
    const legacyBody = { purpose: "course", lang: "en", input: { name: "legacy", topics: [], terms: [{ id: "t1", la: "Nucleus", p: 1 }], photos: [], pages: [], exam: [] } };
    assert.equal(checkerContext.__checkPlan(legacyBody), "", "server validation continues to accept the old terms-plan request");

    const lessonCode = betweenServer("const LS_TERMS =", "function lessonPrompt(") + betweenServer("function lessonPrompt(", "// One call to the Claude Messages API");
    const lessonPrelude = "const PL_STR=300,PL_Q=600,LANG_NAME={ru:'Russian',en:'English',et:'Estonian'};" +
      "const isObj=v=>!!v&&typeof v==='object'&&!Array.isArray(v),isStr=(v,n)=>typeof v==='string'&&v.length<=n,isId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(v);" +
      "function onlyKeys(o,keys){return Object.keys(o).every(k=>keys.includes(k));}";
    const lessonContext = vm.createContext({});
    vm.runInContext(stripTypeScriptTypes(lessonPrelude + lessonCode) + "\nglobalThis.__checkLesson=checkLesson;globalThis.__lessonPrompt=lessonPrompt;", lessonContext);
    assert.equal(lessonContext.__checkLesson({ purpose: "course", lang: "en", input: prepared.input }), "", "server validates the v2 lesson source payload offline");
    const missingContent = JSON.parse(JSON.stringify(prepared.input));missingContent.units[0].content = undefined;
    assert.match(lessonContext.__checkLesson({ purpose: "course", lang: "en", input: missingContent }), /content is missing or too large/, "missing source content returns a validation error rather than throwing");
    const badKnowledgeRef = JSON.parse(JSON.stringify(prepared.input));badKnowledgeRef.units[0].sourceBlockIds = ["unknown-block"];
    assert.match(lessonContext.__checkLesson({ purpose: "course", lang: "en", input: badKnowledgeRef }), /invalid typed unit/);
    const legacyLesson = { purpose: "course", lang: "en", input: { title: "Old", terms: [{ id: "t1", la: "Nucleus", p: 1 }] } };
    assert.equal(lessonContext.__checkLesson(legacyLesson), "", "the same endpoint still accepts the legacy v1 lesson format");
    const universalLessonPrompt = lessonContext.__lessonPrompt("en", prepared.input);
    assert.match(universalLessonPrompt, /learner starting from the basics/);
    assert.match(universalLessonPrompt, /exact source blocks linked to them/);
    assert.doesNotMatch(universalLessonPrompt, /human anatomy|Latin names/);
    const oldLessonPrompt = lessonContext.__lessonPrompt("en", legacyLesson.input);
    assert.match(oldLessonPrompt, /human anatomy/);
  }

  console.log(`KNOWLEDGE PLAN MOCK: ${eligibleUnits.length} units, input ${JSON.stringify(knowledgePlan.inp).length} chars, response ${JSON.stringify(groupedRaw).length} chars; 1 existing plan call on success (server output cap: 8000 tokens)`);
  console.log(`KNOWLEDGE LESSON MOCK: ${prepared.units.length} units, ${prepared.blocks.length} source blocks, input ${prepared.inputChars} chars, response ${JSON.stringify(mockLesson).length} chars; one mocked lesson call per built lesson (server output cap: 8000 tokens; no paid calls)`);
  console.log("COURSE LOGIC TESTS PASSED (source diagnostics, citations/evidence, legacy terms compatibility, KnowledgeUnit discovery/planning/coverage, v2 lesson sourcing/validation/fallback/save-load, v1/v2 routing, one call per lesson)");
}

module.exports = { logic, context, between, betweenServer, source, serverSource };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
