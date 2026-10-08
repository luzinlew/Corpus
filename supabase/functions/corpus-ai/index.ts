// Corpus AI — Supabase Edge Function "corpus-ai".
// The only place that holds the Anthropic API key. Every request belongs to a signed-in Corpus user
// and is counted against that user's daily allowance (public.corpus_ai_take, see supabase/ai.sql).
//
//   GET  → { ready, plan, limit, used }                  today's allowance (the site uses it to switch AI on)
//   POST { messages, json?, max_tokens? } → { text, truncated, plan, limit, used }
//        messages: Claude Messages API turns; images as { type: "image", source: { type: "base64", ... } }
//
// Demo mode (header x-corpus-demo: 1, no sign-in): the cheapest model for text and photos, a few requests per
// visitor per day (public.corpus_demo_take, see supabase/demo.sql). Needs "Verify JWT" switched off for this function.
//
// Secrets: ANTHROPIC_API_KEY (required). Optional: CORPUS_AI_MODEL, CORPUS_AI_VISION_MODEL, CORPUS_AI_DEMO_MODEL.
import { createClient } from "npm:@supabase/supabase-js@2";

const API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const API_URL = Deno.env.get("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com";
const TEXT_MODEL = Deno.env.get("CORPUS_AI_MODEL") ?? "claude-haiku-4-5-20251001";
const VISION_MODEL = Deno.env.get("CORPUS_AI_VISION_MODEL") ?? "claude-sonnet-5-5";
const DEMO_MODEL = Deno.env.get("CORPUS_AI_DEMO_MODEL") ?? "claude-haiku-4-5-20251001";
const MAX_TURNS = 40, MAX_TEXT = 70_000, MAX_IMAGES = 4, MAX_IMAGE_B64 = 8_000_000;
const JSON_SYSTEM = "Your reply is read by a program: answer with only the requested JSON value — no prose, no Markdown code fences.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-corpus-demo",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Json = any;

// The site sends its publishable key as `apikey`; without it, fall back to the platform's own.
function publishableKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
    const first = Object.values(keys)[0];
    if (typeof first === "string") return first;
  } catch { /* not set */ }
  return Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const demo = req.headers.get("x-corpus-demo") === "1";
    const auth = req.headers.get("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const key = req.headers.get("apikey") ?? publishableKey();
    let sb: ReturnType<typeof createClient>;
    let take: (units: number) => Promise<{ data: Json; error: { message: string } | null }>;
    if (demo) {
      const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      if (!svc) return reply(503, { code: "unavailable", message: "demo mode is not set up" });
      sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", svc, { auth: { persistSession: false, autoRefreshToken: false } });
      const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("corpus-demo|" + ip)));
      const visitor = Array.from(digest.slice(0, 16)).map((x) => x.toString(16).padStart(2, "0")).join("");
      take = (units) => sb.rpc("corpus_demo_take", { p_visitor: visitor, p_units: units });
    } else {
      if (!token || !key) return reply(401, { code: "not_granted", message: "sign in first" });
      sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", key, {
        global: { headers: { Authorization: auth } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: who } = await sb.auth.getUser(token);
      if (!who?.user) return reply(401, { code: "not_granted", message: "sign in first" });
      take = (units) => sb.rpc("corpus_ai_take", { p_units: units });
    }

    if (req.method === "GET") {
      const { data, error } = await take(0);
      if (error) return reply(500, { code: "unavailable", message: error.message });
      return reply(200, { ready: !!API_KEY, plan: data?.plan, limit: data?.limit, used: data?.used });
    }
    if (req.method !== "POST") return reply(405, { code: "invalid_input", message: "use GET or POST" });

    let body: Json;
    try { body = await req.json(); } catch { return reply(400, { code: "invalid_input", message: "JSON body expected" }); }
    const messages: Json[] | null = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages || !messages.length || messages.length > MAX_TURNS) {
      return reply(400, { code: "invalid_input", message: "messages: 1–" + MAX_TURNS + " turns" });
    }
    let text = 0, images = 0, imageBytes = 0;
    for (const m of messages) {
      if (m?.role !== "user" && m?.role !== "assistant") return reply(400, { code: "invalid_input", message: "role must be user or assistant" });
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      if (!Array.isArray(blocks) || !blocks.length) return reply(400, { code: "invalid_input", message: "empty turn" });
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") text += b.text.length;
        else if (b?.type === "image" && b.source?.type === "base64" && typeof b.source.data === "string" &&
          /^image\/(jpeg|png|webp|gif)$/.test(b.source.media_type)) { images++; imageBytes += b.source.data.length; }
        else return reply(400, { code: "invalid_input", message: "only text and base64 images" });
      }
    }
    if (messages[messages.length - 1].role !== "user") return reply(400, { code: "invalid_input", message: "last turn must be the user's" });
    if (text > MAX_TEXT || images > MAX_IMAGES || imageBytes > MAX_IMAGE_B64) return reply(413, { code: "too_large", message: "request too large" });
    if (!API_KEY) return reply(503, { code: "unavailable", message: "ANTHROPIC_API_KEY is not set" });

    const units = 1 + images;
    const { data: q, error: qe } = await take(units);
    if (qe) return reply(500, { code: "unavailable", message: qe.message });
    if (!q?.ok) return reply(429, { code: "quota_exceeded", message: "daily AI limit reached", plan: q?.plan, limit: q?.limit, used: q?.used });

    const r = await fetch(API_URL + "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: demo ? DEMO_MODEL : images ? VISION_MODEL : TEXT_MODEL,
        max_tokens: Math.max(64, Math.min(Number(body.max_tokens) || 1500, demo ? 1500 : 4096)),
        ...(body.json ? { system: JSON_SYSTEM } : {}),
        messages,
      }),
    });
    const out: Json = await r.json().catch(() => null);
    if (!r.ok) {
      const m = String(out?.error?.message ?? "model error " + r.status);
      const code = r.status === 429 || r.status === 529 ? "rate_limited" : (r.status === 400 && /image/i.test(m) ? "image_rejected" : "unavailable");
      console.error("anthropic", r.status, m);
      return reply(502, { code, message: m });
    }
    const answer = (out?.content ?? []).filter((b: Json) => b?.type === "text").map((b: Json) => b.text).join("");
    if (!answer.trim()) return reply(502, { code: "empty_completion", message: "empty answer" });
    return reply(200, { text: answer, truncated: out?.stop_reason === "max_tokens", plan: q.plan, limit: q.limit, used: q.used });
  } catch (e) {
    console.error("corpus-ai", e);
    return reply(500, { code: "unavailable", message: String((e as Error)?.message ?? e) });
  }
});
