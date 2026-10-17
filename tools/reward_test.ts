// Run: npx --yes deno run --allow-read --allow-env --allow-net --allow-sys --allow-ffi tools/reward_test.ts   (or deno run …)
// Checks supabase/reward.sql (the weekly reward = 1st place of last week's rating) on a real Postgres (PGlite, in memory), on top of the
// real rating.sql and the real public.ai_bonus table from ai.sql. Only auth.* and the roles are stand-ins.
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const read = (p: string) => Deno.readTextFileSync(new URL("../supabase/" + p, import.meta.url));
const rating = read("rating.sql"), reward = read("reward.sql"), rollback = read("reward_rollback.sql"), ai = read("ai.sql");
const slice = (s: string, from: string, to: string) => { const a = s.indexOf(from), b = s.indexOf(to, a); if (a < 0 || b < 0) throw new Error("ai.sql changed: " + from); return s.slice(a, b); };

const db = new PGlite();
let fails = 0, passes = 0;
const ok = (name: string, c: boolean, extra = "") => { console.log((c ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); if (c) passes++; else fails++; };
const id = (n: number) => "00000000-0000-0000-0000-" + n.toString(16).padStart(12, "0");
const LW = "2026-10-12";   // Monday of the rated week; "today" is Thursday 2026-10-22 (the week of 19..25), so the last full week is 12..18

await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth; create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  create schema private;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  grant usage on schema private to anon, authenticated;
`);
await db.exec(slice(ai, "create table if not exists public.ai_bonus", "alter table public.ai_usage"));   // the real bonus table + its policy
async function tryExec(s: string): Promise<string> { try { await db.exec(s); return ""; } catch (e: any) { return String(e.message); } }
const e0 = await tryExec(rating);
ok("rating.sql runs (precondition)", e0 === "", e0);
const e1 = await tryExec(reward), e2 = await tryExec(reward);
ok("reward.sql runs twice without errors", e1 === "" && e2 === "", e1 + e2);

type R = { ok: boolean; code?: string; msg?: string; rows?: any[] };
async function runAs(role: string | null, uid: string | null, sql: string): Promise<R> {
  await db.exec(role ? `set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false);` : `reset role; select set_config('request.jwt.claim.sub', '', false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e: any) { return { ok: false, code: e.code, msg: String(e.message) }; }
  finally { await db.exec("reset role"); }
}
const sql = (s: string) => runAs(null, null, s);
const award = async (uid: string) => { const r = await runAs("authenticated", uid, `select public.corpus_week_award() r`); if (!r.ok) throw new Error(r.msg); return r.rows![0].r; };
const setToday = (d: string) => db.exec(`create or replace function private.rating_today() returns date language sql stable set search_path = '' as $$ select date '${d}' $$`);
const awards = async () => (await sql(`select week_start::text ws, user_id, units, answers, good, days from private.ai_awards order by week_start`)).rows!;
const bal = async (u: string) => Number((await sql(`select coalesce((select balance from public.ai_bonus where user_id = '${u}'), 0) b`)).rows![0].b);

// people: id, email, week row (answers, correct, days, points), profile mode
type P = { n: number; email: string; ans: number; ok: number; days: number; pts: number; mode?: string; alias?: string };
const people: Record<string, P> = {
  hidden: { n: 1, email: "hid.den@x.ee", ans: 300, ok: 290, days: 5, pts: 290, mode: "hidden" },     // best, but hidden
  low: { n: 2, email: "low.acc@x.ee", ans: 400, ok: 200, days: 5, pts: 200 },                         // 50%: not allowed
  twod: { n: 3, email: "two.days@x.ee", ans: 200, ok: 190, days: 2, pts: 190 },                       // 2 days: not allowed
  few: { n: 4, email: "few.ans@x.ee", ans: 29, ok: 29, days: 4, pts: 29 },                            // 29 answers: not allowed
  anon: { n: 5, email: "ann.anon@x.ee", ans: 100, ok: 80, days: 4, pts: 80 },                         // the winner, anonymous
  real: { n: 6, email: "rea.lone@x.ee", ans: 100, ok: 70, days: 3, pts: 70, mode: "real" },           // exactly 70% and 3 days: allowed, 2nd
  nopr: { n: 7, email: "no.profile@x.ee", ans: 60, ok: 42, days: 3, pts: 42 },                        // no profile: anon, 3rd
};
for (const [k, p] of Object.entries(people)) {
  await sql(`insert into auth.users values ('${id(p.n)}', '${p.email}')`);
  await sql(`insert into public.rating_week (user_id, week_start, answers, correct, active_days, points) values ('${id(p.n)}', '${LW}', ${p.ans}, ${p.ok}, ${p.days}, ${p.pts})`);
  if (p.mode) await sql(`insert into public.rating_profile (user_id, mode, asked) values ('${id(p.n)}', '${p.mode}', true)`);
}
// other weeks must not count: a monster this week and a monster two weeks ago
await sql(`insert into auth.users values ('${id(20)}', 'other.week@x.ee')`);
await sql(`insert into public.rating_week (user_id, week_start, answers, correct, active_days, points) values ('${id(20)}', '2026-10-19', 400, 400, 6, 900), ('${id(20)}', '2026-10-05', 400, 400, 6, 900)`);
const U = (k: string) => id(people[k].n);
const OBS = id(30); await sql(`insert into auth.users values ('${OBS}', 'observer@x.ee')`);

// ---- permissions ----
{
  const a = await runAs("anon", null, `select public.corpus_week_award()`);
  ok("anon cannot execute corpus_week_award (42501)", !a.ok && a.code === "42501" && /permission denied/.test(a.msg!), a.code + " " + a.msg);
  const n = await runAs("authenticated", null, `select public.corpus_week_award() r`);
  ok("authenticated without uid: week null, nothing written", n.ok && n.rows![0].r.week === null && (await awards()).length === 0, JSON.stringify(n.rows));
  const x = await runAs("authenticated", U("anon"), `select * from private.ai_awards`);
  ok("a client cannot read private.ai_awards", !x.ok && x.code === "42501", x.code);
  const pr = (await sql(`select has_function_privilege('anon', 'public.corpus_week_award()', 'execute') a, has_function_privilege('authenticated', 'public.corpus_week_award()', 'execute') u,
     has_function_privilege('public', 'public.corpus_week_award()', 'execute') p`)).rows![0];
  ok("execute only for authenticated", !pr.a && pr.u && !pr.p, JSON.stringify(pr));
}

// ---- the first call of the week ----
await setToday("2026-10-22");
let a = await award(OBS);
ok("the first call closes last week: week is last Monday", a.week === LW, JSON.stringify(a));
ok("the winner is the leader by points among the allowed (hidden, 50%, 2 days, 29 answers are out)", (await awards())[0].user_id === U("anon"), JSON.stringify(await awards()));
ok("the observer is not the winner: me false, fresh true, units 20, balance 0", a.me === false && a.fresh === true && a.units === 20 && a.balance === 0, JSON.stringify(a));
ok("winner is «Студент» for anon (no email, no '@')", a.winner === "Студент" && !JSON.stringify(a).includes("@") && !/ann|anon/i.test(a.winner), JSON.stringify(a));
ok("the winner's balance grew by ai_week_reward (20), once", (await bal(U("anon"))) === 20);
const row = (await awards())[0];
ok("the award row keeps the numbers of the week", row.units === 20 && row.answers === 100 && row.good === 80 && row.days === 4, JSON.stringify(row));
{
  const w = await runAs("authenticated", U("anon"), `update public.ai_bonus set balance = 999 where user_id = '${U("anon")}'`);
  ok("a client cannot raise their own bonus (denied or no row changed)", (await bal(U("anon"))) === 20, w.code + " " + w.msg);
}
a = await award(OBS);
ok("second call: fresh false, same winner, no second award", a.fresh === false && a.week === LW && a.units === 20 && (await bal(U("anon"))) === 20 && (await awards()).length === 1, JSON.stringify(a));
a = await award(U("anon"));
ok("the winner sees me true, balance 20, fresh false", a.me === true && a.fresh === false && a.balance === 20 && a.winner === "Студент", JSON.stringify(a));
a = await award(U("anon"));
ok("…and the balance does not grow on repeat", a.balance === 20 && (await bal(U("anon"))) === 20);
{
  const lo = await award(U("real"));
  ok("another person: me false, own balance 0", lo.me === false && lo.balance === 0 && lo.units === 20);
}

// ---- the winner's name follows the rating name ----
await sql(`insert into public.rating_profile (user_id, mode, asked) values ('${U("anon")}', 'real', true) on conflict (user_id) do update set mode = 'real', asked = true`);
a = await award(OBS);
ok("winner who chose «real» shows the rating name (Ann A.), still no '@'", a.winner === "Ann A." , JSON.stringify(a.winner));
ok("…the answer has no '@' and no email", !JSON.stringify(a).includes("@") && !JSON.stringify(a).includes("anon"), JSON.stringify(a));
await sql(`insert into public.rating_profile (user_id, mode, alias, asked) values ('${U("anon")}', 'alias', 'Nick', true) on conflict (user_id) do update set mode = 'alias', alias = 'Nick', asked = true`);
ok("alias winner shows the nickname", (await award(OBS)).winner === "Nick");
await sql(`delete from public.rating_profile where user_id = '${U("anon")}'`);

// ---- the next week: the next allowed person; hidden never wins; a different rule set ----
await setToday("2026-10-29");     // last full week is now 19..25
await sql(`delete from public.rating_week where week_start = '2026-10-19' and user_id = '${id(20)}'`);
for (const k of ["hidden", "real", "nopr"]) await sql(`insert into public.rating_week (user_id, week_start, answers, correct, active_days, points) values ('${U(k)}', '2026-10-19', ${k === "hidden" ? 400 : 100}, ${k === "hidden" ? 400 : 90}, 5, ${k === "hidden" ? 150 : k === "real" ? 90 : 90})`);
a = await award(OBS);
ok("next week: hidden (150 points) does not win; tie on points 90 -> more answers equal -> lower user id (real, n=6)", a.week === "2026-10-19" && (await awards())[1].user_id === U("real"), JSON.stringify(await awards()));
ok("…real winner shows the rating name, no '@'", /^Rea/.test(a.winner) && !JSON.stringify(a).includes("@"), JSON.stringify(a.winner));
ok("…balance of the second winner is 20", (await bal(U("real"))) === 20 && (await bal(U("anon"))) === 20);

// ---- nobody fits ----
await setToday("2026-11-05");     // last week 26.10..01.11: no rows at all
a = await award(OBS);
ok("nobody fits: units 0, winner null, me false, fresh true", a.week === "2026-10-26" && a.units === 0 && a.winner === null && a.me === false && a.fresh === true, JSON.stringify(a));
ok("…the award row has user_id null, units 0", (await awards())[2].user_id === null && (await awards())[2].units === 0, JSON.stringify(await awards()));
// rows that appear after the closing are not looked at again
await sql(`insert into public.rating_week (user_id, week_start, answers, correct, active_days, points) values ('${U("anon")}', '2026-10-26', 100, 100, 5, 100)`);
const before = await bal(U("anon"));
a = await award(OBS);
ok("a closed week is not searched again: still nobody, fresh false, no bonus", a.fresh === false && a.units === 0 && a.winner === null && (await bal(U("anon"))) === before && (await awards()).length === 3, JSON.stringify(a));

// ---- all rows are rejected or out of the rules: nobody wins ----
await setToday("2026-11-12");
for (const [k, v] of [["a", [29, 29, 5]], ["b", [100, 69, 5]], ["c", [100, 100, 2]]] as const) {
  const u = id(60 + k.charCodeAt(0)); await sql(`insert into auth.users values ('${u}', '${k}.x@x.ee')`);
  await sql(`insert into public.rating_week (user_id, week_start, answers, correct, active_days, points) values ('${u}', '2026-11-02', ${v[0]}, ${v[1]}, ${v[2]}, ${v[1]})`);
}
a = await award(OBS);
ok("29 answers / 69% / 2 days: nobody", a.units === 0 && a.winner === null && a.week === "2026-11-02", JSON.stringify(a));

// ---- the reward size is read from private.settings ----
await sql(`insert into private.settings (key, value) values ('ai_week_reward', '35') on conflict (key) do update set value = '35'`);
await setToday("2026-11-19");
{
  const u = id(80); await sql(`insert into auth.users values ('${u}', 'size.test@x.ee')`);
  await sql(`insert into public.rating_week (user_id, week_start, answers, correct, active_days, points) values ('${u}', '2026-11-09', 50, 50, 3, 50)`);
  const b0 = await bal(u);
  a = await award(u);
  ok("ai_week_reward 35 is paid", a.me === true && a.units === 35 && (await bal(u)) === b0 + 35 && a.balance === 35, JSON.stringify(a));
}

// ---- the real week boundary uses Tallinn time through rating_today() ----
{
  const src = reward.replace(/--.*$/gm, "");
  ok("corpus_week_award uses private.rating_today(), not now()", /function public\.corpus_week_award[\s\S]*private\.rating_today\(\)/.test(src) && !/\bnow\(\)/.test(src.slice(src.indexOf("function public.corpus_week_award"))));
  ok("the old activity data are not used", !/public\.activity|public\.docs/.test(src));
}

// ---- rollback: the old function comes back (needs its tables only when called) ----
const r1 = await tryExec(rollback), r2 = await tryExec(rollback);
ok("reward_rollback.sql runs twice without errors", r1 === "" && r2 === "", r1 + r2);
ok("…it restores the old function (reads public.docs)", (await sql(`select prosrc ~ 'public\\.docs' as old from pg_proc where proname = 'corpus_week_award'`)).rows![0].old === true);
const e3 = await tryExec(reward);
ok("reward.sql can be applied again after the rollback", e3 === "" && (await sql(`select prosrc ~ 'rating_week' as n from pg_proc where proname = 'corpus_week_award'`)).rows![0].n === true, e3);

console.log(`${passes} PASS, ${fails} FAIL`);
console.log(fails ? "FAILED " + fails : "ALL PASSED");
Deno.exit(fails ? 1 : 0);
