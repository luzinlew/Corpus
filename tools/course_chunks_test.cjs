#!/usr/bin/env node
"use strict";
// T-039: outline requests are cut by the expected size of the reply (density of the text), a cut-short chunk is asked again in halves.
// Offline: production cnOutline* helpers and cnStepOutline from src/corpus.html, stubbed AI and storage; the server validator checkOutline is the production one.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const { logic, context, between, betweenServer } = require("./course_logic_test.cjs");
const clone = x => JSON.parse(JSON.stringify(x));
vm.runInContext(between("function cnOutRequireEmphasis(", "\nfunction cnKnowledgeOutlineInput(") + "\n" + between("async function cnStepOutline(", "\n/* (в) вопросы экзамена */"), context);
const C = name => vm.runInContext(name, context), newMap = entries => vm.runInContext("(e => new Map(e))", context)(entries);   // a Map of the app's realm (instanceof Map)
const stepOutline = C("cnStepOutline"), OUT = C("CN_OUT");
let n = 0; const ok = (name, fn) => fn instanceof Promise ? fn : (fn(), n++, console.log("PASS " + name));
const okA = async (name, fn) => { await fn(); n++; console.log("PASS " + name); };

// ---------- pages ----------
const para = (len, tag) => { let s = "", i = 0; while (s.length < len) s += tag + "-" + (i++) + " the quick brown fox jumps over the lazy dog while the heat flows from the hot body to the cold one. "; return s.slice(0, len).trim(); };
// a page of running text: lines of ~90 characters, as a PDF wraps a paragraph
const textPage = (nn, chars, tag) => { const t = para(chars, tag || "p" + nn), lines = []; for (let i = 0; i < t.length; i += 90) lines.push(t.slice(i, i + 90)); return { n: nn, text: lines.join("\n"), em: [], diag: null }; };
// a page of short lines (names of structures), `chars` characters in all
const listPage = (nn, chars, tag) => { const lines = []; let len = 0, i = 0; while (len < chars) { const l = (tag || "L" + nn) + " item " + (i++) + " name"; lines.push(l); len += l.length + 1; } return { n: nn, text: lines.join("\n").slice(0, chars), em: [], diag: null }; };
// a page of `k` blocks: bold headings (emphasis) between paragraphs
const blockPage = (nn, k, chars) => { const heads = [], parts = []; for (let i = 0; i < k; i++) { const h = "Heading " + nn + "." + i; heads.push(h); parts.push(h, para(Math.max(30, Math.floor(chars / k)), "q" + nn + "_" + i)); } return { n: nn, text: parts.join("\n"), em: heads, diag: null }; };
const M = { id: "mat-a", name: "Material A", role: "base", status: "ready", kind: "pdf", chunks: ["c1"], lang: "en" };
const withBlocks = (m, pages) => pages.map(p => ({ ...p, text: p.text.slice(0, 6000), sourceTruncated: false, blocks: logic.cnKnowledgeBlocks(m, [p]) }));
const est = p => C("cnOutlineEst")(p);
const chunksOf = (m, pages) => C("cnOutlineChunks")(withBlocks(m, pages).filter(p => p.text.trim() || p.em.length));   // the step leaves out the pages with nothing on them
const nums = chunks => clone(chunks.map(c => c.map(p => p.n)));

// ---------- (a) the density of a page ----------
ok("constants: target 3000 tokens, 5 pages, at most 80 chunks, 3 repeat requests, k 1.6 text / 2.7 list", () => {
  assert.deepEqual(clone(OUT).target, 3000); assert.equal(OUT.maxPages, 5); assert.equal(OUT.maxChunks, 80); assert.equal(OUT.retryCap, 3); assert.equal(OUT.kText, 1.6); assert.equal(OUT.kList, 2.7);
});
ok("page of running text: 1685..2573 characters of long lines are «text» (k 1.6), E = chars × 1.6", () => {
  for (const c of [1685, 2000, 2573]) { const pg = textPage(1, c), e = est(withBlocks(M, [pg])[0]); assert.equal(e.list, false); assert.equal(e.chars, pg.text.length); assert.ok(Math.abs(pg.text.length - c) <= 30); assert.equal(e.e, Math.ceil(pg.text.length * 1.6)); }
});
ok("page of short lines: 800..1360 characters of names are «list» (k 2.7), E = chars × 2.7", () => {
  for (const c of [800, 1000, 1360]) { const p = withBlocks(M, [listPage(1, c)])[0], e = est(p); assert.equal(e.list, true); assert.equal(e.e, Math.ceil(p.blocks.reduce((a, b) => a + b.text.length, 0) * 2.7)); }
});
ok("a page of lines that start with a marker (-, •, 1.) is a list even when the lines are long", () => {
  const line = k => "• " + para(100, "m" + k), numbered = k => (k + 1) + ". " + para(100, "n" + k);
  assert.equal(est({ text: [0, 1, 2, 3, 4].map(line).join("\n"), blocks: [] }).list, true);
  assert.equal(est({ text: [0, 1, 2, 3, 4].map(numbered).join("\n"), blocks: [] }).list, true);
  assert.equal(est({ text: "- " + para(100, "x") + "\n- " + para(100, "y"), blocks: [] }).list, true);
});
ok("an empty page and a page with one short heading have E 0 / small, and do not break the rule", () => {
  assert.equal(est({ text: "", blocks: [] }).e, 0); assert.equal(est({ text: "   \n ", blocks: [] }).e, 0); assert.ok(est({ text: "Heat", blocks: [] }).e <= 11);
});

// ---------- (b) the cut ----------
const flat = ch => Array.from(ch).flatMap(c => Array.from(c));
function checkCut(m, pages, label) {
  const ch = chunksOf(m, pages), all = flat(ch).map(p => p.n);
  assert.deepEqual(clone(all), pages.filter(p => p.text.trim()).map(p => p.n), label + ": every page in exactly one chunk, in order");
  const ids = clone(flat(ch).flatMap(p => p.blocks.map(b => b.id))), ref = withBlocks(m, pages).flatMap(p => p.blocks.map(b => b.id));
  assert.deepEqual(ids, ref, label + ": every block once, same ids and order");
  ch.forEach(c => { assert.ok(c.length >= 1 && c.length <= OUT.maxPages, label + ": ≤ 5 pages"); const sum = c.reduce((a, p) => a + est(p).e, 0); assert.ok(c.length === 1 || sum <= OUT.target, label + ": E " + sum + " ≤ target unless a single page"); });
  assert.deepEqual(nums(chunksOf(m, pages)), nums(ch), label + ": deterministic");
  return ch;
}
ok("text page of 2000 characters: E 3200 > 3000 → every page is a chunk of its own", () => {
  const ch = checkCut(M, [1, 2, 3, 4].map(i => textPage(i, 2000)), "text 2000"); assert.deepEqual(nums(ch), [[1], [2], [3], [4]]);
});
ok("text pages of 1685 characters (E 2696): one page each; of 900 (E 1440): two", () => {
  assert.deepEqual(nums(checkCut(M, [1, 2, 3].map(i => textPage(i, 1685)), "1685")), [[1], [2], [3]]);
  assert.deepEqual(nums(checkCut(M, [1, 2, 3, 4, 5].map(i => textPage(i, 900)), "900")), [[1, 2], [3, 4], [5]]);
});
ok("10 pages of lists of ~1000 characters: E 2700 each → 10 chunks of one page", () => {
  const ch = checkCut(M, Array.from({ length: 10 }, (_, i) => listPage(i + 1, 1000)), "lists 1000"); assert.equal(ch.length, 10);
  ch.forEach(c => assert.ok(Math.abs(est(c[0]).e - 2700) <= 40, String(est(c[0]).e)));
});
ok("short text pages of 300 characters (E 480) go by 5; short list pages of 300 (E 810) by 3", () => {
  assert.deepEqual(nums(checkCut(M, Array.from({ length: 12 }, (_, i) => textPage(i + 1, 300)), "text 300")), [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12]]);
  assert.deepEqual(nums(checkCut(M, Array.from({ length: 7 }, (_, i) => listPage(i + 1, 300)), "list 300")), [[1, 2, 3], [4, 5, 6], [7]]);
});
ok("the real documents: Core 6 pages of ~2000 characters → 6 chunks; Extra 10 list pages of 800..1360 → 10 chunks; a lecture of 40 pages of ~900 characters → 20 chunks of 2 (of ~1000 → 40 chunks)", () => {
  assert.equal(chunksOf(M, [1, 2, 3, 4, 5, 6].map(i => textPage(i, 1685 + i * 150))).length, 6);
  assert.equal(chunksOf(M, [800, 900, 1000, 1100, 1200, 1300, 1360, 1000, 900, 1200].map((c, i) => listPage(i + 1, c))).length, 10);
  assert.equal(chunksOf(M, Array.from({ length: 40 }, (_, i) => textPage(i + 1, 900))).length, 20);
  assert.equal(chunksOf(M, Array.from({ length: 40 }, (_, i) => textPage(i + 1, 1000))).length, 40);
});
ok("an oversize page (E > target) is alone, the neighbours do not join it; the chunks around it still fill up", () => {
  const ch = checkCut(M, [textPage(1, 300), textPage(2, 300), textPage(3, 5500), textPage(4, 300), textPage(5, 300), textPage(6, 300)], "oversize");
  assert.deepEqual(nums(ch), [[1, 2], [3], [4, 5, 6]]);
});
ok("empty pages (no text, no emphasis) are in no chunk; a material of only empty pages has no chunk", () => {
  const empty = { n: 2, text: "", em: [], diag: null };
  assert.deepEqual(nums(chunksOf(M, [textPage(1, 300), empty, textPage(3, 300)])), [[1, 3]]);
  assert.deepEqual(clone(chunksOf(M, [empty])), []);
});
ok("a page of 6000+ characters is cut to 6000 as before; the JSON size of a chunk stays under CN_PL.outJson (36000)", () => {
  const big = withBlocks(M, [textPage(1, 7000), textPage(2, 7000)]); assert.ok(big[0].text.length <= 6000);
  const ch = C("cnOutlineChunks")(withBlocks(M, Array.from({ length: 30 }, (_, i) => textPage(i + 1, 5900))));
  ch.forEach(c => assert.ok(JSON.stringify(logic.cnKnowledgeOutlineInput(M, { items: c })).length <= 40000));
});
ok("a random mix of 300 pages (text / lists / sizes): the properties hold on all of them; the same input gives the same chunks", () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pages = Array.from({ length: 300 }, (_, i) => rnd() < 0.4 ? listPage(i + 1, 100 + Math.floor(rnd() * 1500)) : textPage(i + 1, 50 + Math.floor(rnd() * 3000)));
  checkCut(M, pages, "random");
});
ok("the estimate of a draft: the chunk count from the same rule (cnOutlineSplitIdx over {e,len}) equals the count of the real cut", () => {
  const pages = withBlocks(M, [1, 2, 3, 4, 5, 6, 7].map(i => i % 2 ? listPage(i, 700) : textPage(i, 700))), real = C("cnOutlineChunks")(pages).length;
  assert.equal(C("cnOutlineSplitIdx")(pages.map(p => ({ e: est(p).e, len: 100 }))).length, real);
});

// ---------- (c) the halves ----------
ok("halves of a chunk of several pages: by pages, balanced by E, every page and block once, keys differ and carry the range", () => {
  const ch = chunksOf(M, [1, 2, 3, 4, 5].map(i => textPage(i, 300))), job = { m: M, items: ch[0], blocks: ch[0].flatMap(p => p.blocks), key: "mat-a.0.1-5.5" };
  const hs = C("cnOutlineHalves")(job);
  assert.equal(hs.length, 2); assert.ok(hs[0].items.length >= 2 && hs[0].items.length <= 3 && hs[1].items.length >= 2);
  assert.deepEqual(clone(hs.flatMap(h => h.items.map(p => p.n))), [1, 2, 3, 4, 5]); assert.deepEqual(clone(hs.flatMap(h => h.blocks.map(b => b.id))), clone(job.blocks.map(b => b.id)));
  assert.notEqual(hs[0].key, hs[1].key); assert.ok(hs.every(h => h.key !== job.key && h.key.startsWith("mat-a.0.")));
  assert.deepEqual(clone(C("cnOutlineHalves")(job).map(h => h.key)), clone(hs.map(h => h.key)), "deterministic");
});
ok("halves of a single page: by blocks in the middle of the characters, same page number, ids unique, the visual mark and the emphasis only once", () => {
  const p = withBlocks(M, [blockPage(4, 6, 1800)])[0]; p.diag = { visual: true };
  const job = { m: M, items: [p], blocks: p.blocks, key: "mat-a.0.4-4.1" }, hs = C("cnOutlineHalves")(job);
  assert.equal(hs.length, 2); assert.equal(p.blocks.length, 12);
  assert.deepEqual(clone(hs.flatMap(h => h.blocks.map(b => b.id))), clone(p.blocks.map(b => b.id))); assert.ok(hs.every(h => h.items.length === 1 && h.items[0].n === 4 && h.items[0].blocks.length === h.blocks.length));
  assert.ok(hs.every(h => h.blocks.length >= 1)); assert.equal(!!hs[0].items[0].diag, true); assert.equal(hs[1].items[0].diag, null);
  assert.notEqual(hs[0].key, hs[1].key); assert.ok(hs[0].key.startsWith(job.key));
  const sizes = hs.map(h => h.blocks.reduce((a, b) => a + b.text.length, 0)), tot = sizes[0] + sizes[1]; assert.ok(Math.abs(sizes[0] - sizes[1]) <= tot / 3, JSON.stringify(sizes));
});
ok("a page with one block cannot be halved (a block is never cut): null; an empty job too", () => {
  const p = withBlocks(M, [textPage(1, 2500)])[0]; assert.equal(p.blocks.length, 1);
  assert.equal(C("cnOutlineHalves")({ m: M, items: [p], blocks: p.blocks, key: "k" }), null);
});

// ---------- (d) the step: stubbed AI ----------
const unitsOf = blocks => blocks.filter(b => b.text.trim().length >= 3).map(b => { const q = b.text.trim().slice(0, 60); return { type: "statement", content: q, sources: [{ block_id: b.id, quote: q }] }; });
const cutInside = (raw, k) => { const t = JSON.stringify(raw), u = JSON.stringify(raw.knowledge[k]), i = JSON.stringify({ knowledge: raw.knowledge.slice(0, k) }).length - 2 + (k ? 1 : 0); return t.slice(0, i + Math.min(12, u.length - 1)); };
const cutErr = (raw, k) => ({ code: "invalid_json", message: "the answer was cut short", truncated: true, text: cutInside(raw, k), courseAI: { charged: true } });
// how: (input, call number) → "ok" | "cut" (half of the units kept) | "cut0" (no whole unit) | "spoiled" (invalid_json, not cut short) | "http" (a 500)
async function run(mats, how, pre) {
  const written = new Map(), calls = [];
  const draft = { id: "d-t039", lang: "en", mats: mats.map(x => ({ ...x.m })) };
  const pagesBy = new Map(mats.map(x => [x.m.id, x.pages]));
  Object.assign(context, { cnTextMats: d => d.mats.filter(m => ["base", "extra"].includes(m.role)), cnPagesOf: async m => clone(pagesBy.get(m.id)), cnWrite: async (coll, id, data) => written.set(coll + "/" + id, clone(data)),
    window: { CORPUS_WEB: { courseAI: { outline: async (_lang, input) => {
      calls.push(clone(input)); const blocks = input.pages.flatMap(p => p.blocks), raw = { knowledge: unitsOf(blocks), knowledge_limited: false, topics: [] };
      assert.equal(vm.runInContext("1", context), 1);
      const v = how(input, calls.length);
      if (v === "ok") return raw; if (v === "cut") throw cutErr(raw, Math.ceil(raw.knowledge.length / 2)); if (v === "cut0") throw cutErr(raw, 0);
      if (v === "spoiled") throw { code: "invalid_json", message: "no JSON in the answer", truncated: false, text: JSON.stringify(raw).slice(0, 80) };
      throw { code: "upstream_error", message: "500", status: 500 };
    } } } }, S: { db: true } });
  const r = { dt: {}, cache: { outl: new Map(), ...(pre || {}) }, ac: { signal: {} }, cancel: false, spent: 0, est: 0 };
  let thrown = null; try { await stepOutline(draft, r); } catch (e) { thrown = e; }
  const docsOf = id => [...written.values()].filter(x => x.kind === "course-knowledge" && x.materialId === id);
  return { r, calls, thrown, docsOf, draft, written, again: async () => { let t = null; try { await stepOutline(draft, r); } catch (e) { t = e; } return t; } };
}
const extracted = docs => docs.flatMap(d => d.units.filter(u => u.extractionStatus === "extracted"));
const wholeIds = (m, pages) => { const bl = withBlocks(m, pages).flatMap(p => p.blocks); return clone(logic.cnKnowledgeClean({ knowledge: unitsOf(bl) }, bl, m).units.map(u => u.id)).sort(); };
const issuesOf = docs => [...new Set(docs.flatMap(d => d.issues))];
const nPages = i => i.pages.length;
const eightText = Array.from({ length: 8 }, (_, i) => textPage(i + 1, 300));    // chunks [1..5] [6..8]

(async () => {
  let t;
  t = await run([{ m: M, pages: eightText }], i => "ok");
  await okA("step: no cut-short reply → the old behaviour: one request a chunk (2), no repeat, spent 2, units = a whole reply, processed", async () => {
    assert.equal(t.thrown, null); assert.deepEqual(t.calls.map(nPages), [5, 3]); assert.equal(t.r.spent, 2);
    const docs = t.docsOf(M.id); assert.deepEqual(extracted(docs).map(u => u.id).sort(), wholeIds(M, eightText)); assert.ok(docs.every(d => d.outlineStatus === "processed") && !issuesOf(docs).some(x => x.startsWith("outline_")), JSON.stringify(issuesOf(docs)));
  });

  t = await run([{ m: M, pages: eightText }], i => nPages(i) === 5 ? "cut" : "ok");
  await okA("step: a chunk of 5 pages is cut short → two halves are asked (3 + 2 pages), then the other chunk: 4 requests, spent 4, retries 2", async () => {
    assert.equal(t.thrown, null); assert.equal(t.calls.length, 4); assert.equal(t.r.spent, 4);
    const sizes = t.calls.map(nPages); assert.equal(sizes[0], 5); assert.equal(sizes.slice(1).reduce((a, b) => a + b, 0), 8, "5 pages in two halves + 3 pages"); assert.equal(t.r.cache.retries.get(M.id), 2);
  });
  await okA("step: the units of the halves REPLACE the cut chunk: all units, no duplicate, none lost; no outline_truncated; the registry is processed", async () => {
    const docs = t.docsOf(M.id), ids = extracted(docs).map(u => u.id).sort();
    assert.deepEqual(ids, wholeIds(M, eightText)); assert.equal(new Set(ids).size, ids.length);
    assert.ok(docs.every(d => d.outlineStatus === "processed")); assert.ok(!issuesOf(docs).some(x => x.startsWith("outline_truncated")), JSON.stringify(issuesOf(docs)));
    assert.ok(!issuesOf(docs).includes("duplicate_across_outline_chunks_merged"));
  });
  { const before = t.calls.length, spent = t.r.spent, again = await t.again();
    await okA("step: the same run again (Continue) sends nothing and spends nothing: the halves are cached, the cut chunk is not asked again", async () => { assert.equal(again, null); assert.equal(t.calls.length, before); assert.equal(t.r.spent, spent); assert.equal(t.r.cache.retries.get(M.id), 2); }); }

  const onePage = [blockPage(1, 6, 2400)];
  t = await run([{ m: M, pages: onePage }], i => i.pages[0].blocks.length >= 10 ? "cut" : "ok");   // the page has 12 blocks (6 headings + 6 paragraphs)
  await okA("step: a single page cut short is halved by blocks (once): 3 requests, both halves carry page 1, block ids unique and complete, units complete", async () => {
    assert.equal(t.thrown, null); assert.equal(t.calls.length, 3); assert.equal(t.r.spent, 3);
    const hs = t.calls.slice(1); assert.ok(hs.every(h => h.pages.length === 1 && h.pages[0].n === 1 && h.pages[0].blocks.length >= 1 && h.pages[0].blocks.length < 12));
    const ids = hs.flatMap(h => h.pages[0].blocks.map(b => b.id)); assert.equal(new Set(ids).size, ids.length); assert.deepEqual(ids, t.calls[0].pages[0].blocks.map(b => b.id));
    assert.deepEqual(extracted(t.docsOf(M.id)).map(u => u.id).sort(), wholeIds(M, onePage)); assert.ok(!issuesOf(t.docsOf(M.id)).some(x => x.startsWith("outline_")));
  });
  await okA("step: every request the app sends passes the production checkOutline of the function (pages, blocks, unique ids, JSON size)", async () => {
    const ctx = vm.createContext({ LANG_NAME: { ru: "Russian", en: "English", et: "Estonian" } });
    vm.runInContext(stripTypeScriptTypes(betweenServer("const OL_PAGES =", "function outlinePrompt(")) + "\nglobalThis.check=checkOutline;", ctx);
    const all = [...t.calls, ...(await run([{ m: M, pages: eightText }], i => nPages(i) === 5 ? "cut" : "ok")).calls];
    assert.ok(all.length >= 6); all.forEach(input => assert.equal(ctx.check({ purpose: "course", lang: "en", input }), "", JSON.stringify(input).slice(0, 120)));
  });

  t = await run([{ m: M, pages: eightText }], i => "cut");
  await okA("step: the halves are cut short too → no second division: the whole units of each half are kept (T-034), 1 + 2 repeat requests for the cut chunk, the other chunk is cut and halved the same way", async () => {
    assert.equal(t.thrown, null); assert.equal(t.calls.length, 3 + 1); assert.equal(t.r.spent, 4);   // chunk 1: 1 + 2 halves; chunk 2: cut, 1 repeat budget left (3 - 2) → none
    assert.equal(t.r.cache.retries.get(M.id), 2);
    const docs = t.docsOf(M.id), got = issuesOf(docs); assert.ok(got.includes("outline_truncated")); assert.ok(got.some(x => x.startsWith("outline_truncated_partial:")));
    assert.ok(docs.every(d => d.outlineStatus === "incomplete")); assert.ok(extracted(docs).length > 0 && extracted(docs).length < wholeIds(M, eightText).length);
  });

  const lists = Array.from({ length: 6 }, (_, i) => blockPage(i + 1, 4, 2300));   // 6 chunks of one page, each with 4 blocks
  t = await run([{ m: M, pages: lists }], i => "cut");
  await okA("step: the cap — 6 chunks all cut short: only ONE chunk is asked again (2 requests), the others keep their whole units; 6 + 2 requests, retries ≤ 3", async () => {
    assert.equal(t.thrown, null); assert.equal(t.calls.length, 8); assert.equal(t.r.spent, 8); assert.ok(t.r.cache.retries.get(M.id) <= OUT.retryCap);
    const docs = t.docsOf(M.id); assert.ok(issuesOf(docs).includes("outline_truncated")); assert.ok(docs.every(d => d.outlineStatus === "incomplete"));
    assert.ok(issuesOf(docs).some(x => /^outline_truncated_partial:\d+$/.test(x)));
  });
  t = await run([{ m: M, pages: lists }], i => "cut", { retries: newMap([[M.id, 2]]) });
  await okA("step: the cap is already used up (2 of 3 done, a pair would make 4): no repeat at all — the T-034 behaviour, one request a chunk", async () => {
    assert.equal(t.thrown, null); assert.equal(t.calls.length, 6); assert.equal(t.r.spent, 6); assert.equal(t.r.cache.retries.get(M.id), 2);
    assert.ok(issuesOf(t.docsOf(M.id)).includes("outline_truncated"));
  });
  t = await run([{ m: M, pages: lists.slice(0, 3) }, { m: { ...M, id: "mat-b", role: "extra", name: "B" }, pages: lists.slice(0, 3) }], i => "cut");
  await okA("step: the cap is per material: two materials each get their own pair of repeat requests (3 + 3 + 2 + 2 = 10)", async () => {
    assert.equal(t.calls.length, 10); assert.equal(t.r.cache.retries.get("mat-a"), 2); assert.equal(t.r.cache.retries.get("mat-b"), 2); assert.equal(t.r.spent, 10);
  });

  t = await run([{ m: M, pages: eightText }], i => nPages(i) === 5 ? "spoiled" : "ok");
  await okA("step: invalid_json without truncated:true → no repeat: the step fails with invalid_json after 1 request (the second worker may have one more), no halves asked", async () => {
    assert.equal(t.thrown && t.thrown.code, "invalid_json"); assert.ok(t.calls.every(i => nPages(i) === 5 || nPages(i) === 3)); assert.ok(!t.r.cache.retries || !t.r.cache.retries.get(M.id)); assert.ok(t.calls.length <= 2);
    assert.ok(!issuesOf(t.docsOf(M.id)).some(x => x.startsWith("outline_truncated")));
  });
  t = await run([{ m: M, pages: eightText }], i => nPages(i) === 5 ? "http" : "ok");
  await okA("step: a 500 from the function → no repeat, the step fails with that error", async () => {
    assert.equal(t.thrown && t.thrown.code, "upstream_error"); assert.ok(t.calls.every(i => nPages(i) === 5 || nPages(i) === 3)); assert.ok(!t.r.cache.retries || !t.r.cache.retries.get(M.id));
  });
  t = await run([{ m: M, pages: eightText }], i => nPages(i) === 5 ? "cut0" : "ok");
  await okA("step: cut short without a whole unit → the halves are asked all the same (same rule) and fill the registry; no error", async () => {
    assert.equal(t.thrown, null); assert.equal(t.calls.length, 4); assert.deepEqual(extracted(t.docsOf(M.id)).map(u => u.id).sort(), wholeIds(M, eightText)); assert.ok(!issuesOf(t.docsOf(M.id)).some(x => x.startsWith("outline_")));
  });
  t = await run([{ m: M, pages: [textPage(1, 2400)] }], i => "cut0");
  await okA("step: a one-block page cut short without a whole unit cannot be halved → as before: invalid_json, 1 request, knowledge_missing + outline_truncated", async () => {
    assert.equal(t.thrown && t.thrown.code, "invalid_json"); assert.equal(t.calls.length, 1); assert.equal(t.r.spent, 1);
    const g = issuesOf(t.docsOf(M.id)); assert.ok(g.includes("knowledge_missing") && g.includes("outline_truncated"));
  });
  t = await run([{ m: M, pages: eightText }], (i, k) => nPages(i) === 5 && k === 1 ? "cut" : (k === 3 ? "http" : "ok"));
  await okA("step: a half fails with a network-like error: the step fails, the first half is saved; Continue asks only the failed half (no new repeat budget, no re-ask of the cut chunk)", async () => {
    assert.equal(t.thrown && t.thrown.code, "upstream_error"); const retries = t.r.cache.retries.get(M.id), before = t.calls.length;
    const again = await t.again(); assert.equal(again, null); assert.equal(t.r.cache.retries.get(M.id), retries);
    const sizes = t.calls.slice(before).map(nPages); assert.ok(sizes.length >= 1 && sizes.every(s => s < 5), JSON.stringify(sizes));
    assert.deepEqual(extracted(t.docsOf(M.id)).map(u => u.id).sort(), wholeIds(M, eightText));
  });

  const huge = Array.from({ length: 400 }, (_, i) => textPage(i + 1, 2000));
  t = await run([{ m: M, pages: huge }], i => "ok");
  await okA("step: a material that needs more than 80 chunks (400 pages of 2000 characters) → an explicit error before any request: 0 requests, 0 spent, nothing written", async () => {
    assert.equal(t.thrown && t.thrown.code, "material_too_large"); assert.equal(t.thrown.n, 400); assert.equal(t.thrown.max, 80); assert.equal(t.calls.length, 0); assert.equal(t.r.spent, 0); assert.equal(t.written.size, 0);
    assert.equal(t.thrown.name, "Material A");
  });
  t = await run([{ m: M, pages: Array.from({ length: 80 }, (_, i) => textPage(i + 1, 2000)) }], i => "ok");
  await okA("step: exactly 80 chunks is allowed (80 requests)", async () => { assert.equal(t.thrown, null); assert.equal(t.calls.length, 80); assert.equal(t.r.spent, 80); });
  t = await run([{ m: M, pages: Array.from({ length: 81 }, (_, i) => textPage(i + 1, 2000)) }], i => "ok");
  await okA("step: 81 chunks is refused (the limit is per material)", async () => { assert.equal(t.thrown && t.thrown.code, "material_too_large"); assert.equal(t.calls.length, 0); });
  t = await run([{ m: M, pages: eightText }, { m: { ...M, id: "mat-b", role: "extra" }, pages: Array.from({ length: 81 }, (_, i) => textPage(i + 1, 2000)) }], i => "ok");
  await okA("step: the second material is too large: no request is sent for the first one either", async () => { assert.equal(t.thrown && t.thrown.code, "material_too_large"); assert.equal(t.calls.length, 0); assert.equal(t.r.spent, 0); });

  console.log("\nRESULT: " + n + " checks\nALL CHUNK TESTS PASSED");
})().catch(e => { console.error(e); process.exitCode = 1; });
