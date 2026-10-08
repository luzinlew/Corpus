/* A small stand-in for the parts of Supabase the site uses (Auth, PostgREST on public.docs + the
   corpus_doc_update RPC, public.shares + the share RPCs, Storage on the 'plates' bucket), for local browser tests only.
   It enforces the same rules as supabase/setup.sql: the invite code, owner-only rows and photos.
   Usage: node tools/fake-supabase.js [port] [invite] */
const http = require('http');
const crypto = require('crypto');

const PORT = +(process.argv[2] || 54321);
const INVITE = process.argv[3] === undefined ? 'p8wyzmtw' : process.argv[3];
const users = new Map();      // email -> {id,email,password,meta,created}
const access = new Map();     // access token -> uid
const refresh = new Map();    // refresh token -> uid
const docs = new Map();       // owner|coll|id -> row
const objects = new Map();    // name -> {owner,type,buf}
const shares = new Map();     // owner|src -> row (public.shares)
const aiUsed = new Map();     // uid|day -> units used today (public.ai_usage)
const AI_LIMIT = +(process.env.FAKE_AI_LIMIT || 5);
let FN_URL = process.env.FAKE_FN_URL || '';                 // where the corpus-ai function runs (deno), if at all
const FN_URL0 = FN_URL;
const ANTHROPIC_KEY = 'test-anthropic-key';                  // the fake Claude API below accepts only this key
const ADMINS = (process.env.FAKE_ADMINS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
const activity = new Map();   // uid -> Map(day -> {opens, last})
const log = [];

const b64u = (s) => Buffer.from(s).toString('base64url');
function jwt(u) {
  const now = Math.floor(Date.now() / 1000);
  return b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' +
    b64u(JSON.stringify({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600, session_id: crypto.randomUUID() })) +
    '.' + b64u('fake-signature');
}
function userObj(u) {
  return { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.created, phone: '',
    confirmed_at: u.created, last_sign_in_at: new Date().toISOString(), app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: u.meta, identities: [{ identity_id: crypto.randomUUID(), id: u.id, user_id: u.id, identity_data: { email: u.email, sub: u.id }, provider: 'email' }],
    created_at: u.created, updated_at: u.created, is_anonymous: false };
}
function session(u) {
  const at = jwt(u), rt = crypto.randomBytes(16).toString('hex');
  access.set(at, u.id); refresh.set(rt, u.id);
  return { access_token: at, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: rt, user: userObj(u) };
}
const byId = (id) => Array.from(users.values()).find((u) => u.id === id);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,apikey,content-type,prefer,x-client-info,x-upsert,accept-profile,content-profile,range,cache-control,x-supabase-api-version,accept');
  res.setHeader('Access-Control-Expose-Headers', 'content-range,content-type,x-supabase-api-version');
}
function send(res, status, body, type) {
  cors(res);
  if (body === undefined || body === null) { res.writeHead(status); res.end(); return; }
  if (Buffer.isBuffer(body)) { res.writeHead(status, { 'Content-Type': type || 'application/octet-stream' }); res.end(body); return; }
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
}
const authErr = (res, status, code, msg) => send(res, status, { code: status, error_code: code, msg: msg });
function uidOf(req) {
  const h = req.headers.authorization || '';
  const t = h.replace(/^Bearer\s+/i, '');
  return access.get(t) || null;
}
function readBody(req) {
  return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
}
function merge(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return b;
  const r = Object.assign({}, a);
  for (const k of Object.keys(b)) {
    r[k] = (r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]) && b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) ? merge(r[k], b[k]) : b[k];
  }
  return r;
}
function multipartFile(buf, ctype) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype || '');
  if (!m) return null;
  const sep = Buffer.from('--' + (m[1] || m[2]));
  let pos = buf.indexOf(sep), found = null;
  while (pos >= 0) {
    const next = buf.indexOf(sep, pos + sep.length);
    if (next < 0) break;
    const part = buf.slice(pos + sep.length + 2, next - 2);
    const hEnd = part.indexOf('\r\n\r\n');
    const head = part.slice(0, hEnd).toString();
    const body = part.slice(hEnd + 4);
    if (/filename=/i.test(head) || /name=""/.test(head)) {
      const t = /content-type:\s*([^\r\n]+)/i.exec(head);
      found = { type: t ? t[1].trim() : 'application/octet-stream', buf: body };
    }
    pos = next;
  }
  return found;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (req.method === 'OPTIONS') { send(res, 204); return; }
  const raw = await readBody(req);
  let body = null;
  try { body = raw.length && /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw.toString()) : null; } catch (e) {}
  log.push(req.method + ' ' + p);

  /* ---------- test helpers ---------- */
  if (p === '/__state') { send(res, 200, { users: users.size, docs: Array.from(docs.values()), objects: Array.from(objects.entries()).map(([k, v]) => ({ name: k, owner: v.owner, type: v.type, size: v.buf.length })), shares: Array.from(shares.values()) }); return; }
  if (p === '/__log') { send(res, 200, log.splice(0)); return; }
  if (p === '/__fn') { FN_URL = u.searchParams.get('off') === '1' ? '' : FN_URL0; send(res, 200, { fn: FN_URL }); return; }

  /* ---------- auth ---------- */
  if (p === '/auth/v1/signup' && req.method === 'POST') {
    const email = String(body.email || '').toLowerCase(), pw = String(body.password || ''), meta = body.data || {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return authErr(res, 400, 'validation_failed', 'Unable to validate email address: invalid format');
    if (pw.length < 6) return authErr(res, 422, 'weak_password', 'Password should be at least 6 characters.');
    if (users.has(email)) return authErr(res, 422, 'user_already_exists', 'User already registered');
    if (INVITE && meta.invite !== INVITE) return authErr(res, 500, 'unexpected_failure', 'Database error saving new user');
    const nu = { id: crypto.randomUUID(), email, password: pw, meta, created: new Date().toISOString() };
    users.set(email, nu);
    send(res, 200, session(nu)); return;
  }
  if (p === '/auth/v1/token' && req.method === 'POST') {
    const g = u.searchParams.get('grant_type');
    if (g === 'password') {
      const usr = users.get(String(body.email || '').toLowerCase());
      if (!usr || usr.password !== body.password) return authErr(res, 400, 'invalid_credentials', 'Invalid login credentials');
      send(res, 200, session(usr)); return;
    }
    if (g === 'refresh_token') {
      const id = refresh.get(body.refresh_token);
      if (!id) return authErr(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
      refresh.delete(body.refresh_token);
      send(res, 200, session(byId(id))); return;
    }
  }
  if (p === '/auth/v1/user' && req.method === 'GET') {
    const id = uidOf(req); if (!id) return authErr(res, 401, 'bad_jwt', 'invalid JWT');
    send(res, 200, userObj(byId(id))); return;
  }
  if (p === '/auth/v1/recover' && req.method === 'POST') { log.push({ recover: String(body.email || '').toLowerCase() }); send(res, 200, {}); return; }
  if (p === '/auth/v1/user' && req.method === 'PUT') {
    const id = uidOf(req); if (!id) return authErr(res, 401, 'bad_jwt', 'invalid JWT');
    const usr = byId(id), pw = String(body.password || '');
    if (pw.length < 6) return authErr(res, 422, 'weak_password', 'Password should be at least 6 characters.');
    if (pw === usr.password) return authErr(res, 422, 'same_password', 'New password should be different from the old password.');
    usr.password = pw; send(res, 200, userObj(usr)); return;
  }
  if (p === '/auth/v1/logout') { const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); access.delete(t); send(res, 204); return; }

  /* ---------- rest: public.docs (row-level security: owner = auth.uid()) ---------- */
  if (p === '/rest/v1/docs') {
    const uid = uidOf(req);
    const f = {};
    for (const [k, v] of u.searchParams) if (/^(owner|coll|id)$/.test(k) && v.startsWith('eq.')) f[k] = v.slice(3);
    const rows = () => Array.from(docs.values()).filter((r) => r.owner === uid && Object.keys(f).every((k) => r[k] === f[k]));
    if (req.method === 'GET') {
      let list = rows().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const off = +(u.searchParams.get('offset') || 0), lim = u.searchParams.get('limit');
      list = list.slice(off, lim ? off + +lim : undefined);
      const cols = (u.searchParams.get('select') || '*').split(',');
      send(res, 200, list.map((r) => (cols[0] === '*' ? r : Object.fromEntries(cols.map((c) => [c, r[c]]))))); return;
    }
    if (req.method === 'POST') {
      const arr = Array.isArray(body) ? body : [body];
      for (const r of arr) {
        if (!uid || r.owner !== uid) { send(res, 403, { code: '42501', message: 'new row violates row-level security policy for table "docs"', details: null, hint: null }); return; }
      }
      for (const r of arr) docs.set(r.owner + '|' + r.coll + '|' + r.id, { owner: r.owner, coll: r.coll, id: r.id, data: r.data, updated_at: r.updated_at || new Date().toISOString() });
      send(res, 201); return;
    }
    if (req.method === 'DELETE') { rows().forEach((r) => docs.delete(r.owner + '|' + r.coll + '|' + r.id)); send(res, 204); return; }
  }
  /* ---------- rest: public.shares (owner-only rows) + the share RPCs (as in supabase/share.sql) ---------- */
  if (p === '/rest/v1/shares') {
    const uid = uidOf(req);
    const f = {};
    for (const [k, v] of u.searchParams) if (/^(owner|src|code)$/.test(k) && v.startsWith('eq.')) f[k] = v.slice(3);
    const rows = () => Array.from(shares.values()).filter((r) => r.owner === uid && Object.keys(f).every((k) => r[k] === f[k]));
    if (req.method === 'GET') {
      const cols = (u.searchParams.get('select') || '*').split(',');
      send(res, 200, rows().map((r) => (cols[0] === '*' ? r : Object.fromEntries(cols.map((c) => [c, r[c]]))))); return;
    }
    if (req.method === 'DELETE') { rows().forEach((r) => shares.delete(r.owner + '|' + r.src)); send(res, 204); return; }
  }
  if (p === '/rest/v1/rpc/corpus_share_put' && req.method === 'POST') {
    const uid = uidOf(req);
    if (!uid) { send(res, 401, { code: '42501', message: 'permission denied for function corpus_share_put' }); return; }
    if (!body.p_src || !/^(deck|folder)$/.test(body.p_kind)) { send(res, 400, { code: '22023', message: 'share_bad_request' }); return; }
    if (JSON.stringify(body.p_data).length > 6 * 1024 * 1024) { send(res, 400, { code: '54000', message: 'share_too_large' }); return; }
    const k = uid + '|' + body.p_src;
    let row = shares.get(k);
    const now = new Date().toISOString();
    if (!row) {
      const a = '23456789abcdefghjkmnpqrstuvwxyz', b = crypto.randomBytes(10); let code = '';
      for (let i = 0; i < 10; i++) code += a[b[i] % 31];
      row = { owner: uid, src: body.p_src, code, kind: body.p_kind, name: String(body.p_name || '').slice(0, 200), data: body.p_data, created_at: now, updated_at: now, opens: 0 };
      shares.set(k, row);
    } else { Object.assign(row, { kind: body.p_kind, name: String(body.p_name || '').slice(0, 200), data: body.p_data, updated_at: now }); }
    send(res, 200, { code: row.code, createdAt: row.created_at }); return;
  }
  if (p === '/rest/v1/rpc/corpus_share_open' && req.method === 'POST') {
    const uid = uidOf(req);
    if (!uid) { send(res, 401, { code: '42501', message: 'share_sign_in' }); return; }
    const code = String(body.p_code || '').trim().toLowerCase();
    const row = Array.from(shares.values()).find((r) => r.code === code);
    if (!row) { send(res, 404, { code: 'P0002', message: 'share_not_found', details: null, hint: null }); return; }
    row.opens++;
    send(res, 200, { kind: row.kind, name: row.name, data: row.data, createdAt: row.created_at, updatedAt: row.updated_at, from: byId(row.owner).email.replace(/^(.{0,2})[^@]*@/, '$1***@'), mine: row.owner === uid }); return;
  }
  if (p === '/rest/v1/rpc/corpus_doc_update' && req.method === 'POST') {
    const uid = uidOf(req);
    const k = uid + '|' + body.p_coll + '|' + body.p_id, row = docs.get(k);
    if (!uid || !row) { send(res, 404, { code: 'P0002', message: 'doc_missing', details: null, hint: null }); return; }
    row.data = merge(row.data, body.p_patch); row.updated_at = new Date().toISOString();
    send(res, 204); return;
  }

  /* ---------- rpc: corpus_ai_take (daily allowance, as in supabase/ai.sql) ---------- */
  if (p === '/rest/v1/rpc/corpus_ai_take' && req.method === 'POST') {
    const uid = uidOf(req);
    if (!uid) { send(res, 401, { code: '42501', message: 'permission denied for function corpus_ai_take' }); return; }
    const n = body && body.p_units;
    if (typeof n !== 'number' || n < 0 || n > 20) { send(res, 400, { code: '22023', message: 'bad_units' }); return; }
    const k = uid + '|' + new Date().toISOString().slice(0, 10), used = aiUsed.get(k) || 0;
    if (used + n > AI_LIMIT) { send(res, 200, { ok: false, plan: 'free', limit: AI_LIMIT, used }); return; }
    aiUsed.set(k, used + n); send(res, 200, { ok: true, plan: 'free', limit: AI_LIMIT, used: used + n }); return;
  }

  if (p === '/rest/v1/rpc/corpus_week_award' && req.method === 'POST') { send(res, 200, { week: null }); return; }
  /* ---------- rpc: corpus_ping / corpus_site_stats (as in supabase/stats.sql) ---------- */
  const isAdmin = (uid) => { const u = byId(uid); return !!u && ADMINS.includes(u.email.toLowerCase()); };
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  if (p === '/rest/v1/rpc/corpus_ping' && req.method === 'POST') {
    const uid = uidOf(req);
    if (!uid) { send(res, 200, { admin: false }); return; }
    const m = activity.get(uid) || new Map(); activity.set(uid, m);
    const d = dayOf(Date.now()), e = m.get(d) || { opens: 0 }; e.opens++; e.last = new Date().toISOString(); m.set(d, e);
    send(res, 200, { admin: isAdmin(uid) }); return;
  }
  if (p === '/rest/v1/rpc/corpus_site_stats' && req.method === 'POST') {
    const uid = uidOf(req);
    if (!uid || !isAdmin(uid)) { send(res, 403, { code: '42501', message: 'not_admin' }); return; }
    const today = dayOf(Date.now()), back = (n) => dayOf(Date.now() - n * 86400000);
    const rev = [];   // {owner, day, n}
    for (const r of docs.values()) if (r.coll === 'stats' && r.data && r.data.days) for (const [day, e] of Object.entries(r.data.days)) rev.push({ owner: r.owner, day, n: (e && e.n) || 0 });
    const sum = (f) => rev.filter(f).reduce((a, r) => a + r.n, 0);
    const act = (f) => { let n = 0; for (const [, m] of activity) for (const d of m.keys()) if (f(d)) { n++; break; } return n; };
    const days = []; for (let i = 13; i >= 0; i--) { const d = back(i); days.push({ day: d, active: act((x) => x === d), reviews: sum((r) => r.day === d), signups: 0 }); }
    let ai7 = 0; for (const [k, v] of aiUsed) if (k.split('|')[1] > back(7)) ai7 += v;
    const people = Array.from(users.values()).map((u) => { const m = activity.get(u.id) || new Map(); const last = Array.from(m.values()).map((e) => e.last).sort().pop() || null;
      return { email: u.email, joined: u.created.slice(0, 10), last_seen: last, days30: m.size, reviews7: sum((r) => r.owner === u.id && r.day > back(7)) }; });
    send(res, 200, { users: users.size, new7: users.size, active_today: act((d) => d === today), active7: act((d) => d > back(7)), active30: act((d) => d > back(30)),
      reviews_today: sum((r) => r.day === today), reviews7: sum((r) => r.day > back(7)), ai7, days, people }); return;
  }

  /* ---------- a stand-in for the Claude Messages API ---------- */
  if (p === '/v1/messages' && req.method === 'POST') {
    if (req.headers['x-api-key'] !== ANTHROPIC_KEY) { send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }); return; }
    const last = body.messages[body.messages.length - 1];
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    const imgs = blocks.filter((b) => b.type === 'image').length, said = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    const text = body.system ? JSON.stringify({ ok: true, model: body.model, images: imgs, turns: body.messages.length })
      : 'Answer from ' + body.model + ' (' + imgs + ' images) to: ' + said.slice(0, 40);
    send(res, 200, { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } });
    return;
  }

  /* ---------- edge function: forwarded to the real function code running in deno ---------- */
  if (p === '/functions/v1/corpus-ai') {
    if (!FN_URL) { send(res, 404, { message: 'Requested function was not found' }); return; }
    try {
      const h = {};
      for (const k of ['authorization', 'apikey', 'content-type']) if (req.headers[k]) h[k] = req.headers[k];
      const r = await fetch(FN_URL, { method: req.method, headers: h, body: req.method === 'GET' ? undefined : raw });
      const buf = Buffer.from(await r.arrayBuffer());
      cors(res); res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' }); res.end(buf);
    } catch (e) { send(res, 502, { message: 'function not reachable: ' + e.message }); }
    return;
  }

  /* ---------- storage: bucket 'plates' (public reads, owner-only delete, raster pictures only) ---------- */
  let m;
  if ((m = /^\/storage\/v1\/object\/public\/plates\/(.+)$/.exec(p)) && req.method === 'GET') {
    const o = objects.get(decodeURIComponent(m[1]));
    if (!o) { send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' }); return; }
    cors(res); res.writeHead(200, { 'Content-Type': o.type, 'Cache-Control': 'max-age=3600' }); res.end(o.buf); return;
  }
  if ((m = /^\/storage\/v1\/object\/plates\/(.+)$/.exec(p)) && req.method === 'POST') {
    const uid = uidOf(req);
    if (!uid) { send(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }); return; }
    const name = decodeURIComponent(m[1]);
    const file = /multipart/i.test(req.headers['content-type'] || '') ? multipartFile(raw, req.headers['content-type']) : { type: req.headers['content-type'], buf: raw };
    if (!file) { send(res, 400, { statusCode: '400', error: 'invalid', message: 'no file' }); return; }
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) { send(res, 400, { statusCode: '415', error: 'invalid_mime_type', message: 'mime type ' + file.type + ' is not supported' }); return; }
    if (file.buf.length > 26214400) { send(res, 400, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' }); return; }
    if (objects.has(name)) { send(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }); return; }
    objects.set(name, { owner: uid, type: file.type, buf: file.buf });
    send(res, 200, { Key: 'plates/' + name, Id: crypto.randomUUID() }); return;
  }
  if (p === '/storage/v1/object/plates' && req.method === 'DELETE') {
    const uid = uidOf(req), out = [];
    for (const name of (body && body.prefixes) || []) { const o = objects.get(name); if (o && o.owner === uid) { objects.delete(name); out.push({ name }); } }
    send(res, 200, out); return;
  }
  send(res, 404, { message: 'not found: ' + req.method + ' ' + p });
}).listen(PORT, () => console.log('fake supabase on :' + PORT + (INVITE ? ' (invite ' + INVITE + ')' : ' (open sign-up)')));
