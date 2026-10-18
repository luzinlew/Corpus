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
run(between("const CN_MABB=", "\n/* ---- тексты"));
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
  const lab = (...t) => t.map((x, i) => ({ t: x, x: 10 + 10 * i, y: 10, w: 5, h: 2 }));
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
async function t_cache() {
  const pick = fn("cnKnowledgePicPick"), cache = new Map(), terms = S("Os frontale", "Os parietale", "Os nasale");
  let pagesReads = 0, docReads = 0;
  const pages = { M1: [page(1, true, "Os frontale"), page(2, true, "Os frontale", "Os parietale", "Os nasale")], M2: [] };
  context.cnPagesOf = async m => { pagesReads++; return clone(pages[m.id] || []); };
  context.cnDocData = async () => { docReads++; return { labels: [{ t: "Os frontale", x: 1, y: 1, w: 2, h: 2 }] }; };
  for (let lesson = 0; lesson < 6; lesson++) await pick(deck(), terms, null, new Set(), cache);
  assert.deepEqual([pagesReads, docReads], [1, 1], "six lessons of one build read the pictures material once and the photo captions once");
  await pick(deck(), terms, null, new Set());
  assert.equal(pagesReads, 2, "without a cache every call reads (the old way stays correct)");
}
function t_used_ocr() {
  const used = fn("cnKnowledgePicUsed"), ocr = fn("cnKnowledgePicOcr");
  const d = { id: "D", _plan: { at: 7, parts: [{ lessons: [{ id: "a" }, { id: "b" }] }, { lessons: [{ id: "c" }] }] } };
  const plates = [{ cb: "D|7|a", picRef: "g:M:1" }, { cb: "D|7|b", picRef: "g:M:2" }, { cb: "D|7|c", picRef: "g:M:3" }, { cb: "D|6|a", picRef: "g:M:9" }, { cb: "D|7|a" }];
  assert.deepEqual([...used(d, "a", plates)], [], "the first lesson has no earlier lesson");
  assert.deepEqual([...used(d, "b", plates)], ["g:M:1"], "only lessons earlier in the plan count; later lessons and an old plan do not");
  assert.deepEqual([...used(d, "c", plates)].sort(), ["g:M:1", "g:M:2"], "the third lesson sees the first two");
  assert.deepEqual([...used(d, "b", plates.slice().reverse())], ["g:M:1"], "the order of the plates (of building) does not matter");
  assert.equal(ocr(null).ocr, false, "no choice: no recognition");
  assert.equal(ocr({ matched: 0 }).ocr, false, "a page with no structure found: no recognition");
  assert.deepEqual(JSON.parse(JSON.stringify(ocr({ matched: 2 }))), { ocr: true, max: 40 }, "a page chosen by its captions: recognition of at most 40 boxes");
}
/* T-058: frames of the captions (cnBldMatch): joined pieces, abbreviations, OCR slips in long words, Estonian names of Latin captions; no frame on a chance word */
function t_match() {
  const match = (terms, cands, ar) => context.cnBldMatch(terms.map((la, i) => ({ id: "u" + i, la })), cands, ar);
  const C = (t, x, y, w = 10, h = 3) => ({ t, x, y, w, h });
  const hit = (terms, cands, i = 0) => match(terms, cands).get("u" + i);
  // pieces of one caption
  let m = hit(["Fossa cranii media"], [C("Fossa cranii", 10, 10, 12), C("media", 23.5, 10, 6)]);
  assert.ok(m && m.x === 10 && m.w >= 19, "two pieces of one line are one caption; the frame covers both");
  m = hit(["Fossa cranii posterior"], [C("Fossa cranii", 10, 10, 12), C("posterior", 10, 13.6, 9)]);
  assert.ok(m && m.h >= 6, "two lines one under the other are one caption");
  m = hit(["Fossa cranii media"], [C("Fossa", 10, 10, 6), C("cranii", 10, 13.4, 6), C("media", 10, 16.8, 6)]);
  assert.ok(m, "three lines in a column");
  assert.equal(hit(["Fossa cranii media"], [C("Fossa cranii", 10, 10, 12), C("media", 70, 60, 6)]), undefined, "pieces far apart are not joined");
  assert.equal(hit(["Fossa cranii media"], [C("Fossa cranii", 10, 10, 12), C("media", 10, 30, 6)]), undefined, "lines with a gap are not joined");
  // abbreviations, both ways
  assert.ok(hit(["Arteria carotis"], [C("A. carotis", 5, 5)]), "A. = arteria");
  assert.ok(hit(["A. carotis"], [C("Arteria carotis", 5, 5)]), "the abbreviation on the lesson side");
  assert.ok(hit(["Arteria carotis"], [C("A carotis", 5, 5)]), "the dot lost by OCR");
  assert.ok(hit(["Ligamentum cruciatum"], [C("Lig. cruciatum", 5, 5)]), "lig.");
  assert.ok(hit(["Nervus facialis"], [C("N. facialis", 5, 5)]) && hit(["N. facialis"], [C("Nervus facialis", 5, 5)]), "n.");
  assert.ok(hit(["Processus styloideus"], [C("Proc. styloideus", 5, 5)]), "proc.");
  assert.ok(hit(["Fossa cranii media"], [C("F. cranii media", 5, 5)]) && hit(["F. cranii media"], [C("Fossa cranii media", 5, 5)]), "f.");
  assert.ok(hit(["Musculi glutei"], [C("Mm. glutei", 5, 5)]), "mm.");
  assert.equal(hit(["Arteria carotis"], [C("A. femoralis", 5, 5)]), undefined, "an abbreviation does not match another name");
  assert.equal(hit(["Nervus facialis"], [C("N. ulnaris", 5, 5)]), undefined, "n. + another word");
  // OCR slips in long words
  assert.ok(hit(["Processus styloideus"], [C("Processus styloidcus", 5, 5)]), "one wrong letter in a long word");
  assert.ok(hit(["Foramen magnum"], [C("Foramen magnurn", 5, 5)]), "rn read for m");
  assert.ok(hit(["Mandibula"], [C("Mandihula", 5, 5)]), "one letter in a one-word name of nine letters");
  // a chance word is not a caption
  assert.equal(hit(["Ulna"], [C("Ulma", 5, 5)]), undefined, "a short word: exact only");
  assert.equal(hit(["Costa"], [C("Cosla", 5, 5)]), undefined, "five letters, one slip (0.8): no");
  assert.equal(hit(["Femur"], [C("Humerus", 5, 5)]), undefined, "another bone");
  assert.equal(hit(["Vertebra C1"], [C("Vertebra C2", 5, 5)]), undefined, "a number is exact");
  assert.equal(hit(["Os sphenoidale"], [C("Os ethmoidale", 5, 5)]), undefined, "two bones");
  assert.equal(hit(["Fossa cranii media"], [C("Fossa cranii media et", 5, 5)]), undefined, "an extra word");
  // anterior / posterior stay apart
  m = match(["Pars anterior", "Pars posterior"], [C("Pars posterior", 5, 20)]);
  assert.deepEqual([m.has("u0"), m.has("u1")], [false, true], "only the posterior is on the page");
  assert.equal(hit(["Musculus tibialis anterior"], [C("Musculus tibialis posterior", 5, 5)]), undefined, "a long name differing in the one word that matters");
  m = match(["Pars anterior", "Pars posterior"], [C("Pars posterlor", 5, 20), C("Pars anterior", 5, 10)]);
  assert.deepEqual([m.get("u0").y, m.get("u1").y], [10, 20], "each name gets its own caption");
  assert.equal(hit(["Fossa cranii interna"], [C("Fossa cranii externa", 5, 5)]), undefined, "interna / externa");
  // one caption names one structure
  m = match(["Pars media", "Pars media"], [C("Pars media", 5, 5)]);
  assert.equal(m.size, 1, "one caption, one frame");
  m = match(["Pars media"], [C("Pars media", 5, 5), C("Pars media", 5, 5)]);
  assert.equal(m.size, 1);
  // Estonian names of Latin captions (a lesson in Estonian over a Latin picture)
  const et = match(["BASIS CRANII EXTERNA", "Eesmine osa", "Keskmine osa", "Tagumine osa"],
    [C("Välimine koljupõhimik", 56, 6, 25), C("basis cranii externa", 56, 13, 24), C("Pars anterior", 55, 24, 15), C("(3 osa)", 71, 24, 6), C("Pars media", 55, 29, 13), C("Pars posterior", 55, 34, 15), C("Pars anterior (3 osa)", 55, 24, 22)]);
  assert.equal(et.size, 4, "four of four: the three parts are named in Estonian, the captions in Latin");
  assert.ok(et.get("u1").y === 24 && et.get("u3").y === 34, "each part on its own line");
  assert.equal(hit(["Eesmine osa"], [C("Pars posterior", 5, 5)]), undefined, "eesmine is anterior, not posterior");
  assert.equal(hit(["Eesmine kolju"], [C("Pars anterior", 5, 5)]), undefined, "a name that is not fully translated gets no frame");
  assert.equal(hit(["Osa"], [C("Pars", 5, 5)]), undefined, "one translated word alone is no name");
}
(async () => {
  let failed = 0;
  for (const [name, f] of [["P1 count of the structures a page names", t_count], ["P2 rank: most, heading, not used, lower page, threshold", t_rank], ["P3 choice among the pages of the picture materials", t_pick], ["P4 photos and unreadable materials", t_photos], ["P5 the pages are read once for a build", t_cache], ["P6 used pages count earlier lessons only; recognition only on a chosen page", t_used_ocr], ["P7 frames: pieces, abbreviations, OCR slips, Estonian names; no frame on a chance word", t_match]]) {
    try { await f(); console.log("PASS " + name); } catch (e) { failed++; console.log("FAIL " + name + "\n  " + String(e && (e.stack || e.message) || e).split("\n").slice(0, 10).join("\n  ")); }
  }
  if (failed) process.exitCode = 1; else console.log("COURSE PICTURES TESTS PASSED");
})();
