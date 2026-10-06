// Run: CORPUS_PUSH_NO_SERVE=1 deno run --allow-net --allow-env --allow-read --allow-sys tools/push_test.ts   (or npx deno)
// Checks corpus-push: the scheduling rules (plan) and real Web Push encryption through web-push.
import { plan, localNow } from "../supabase/functions/corpus-push/index.ts";
import webpush from "npm:web-push@3.6.7";
import ece from "npm:http_ece@1.2.0";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";

let fails = 0;
const ok = (name: string, c: boolean, extra = "") => { console.log((c ? "PASS " : "FAIL ") + name + (extra ? "  " + extra : "")); if (!c) fails++; };

// 2026-10-07 is a Wednesday; Tallinn = UTC+3 in October
const at = (h: number, m = 0, day = 7) => new Date(Date.UTC(2026, 9, day, h - 3, m));
const n = {
  tz: "Europe/Tallinn", lang: "ru", daily: "19:00", remDays: [7, 3, 1], day: "2026-10-07",
  due: { "2026-10-07": 12, "2026-10-08": 20, "2026-10-09": 31 }, newToday: 5, newPer: 15, at: at(10).getTime(),
  exams: [{ id: "e1", title: "Коллоквиум: череп", date: "2026-10-10", newAll: 40 }, { id: "e2", title: "Кости", date: "2026-10-08", newAll: 0 }],
};
ok("local time", localNow(at(19, 5), "Europe/Tallinn").date === "2026-10-07" && localNow(at(19, 5), "Europe/Tallinn").min === 19 * 60 + 5);

let p = plan(n, null, at(18, 50));
ok("nothing before 19:00 except morning", p.out.length === 0, JSON.stringify(p.out));
p = plan(n, null, at(19, 5));
ok("daily at 19:05", p.out.length === 1 && p.out[0].tag === "corpus-daily" && p.out[0].body === "На сегодня: 12 карточек на повтор и 5 новых.", JSON.stringify(p.out));
const p2 = plan(n, p.sent, at(19, 20));
ok("daily not repeated", p2.out.length === 0);
p = plan(n, null, at(8, 5));
ok("8:00 exams: 3 days before + tomorrow", p.out.length === 2 && p.out.some((x) => x.body === "Через 3 дня. Осталось новых карточек: 40.") && p.out.some((x) => x.body === "Завтра. Всё пройдено — осталось повторение."), JSON.stringify(p.out));
ok("exam link opens the calendar", p.out.every((x) => x.url.endsWith("?v=cal")));
const p3 = plan(n, p.sent, at(9, 5));
ok("exam not repeated", p3.out.length === 0);
p = plan(n, null, at(8, 5, 8));
ok("next day: e2 today, e1 not in remDays (2 days)", p.out.length === 1 && p.out[0].body === "Сегодня. Удачи!", JSON.stringify(p.out));
p = plan({ ...n, lang: "et" }, null, at(19, 5, 9));
ok("later day uses running total + newPer (et)", p.out[0]?.body === "Täna: 31 kordamist ja 15 uut.", JSON.stringify(p.out));
p = plan({ ...n, daily: "", exams: [] }, null, at(19, 5));
ok("daily off", p.out.length === 0);
p = plan({ ...n, due: {}, newToday: 0 }, null, at(19, 5));
ok("nothing due → no daily, but marked", p.out.length === 0 && p.sent.daily === "2026-10-07");
p = plan({ ...n, at: at(10).getTime() - 40 * 86400000 }, null, at(19, 5));
ok("stale summary → no daily nag", p.out.length === 0);
p = plan({ ...n, tz: "Asia/Tokyo" }, null, at(19, 5));
ok("other time zone respected", p.out.every((x) => x.tag !== "corpus-daily"));

// real encryption: a subscription made like a browser would, delivered to a local endpoint
const vapid = webpush.generateVAPIDKeys();
webpush.setVapidDetails("https://luzinlew.github.io/Corpus/", vapid.publicKey, vapid.privateKey);
const ua = crypto.createECDH("prime256v1"); ua.generateKeys();
const auth = crypto.randomBytes(16);
const sub = { endpoint: "https://web.push.apple.com/QGuQyavXutnMH8ab", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
const rq = webpush.generateRequestDetails(sub, JSON.stringify({ title: "Пора повторить", body: "x" }), { TTL: 60 });
const got = { body: new Uint8Array(rq.body), headers: new Headers(rq.headers as Record<string, string>) };
ok("VAPID auth for Apple push", rq.endpoint.startsWith("https://web.push.apple.com") && !!got && /^vapid t=/.test(got!.headers.get("authorization") ?? ""), got?.headers.get("authorization")?.slice(0, 20));
const plain = ece.decrypt(Buffer.from(got!.body), { version: "aes128gcm", privateKey: ua, authSecret: auth });
ok("payload decrypts", JSON.parse(plain.toString()).title === "Пора повторить");
console.log(fails ? "FAILED " + fails : "ALL PUSH TESTS PASSED");
Deno.exit(fails ? 1 : 0);
