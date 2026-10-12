// Run: npx --yes deno run --allow-read --allow-env --allow-net --allow-sys --allow-ffi tools/ai_quota_test.ts   (or deno run …)
// Checks the AI limits of supabase/ai.sql on a real Postgres (PGlite, in memory): the course allowance (corpus_ai_take_course) that is
// spent first, then the daily allowance (corpus_ai_take), the site-wide course cap, granted requests, and who may read or change what.
// Only auth.* and the roles are stand-ins; ai.sql itself is run as it is, twice (it must be safe to run again).
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const read = (p: string) => Deno.readTextFileSync(new URL("../supabase/" + p, import.meta.url));
const ai = read("ai.sql");

const db = new PGlite();
let fails = 0;
const ok = (name: string, c: boolean, extra = "") => { console.log((c ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); if (!c) fails++; };

const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b", C = "00000000-0000-0000-0000-00000000000c";
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  insert into auth.users values ('${A}'), ('${B}'), ('${C}');
  create schema private; revoke all on schema private from public, anon, authenticated;
`);
await db.exec(ai);
await db.exec(ai);                                                                                        // safe to run again

type R = { ok: boolean; code?: string; msg?: string; rows?: any[] };
// run one statement as a signed-in person (uid), as the anonymous role ("anon"), or as the service key / SQL Editor (null)
async function run(who: string | null, sql: string): Promise<R> {
  if (who === "anon") await db.exec(`set role anon; select set_config('request.jwt.claim.sub', '', false);`);
  else if (who) await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${who}', false);`);
  else await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e: any) { return { ok: false, code: e.code, msg: String(e.message) }; }
  finally { await db.exec("reset role"); }
}
const set = (k: string, v: string) => run(null, `insert into private.settings (key, value) values ('${k}', '${v}') on conflict (key) do update set value = excluded.value`);
const course = async (who: string | null, n: number | string = 1) => (await run(who, `select public.corpus_ai_take_course(${n}) as r`));
const take = async (who: string, n: number | string = 1) => { const r = await course(who, n); return r.ok ? r.rows![0].r : { error: r.code + " " + r.msg }; };
const one = async (sql: string) => (await run(null, sql)).rows![0];
const has = (o: any, p: Record<string, unknown>) => Object.entries(p).every(([k, v]) => o[k] === v);

// ---- what ai.sql leaves behind ----
let r: any = await one(`select (select value from private.settings where key = 'ai_course_free') as free, (select value from private.settings where key = 'ai_course_global_daily') as glob`);
ok("the settings start at 300 course requests per person and 3000 per day for the site", r.free === "300" && r.glob === "3000", JSON.stringify(r));
await set("ai_course_free", "3"); await set("ai_free_daily", "2");
r = await one(`select count(*)::int n from pg_policies where tablename = 'ai_course'`);
ok("ai.sql run twice leaves one policy on ai_course", r.n === 1, JSON.stringify(r));

// ---- the course allowance first, then the daily one ----
let t = await take(A);
ok("the first request is paid from the course allowance (pool course, 2 left of 3)", has(t, { ok: true, pool: "course", course_left: 2, course_free: 3, used: 0 }), JSON.stringify(t));
t = await take(A); t = await take(A);
ok("…the third uses it up; the daily allowance is untouched", has(t, { ok: true, pool: "course", course_left: 0, used: 0, limit: 2 }), JSON.stringify(t));
t = await take(A);
ok("then the daily allowance pays (pool daily, 1 of 2 used), the course allowance stays at 0", has(t, { ok: true, pool: "daily", course_left: 0, course_free: 3, used: 1 }), JSON.stringify(t));
t = await take(A);
ok("…the second daily request", has(t, { ok: true, pool: "daily", used: 2 }), JSON.stringify(t));
t = await take(A);
ok("when both are used up the request is refused (ok false, pool daily), nothing changes", has(t, { ok: false, pool: "daily", used: 2, course_left: 0 }), JSON.stringify(t));
r = await one(`select used from public.ai_course where user_id = '${A}'`);
ok("the refused request did not touch the course count (3)", r.used === 3, JSON.stringify(r));

// ---- granted requests, and the course allowance does not depend on the daily one ----
await run(null, `insert into public.ai_course (user_id, granted) values ('${A}', 2) on conflict (user_id) do update set granted = excluded.granted`);
t = await take(A);
ok("granted requests are added: paid from the course allowance although the daily one is used up (1 left of 5)", has(t, { ok: true, pool: "course", course_left: 1, course_free: 5, used: 2 }), JSON.stringify(t));
t = await take(A, 0);
ok("p_units 0 only reports: pool null, the course and daily numbers, nothing is taken", has(t, { ok: true, pool: null, course_left: 1, course_free: 5, used: 2, limit: 2 }), JSON.stringify(t));
t = await take(A, 0); t = await take(A, 0);
r = await one(`select (select used from public.ai_course where user_id = '${A}') as cu, (select sum(used)::int from public.ai_usage where user_id = '${A}') as du`);
ok("…and repeating it changes nothing (course used 4, daily used 2)", r.cu === 4 && r.du === 2, JSON.stringify(r));
t = await take(A);
ok("the last granted request is paid from the course allowance", has(t, { ok: true, pool: "course", course_left: 0 }), JSON.stringify(t));
t = await take(A);
ok("then the daily allowance is the only one left, and it is used up: refused", has(t, { ok: false, pool: "daily", course_left: 0 }), JSON.stringify(t));

// ---- people stay apart ----
t = await take(B);
ok("another person has a course allowance of their own (2 left of 3) and a daily one", has(t, { ok: true, pool: "course", course_left: 2, course_free: 3, used: 0 }), JSON.stringify(t));
r = await run(B, `select user_id, used, granted from public.ai_course`);
ok("a person reads only their own course row", r.ok && r.rows!.length === 1 && r.rows![0].user_id === B && r.rows![0].used === 1, JSON.stringify(r.rows));
r = await run(B, `select count(*)::int n from public.ai_course where user_id = '${A}'`);
ok("…and none of someone else's", r.ok && r.rows![0].n === 0, JSON.stringify(r));

// ---- the site-wide course cap of the day ----
await run(null, `delete from private.ai_course_global`);
await set("ai_course_global_daily", "2");
t = await take(B);   // B used 1 of 3 before; this is the first request counted for the site today
ok("under the site-wide cap the course allowance pays (1 of 2 for the site)", has(t, { ok: true, pool: "course", course_left: 1 }), JSON.stringify(t));
t = await take(C);
ok("…the second request of the day for the site is the last", has(t, { ok: true, pool: "course", course_left: 2 }), JSON.stringify(t));
t = await take(B);
ok("over the cap the daily allowance pays instead (pool daily); the course allowance of the person is not touched (1 left)", has(t, { ok: true, pool: "daily", course_left: 1, used: 1 }), JSON.stringify(t));
r = await one(`select (select used from public.ai_course where user_id = '${B}') as bu, (select used from private.ai_course_global) as gu`);
ok("…B has used 2 course requests, the site count stays at the cap (2)", r.bu === 2 && r.gu === 2, JSON.stringify(r));
await set("ai_course_global_daily", "3000");
t = await take(B);
ok("with the cap raised the course allowance pays again", has(t, { ok: true, pool: "course", course_left: 0 }), JSON.stringify(t));

// ---- the daily site-wide cap is the daily pool's business, not the course pool's ----
await set("ai_global_daily", "0");
t = await take(C);
ok("when the daily site cap is used up the course allowance still pays", has(t, { ok: true, pool: "course", course_left: 1 }), JSON.stringify(t));
r = await one(`select coalesce(sum(used), 0)::int n from private.ai_global`);
ok("…and course requests are not counted in the daily site total (only the 3 daily requests of A and B are)", r.n === 3, JSON.stringify(r));
await set("ai_global_daily", "300");

// ---- a setting that is not a number never blocks anybody ----
await set("ai_course_free", "lots"); await set("ai_course_global_daily", "many");
t = await take(C, 0);
ok("course_free that is not a number falls back to 300 (plus granted 0)", has(t, { pool: null, course_free: 300, course_left: 300 - 2 }), JSON.stringify(t));
t = await take(C);
ok("a global cap that is not a number falls back to 3000: the course allowance pays", has(t, { ok: true, pool: "course" }), JSON.stringify(t));
await set("ai_course_free", "3"); await set("ai_course_global_daily", "3000");

// ---- wrong calls ----
for (const bad of [-1, 21, "null"]) {
  const x = await course(A, bad);
  ok("p_units " + bad + " is refused (22023)", !x.ok && x.code === "22023", x.code + " " + x.msg);
}
let x = await course(null, 1);
ok("without a signed-in person it is refused (28000)", !x.ok && x.code === "28000", x.code + " " + x.msg);
x = await course("anon", 1);
ok("the anonymous role cannot call it (42501)", !x.ok && x.code === "42501", x.code + " " + x.msg);
x = await course("anon", 0);
ok("…not even to look (42501)", !x.ok && x.code === "42501", x.code + " " + x.msg);

// ---- nobody changes the numbers from outside ----
x = await run(A, `update public.ai_course set granted = 1000 where user_id = '${A}'`);
ok("a person cannot raise their own granted requests (42501)", !x.ok && x.code === "42501", x.code);
x = await run(A, `update public.ai_course set used = 0 where user_id = '${A}'`);
ok("…cannot reset their used count (42501)", !x.ok && x.code === "42501", x.code);
x = await run(C, `insert into public.ai_course (user_id, granted) values ('${C}', 1000) on conflict (user_id) do update set granted = excluded.granted`);
ok("…cannot write a row of their own (42501)", !x.ok && x.code === "42501", x.code);
x = await run(A, `delete from public.ai_course where user_id = '${A}'`);
ok("…cannot delete their row to start again (42501)", !x.ok && x.code === "42501", x.code);
x = await run("anon", `select * from public.ai_course`);
ok("the anonymous role cannot read the table (42501)", !x.ok && x.code === "42501", x.code);
x = await run(A, `select * from private.ai_course_global`);
ok("the site-wide course count is not readable by users (42501)", !x.ok && x.code === "42501", x.code);
x = await run(A, `select * from private.settings`);
ok("…nor the settings (42501)", !x.ok && x.code === "42501", x.code);
r = await one(`select used, granted from public.ai_course where user_id = '${A}'`);
ok("the numbers of A are as they were (used 5, granted 2)", r.used === 5 && r.granted === 2, JSON.stringify(r));

// ---- run again: nothing is overwritten ----
await set("ai_course_free", "7");
await db.exec(ai);
r = await one(`select (select value from private.settings where key = 'ai_course_free') as free, (select granted from public.ai_course where user_id = '${A}') as g`);
ok("running ai.sql again keeps the settings and the rows", r.free === "7" && r.g === 2, JSON.stringify(r));
t = await take(B, 0);
ok("…and the function still works", has(t, { pool: null, course_free: 7 }), JSON.stringify(t));

// ---- the first part of ai.sql still works: the daily allowance on its own ----
t = await run(C, `select public.corpus_ai_take(1) as r`);
ok("corpus_ai_take (the daily allowance) is as before", t.ok && t.rows![0].r.ok === true && t.rows![0].r.plan === "free" && t.rows![0].r.limit === 2, JSON.stringify(t.rows));

// ---- the rollback (supabase/ai_course_rollback.sql) takes the course allowance away and leaves the daily one ----
const rollback = read("ai_course_rollback.sql");
await db.exec(rollback);
await db.exec(rollback);                                                                                  // safe to run again
r = await one(`select to_regclass('public.ai_course') is null as t1, to_regclass('private.ai_course_global') is null as t2,
  to_regprocedure('public.corpus_ai_take_course(integer)') is null as f, (select count(*)::int from private.settings where key like 'ai_course%') as s`);
ok("rollback (run twice): the function, both tables and the settings are gone", r.t1 && r.t2 && r.f && r.s === 0, JSON.stringify(r));
t = await run(B, `select public.corpus_ai_take(1) as r`);
ok("…and the daily allowance works as before", t.ok && t.rows![0].r.ok === true, JSON.stringify(t.rows));
x = await course(B, 1);
ok("…while the course function no longer exists (42883)", !x.ok && x.code === "42883", x.code + " " + x.msg);
await db.exec(ai);
t = await take(B, 0);
ok("ai.sql after a rollback brings the course allowance back (a fresh 300 for everybody)", has(t, { pool: null, course_free: 300 }) && t.course_left === 300, JSON.stringify(t));

console.log(fails ? "FAILED " + fails : "ALL AI QUOTA TESTS PASSED");
Deno.exit(fails ? 1 : 0);
