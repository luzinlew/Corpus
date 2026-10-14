#!/usr/bin/env node
"use strict";
// Offline discovery audit: production parsers/outline pipeline + saved responses.
// Generic fixture expectations and real witnesses are test data, never product rules.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const { logic, context, between, betweenServer, source } = require("./course_logic_test.cjs");
const clone = x => JSON.parse(JSON.stringify(x));
const norm = x => String(x).replace(/\s+/gu, " ").toLowerCase();
const code = betweenServer("const OL_PAGES =", "function checkPlan(");
const edge = vm.createContext({ LANG_NAME: { en: "English", ru: "Russian", et: "Estonian" } });
vm.runInContext(stripTypeScriptTypes(code) + "\nglobalThis.h={checkOutline,outlinePrompt};", edge);
vm.runInContext(between("function cnOutRequireEmphasis(", "\nfunction cnKnowledgeOutlineInput(") + "\n" +
  between("async function cnStepOutline(", "\n/* (в) вопросы экзамена */"), context);
const stepOutline = vm.runInContext("cnStepOutline", context);

function promptTests(input) {
  assert.equal(edge.h.checkOutline({ purpose: "course", lang: "en", input }), "");
  const prompt = edge.h.outlinePrompt("en", input);
  assert.match(prompt, /knowledge registry first/);
  assert.match(prompt, /A term does not need a definition or explanatory prose/);
  assert.match(prompt, /Visual knowledge only:/);
  assert.doesNotMatch(prompt, /definitions, claims, facts, ordered actions\/processes, formulas, structured tables and visual objects only when/);
  assert.match(prompt, /citing the actual block containing each item/);
  assert.match(prompt, /not merely in topics or legacy terms/);
  assert.match(prompt, /knowledge_limited:true/);
  assert.ok(prompt.indexOf("For knowledge,") < prompt.indexOf("For an anatomy source,"), "legacy instructions must not lead discovery");
  const example = JSON.parse(prompt.match(/Reply only as JSON with (\{[^\n]+\})\. No comments/)[1]);
  assert.deepEqual(Object.keys(example), ["knowledge", "knowledge_limited", "topics"]);
  assert.deepEqual(Object.keys(example.knowledge[0]), ["type", "content", "sources"]);
  assert.deepEqual(JSON.parse(prompt.split("INPUT:\n")[1]), clone(input), "prompt must preserve the exact validated payload");
  assert.match(source, /CN_KNOWLEDGE_PROMPT_VERSION=3/);
  assert.match(code, /OL_MAX_TOKENS = 4096/);
  assert.match(code, /up to 50 distinct source-supported units/);
  return prompt;
}

function syntheticTests() {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "course_discovery_lists.json"), "utf8"));
  const blocks = logic.cnKnowledgeBlocks(fixture.material, fixture.pages);
  const input = logic.cnKnowledgeOutlineInput(fixture.material, { items: fixture.pages.map(p => ({ ...p, blocks: blocks.filter(b => b.page === p.n) })) });
  promptTests(input);
  const raw = { knowledge: fixture.expected.map(x => ({ type: x.type, content: x.content, sources: [{ block_id: blocks.find(b => b.page === x.page && b.text.includes(x.quote)).id, quote: x.quote }] })),
    knowledge_limited: false, topics: fixture.pages.map(p => ({ title: p.em[0], pages: [p.n], terms: [] })) };
  const cleaned = logic.cnKnowledgeClean(raw, blocks, fixture.material), again = logic.cnKnowledgeClean(clone(raw), blocks, fixture.material);
  assert.equal(cleaned.rejected, 0);
  assert.equal(cleaned.units.length, fixture.expected.length);
  assert.deepEqual(clone(cleaned.units), clone(again.units), "IDs/ordering must be stable for unchanged inputs");
  fixture.expected.forEach((x, i) => {
    const u = cleaned.units[i];
    assert.equal(u.type, x.type); assert.equal(u.content, x.content);
    assert.equal(u.sources[0].page, x.page); assert.equal(u.sources[0].materialId, fixture.material.id);
    const b = blocks.find(b => b.id === u.sources[0].blockId);
    assert.equal(b.text.slice(u.sources[0].start - b.start, u.sources[0].end - b.start), x.quote);
    assert.equal(u.verificationStatus, "unverified");
  });
  const before = JSON.stringify(raw), topics = logic.cnOutClean(raw, fixture.pages);
  assert.equal(topics.length, 3);
  assert.equal(JSON.stringify(raw), before, "legacy topic/terms parser must not mutate typed knowledge");
  const topicsOnly = { ...clone(raw), knowledge: [] }, empty = logic.cnKnowledgeClean(topicsOnly, blocks, fixture.material);
  assert.equal(logic.cnOutClean(topicsOnly, fixture.pages).length, 3);
  assert.equal(empty.units.length, 0, "topics cannot be promoted to invented knowledge");
  assert.equal(empty.rejected, 0, "empty model output is not validator loss");
  assert.equal(empty.status, "incomplete"); assert.ok(empty.issues.includes("empty_knowledge_for_text"));
  const invalid = clone(raw); invalid.knowledge[0].sources[0].quote = "This text is absent.";
  const rejected = logic.cnKnowledgeClean(invalid, blocks, fixture.material);
  assert.equal(rejected.rejected, 1); assert.equal(rejected.units.length, 7);
  assert.ok(rejected.issues.includes("source_quote_mismatch"));
  const duplicate = clone(raw); duplicate.knowledge.push(clone(raw.knowledge[0]));
  const merged = logic.cnKnowledgeClean(duplicate, blocks, fixture.material);
  assert.equal(merged.mergedDuplicates, 1); assert.equal(merged.units.length, 8);
  const limited = logic.cnKnowledgeClean({ ...clone(raw), knowledge_limited: true }, blocks, fixture.material);
  assert.equal(limited.status, "incomplete"); assert.ok(limited.issues.includes("model_limit_reported"));
  console.log("DISCOVERY SYNTHETIC PASSED: non-prose terms in 3 scripts, IDs/order/provenance, topics independence, rejected-vs-absent, duplicates, limits, prompt contract (no model invoked)");
}

async function auditEvidence(directory) {
  const read = n => JSON.parse(fs.readFileSync(path.join(directory, n), "utf8"));
  const ledger = fs.readFileSync(path.join(directory, "real-run-ledger.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse).filter(x => x.status === "completed");
  assert.equal(ledger.length, 5);
  const records = read("backend-after-paid.json").docs, docs = new Map(records.filter(x => x.coll === "ctext").map(x => [x.id, x.data]));
  const saved = records.find(x => x.coll === "cplan" && x.data.planVersion === 2);
  const draft = clone(records.find(x => x.coll === "cdraft" && x.id === saved.id).data);
  draft.id = saved.id;
  const pagesOf = m => m.chunks.flatMap(id => docs.get(id)?.pages || []);
  const materials = draft.mats.filter(m => ["base", "extra"].includes(m.role));
  const outlines = materials.map((m, i) => {
    const call = ledger[i], input = JSON.parse(call.request.messages[0].content.split("INPUT:\n")[1]);
    const raw = JSON.parse(call.response.content.filter(x => x.type === "text").map(x => x.text).join(""));
    const pages = pagesOf(m), blocks = logic.cnKnowledgeBlocks(m, pages), result = logic.cnKnowledgeClean(raw, blocks, m);
    assert.deepEqual(clone(blocks.map(b => ({ id: b.id, text: b.text, emphasis: b.emphasis }))), input.pages.flatMap(p => p.blocks));
    pages.forEach(p => assert.equal(blocks.filter(b => b.page === p.n && b.kind === "page_text").map(b => b.text).join(""), p.text, "entire extracted page reached SourceBlock without truncation"));
    assert.equal(edge.h.checkOutline({ purpose: "course", lang: "en", input }), "");
    assert.equal(call.response.stop_reason, "end_turn");
    const currentPrompt = promptTests(input);
    return { m, pages, blocks, input, raw, result, metrics: { material: m.name, pages: pages.length, extractedChars: pages.reduce((n, p) => n + p.text.length, 0), sourceBlocks: blocks.length,
      rawUnits: raw.knowledge.length, rawTopics: raw.topics.length, storedTextUnits: m.kdocs.flatMap(id => docs.get(id)?.units || []).filter(u => u.extractionStatus === "extracted").length,
      acceptedReplay: result.units.length, rejectedReplay: result.rejected, issues: clone(result.issues), stopReason: call.response.stop_reason,
      outputTokens: call.response.usage.output_tokens, maxOutputTokens: call.request.max_tokens,
      oldPromptChars: call.request.messages[0].content.length, newPromptChars: currentPrompt.length } };
  });
  const witnessRows = (outline, witnesses) => witnesses.map(({ page, knowledge }) => {
    const bHits = outline.blocks.filter(b => b.page === page && norm(b.text).includes(norm(knowledge)));
    const rawContents = outline.raw.knowledge.filter(u => norm(JSON.stringify(u.content)).includes(norm(knowledge)));
    const rawCitations = outline.raw.knowledge.filter(u => norm(JSON.stringify(u.sources)).includes(norm(knowledge)));
    const rawTopics = outline.raw.topics.filter(t => norm(JSON.stringify(t)).includes(norm(knowledge)));
    const registry = outline.result.units.filter(u => norm(JSON.stringify(u.content)).includes(norm(knowledge)));
    const sentHits = outline.input.pages.filter(p => p.n === page).flatMap(p => p.blocks).filter(b => norm(b.text).includes(norm(knowledge)));
    const row = { knowledge, page, extracted: outline.pages.some(p => p.n === page && norm(p.text).includes(norm(knowledge))),
      sourceBlocks: bHits.map(b => ({ id: b.id, start: b.start, end: b.end, emphasis: b.emphasis, excerpt: norm(b.text).slice(Math.max(0, norm(b.text).indexOf(norm(knowledge)) - 30), norm(b.text).indexOf(norm(knowledge)) + knowledge.length + 50) })),
      sentBlockIds: sentHits.map(b => b.id), rawContentMatches: rawContents.length, rawCitationMatches: rawCitations.length, rawTopicMatches: rawTopics.length,
      registryMatches: registry.length, cause: "absent_from_raw_response" };
    assert.equal(row.extracted, true, knowledge + ": extracted"); assert.ok(bHits.length, knowledge + ": source block");
    assert.deepEqual(row.sentBlockIds, clone(bHits.map(b => b.id)), knowledge + ": actual request");
    assert.equal(rawContents.length + rawCitations.length + rawTopics.length, 0, knowledge + ": absent before client filtering");
    assert.equal(registry.length, 0, knowledge + ": cannot invent omitted units offline");
    return row;
  });
  const witnesses = Object.entries(read("omission-witnesses.json")).flatMap(([p, names]) => names.map(knowledge => ({ page: +p, knowledge })));
  assert.equal(witnesses.length, 21);
  const main = witnessRows(outlines[0], witnesses);
  const extra = witnessRows(outlines[1], ["Margo frontalis", "Tuber parietale", "Glabella"].map(knowledge => ({ page: 1, knowledge })));
  assert.equal(outlines[0].raw.knowledge.length, 26); assert.equal(outlines[0].result.units.length, 26);
  assert.ok(outlines[0].result.issues.includes("source_quote_relinked"));
  assert.equal(outlines[1].raw.knowledge.length, 0); assert.equal(outlines[1].result.rejected, 0);
  assert.equal(outlines[1].raw.topics.length, 16); assert.equal(outlines[1].raw.knowledge_limited, false);
  assert.ok(outlines[1].result.issues.includes("empty_knowledge_for_text"));
  const written = new Map(), calls = [];
  Object.assign(context, { cnTextMats: d => d.mats.filter(m => ["base", "extra"].includes(m.role)), cnPagesOf: async m => pagesOf(m),
    cnWrite: async (coll, id, data) => written.set(coll + "/" + id, clone(data)),
    window: { CORPUS_WEB: { courseAI: { outline: async (_lang, input) => {
      const o = outlines.find(x => x.input.name === input.name); assert.ok(o); assert.deepEqual(clone(input), o.input);
      calls.push(input.name); return clone(o.raw);
    } } } }, S: { db: true } });
  const r = { dt: {}, cache: { outl: new Map() }, ac: { signal: {} }, cancel: false, spent: 0 };
  await stepOutline(draft, r);
  assert.equal(calls.length, 2, "one existing mocked outline per material, no retry for an empty registry");
  assert.equal(r.topics.length, 26);
  const sidecars = [...written.values()].filter(x => x.kind === "course-knowledge");
  assert.equal(sidecars.filter(x => x.materialId === materials[0].id).flatMap(x => x.units).filter(u => u.extractionStatus === "extracted").length, 26);
  const emptyDoc = sidecars.find(x => x.materialId === materials[1].id);
  assert.equal(emptyDoc.units.length, 0); assert.equal(emptyDoc.outlineStatus, "incomplete");
  assert.ok(emptyDoc.issues.includes("empty_knowledge_for_text"));
  assert.equal(logic.cnKnowledgeDocClean(clone(emptyDoc)).outlineStatus, "incomplete");
  return { main, extraExamples: extra, metrics: outlines.map(x => x.metrics), pipelineMockCalls: calls.length,
    causesAmong21: { extraction: 0, sourceBlocks: 0, requestShortening: 0, rawResponseAbsent: 21, validatorRejected: 0 },
    semanticCompleteness: "not_proven", realAIRequests: 0 };
}

async function main() {
  syntheticTests();
  const args = process.argv.slice(2), directory = args[args.indexOf("--evidence") + 1];
  if (args.includes("--evidence")) {
    assert.ok(directory);
    const result = await auditEvidence(directory);
    if (args.includes("--report")) fs.writeFileSync(args[args.indexOf("--report") + 1], JSON.stringify(result, null, 2) + "\n");
    console.log("REAL DISCOVERY AUDIT PASSED: " + JSON.stringify({ causesAmong21: result.causesAmong21, metrics: result.metrics, pipelineMockCalls: result.pipelineMockCalls }));
  }
}
module.exports = { auditEvidence };
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
