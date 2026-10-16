// Run: npx --yes deno run --allow-read --allow-env --allow-net --allow-sys --allow-ffi tools/rating_test.ts   (or deno run …)
// Checks supabase/rating.sql (and rating_rollback.sql) on a real Postgres (PGlite, in memory): the weekly rating tables and functions.
// Only auth.* and the roles are stand-ins.
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const read = (p: string) => Deno.readTextFileSync(new URL("../supabase/" + p, import.meta.url));
const rating = read("rating.sql"), rollback = read("rating_rollback.sql");

const db = new PGlite();
let fails = 0, passes = 0;
const ok = (name: string, c: boolean, extra = "") => { console.log((c ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); if (c) passes++; else fails++; };

const id = (n: number) => "00000000-0000-0000-0000-" + n.toString(16).padStart(12, "0");
const WS = "2026-10-12";   // Monday of the test week; "today" is Thursday 2026-10-15
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth; create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  create schema private; revoke all on schema private from public, anon, authenticated;
`);
await db.exec(rating);
await db.exec(rating);                                   // safe to run again
ok("rating.sql runs twice without errors", true);

type R = { ok: boolean; code?: string; msg?: string; rows?: any[] };
// role "authenticated"/"anon" with a uid (or none), or the superuser (role null = SQL Editor)
async function runAs(role: string | null, uid: string | null, sql: string): Promise<R> {
  await db.exec(role ? `set role ${role}; select set_config('request.jwt.claim.sub', '${uid ?? ""}', false);` : `reset role; select set_config('request.jwt.claim.sub', '', false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e: any) { return { ok: false, code: e.code, msg: String(e.message) }; }
  finally { await db.exec("reset role"); }
}
const run = (uid: string | null, sql: string) => runAs(uid ? "authenticated" : null, uid, sql);
const sql = (s: string) => runAs(null, null, s);
const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const submit = (uid: string, days: any) => run(uid, `select public.corpus_rating_submit(${days === null ? "null" : q(typeof days === "string" ? days : JSON.stringify(days))}::jsonb)`);
const getRaw = async (uid: string, metric = "points") => (await run(uid, `select public.corpus_rating_get(${q(metric)}) r`));
const get = async (uid: string, metric = "points") => { const r = await getRaw(uid, metric); if (!r.ok) throw new Error(r.msg); return r.rows![0].r; };
const week = async (uid: string) => (await sql(`select answers, correct, active_days, points, week_start::text ws from public.rating_week where user_id = '${uid}' order by week_start`)).rows!;
const setToday = (d: string) => db.exec(`create or replace function private.rating_today() returns date language sql stable set search_path = '' as $$ select date '${d}' $$`);

// ---- the real rating_today() follows Tallinn time, not the session's ----
for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC"]) {
  await db.exec(`set timezone = '${tz}'`);
  const r = await sql(`select private.rating_today() = (now() at time zone 'Europe/Tallinn')::date as same`);
  ok("rating_today() is the Tallinn date (session " + tz + ")", r.ok && r.rows![0].same === true, r.msg);
}
await db.exec(`reset timezone`);

// ---- users ----
const U1 = id(1), U2 = id(2), U3 = id(3), NOBODY = id(99);
await sql(`insert into auth.users values ('${U1}', 'user.one@x.ee'), ('${U2}', 'user.two@x.ee'), ('${U3}', 'user.three@x.ee'), ('${NOBODY}', 'no.body@x.ee')`);
await setToday("2026-10-15");

// ---- nothing is open to clients ----
for (const [role, uid] of [["authenticated", U1], ["anon", null]] as const) {
  for (const t of ["rating_profile", "rating_week"]) {
    const stmts: Record<string, string> = {
      select: `select * from public.${t}`,
      insert: t === "rating_profile" ? `insert into public.${t} (user_id) values ('${U1}')` : `insert into public.${t} (user_id, week_start) values ('${U1}', '${WS}')`,
      update: `update public.${t} set user_id = user_id`,
      delete: `delete from public.${t}`,
    };
    for (const [op, s] of Object.entries(stmts)) {
      const r = await runAs(role, uid, s);
      ok(`${role} cannot ${op} ${t} directly (42501)`, !r.ok && r.code === "42501", r.code + " " + r.msg);
    }
  }
}
for (const f of ["corpus_rating_submit('{}'::jsonb)", "corpus_rating_set_profile('real')", "corpus_rating_get('points')", "corpus_rating_delete_mine()"]) {
  const r = await runAs("anon", null, `select public.${f}`);
  ok("anon cannot execute " + f.split("(")[0] + " (42501)", !r.ok && r.code === "42501", r.code);
  const r2 = await runAs("authenticated", null, `select public.${f}`);
  ok("no uid -> not_signed_in (42501) in " + f.split("(")[0], !r2.ok && r2.code === "42501" && /not_signed_in/.test(r2.msg!), r2.code + " " + r2.msg);
}
for (const f of ["private.rating_name('" + U1 + "')", "private.rating_today()", "private.rating_ranked('points', date '2026-10-12')"]) {
  const r = await run(U1, `select * from ${f}`);
  ok("a client cannot call " + f.split("(")[0], !r.ok && r.code === "42501", r.code);
}

// ---- submit ----
let r = await submit(U1, {
  "2026-10-11": { n: 50, ok: 50 },            // last Sunday: another week
  "2026-10-12": { n: 10, ok: 5 },
  "2026-10-15": { n: 500, ok: 600 },          // n -> 400, ok -> n
  "2026-10-16": { n: 20, ok: 20 },            // tomorrow
  "2026-11-30": { n: 20, ok: 20 },
});
ok("submit works", r.ok, r.msg);
let w = await week(U1);
ok("days outside the week and in the future are ignored; n capped at 400; ok capped at n", w.length === 1 && w[0].ws === WS && w[0].answers === 410 && w[0].correct === 405 && w[0].active_days === 2, JSON.stringify(w));
ok("points use at most 150 correct a day", w[0].points === 5 + 150, JSON.stringify(w));
const prof = (await sql(`select mode, asked from public.rating_profile where user_id = '${U1}'`)).rows!;
ok("submit creates a profile (real, not asked)", prof.length === 1 && prof[0].mode === "real" && prof[0].asked === false, JSON.stringify(prof));

await submit(U2, { "2026-10-13": { n: 300, ok: 300 } });
w = await week(U2);
ok("300 correct in a day: points 150, answers 300", w[0].points === 150 && w[0].answers === 300 && w[0].correct === 300, JSON.stringify(w));
await submit(U2, { "2026-10-13": { n: 20, ok: 10 } });
w = await week(U2);
ok("a second submit replaces, does not add", w.length === 1 && w[0].answers === 20 && w[0].correct === 10 && w[0].points === 10 && w[0].active_days === 1, JSON.stringify(w));

const junk: [string, any][] = [
  ["a string", '"abc"'], ["an array", "[1,2,3]"], ["a number", "5"], ["null (json)", "null"], ["sql null", null], ["empty object", "{}"],
  ["bad date key", { abc: { n: 1, ok: 1 } }], ["impossible date", { "2026-13-45": { n: 1, ok: 1 } }], ["date with time", { "2026-10-13T10:00": { n: 1, ok: 1 } }],
  ["value is a string", { "2026-10-13": "x" }], ["n is a string", { "2026-10-13": { n: "a", ok: 1 } }], ["ok missing", { "2026-10-13": { n: 4 } }],
  ["negative numbers", { "2026-10-13": { n: -5, ok: -1 } }], ["fractions", { "2026-10-13": { n: 2.9, ok: 1.5 } }],
  ["enormous numbers", '{"2026-10-13":{"n":1e999,"ok":1e999}}'], ["nested garbage", { "2026-10-13": { n: { a: 1 }, ok: [1] } }],
];
const GJ = id(50); await sql(`insert into auth.users values ('${GJ}', 'junk@x.ee')`);
for (const [name, v] of junk) {
  const r = await submit(GJ, v);
  ok("garbage does not crash: " + name, r.ok, r.msg);
}
await submit(GJ, { "2026-10-13": { n: -5, ok: -1 } });
w = await week(GJ);
ok("negative numbers count as zero", w.length === 1 && w[0].answers === 0 && w[0].active_days === 0 && w[0].points === 0, JSON.stringify(w));
await submit(GJ, { "2026-10-13": { n: 2.9, ok: 1.5 } });
w = await week(GJ);
ok("fractions are rounded down", w[0].answers === 2 && w[0].correct === 1, JSON.stringify(w));
await submit(GJ, '{"2026-10-13":{"n":1e999,"ok":1e999}}');
w = await week(GJ);
ok("enormous numbers are capped", w[0].answers === 400 && w[0].correct === 400 && w[0].points === 150, JSON.stringify(w));
await sql(`delete from public.rating_week where user_id = '${GJ}'`);

// old rows are cleaned up (older than 56 days), recent ones stay
await sql(`insert into public.rating_week (user_id, week_start, answers, correct, active_days, points) values ('${U3}', '2026-08-10', 5, 5, 1, 5), ('${U3}', '2026-09-07', 5, 5, 1, 5)`);
await submit(U3, { "2026-10-14": { n: 1, ok: 1 } });
w = await week(U3);
ok("rows older than 56 days are deleted, newer stay", w.map((x) => x.ws).join() === "2026-09-07,2026-10-12", JSON.stringify(w));
await sql(`delete from public.rating_week where user_id = '${U3}'`);

// ---- the week is Monday to Sunday by Tallinn time ----
await setToday("2026-10-19");   // Monday
await submit(U3, { "2026-10-18": { n: 5, ok: 5 }, "2026-10-19": { n: 7, ok: 3 } });
w = await week(U3);
ok("on Monday the new week starts: Sunday is ignored", w.length === 1 && w[0].ws === "2026-10-19" && w[0].answers === 7, JSON.stringify(w));
let g = await get(U3);
ok("get reports the new week and my new numbers", g.week_start === "2026-10-19" && g.me.answers === 7, JSON.stringify(g.me));
g = await get(U1);
ok("last week's results are not in the new week", g.me.answers === 0 && g.total === 1, JSON.stringify(g.me));
await setToday("2026-10-18");   // Sunday
await submit(U3, { "2026-10-18": { n: 5, ok: 5 }, "2026-10-19": { n: 7, ok: 3 } });
w = await week(U3);
ok("on Sunday the week is still the old one: Monday ahead is ignored", w.length === 2 && w[0].ws === "2026-10-12" && w[0].answers === 5, JSON.stringify(w));
await sql(`truncate public.rating_week`);
await setToday("2026-10-15");

// ---- get: the three tables ----
type U = { id: string; name: string; answers: number; correct: number; points: number; mode?: string };
const users: U[] = [];
const L = "abcdefghijklmno";
for (let i = 0; i < 15; i++) {
  const j = i === 13 ? 12 : i;     // user 13 is an exact copy of user 12: a full tie
  const answers = 100 + 7 * j, correct = Math.floor(answers * (50 + ((j * 7) % 15) * 3) / 100);
  users.push({ id: id(100 + i), name: `Person ${L[i].toUpperCase()}.`, answers, correct, points: correct });
}
users.push({ id: id(120), name: "Low U.", answers: 99, correct: 99, points: 99 });                    // 99 answers: no share tables
users.push({ id: id(121), name: "Zero U.", answers: 120, correct: 0, points: 0 });                    // no correct: not in points
users.push({ id: id(122), name: "Hid D.", answers: 500, correct: 500, points: 150, mode: "hidden" }); // hidden: nowhere
const emailOf = (u: U) => u.name.replace(".", "").toLowerCase().replace(" ", ".") + "@x.ee";
for (const u of users) {
  await sql(`insert into auth.users values ('${u.id}', '${emailOf(u)}')`);
  await sql(`insert into public.rating_week (user_id, week_start, answers, correct, active_days, points) values ('${u.id}', '${WS}', ${u.answers}, ${u.correct}, 3, ${u.points})`);
  if (u.mode) await sql(`insert into public.rating_profile (user_id, mode, asked) values ('${u.id}', '${u.mode}', true)`);
}
const val10 = (u: U, m: string) => m === "points" ? u.points * 10 : Math.floor((2000 * (m === "accuracy" ? u.correct : u.answers - u.correct) + u.answers) / (2 * u.answers));   // exact round(x, 1) * 10
function expected(m: string): U[] {
  const el = users.filter((u) => u.mode !== "hidden" && (m === "points" ? u.points > 0 : u.answers >= 100));
  return el.sort((a, b) => (m === "errors" ? val10(a, m) - val10(b, m) : val10(b, m) - val10(a, m)) || b.answers - a.answers || (a.id < b.id ? -1 : 1));
}
const ME = users[7].id;
const all: string[] = [];
for (const m of ["points", "accuracy", "errors"]) {
  const exp = expected(m);
  const raw = await getRaw(ME, m); all.push(JSON.stringify(raw.rows));
  const g = raw.rows![0].r;
  ok(`${m}: total counts only people in the table (${exp.length})`, g.total === exp.length, g.total);
  ok(`${m}: order and ranks of the top 10`, g.top.length === 10 && g.top.every((t: any, i: number) => t.rank === i + 1 && t.name === exp[i].name), JSON.stringify(g.top.map((t: any) => t.name)) + " vs " + exp.slice(0, 10).map((e) => e.name));
  ok(`${m}: values`, g.top.every((t: any, i: number) => Math.round(Number(t.value) * 10) === val10(exp[i], m)), JSON.stringify(g.top.map((t: any) => t.value)));
  const k = exp.indexOf(users[7]);
  const around = exp.slice(Math.max(0, k - 3), k + 4);
  ok(`${m}: me.rank, around is 3 above and 3 below`, g.me.rank === k + 1 && g.me.eligible === true && g.around.map((a: any) => a.name).join() === around.map((a) => a.name).join()
     && g.around.every((a: any, i: number) => a.rank === Math.max(0, k - 3) + i + 1 && a.me === (a.rank === k + 1)), `rank ${g.me.rank} vs ${k + 1}; ${JSON.stringify(g.around.map((a: any) => a.rank + a.name))}`);
  ok(`${m}: no hidden person anywhere`, !JSON.stringify(g).includes("Hid D."));
  const top = await get(exp[0].id, m);
  ok(`${m}: the leader has rank 1 and around of 4`, top.me.rank === 1 && top.around.length === 4 && top.around[0].me === true, JSON.stringify(top.around.map((a: any) => a.rank)));
  const last = await get(exp[exp.length - 1].id, m);
  ok(`${m}: the last has rank ${exp.length} and around of 4`, last.me.rank === exp.length && last.around.length === 4 && last.around[3].me === true, JSON.stringify(last.around.map((a: any) => a.rank)));
}
{
  const ex = expected("points").map((u) => u.name);
  ok("a full tie is stable: the lower user id goes first, in every call", ex.indexOf("Person M.") + 1 === ex.indexOf("Person N.") ? true : ex.indexOf("Person N.") + 1 === ex.indexOf("Person M."), ex.join());
  const g1 = JSON.stringify(await get(ME)), g2 = JSON.stringify(await get(ME));
  ok("the same call gives the same answer", g1 === g2);
}
// the 99/100 threshold
const lowM = await get(id(120), "accuracy");
ok("99 answers: not in accuracy (rank null, eligible false, around empty)", lowM.me.rank === null && lowM.me.eligible === false && lowM.me.value === null && lowM.around.length === 0 && lowM.me.answers === 99, JSON.stringify(lowM.me));
const lowE = await get(id(120), "errors");
ok("99 answers: not in errors either", lowE.me.eligible === false);
const lowP = await get(id(120), "points");
ok("99 answers: but in points", lowP.me.eligible === true && lowP.me.points === 99);
await sql(`update public.rating_week set answers = 100 where user_id = '${id(120)}'`);
ok("100 answers: in accuracy", (await get(id(120), "accuracy")).me.eligible === true);
ok("100 answers: in errors", (await get(id(120), "errors")).me.eligible === true);
await sql(`update public.rating_week set answers = 99 where user_id = '${id(120)}'`);
const zeroP = await get(id(121), "points");
ok("0 points: not in points, but in accuracy", zeroP.me.eligible === false && (await get(id(121), "accuracy")).me.eligible === true);
const hid = await get(id(122), "points");
ok("a hidden person sees themselves as not in the table", hid.me.rank === null && hid.me.eligible === false && hid.me.mode === "hidden" && hid.me.asked === true && hid.me.points === 150, JSON.stringify(hid.me));
const np = await get(NOBODY);
ok("a person with no profile and no data: real, not asked, default name, not in the table", np.me.mode === "real" && np.me.asked === false && np.me.name === "No B." && np.me.rank === null && np.me.eligible === false && np.me.answers === 0 && np.around.length === 0, JSON.stringify(np.me));
const bm = await run(ME, `select public.corpus_rating_get('everything')`);
ok("unknown metric -> bad_metric (22023)", !bm.ok && bm.code === "22023" && /bad_metric/.test(bm.msg!), bm.code);
const bm2 = await run(ME, `select public.corpus_rating_get(null)`);
ok("null metric -> bad_metric (22023)", !bm2.ok && bm2.code === "22023", bm2.code);
const dflt = await run(ME, `select public.corpus_rating_get() r`);
ok("the default metric is points", dflt.ok && dflt.rows![0].r.metric === "points");

// ---- no email, no user id in answers ----
{
  const ser = all.join() + JSON.stringify(await get(NOBODY)) + JSON.stringify(await get(id(122)));
  ok("answers of get contain no '@'", !ser.includes("@"));
  ok("answers of get contain no user id (uuid)", !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(ser));
  const sp = JSON.stringify((await run(ME, `select public.corpus_rating_set_profile('real') r`)).rows);
  ok("set_profile answers contain no '@' or uuid", !sp.includes("@") && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(sp), sp);
}

// ---- names ----
const nameOf = async (email: string | null, n: number) => {
  const u = id(200 + n);
  await sql(`insert into auth.users values ('${u}', ${email === null ? "null" : q(email)})`);
  const r = await run(u, `select public.corpus_rating_set_profile('real') r`);
  return r.ok ? r.rows![0].r.name : r.msg;
};
const names: [string | null, string][] = [
  ["lev.luzin@x.ee", "Lev L."], ["luzinlew@gmail.com", "Luzinlew"], ["ivan_petrov2@x.ee", "Ivan P."], ["", "Студент"], [null, "Студент"],
  ["12345@x.ee", "Студент"], ["anna-maria.kask+tag@x.ee", "Anna M."], ["J.K.Rowling@x.ee", "J K."], ["MARI@x.ee", "Mari"],
];
for (let i = 0; i < names.length; i++) { const n = await nameOf(names[i][0], i); ok(`name of ${JSON.stringify(names[i][0])} is "${names[i][1]}"`, n === names[i][1], n); }

// ---- set_profile ----
const P = id(300); await sql(`insert into auth.users values ('${P}', 'pat.person@x.ee')`);
const sp = (mode: string | null, alias: string | null = null) => run(P, `select public.corpus_rating_set_profile(${mode === null ? "null" : q(mode)}, ${alias === null ? "null" : q(alias)}) r`);
for (const m of ["foo", "", null, "REAL"]) { const r = await sp(m as any); ok(`bad mode ${JSON.stringify(m)} -> bad_mode (22023)`, !r.ok && r.code === "22023" && /bad_mode/.test(r.msg!), r.code + " " + r.msg); }
const badAliases: [string, string | null][] = [["1 character", "a"], ["21 characters", "a".repeat(21)], ["html", "<b>"], ["double quote", 'x"y'], ["single quote", "it's"], ["semicolon", "a;b"], ["emoji", "ab😀"],
  ["null alias", null], ["blanks only", "    "], ["@", "a@b.ee"], ["slash", "a/b"], ["newline", "ab\ncd"]];
for (const [name, a] of badAliases) { const r = await sp("alias", a); ok(`bad alias (${name}) -> bad_alias (22023)`, !r.ok && r.code === "22023" && /bad_alias/.test(r.msg!), r.code + " " + r.msg); }
ok("a refused alias leaves no profile", (await sql(`select count(*)::int n from public.rating_profile where user_id = '${P}'`)).rows![0].n === 0);
let s = await sp("alias", "Костик_2");
ok("alias 'Костик_2' is accepted and used as the name", s.ok && s.rows![0].r.name === "Костик_2" && s.rows![0].r.mode === "alias" && s.rows![0].r.alias === "Костик_2", s.msg + JSON.stringify(s.rows));
s = await sp("alias", "  Anu K.-1 ");
ok("alias is trimmed, letters digits space . _ - allowed", s.ok && s.rows![0].r.alias === "Anu K.-1", s.msg);
s = await sp("alias", "a".repeat(20)); ok("20 characters are fine", s.ok, s.msg);
s = await sp("alias", "ab"); ok("2 characters are fine", s.ok, s.msg);
await sp("alias", "Костик_2");
await sql(`insert into public.rating_week (user_id, week_start, answers, correct, active_days, points) values ('${P}', '${WS}', 10, 10, 1, 10)`);
let gp = await get(P);
ok("get shows the alias as my name; asked is true", gp.me.name === "Костик_2" && gp.me.mode === "alias" && gp.me.asked === true && gp.around.some((t: any) => t.name === "Костик_2" && t.me), JSON.stringify(gp.me));
ok("the email local part is not shown for an alias", !JSON.stringify(gp).includes("Pat"));
s = await sp("hidden", "ignored");
ok("hidden clears the alias", s.ok && s.rows![0].r.alias === null && s.rows![0].r.mode === "hidden", JSON.stringify(s.rows));
ok("…the stored alias is null", (await sql(`select alias from public.rating_profile where user_id = '${P}'`)).rows![0].alias === null);
gp = await get(P);
ok("hidden: not in the table", gp.me.eligible === false && !gp.top.some((t: any) => t.me) && gp.me.name === "Pat P.", JSON.stringify(gp.me));
s = await sp("real", "ignored");
ok("real clears the alias and shows the email name", s.ok && s.rows![0].r.alias === null && s.rows![0].r.name === "Pat P.", JSON.stringify(s.rows));
ok("back to real: in the table again", (await get(P)).me.eligible === true);
await run(P, `select public.corpus_rating_submit('{"2026-10-13":{"n":3,"ok":3}}'::jsonb)`);
ok("submit does not reset the chosen mode", (await get(P)).me.mode === "real" && (await get(P)).me.asked === true);
await sp("hidden");
await run(P, `select public.corpus_rating_submit('{"2026-10-13":{"n":4,"ok":3}}'::jsonb)`);
ok("submit keeps 'hidden'", (await get(P)).me.mode === "hidden");

// ---- delete_mine ----
const before = (await sql(`select count(*)::int n from public.rating_week where user_id <> '${P}'`)).rows![0].n;
const pBefore = (await sql(`select count(*)::int n from public.rating_profile where user_id <> '${P}'`)).rows![0].n;
r = await run(P, `select public.corpus_rating_delete_mine()`);
ok("delete_mine works", r.ok, r.msg);
const mine = (await sql(`select (select count(*) from public.rating_week where user_id = '${P}')::int w, (select count(*) from public.rating_profile where user_id = '${P}')::int p`)).rows![0];
ok("delete_mine erases my rows and my profile", mine.w === 0 && mine.p === 0, JSON.stringify(mine));
ok("…and leaves everybody else's", (await sql(`select count(*)::int n from public.rating_week where user_id <> '${P}'`)).rows![0].n === before && (await sql(`select count(*)::int n from public.rating_profile where user_id <> '${P}'`)).rows![0].n === pBefore);
r = await run(P, `select public.corpus_rating_delete_mine()`);
ok("delete_mine twice is fine", r.ok, r.msg);
ok("after deleting I am back to defaults", (await get(P)).me.mode === "real" && (await get(P)).me.asked === false);

// ---- cascade ----
const CU = id(400); await sql(`insert into auth.users values ('${CU}', 'cas.cade@x.ee')`);
await submit(CU, { "2026-10-13": { n: 1, ok: 1 } });
await run(CU, `select public.corpus_rating_set_profile('alias', 'Cascade')`);
ok("cascade: data exists", (await sql(`select count(*)::int n from public.rating_week where user_id = '${CU}'`)).rows![0].n === 1);
await sql(`delete from auth.users where id = '${CU}'`);
const cas = (await sql(`select (select count(*) from public.rating_week where user_id = '${CU}')::int w, (select count(*) from public.rating_profile where user_id = '${CU}')::int p`)).rows![0];
ok("deleting the user deletes their rating rows and profile", cas.w === 0 && cas.p === 0, JSON.stringify(cas));

// ---- rollback ----
await db.exec(rollback);
await db.exec(rollback);
ok("rating_rollback.sql runs twice without errors", true);
const left = (await sql(`select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname like '%rating%')::int f,
  (select count(*) from pg_class where relname like 'rating_%')::int t`)).rows![0];
ok("rollback removes all functions and tables", left.f === 0 && left.t === 0, JSON.stringify(left));
await db.exec(rating);
ok("rating.sql can be applied again after a rollback", (await run(U1, `select public.corpus_rating_get() r`)).ok);

console.log(`${passes} PASS, ${fails} FAIL`);
console.log(fails ? "FAILED " + fails : "ALL PASSED");
Deno.exit(fails ? 1 : 0);
