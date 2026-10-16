#!/usr/bin/env node
"use strict";
// T-034: a cut-short outline reply keeps the knowledge units that were complete before the cut.
// Offline: production cnKnowledgeSalvage / cnKnowledgePartial / cnKnowledgeClean / cnStepOutline from src/corpus.html, stubbed AI and storage.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { logic, context, between } = require("./course_logic_test.cjs");
const clone = x => JSON.parse(JSON.stringify(x));
vm.runInContext(between("function cnOutRequireEmphasis(", "\nfunction cnKnowledgeOutlineInput(") + "\n" +
  between("async function cnStepOutline(", "\n/* (в) вопросы экзамена */"), context);
const stepOutline = vm.runInContext("cnStepOutline", context);
const salvage = context.cnKnowledgeSalvage, partial = context.cnKnowledgePartial;
assert.equal(typeof salvage, "function", "cnKnowledgeSalvage is in src/corpus.html");
assert.equal(typeof partial, "function", "cnKnowledgePartial is in src/corpus.html");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "course_discovery_lists.json"), "utf8"));
const M = fixture.material, blocks = logic.cnKnowledgeBlocks(M, fixture.pages);
const unitOf = x => ({ type: x.type, content: x.content, sources: [{ block_id: blocks.find(b => b.page === x.page && b.text.includes(x.quote)).id, quote: x.quote }] });
const units = fixture.expected.map(unitOf);                      // 8 valid units in source order
const topics = fixture.pages.map(p => ({ title: p.em[0], pages: [p.n], terms: [] }));
const full = { knowledge: units, knowledge_limited: false, topics };
// cut the reply inside unit k (its first characters only): the units before it are whole
const cutInside = (raw, k) => {   // knowledge is the first key: the k-th unit starts right after the first k units
  const t = JSON.stringify(raw), u = JSON.stringify(raw.knowledge[k]), i = JSON.stringify({ knowledge: raw.knowledge.slice(0, k) }).length - 2 + (k ? 1 : 0);
  assert.equal(t.slice(i, i + u.length), u); return t.slice(0, i + Math.min(12, u.length - 1)); };
const err = text => ({ code: "invalid_json", message: "the answer was cut short", truncated: true, text });
let n = 0; const ok = (name, fn) => { fn(); n++; console.log("PASS " + name); };

// ---------- (a) synthetic cut-short replies ----------
ok("salvage: 5 whole units before the cut inside the 6th; the unfinished 6th is dropped", () => {
  const s = salvage(cutInside(full, 5));
  assert.deepEqual(clone(s.knowledge), clone(units.slice(0, 5))); assert.equal(s.closed, false);
});
ok("partial: the 5 whole units pass production validation; issues outline_truncated + outline_truncated_partial:5; status incomplete", () => {
  const p = partial(err(cutInside(full, 5)), blocks, M), whole = logic.cnKnowledgeClean({ knowledge: units.slice(0, 5) }, blocks, M);
  assert.equal(p.units.length, 5); assert.equal(p.status, "incomplete"); assert.equal(p.rejected, 0);
  assert.ok(p.issues.includes("outline_truncated")); assert.ok(p.issues.includes("outline_truncated_partial:5"));
  assert.ok(!p.issues.includes("knowledge_missing"));
  assert.deepEqual(clone(p.units), clone(whole.units), "same ids, provenance and order as the same units in a whole reply");
});
ok("partial: a wrong quote in a whole unit is rejected (source_quote_mismatch), N counts only accepted units", () => {
  const raw = clone(full); raw.knowledge[1].sources[0].quote = "This text is absent.";
  const p = partial(err(cutInside(raw, 5)), blocks, M);
  assert.equal(p.units.length, 4); assert.equal(p.rejected, 1);
  assert.ok(p.issues.includes("source_quote_mismatch")); assert.ok(p.issues.includes("outline_truncated_partial:4"));
});
ok("partial: an unknown block id and a wrong shape are rejected as in a whole reply", () => {
  const raw = clone(full); raw.knowledge[0].sources[0].block_id = "b_not_sent"; raw.knowledge[2].extra = 1;
  const p = partial(err(cutInside(raw, 5)), blocks, M);
  assert.equal(p.units.length, 3); assert.equal(p.rejected, 2);
  assert.ok(p.issues.includes("unknown_source_block")); assert.ok(p.issues.includes("invalid_unit_shape"));
});
ok("partial: a duplicate whole unit is merged (mergedDuplicates 1), not counted twice", () => {
  const raw = clone(full); raw.knowledge.splice(3, 0, clone(raw.knowledge[0]));
  const p = partial(err(cutInside(raw, 6)), blocks, M);
  assert.equal(p.mergedDuplicates, 1); assert.equal(p.units.length, 5); assert.ok(p.issues.includes("outline_truncated_partial:5"));
});
ok("partial: more than 50 whole units → cut to the first 50 with unit_limit, as before; a unit after the 50th is not taken", () => {
  const many = []; for (let i = 0; i < 52; i++) many.push(clone(units[i % 7]));
  many.push(clone(units[7]));                                   // the 53rd is the only one with this content
  const raw = { knowledge: many.concat([clone(units[0])]) };
  const p = partial(err(cutInside(raw, 53)), blocks, M);
  assert.ok(p.issues.includes("unit_limit")); assert.equal(p.units.length, 7);
  assert.ok(!p.units.some(u => u.content === units[7].content)); assert.ok(p.issues.includes("outline_truncated_partial:7"));
});
ok("salvage: braces, brackets, quotes and a fake \"knowledge\" key inside strings do not break the object bounds", () => {
  const raw = clone(full); raw.knowledge[0].content = 'R {"knowledge":[}] "x" \\ end';
  const s = salvage(cutInside(raw, 2));
  assert.equal(s.knowledge.length, 2); assert.equal(s.knowledge[0].content, raw.knowledge[0].content);
  assert.equal(salvage('{"topics":[{"title":"has \\"knowledge\\":[{\\"a\\":1}] inside"}],"knowledge":[{"type":"term"').knowledge.length, 0);
});
ok("salvage: only the top-level knowledge array counts (a nested one is ignored)", () => {
  const s = salvage('{"topics":[{"knowledge":[{"type":"term","content":"X","sources":[]}]}],"knowledge":[' + JSON.stringify(units[0]) + ',{"type":"te');
  assert.deepEqual(clone(s.knowledge), [clone(units[0])]);
});
ok("salvage: a cut inside the topics after a whole knowledge array keeps all units (closed array)", () => {
  const t = JSON.stringify(full), s = salvage(t.slice(0, t.indexOf('"topics"') + 15));
  assert.equal(s.knowledge.length, 8); assert.equal(s.closed, true);
});
ok("no whole unit: partial gives nothing (null) → the old path (knowledge_missing + outline_truncated)", () => {
  for (const text of [cutInside(full, 0), '{"knowledge":[', '{"knowl', "", "Sorry, I cannot.", '```json\n{"knowledge":[{"type"', null, undefined])
    assert.equal(partial(err(text), blocks, M), null, String(text));
  const raw = clone(full); raw.knowledge[0].sources[0].quote = "absent";
  assert.equal(partial(err(cutInside(raw, 1)), blocks, M), null, "whole units that all fail validation do not count as a partial registry");
  assert.equal(partial({ code: "timeout", text: cutInside(full, 5) }, blocks, M), null, "only invalid_json replies are read");
  assert.equal(partial(null, blocks, M), null);
  const old = logic.cnKnowledgeClean(null, blocks, M, { transportError: "invalid_json", truncated: true });
  assert.ok(old.issues.includes("knowledge_missing") && old.issues.includes("outline_truncated")); assert.equal(old.units.length, 0);
});
ok("partial: invalid_json WITHOUT truncated:true (spoiled, not cut short) is not read, even with whole units in the text → null", () => {
  const text = cutInside(full, 5);
  for (const t of [false, undefined, "true", 1]) assert.equal(partial({ code: "invalid_json", message: "no JSON in the answer", truncated: t, text }, blocks, M), null, String(t));
  assert.equal(partial({ code: "invalid_json", message: "no JSON in the answer", text }, blocks, M), null);
  assert.ok(partial(err(text), blocks, M), "truncated:true is read as before");
});
ok("salvage: a reply in a ```json fence is read the same way; text over the size limit is not read", () => {
  assert.equal(salvage("```json\n" + cutInside(full, 3)).knowledge.length, 3);
  assert.equal(salvage(cutInside(full, 3) + " ".repeat(200001)), null);
});

// ---------- (b) the step: cut-short reply → registry from the whole units, no retry, one spent unit; whole reply unchanged ----------
async function step(answer) {
  const written = new Map(), calls = [];
  const draft = { id: "d-t034", lang: "en", mats: [{ ...M, role: "base", status: "ready", kind: "pdf", chunks: ["c1"], lang: "en" }] };
  Object.assign(context, { cnTextMats: d => d.mats.filter(m => ["base", "extra"].includes(m.role)), cnPagesOf: async () => clone(fixture.pages),
    cnWrite: async (coll, id, data) => written.set(coll + "/" + id, clone(data)),
    window: { CORPUS_WEB: { courseAI: { outline: async (_lang, input) => { calls.push(input.name); return answer(); } } } }, S: { db: true } });
  const r = { dt: {}, cache: { outl: new Map() }, ac: { signal: {} }, cancel: false, spent: 0 };
  let thrown = null; try { await stepOutline(draft, r); } catch (e) { thrown = e; }
  const docs = [...written.values()].filter(x => x.kind === "course-knowledge");
  return { r, calls, thrown, docs, draft };
}
(async () => {
  const cut = await step(() => { throw err(cutInside(full, 5)); });
  ok("step: a cut-short reply does not stop the step; one outline call, one spent unit, no retry", () => {
    assert.equal(cut.thrown, null); assert.equal(cut.calls.length, 1); assert.equal(cut.r.spent, 1);
  });
  ok("step: the registry document holds the 5 whole units, outlineStatus incomplete, issues outline_truncated + outline_truncated_partial:5 (not knowledge_missing / outline_shape_invalid)", () => {
    const d = cut.docs[0], txt = d.units.filter(u => u.extractionStatus === "extracted");
    assert.equal(txt.length, 5); assert.equal(d.outlineStatus, "incomplete");
    assert.ok(d.issues.includes("outline_truncated") && d.issues.includes("outline_truncated_partial:5"));
    assert.ok(!d.issues.includes("knowledge_missing") && !d.issues.includes("outline_shape_invalid"));
    const back = logic.cnKnowledgeDocClean(clone(d));
    assert.equal(back.outlineStatus, "incomplete"); assert.ok(back.issues.includes("outline_truncated_partial:5"));
  });
  { const again = cut.calls.length, thrown2 = await stepOutline(cut.draft, cut.r).then(() => null, e => e);
    ok("step: the answer is cached: running the step again with the same run sends nothing and spends nothing", () => { assert.equal(thrown2, null); assert.equal(cut.calls.length, again, "no second outline request"); assert.equal(cut.r.spent, 1); }); }
  const none = await step(() => { throw err('{"knowledge":[{"type":"te'); });
  ok("step: no whole unit → as before: the step fails with invalid_json, registry empty with knowledge_missing + outline_truncated, one spent unit", () => {
    assert.equal(none.thrown && none.thrown.code, "invalid_json"); assert.equal(none.calls.length, 1); assert.equal(none.r.spent, 1);
    const d = none.docs[0]; assert.equal(d.units.filter(u => u.extractionStatus === "extracted").length, 0);
    assert.ok(d.issues.includes("knowledge_missing") && d.issues.includes("outline_truncated")); assert.ok(!d.issues.some(x => x.startsWith("outline_truncated_partial")));
  });
  const spoiled = await step(() => { throw { code: "invalid_json", message: "no JSON in the answer", truncated: false, text: cutInside(full, 5) }; });
  ok("step: invalid_json without truncated (spoiled JSON with whole units) → as before: step fails, registry empty, knowledge_missing, NO outline_truncated*, one spent unit", () => {
    assert.equal(spoiled.thrown && spoiled.thrown.code, "invalid_json"); assert.equal(spoiled.calls.length, 1); assert.equal(spoiled.r.spent, 1);
    const d = spoiled.docs[0]; assert.equal(d.units.filter(u => u.extractionStatus === "extracted").length, 0);
    assert.ok(d.issues.includes("knowledge_missing")); assert.ok(!d.issues.some(x => x.startsWith("outline_truncated")), JSON.stringify(d.issues));
  });
  const whole = await step(() => clone(full));
  ok("step (regression): a whole reply gives the same 8 units as cnKnowledgeClean, processed, no truncation issues", () => {
    assert.equal(whole.thrown, null); assert.equal(whole.calls.length, 1); assert.equal(whole.r.spent, 1);
    const d = whole.docs[0], ref = logic.cnKnowledgeClean(clone(full), blocks, M);
    assert.deepEqual(clone(d.units.filter(u => u.extractionStatus === "extracted")), clone(ref.units));
    assert.ok(!d.issues.some(x => x.startsWith("outline_truncated")));
    assert.ok(salvage(JSON.stringify(full)).closed, "the reader sees a whole reply as a closed array");
  });
  console.log("\nRESULT: " + n + " checks\nALL TRUNCATED-OUTLINE TESTS PASSED");
})().catch(e => { console.error(e); process.exitCode = 1; });
