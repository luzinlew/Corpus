// Run: npx --yes deno run --allow-read --allow-env --allow-net --allow-sys --allow-ffi tools/quota_test.ts   (or deno run …)
// Checks supabase/quota.sql on a real Postgres (PGlite, in memory): the limits per account on documents and photos, and that the
// docs / storage policies of setup.sql still keep people apart; share codes use the real share.sql. Only auth.* and storage.* are stand-ins; the policies and tables
// under test are taken from setup.sql itself.
import { PGlite } from "npm:@electric-sql/pglite@0.5.8";

const read = (p: string) => Deno.readTextFileSync(new URL("../supabase/" + p, import.meta.url));
const setup = read("setup.sql"), quota = read("quota.sql");
const slice = (s: string, from: string, to: string) => { const a = s.indexOf(from), b = s.indexOf(to, a); if (a < 0 || b < 0) throw new Error("setup.sql changed: " + from); return s.slice(a, b); };

const db = new PGlite();
let fails = 0;
const ok = (name: string, c: boolean, extra = "") => { console.log((c ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); if (!c) fails++; };

const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  insert into auth.users values ('${A}'), ('${B}');
  create schema storage;
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner_id text, metadata jsonb);
  alter table storage.objects enable row level security;
  grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;
  create schema private; revoke all on schema private from public, anon, authenticated;
`);
await db.exec(slice(setup, "create table if not exists public.docs", "-- Recursive merge"));            // the real docs table + its policy
await db.exec(slice(setup, 'drop policy if exists "corpus plates insert"', "-- 3. Sign-up"));            // the real photo policies
await db.exec(read("share.sql"));                                                                         // the real share codes table, policy and functions
await db.exec(quota);
await db.exec(quota);                                                                                     // safe to run again

// run one statement as a signed-in person (uid) or without one (null = the service key / SQL Editor)
async function run(uid: string | null, sql: string): Promise<{ ok: boolean; code?: string; msg?: string; rows?: any[] }> {
  await db.exec(uid ? `set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);` : `reset role; select set_config('request.jwt.claim.sub', '', false);`);
  try { const r = await db.query(sql); return { ok: true, rows: r.rows }; }
  catch (e: any) { return { ok: false, code: e.code, msg: String(e.message) }; }
  finally { await db.exec("reset role"); }
}
const set = (k: string, v: string) => run(null, `update private.settings set value = '${v}' where key = '${k}'`);
const hex = (bytes: number) => `(select string_agg(md5(i::text || random()::text), '') from generate_series(1, ${Math.ceil(bytes / 32)}) i)`;   // does not compress
const ins = (uid: string, id: string, bytes = 10, coll = "t") => run(uid, `insert into public.docs (owner, coll, id, data) values ('${uid}', '${coll}', '${id}', jsonb_build_object('p', ${hex(bytes)}))`);
const count = async (uid: string) => Number((await run(null, `select count(*)::int n from public.docs where owner = '${uid}'`)).rows![0].n);

// ---- one document ----
await set("quota_doc_kb", "100");
let r = await ins(A, "small", 50_000);
ok("document under the limit is saved", r.ok, r.msg);
r = await ins(A, "big", 150_000);
ok("document over the limit is refused (54000)", !r.ok && r.code === "54000", r.code + " " + r.msg);
r = await run(A, `update public.docs set data = jsonb_build_object('p', ${hex(150_000)}) where owner = '${A}' and id = 'small'`);
ok("growing a document past the limit is refused (54000)", !r.ok && r.code === "54000", r.code);
await run(null, `insert into public.docs (owner, coll, id, data) values ('${A}', 't', 'legacy', jsonb_build_object('p', ${hex(150_000)}))`);   // stored before the limit existed
r = await run(A, `update public.docs set data = jsonb_set(data, '{q}', '1') where owner = '${A}' and id = 'legacy'`);
ok("a document already over the limit is refused when it grows", !r.ok && r.code === "54000", r.code);
r = await run(A, `update public.docs set data = jsonb_build_object('p', ${hex(100_000)}) where owner = '${A}' and id = 'legacy'`);
ok("…but may shrink (saving progress keeps working)", r.ok, r.msg);
await run(null, `delete from public.docs where owner = '${A}'`);
await set("quota_doc_kb", "1024");

// ---- number of documents ----
await set("quota_docs_count", "3");
for (const id of ["d1", "d2", "d3"]) await ins(A, id);
r = await ins(A, "d4");
ok("fourth document is refused (53400)", !r.ok && r.code === "53400" && /user_quota_exceeded/.test(r.msg!), r.code + " " + r.msg);
ok("…and nothing was stored", (await count(A)) === 3);
r = await run(A, `insert into public.docs (owner, coll, id, data) values ('${A}', 't', 'e1', '{}'), ('${A}', 't', 'e2', '{}')`);
ok("a batch that does not fit is refused as a whole", !r.ok && r.code === "53400" && (await count(A)) === 3, r.code);
r = await run(A, `insert into public.docs (owner, coll, id, data) values ('${A}', 't', 'd1', '{"n":2}') on conflict (owner, coll, id) do update set data = excluded.data`);
ok("an upsert of an existing document still works at the limit", r.ok, r.msg);
r = await ins(B, "b1");
ok("another account is not affected", r.ok, r.msg);
r = await run(A, `delete from public.docs where owner = '${A}' and id = 'd3'`);
r = await ins(A, "d4");
ok("after deleting one, a new document fits", r.ok, r.msg);
r = await run(null, `insert into public.docs (owner, coll, id, data) values ('${A}', 't', 'svc', '{}')`);
ok("a write without a signed-in person (service key / SQL Editor) is not limited", r.ok && (await count(A)) === 4, r.msg);
r = await run(A, `update public.docs set data = '{"n":3}' where owner = '${A}' and id = 'd1'`);
ok("over the limit, an update that does not grow a document still works", r.ok, r.msg);
r = await run(A, `update public.docs set data = jsonb_build_object('p', ${hex(5000)}) where owner = '${A}' and id = 'd1'`);
ok("…but one that makes a document bigger is refused (53400)", !r.ok && r.code === "53400", r.code);
await run(null, `delete from public.docs`);
await set("quota_docs_count", "20000");

// ---- total size of documents ----
await set("quota_docs_mb", "1");
await ins(A, "m1", 400_000); await ins(A, "m2", 400_000);
r = await ins(A, "m3", 400_000);
ok("documents over the total size are refused (53400)", !r.ok && r.code === "53400", r.code);
r = await run(A, `update public.docs set data = jsonb_build_object('p', ${hex(700_000)}) where owner = '${A}' and id = 'm1'`);
ok("growing a document past the total size is refused (53400)", !r.ok && r.code === "53400", r.code);
await run(null, `delete from public.docs`);
await set("quota_docs_mb", "50");

// ---- a typo in the settings never blocks writes ----
await set("quota_docs_count", "lots");
r = await ins(A, "t1");
ok("a setting that is not a number falls back to the default", r.ok, r.msg);
await set("quota_docs_count", "20000");

// ---- the people stay apart (setup.sql policies) ----
r = await run(B, `select count(*)::int n from public.docs where owner = '${A}'`);
ok("another account sees none of the documents", r.ok && r.rows![0].n === 0);
r = await run(B, `insert into public.docs (owner, coll, id, data) values ('${A}', 't', 'x', '{}')`);
ok("…and cannot write into them", !r.ok && r.code === "42501", r.code);

// ---- photos ----
const photo = (uid: string, name: string, size: number) => run(uid, `insert into storage.objects (bucket_id, name, owner_id, metadata) values ('plates', '${name}', '${uid}', '{"size": ${size}}')`);
await set("quota_photos_count", "2");
r = await photo(A, "p1", 1000); const r2 = await photo(A, "p2", 1000);
ok("photos under the count limit are accepted", r.ok && r2.ok, r.msg);
r = await photo(A, "p3", 1000);
ok("the next photo is refused", !r.ok && r.code === "42501", r.code + " " + r.msg);
r = await photo(B, "pb", 1000);
ok("another account can still upload", r.ok, r.msg);
r = await run(A, `delete from storage.objects where name = 'p2'`);
r = await photo(A, "p3", 1000);
ok("after deleting a photo there is room again", r.ok, r.msg);
await run(null, `delete from storage.objects`);
await set("quota_photos_count", "6000");
await set("quota_photos_mb", "1");
await photo(A, "s1", 600_000); r = await photo(A, "s2", 600_000);
ok("a photo is accepted while the account is under the size limit", r.ok, r.msg);
r = await photo(A, "s3", 600_000);
ok("…and refused once the stored photos reach it", !r.ok && r.code === "42501", r.code);
r = await run(A, `select public.corpus_photo_room() as room`);
ok("corpus_photo_room() answers only for the caller", r.ok && r.rows![0].room === false);
r = await run(null, `select public.corpus_photo_room() as room`);
ok("…and says no without a signed-in person", r.ok && r.rows![0].room === false);
r = await run(A, `insert into storage.objects (bucket_id, name, owner_id, metadata) values ('other', 'o1', '${A}', '{"size": 1}')`);
ok("the policy still refuses other buckets", !r.ok && r.code === "42501", r.code);

// ---- share codes (share.sql) ----
const put = (uid: string, src: string, bytes = 10) => run(uid, `select public.corpus_share_put('${src}', 'deck', 'n', jsonb_build_object('p', ${hex(bytes)}))`);
await set("quota_shares_count", "2");
r = await put(A, "deck:1"); const rs2 = await put(A, "deck:2");
ok("share codes under the limit are made", r.ok && rs2.ok, r.msg);
r = await put(A, "deck:3");
ok("a third share code is refused (53400)", !r.ok && r.code === "53400" && /user_quota_exceeded/.test(r.msg!), r.code + " " + r.msg);
const code1 = (await run(null, `select code from public.shares where src = 'deck:1'`)).rows![0].code;
r = await put(A, "deck:1");
ok("refreshing a snapshot at the limit still works, the code stays", r.ok && (await run(null, `select code from public.shares where src = 'deck:1'`)).rows![0].code === code1, r.msg);
r = await put(B, "deck:1");
ok("another account can still make codes", r.ok, r.msg);
await run(A, `delete from public.shares where src = 'deck:2'`);
r = await put(A, "deck:3");
ok("after revoking one, a new code is made", r.ok, r.msg);
await run(null, `delete from public.shares`);
await set("quota_shares_count", "100");
await set("quota_shares_mb", "1");
await put(A, "deck:1", 400_000); await put(A, "deck:2", 400_000);
r = await put(A, "deck:3", 400_000);
ok("snapshots over the total size are refused (53400)", !r.ok && r.code === "53400", r.code);
r = await put(A, "deck:1", 700_000);
ok("refreshing a snapshot so that it grows past the total size is refused (53400)", !r.ok && r.code === "53400", r.code);
r = await run(null, `insert into public.shares (owner, src, code, kind, data) values ('${A}', 'deck:svc', 'svccode001', 'deck', ${"'{}'"})`);
ok("a share written without a signed-in person is not limited", r.ok, r.msg);
await run(null, `delete from public.shares`);
await set("quota_shares_mb", "20");

console.log(fails ? "FAILED " + fails : "ALL QUOTA TESTS PASSED");
Deno.exit(fails ? 1 : 0);
