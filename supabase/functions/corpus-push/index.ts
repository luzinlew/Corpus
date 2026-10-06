// Corpus push — Supabase Edge Function "corpus-push".
// Sends Web Push reminders: a daily "time to review" at the time each person picked, and reminders before
// the tests in their calendar (the days they picked + the day before + the morning of), at 8:00 their time.
//
//   GET  (signed in)                → { publicKey }            the site subscribes the device with it
//   POST (signed in) { test: true } → { sent }                 a test notification to the person's own devices
//   POST x-corpus-cron: <key>       → { users, sent, dropped } the scheduled run (pg_cron, supabase/push.sql)
//
// What the app stores (table public.docs, owner = the person):
//   coll 'push', id = hash of the endpoint → { endpoint, keys: { p256dh, auth } }    one per device
//   coll 'meta', id 'notify'               → a short summary the app keeps current: time zone, language,
//                                            daily time, reminder days, cards due per day, upcoming tests
//   coll 'meta', id 'notify_sent'          → written here: what was already sent, so nothing repeats
// The VAPID keys are made on the first run and kept in private.settings (public.corpus_push_cfg).
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SITE = Deno.env.get("CORPUS_SITE_URL") ?? "https://luzinlew.github.io/Corpus/";
const EXAM_AT = 8 * 60;          // test reminders: 8:00 local time
const WINDOW = 3 * 60;           // a run missed by the scheduler still sends within this many minutes
const STALE = 30 * 86400000;     // no daily nudges for someone who hasn't opened Corpus in a month

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Json = any;

function firstKey(env: string, ...fallbacks: string[]): string {
  try {
    const keys = JSON.parse(Deno.env.get(env) ?? "{}");
    const first = Object.values(keys)[0];
    if (typeof first === "string") return first;
  } catch { /* not set */ }
  for (const f of fallbacks) { const v = Deno.env.get(f); if (v) return v; }
  return "";
}
const URL_ = Deno.env.get("SUPABASE_URL") ?? "";
const admin = () => createClient(URL_, firstKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

let CFG: { pub: string; priv: string; cron: string } | null = null;
async function cfg(db: Json) {
  if (CFG) return CFG;
  let r = await db.rpc("corpus_push_cfg");
  if (r.error) throw new Error("corpus_push_cfg: " + r.error.message);
  if (!r.data?.pub || !r.data?.priv) {
    const k = webpush.generateVAPIDKeys();
    r = await db.rpc("corpus_push_cfg", { p_pub: k.publicKey, p_priv: k.privateKey });
    if (r.error) throw new Error("corpus_push_cfg: " + r.error.message);
  }
  CFG = { pub: r.data.pub, priv: r.data.priv, cron: r.data.cron ?? "" };
  webpush.setVapidDetails(SITE, CFG.pub, CFG.priv);
  return CFG;
}

/* ---------- what to send to one person right now ---------- */
const T = {
  ru: {
    daily: (d: number, n: number) => "На сегодня: " + [d ? d + " " + ru(d, "карточка", "карточки", "карточек") + " на повтор" : "", n ? n + " " + ru(n, "новая", "новые", "новых") : ""].filter(Boolean).join(" и ") + ".",
    dailyT: "Пора повторить",
    today: "Сегодня. Удачи!",
    tomorrow: "Завтра.",
    inDays: (k: number) => "Через " + k + " " + ru(k, "день", "дня", "дней") + ".",
    left: (n: number) => " Осталось новых карточек: " + n + ".",
    done: " Всё пройдено — осталось повторение.",
    testT: "Уведомления включены",
    test: "Так будут приходить напоминания Corpus.",
  },
  en: {
    daily: (d: number, n: number) => "Today: " + [d ? d + (d === 1 ? " review" : " reviews") : "", n ? n + " new" : ""].filter(Boolean).join(" and ") + ".",
    dailyT: "Time to review",
    today: "Today. Good luck!",
    tomorrow: "Tomorrow.",
    inDays: (k: number) => "In " + k + " days.",
    left: (n: number) => " New cards left: " + n + ".",
    done: " Everything seen — review only.",
    testT: "Notifications are on",
    test: "This is how Corpus reminders will look.",
  },
  et: {
    daily: (d: number, n: number) => "Täna: " + [d ? d + " kordamist" : "", n ? n + " uut" : ""].filter(Boolean).join(" ja ") + ".",
    dailyT: "Aeg korrata",
    today: "Täna. Edu!",
    tomorrow: "Homme.",
    inDays: (k: number) => k + " päeva pärast.",
    left: (n: number) => " Uusi kaarte jäänud: " + n + ".",
    done: " Kõik läbitud — jäänud on kordamine.",
    testT: "Teavitused on sees",
    test: "Nii näevad välja Corpuse meeldetuletused.",
  },
};
function ru(n: number, a: string, b: string, c: string) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return a;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return b;
  return c;
}
const words = (l: string) => (T as Json)[l] ?? T.et;

export function localNow(now: Date, tz: string) {
  let f: Intl.DateTimeFormat;
  try { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch { f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Tallinn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(now)) p[x.type] = x.value;
  return { date: p.year + "-" + p.month + "-" + p.day, min: (+p.hour % 24) * 60 + +p.minute };
}
const dayNo = (ds: string) => { const [y, m, d] = ds.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const hhmm = (s: unknown) => (typeof s === "string" && /^\d\d:\d\d$/.test(s)) ? +s.slice(0, 2) * 60 + +s.slice(3) : null;

/* cards due by the end of `date` (the app sends a running total per day for two weeks) */
function dueOn(n: Json, date: string): number {
  const due = n.due && typeof n.due === "object" ? n.due : {};
  if (due[date] != null) return +due[date] || 0;
  const keys = Object.keys(due).sort();
  if (!keys.length || date < keys[0]) return 0;
  return +due[keys[keys.length - 1]] || 0;
}

export function plan(n: Json, sentIn: Json, now: Date) {
  const out: { title: string; body: string; tag: string; url: string }[] = [];
  const sent = { daily: sentIn?.daily ?? "", ex: { ...(sentIn?.ex ?? {}) } };
  if (!n || typeof n !== "object") return { out, sent, changed: false };
  const w = words(n.lang);
  const { date, min } = localNow(now, String(n.tz || "Europe/Tallinn"));
  let changed = false;

  const daily = hhmm(n.daily);
  if (daily != null && min >= daily && min < daily + WINDOW && sent.daily !== date) {
    sent.daily = date; changed = true;
    const fresh = now.getTime() - (+n.at || 0) < STALE;
    const d = dueOn(n, date), k = date === n.day ? (+n.newToday || 0) : (+n.newPer || 0);
    if (fresh && d + k > 0) out.push({ title: w.dailyT, body: w.daily(d, k), tag: "corpus-daily", url: SITE });
  }

  if (min >= EXAM_AT && min < EXAM_AT + WINDOW * 2) {
    const days: number[] = Array.isArray(n.remDays) ? n.remDays.map(Number) : [7, 3, 1];
    for (const e of Array.isArray(n.exams) ? n.exams.slice(0, 20) : []) {
      if (!e || typeof e.date !== "string" || !/^\d{4}-\d\d-\d\d$/.test(e.date)) continue;
      const dl = dayNo(e.date) - dayNo(date);
      if (dl < 0 || !(dl <= 1 || days.includes(dl))) continue;
      const key = String(e.id) + "@" + e.date + "#" + dl;
      if (sent.ex[key]) continue;
      sent.ex[key] = date; changed = true;
      const when = dl === 0 ? w.today : dl === 1 ? w.tomorrow : w.inDays(dl);
      const rest = dl === 0 ? "" : (+e.newAll > 0 ? w.left(+e.newAll) : w.done);
      out.push({ title: String(e.title || "Corpus").slice(0, 120), body: when + rest, tag: "corpus-exam-" + e.id, url: SITE + "?v=cal" });
    }
  }
  /* forget what was sent for tests long past */
  for (const k of Object.keys(sent.ex)) {
    const d = String(sent.ex[k]);
    if (/^\d{4}-\d\d-\d\d$/.test(d) && dayNo(date) - dayNo(d) > 40) { delete sent.ex[k]; changed = true; }
  }
  return { out, sent, changed };
}

/* ---------- delivery ---------- */
async function deliver(db: Json, sub: Json, payload: Json): Promise<"ok" | "gone" | "fail"> {
  const s = sub.data ?? {};
  if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth) return "gone";
  try {
    await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
      JSON.stringify(payload), { TTL: 6 * 3600, urgency: "normal" });
    return "ok";
  } catch (e: Json) {
    const st = e?.statusCode | 0;
    if (st === 404 || st === 410) {
      await db.from("docs").delete().eq("owner", sub.owner).eq("coll", "push").eq("id", sub.id);
      return "gone";
    }
    console.error("push failed", st, String(e?.body ?? e?.message ?? e).slice(0, 200));
    return "fail";
  }
}

async function runAll(db: Json, now: Date) {
  const subs: Json[] = [];
  for (let from = 0; ; from += 1000) {
    const r = await db.from("docs").select("owner,id,data").eq("coll", "push").order("owner").range(from, from + 999);
    if (r.error) throw new Error(r.error.message);
    subs.push(...r.data);
    if (r.data.length < 1000) break;
  }
  const byOwner = new Map<string, Json[]>();
  for (const s of subs) { if (!byOwner.has(s.owner)) byOwner.set(s.owner, []); byOwner.get(s.owner)!.push(s); }
  let sent = 0, dropped = 0;
  const owners = Array.from(byOwner.keys());
  for (let i = 0; i < owners.length; i += 200) {
    const part = owners.slice(i, i + 200);
    const r = await db.from("docs").select("owner,id,data").eq("coll", "meta").in("id", ["notify", "notify_sent"]).in("owner", part);
    if (r.error) throw new Error(r.error.message);
    const meta = new Map<string, Json>();
    for (const row of r.data) meta.set(row.owner + "|" + row.id, row.data);
    for (const owner of part) {
      const p = plan(meta.get(owner + "|notify"), meta.get(owner + "|notify_sent"), now);
      for (const msg of p.out) {
        for (const sub of byOwner.get(owner)!) {
          const res = await deliver(db, sub, msg);
          if (res === "ok") sent++; else if (res === "gone") dropped++;
        }
      }
      if (p.changed) {
        await db.from("docs").upsert({ owner, coll: "meta", id: "notify_sent", data: p.sent, updated_at: now.toISOString() }, { onConflict: "owner,coll,id" });
      }
    }
  }
  return { users: owners.length, sent, dropped };
}

if (!Deno.env.get("CORPUS_PUSH_NO_SERVE")) Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const db = admin();
    const c = await cfg(db);
    const cron = req.headers.get("x-corpus-cron") ?? "";
    if (cron) {
      if (!c.cron || cron !== c.cron) return reply(401, { code: "not_granted", message: "bad cron key" });
      return reply(200, await runAll(db, new Date()));
    }
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: who } = token ? await db.auth.getUser(token) : { data: null };
    const uid = who?.user?.id;
    if (!uid) return reply(401, { code: "not_granted", message: "sign in first" });
    if (req.method === "GET") return reply(200, { publicKey: c.pub });
    let body: Json = {};
    try { body = await req.json(); } catch { /* empty */ }
    if (body?.test) {
      const r = await db.from("docs").select("owner,id,data").eq("coll", "push").eq("owner", uid);
      if (r.error) return reply(500, { code: "unavailable", message: r.error.message });
      const lang = ["ru", "en", "et"].includes(body.lang) ? body.lang : "et";
      const w = words(lang);
      let sent = 0;
      for (const sub of r.data) if ((await deliver(db, sub, { title: w.testT, body: w.test, tag: "corpus-test", url: SITE })) === "ok") sent++;
      return reply(200, { sent });
    }
    return reply(400, { code: "invalid_input", message: "nothing to do" });
  } catch (e) {
    console.error(e);
    return reply(500, { code: "unavailable", message: String((e as Error)?.message ?? e) });
  }
});
