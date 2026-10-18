#!/usr/bin/env node
"use strict";
// Offline checks of the picture choice of a lesson v2 (T-046): the page of a «Pictures» material that names the most structures of the lesson wins; frames are matched by the same
// function as for lessons v1. Production client functions (vm), no browser, network or model.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { context, between } = require("./course_logic_test.cjs");
const run = code => vm.runInContext(code, context);
run("const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));const r2=v=>Math.round(v*100)/100;");
run(between("const cnStem=", "\n"));
run(between("function cnBldMatch(", "\n/* ---- тексты"));
const fn = name => run(name);
const S = (...names) => names.map((la, i) => ({ id: "u" + i, la }));
const lines = (...t) => t;
const clone = x => JSON.parse(JSON.stringify(x));

function t_count() {
  const count = fn("cnKnowledgePicCount");
  assert.equal(count(S("Os frontale", "Os parietale", "Os nasale"), lines("Os frontale", "Os parietale", "Title of the slide")), 2, "whole-name match");
  assert.equal(count(S("Processus spinosus"), lines("Processus spinosi")), 1, "stem match (first six letters of each word)");
  assert.equal(count(S("Os frontale"), lines("Os frontale", "Os frontale")), 1, "one structure counts once");
  assert.equal(count(S("Os frontale", "Os frontale"), lines("Os frontale")), 1, "one caption names one structure");
  assert.equal(count(S("Os frontale"), lines("The os frontale is the bone of the forehead and it has a long description that is a paragraph")), 0, "a name inside a paragraph is not a caption");
  assert.equal(count([], lines("Os frontale")), 0);
  assert.equal(count(S("Os frontale"), []), 0);
}
function t_rank() {
  const rank = fn("cnKnowledgePicRank"), none = new Set();
  const c = (ref, order, matched, head) => ({ ref, order, matched, head: !!head });
  assert.equal(rank([c("a", 1, 2), c("b", 2, 4), c("c", 3, 3)], none).ref, "b", "the most structures wins");
  assert.equal(rank([c("a", 1, 3), c("b", 2, 3)], none).ref, "a", "a tie: the lower page");
  assert.equal(rank([c("a", 1, 3), c("b", 2, 3, true)], none).ref, "b", "a tie: the page of the matched heading");
  assert.equal(rank([c("a", 1, 3), c("b", 2, 3)], new Set(["a"])).ref, "b", "a tie: the page not used by an earlier lesson");
  assert.equal(rank([c("a", 1, 3, true), c("b", 2, 3)], new Set(["a"])).ref, "a", "the heading comes before the 'not used' preference");
  assert.equal(rank([c("a", 1, 3), c("b", 2, 4)], new Set(["b"])).ref, "b", "a used page with more structures still wins");
  assert.equal(rank([c("a", 1, 1), c("b", 2, 1)], none), null, "one structure without the heading is below the threshold");
  assert.equal(rank([c("a", 1, 1), c("b", 2, 1, true)], none).ref, "b", "one structure + the heading is enough");
  assert.equal(rank([c("a", 1, 0, true)], none), null, "the heading alone is not enough here: the old way decides");
  assert.equal(rank([], none), null);
}
function deck(extra) {
  const mats = [
    { id: "M1", name: "Practicum.pdf", kind: "pdf", role: "pics", status: "ready" },
    { id: "M2", name: "Notes.pdf", kind: "pdf", role: "base", status: "ready" },
    { id: "M3", name: "Atlas.png", kind: "img", role: "pics", status: "ready", photos: 2, lab: ["L0", "-"] }];
  return Object.assign({ id: "D", mats, _plan: { knowledgeIndex: [{ id: "V1", type: "visual", sources: [{ materialId: "M1", page: 2 }] }] } }, extra);
}
function stub(pages, labels) {
  context.cnPagesOf = async m => { if (!pages[m.id]) throw new Error("no pages"); return clone(pages[m.id]); };
  context.cnDocData = async (_c, id) => labels[id] ? { labels: labels[id] } : null;
}
const page = (n, visual, ...t) => ({ n, text: t.join("\n"), em: [], diag: visual ? { known: true, visual: true } : { known: true } });
async function t_pick() {
  const pick = fn("cnKnowledgePicPick"), terms = S("Os frontale", "Os parietale", "Os occipitale", "Os nasale");
  stub({ M1: [page(1, true, "Os frontale", "Os parietale"), page(2, true, "Os frontale", "Os parietale", "Os occipitale", "Os nasale"), page(3, true)], M2: [page(1, false, "Os frontale", "Os parietale", "Os occipitale", "Os nasale")] }, {});
  let r = await pick(deck(), terms, null, new Set());
  assert.deepEqual([r.ref, r.matched, r.unitId], ["g:M1:2", 4, "V1"], "page 2 names four structures; the page of the base material is not a candidate; the visual unit of the page is named");
  r = await pick(deck(), terms.slice(0, 2), null, new Set());
  assert.equal(r.ref, "g:M1:1", "an equal count (2 and 2): the lower page");
  r = await pick(deck(), terms.slice(0, 2), null, new Set(["g:M1:1"]));
  assert.equal(r.ref, "g:M1:2", "an equal count: the page an earlier lesson did not use");
  r = await pick(deck(), terms.slice(0, 1), null, new Set());
  assert.equal(r, null, "one structure alone: no picture of this kind");
  r = await pick(deck(), terms.slice(0, 1), { ref: "g:M1:3", unitId: "V9" }, new Set());
  assert.equal(r, null, "one structure on pages 1 and 2, the heading on page 3 (no structure there): the old way decides");
  r = await pick(deck(), terms.slice(0, 1), { ref: "g:M1:2", unitId: "V1" }, new Set());
  assert.deepEqual([r.ref, r.matched], ["g:M1:2", 1], "one structure + the heading page");
  r = await pick(deck(), S("Femur", "Tibia"), null, new Set());
  assert.equal(r, null, "no structure on any page: the old way decides");
  r = await pick(deck(), [], null, new Set());
  assert.equal(r, null, "a lesson without structures");
}
async function t_photos() {
  const pick = fn("cnKnowledgePicPick"), terms = S("Os frontale", "Os parietale", "Os nasale");
  const lab = (...t) => t.map((x, i) => ({ t: x, x: 10 + i, y: 10, w: 5, h: 2 }));
  stub({ M1: [page(1, true, "Os frontale")], M2: [] }, { L0: lab("Os frontale", "Os parietale", "Os nasale") });
  let r = await pick(deck(), terms, null, new Set());
  assert.deepEqual([r.ref, r.matched], ["p:M3:0", 3], "a photo with its own labels wins over a page with one");
  stub({ M1: [page(1, true, "Os frontale", "Os parietale", "Os nasale")], M2: [] }, { L0: lab("Os frontale", "Os parietale", "Os nasale") });
  r = await pick(deck(), terms, null, new Set());
  assert.equal(r.ref, "g:M1:1", "an equal count: the material that comes first");
  stub({}, {});
  r = await pick(deck(), terms, null, new Set());
  assert.equal(r, null, "the pages cannot be read: no choice, no error");
}
(async () => {
  let failed = 0;
  for (const [name, f] of [["P1 count of the structures a page names", t_count], ["P2 rank: most, heading, not used, lower page, threshold", t_rank], ["P3 choice among the pages of the picture materials", t_pick], ["P4 photos and unreadable materials", t_photos]]) {
    try { await f(); console.log("PASS " + name); } catch (e) { failed++; console.log("FAIL " + name + "\n  " + String(e && (e.stack || e.message) || e).split("\n").slice(0, 10).join("\n  ")); }
  }
  if (failed) process.exitCode = 1; else console.log("COURSE PICTURES TESTS PASSED");
})();
