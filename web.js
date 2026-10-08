/* Corpus — web runtime.
   The app (src/corpus.html) was written for claude.ai, where a page reaches storage through
   window.claude.use(name). This file provides the same namespaces on top of Supabase, so the very
   same app runs as a website:
     db        — the user's documents (table public.docs, row-level security: only the owner sees them)
     assets    — photos in Supabase Storage, served same-origin at <site>/_blob/<id> by sw.js
     downloads — save a generated file (on phones: the share sheet, e.g. straight to Telegram)
     user      — the signed-in person
     sample    — Claude, through the Supabase Edge Function "corpus-ai" (the site owner's API key,
                 a daily allowance per user). Until that function is deployed, AI features stay hidden.
   Beyond window.claude, window.CORPUS_WEB.shares passes a deck or folder to another person by a short
   code (shown as a QR code): the snapshot lives in public.shares, photos stay in the public bucket and
   are copied into the receiver's own Corpus on import (supabase/share.sql), and window.CORPUS_WEB.push
   turns on push reminders for this device (supabase/push.sql, supabase/functions/corpus-push). */
(function () {
  'use strict';
  var CFG = window.CORPUS_CONFIG || {};
  var BASE = new URL('./', location.href).pathname;            // e.g. /corpus/
  var BUCKET = CFG.bucket || 'plates';
  var CACHE = 'corpus-blobs-v1';
  var configured = !!(CFG.url && CFG.key && window.supabase && window.supabase.createClient);
  var PUBLIC = configured ? CFG.url.replace(/\/+$/, '') + '/storage/v1/object/public/' + BUCKET + '/' : '';
  var FN = configured ? CFG.url.replace(/\/+$/, '') + '/functions/v1/corpus-ai' : '';

  var W = { blobBase: BASE + '_blob/', email: '', uid: '', admin: false, signOut: signOut, siteStats: siteStats,
    shares: null, shareCode: '', starter: String(CFG.starter || '').trim().toLowerCase(), qrScript: BASE + 'vendor/qrcode.js' };
  window.CORPUS_WEB = W;

  /* a share code arrives in the link (?s=...): the app imports that deck or folder once the person is signed in */
  try { W.shareCode = (new URL(location.href).searchParams.get('s') || '').trim().toLowerCase(); } catch (e) {}
  W.clearShareCode = function () {
    W.shareCode = '';
    try { var u = new URL(location.href); u.searchParams.delete('s'); history.replaceState(null, '', u.pathname + u.search + u.hash); } catch (e) {}
  };

  /* the invite code arrives in the link (?i=...) and is kept for the sign-up form. It stays in the
     address bar, so a link copied from there still works as an invitation. */
  var INVITE = '';
  try { INVITE = (new URL(location.href).searchParams.get('i') || '').trim(); } catch (e) {}
  if (INVITE) { try { localStorage.setItem('corpus.invite', INVITE); } catch (e) {} }
  function storedInvite() {
    var v = '';
    try { v = localStorage.getItem('corpus.invite') || ''; } catch (e) {}
    return v || INVITE;
  }

  var sb = configured ? window.supabase.createClient(CFG.url, CFG.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'corpus-auth' }
  }) : null;

  /* ---------- photos: the service worker answers <site>/_blob/<id> from Storage and keeps a copy on the device ---------- */
  function swControl() {
    if (!configured || !('serviceWorker' in navigator)) return Promise.resolve(false);
    return new Promise(function (res) {
      var done = false;
      function fin(v) { if (!done) { done = true; res(v); } }
      setTimeout(function () { fin(!!navigator.serviceWorker.controller); }, 6000);
      navigator.serviceWorker.addEventListener('controllerchange', function () { fin(true); });
      navigator.serviceWorker.register(BASE + 'sw.js?b=' + encodeURIComponent(PUBLIC), { scope: BASE })
        .then(function (reg) {
          if (navigator.serviceWorker.controller) { fin(true); return; }
          /* active but not controlling (a hard reload): ask it to take this page */
          if (reg.active) reg.active.postMessage('claim');
        })
        .catch(function () { fin(false); });
    });
  }

  /* ---------- ready: configured → signed in → photos route ---------- */
  var swP = swControl();                      // installs in parallel with signing in
  var ready = (async function () {
    if (!configured) { await bodyReady(); notConfigured(); return null; }
    var rp = recoveryParams(), session = null, firstMsg = '';
    if (rp) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      var at = rp.get('access_token'), rt = rp.get('refresh_token');
      if (at && rt) {
        var sr = await sb.auth.setSession({ access_token: at, refresh_token: rt });
        if (!sr.error && sr.data && sr.data.session) session = await recoveryScreen();
      }
      if (!session) firstMsg = 'Ссылка устарела или уже использована. Нажмите «Забыли пароль?» и запросите новую.';
    }
    if (!session) {
      var r = await sb.auth.getSession();
      session = r && r.data && r.data.session;
    }
    if (!session) session = await authScreen(firstMsg);
    if (session.guest) return await guestStart();
    var aiP = aiStatus();
    if (!(await swP)) W.blobBase = PUBLIC;    // no service worker (rare): load photos straight from Storage
    W.uid = session.user.id;
    W.email = session.user.email || '';
    /* AI: known to work on this device → on at once, refreshed in the background; otherwise wait briefly for the answer */
    var aiKnown = false;
    try { aiKnown = localStorage.getItem('corpus.ai') === '1'; } catch (e) {}
    aiP.then(function (st) { if (st) W.ai = st; try { localStorage.setItem('corpus.ai', st ? '1' : '0'); } catch (e) {} });
    var aiOn = aiKnown || !!(await Promise.race([aiP, new Promise(function (r) { setTimeout(function () { r(null); }, 2500); })]));
    try { localStorage.setItem('corpus.known', '1'); } catch (e) {}
    ping();
    /* signed out elsewhere (or the session was revoked): start over at the sign-in screen */
    sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT' && !leaving) setTimeout(function () { location.reload(); }, 0); });
    W.shares = mkShares();
    return { db: mkDb(session.user.id), assets: mkAssets(), downloads: mkDownloads(), user: mkUser(session.user), sample: aiOn ? mkSample() : null };
  })();

  window.claude = Object.freeze({
    use: async function (name) {
      var ns = await ready;
      return (ns && ns[name]) || null;
    }
  });

  /* ---------- activity: one mark per person per day (supabase/stats.sql); tells whether this is an admin ---------- */
  var pingDay = '';
  function today() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function ping() {
    pingDay = today();
    sb.rpc('corpus_ping').then(function (r) { if (r && r.data && r.data.admin) W.admin = true; }, function () {});
    weekAward();
  }
  /* weekly reward (supabase/reward.sql): the winner of last week is told once */
  function weekAward() {
    sb.rpc('corpus_week_award').then(function (r) {
      var a = r && r.data;
      if (!a || !a.week || !a.me) return;
      var seen = ''; try { seen = localStorage.getItem('corpus.award') || ''; } catch (e) {}
      if (seen === String(a.week)) return;
      try { localStorage.setItem('corpus.award', String(a.week)); } catch (e) {}
      W.award = a;
      if (W.onAward) W.onAward(a);
    }, function () {});
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && W.uid && pingDay && pingDay !== today()) ping();   // the app was left open overnight
  });
  async function siteStats(days) {
    var r = await sb.rpc('corpus_site_stats', { p_days: days || 14 });
    if (r.error) throw { code: 'unavailable', message: r.error.message };
    return r.data;
  }

  var leaving = false;
  async function signOut() {
    leaving = true;
    try { await sb.auth.signOut({ scope: 'local' }); } catch (e) {}
    try { await caches.delete(CACHE); } catch (e) {}
    location.reload();
  }

  /* ---------- push: reminders on this device (supabase/functions/corpus-push shows them through sw.js).
     On iPhone and iPad they work only when Corpus is opened from the home screen (iOS 16.4+). ---------- */
  var PUSH_FN = configured ? CFG.url.replace(/\/+$/, '') + '/functions/v1/corpus-push' : '';
  W.startView = '';
  try { if (new URL(location.href).searchParams.get('v') === 'cal') W.startView = 'calendar'; } catch (e) {}
  W.clearStartView = function () {
    W.startView = '';
    try { var u = new URL(location.href); u.searchParams.delete('v'); history.replaceState(null, '', u.pathname + u.search + u.hash); } catch (e) {}
  };
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.corpus === 'open' && d.view && W.onOpenView) W.onOpenView(d.view);
  });
  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function standalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }
  function pushCapable() { return configured && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function b64ToU8(b) {
    var s = atob((b + '='.repeat((4 - b.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  async function subId(ep) {
    var h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ep)));
    return Array.prototype.slice.call(h, 0, 16).map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  async function pushFetch(method, body) {
    var s = await sb.auth.getSession();
    var tok = s && s.data && s.data.session ? s.data.session.access_token : '';
    var r;
    try {
      r = await fetch(PUSH_FN, { method: method, headers: { Authorization: 'Bearer ' + tok, apikey: CFG.key, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined });
    } catch (e) { throw { code: 'unavailable', message: String((e && e.message) || e) }; }
    var j = null;
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw { code: r.status === 404 ? 'not_set_up' : ((j && j.code) || 'unavailable'), message: (j && j.message) || ('HTTP ' + r.status) };
    return j;
  }
  async function swReg() {
    if (!('serviceWorker' in navigator)) return null;
    return Promise.race([navigator.serviceWorker.ready, new Promise(function (r) { setTimeout(function () { r(null); }, 5000); })]);
  }
  W.push = Object.freeze({
    /* 'on' | 'off' | 'denied' | 'install' (iPhone/iPad: open from the home screen first) | 'unsupported' */
    state: async function () {
      if (!pushCapable()) return isIOS() && !standalone() ? 'install' : 'unsupported';
      if (Notification.permission === 'denied') return 'denied';
      var reg = await swReg();
      if (!reg) return 'unsupported';
      var sub = await reg.pushManager.getSubscription();
      return sub && Notification.permission === 'granted' ? 'on' : 'off';
    },
    /* call straight from a tap: the permission prompt needs it */
    enable: async function () {
      if (!pushCapable()) throw { code: isIOS() && !standalone() ? 'install' : 'unsupported' };
      var perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (perm !== 'granted') throw { code: perm === 'denied' ? 'denied' : 'declined' };
      var reg = await swReg();
      if (!reg) throw { code: 'unsupported' };
      var j = await pushFetch('GET');
      if (!j || !j.publicKey) throw { code: 'not_set_up' };
      var key = b64ToU8(j.publicKey), sub = await reg.pushManager.getSubscription();
      if (sub && sub.options && sub.options.applicationServerKey) {
        var cur = new Uint8Array(sub.options.applicationServerKey), same = cur.length === key.length;
        for (var i = 0; same && i < key.length; i++) same = cur[i] === key[i];
        if (!same) { try { await sub.unsubscribe(); } catch (e) {} sub = null; }
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      var js = sub.toJSON();
      var res = await sb.from('docs').upsert({ owner: W.uid, coll: 'push', id: await subId(js.endpoint),
        data: { endpoint: js.endpoint, keys: js.keys, ua: String(navigator.userAgent || '').slice(0, 160), at: Date.now() },
        updated_at: new Date().toISOString() }, { onConflict: 'owner,coll,id' });
      if (res.error) throw { code: 'unavailable', message: res.error.message };
      return true;
    },
    disable: async function () {
      var reg = await swReg(), sub = reg ? await reg.pushManager.getSubscription() : null;
      if (!sub) return;
      var id = await subId(sub.endpoint);
      try { await sub.unsubscribe(); } catch (e) {}
      await sb.from('docs').delete().eq('owner', W.uid).eq('coll', 'push').eq('id', id);
    },
    /* a test notification to this person's devices */
    test: function (lang) { return pushFetch('POST', { test: true, lang: lang }); }
  });

  /* ---------- db: documents in public.docs (owner, coll, id) → data ---------- */
  function mkDb(uid) {
    var T = 'docs';
    function genId() {
      var a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', b = crypto.getRandomValues(new Uint8Array(20)), s = '';
      for (var i = 0; i < b.length; i++) s += a[b[i] % 62];
      return s;
    }
    function fail(res) {
      var e = (res && res.error) || {}, st = (res && res.status) | 0, m = String(e.message || '');
      if (e.code === 'P0002' || /doc_missing/.test(m)) return { code: 'invalid_argument', message: 'document does not exist' };
      if (e.code === '25006' || /read-only/i.test(m)) return { code: 'quota_exceeded', message: m || 'database is read-only' };
      if (st === 413 || e.code === '54000') return { code: 'invalid_argument', message: m || 'too large' };
      return { code: 'unavailable', message: m || 'network error' };
    }
    function docRef(coll, id) {
      return Object.freeze({
        id: id, path: coll + '/' + id,
        get: async function () {
          var res = await sb.from(T).select('data').eq('owner', uid).eq('coll', coll).eq('id', id).maybeSingle();
          if (res.error) throw fail(res);
          var d = res.data ? res.data.data : undefined;
          return { id: id, exists: !!res.data, data: function () { return d; } };
        },
        set: async function (obj) {
          var res = await sb.from(T).upsert({ owner: uid, coll: coll, id: id, data: obj, updated_at: new Date().toISOString() }, { onConflict: 'owner,coll,id' });
          if (res.error) throw fail(res);
        },
        update: async function (patch) {
          var res = await sb.rpc('corpus_doc_update', { p_coll: coll, p_id: id, p_patch: patch });
          if (res.error) throw fail(res);
        },
        delete: async function () {
          var res = await sb.from(T).delete().eq('owner', uid).eq('coll', coll).eq('id', id);
          if (res.error) throw fail(res);
        }
      });
    }
    function collection(coll) {
      return Object.freeze({
        doc: function (id) { return docRef(coll, id || genId()); },
        get: async function () {
          var docs = [], PAGE = 1000;
          for (var from = 0; ; from += PAGE) {
            var res = await sb.from(T).select('id,data').eq('owner', uid).eq('coll', coll).order('id').range(from, from + PAGE - 1);
            if (res.error) throw fail(res);
            res.data.forEach(function (r) { var d = r.data; docs.push({ id: r.id, exists: true, data: function () { return d; } }); });
            if (res.data.length < PAGE) break;
          }
          return { docs: docs, size: docs.length, empty: !docs.length };
        }
      });
    }
    /* many documents in one request (an import writes hundreds of photos and packs at once) */
    async function setMany(items) {
      var now = new Date().toISOString();
      var rows = items.map(function (it) { return { owner: uid, coll: it.coll, id: it.id, data: it.data, updated_at: now }; });
      var res = await sb.from(T).upsert(rows, { onConflict: 'owner,coll,id' });
      if (res.error) throw fail(res);
    }
    return Object.freeze({
      collection: collection,
      doc: function (path) { var p = String(path).split('/'); return docRef(p.slice(0, -1).join('/'), p[p.length - 1]); },
      setMany: setMany
    });
  }


  /* ---------- guest: look around without an account. Everything lives in memory and disappears on reload. ---------- */
  async function guestStart() {
    W.guest = true; W.uid = 'guest'; W.email = ''; W.starter = ''; W.push = null; W.guestUrls = {};
    guestBanner();
    /* a few AI requests with the cheapest model, counted per visitor by the function (supabase/demo.sql) */
    var st = await Promise.race([aiStatus(), new Promise(function (r) { setTimeout(function () { r(null); }, 3000); })]);
    if (st) W.ai = st;
    return { db: mkGuestDb(), assets: mkGuestAssets(), downloads: mkDownloads(), user: mkUser({ id: 'guest', email: '' }), sample: st ? mkSample() : null };
  }
  function guestBanner() {
    var b = document.createElement('div');
    b.className = 'cw-guest';
    b.innerHTML = '<span>Демо-режим: ничего не сохраняется — после закрытия всё исчезнет. ИИ — до 5 запросов.</span>' +
      '<button type="button" class="cw-guest-go">Войти или создать аккаунт</button>';
    b.querySelector('button').addEventListener('click', function () { location.reload(); });
    document.body.insertBefore(b, document.body.firstChild);
    document.body.classList.add('cw-is-guest');
  }
  function mkGuestDb() {
    var store = {}, seq = 0;
    function key(c, id) { return c + '/' + id; }
    function genId() { return 'g' + Date.now().toString(36) + (++seq).toString(36) + Math.random().toString(36).slice(2, 8); }
    function copy(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
    function docRef(coll, id) {
      return Object.freeze({
        id: id, path: coll + '/' + id,
        get: async function () { var d = copy(store[key(coll, id)]); return { id: id, exists: d !== undefined, data: function () { return d; } }; },
        set: async function (obj) { store[key(coll, id)] = copy(obj); },
        update: async function (patch) {
          var k = key(coll, id);
          if (!(k in store)) throw { code: 'invalid_argument', message: 'document does not exist' };
          store[k] = Object.assign({}, store[k], copy(patch));
        },
        delete: async function () { delete store[key(coll, id)]; }
      });
    }
    return Object.freeze({
      collection: function (coll) {
        return Object.freeze({
          doc: function (id) { return docRef(coll, id || genId()); },
          get: async function () {
            var docs = Object.keys(store).filter(function (k) { return k.indexOf(coll + '/') === 0; }).sort().map(function (k) {
              var d = copy(store[k]); return { id: k.slice(coll.length + 1), exists: true, data: function () { return d; } };
            });
            return { docs: docs, size: docs.length, empty: !docs.length };
          }
        });
      },
      doc: function (path) { var p = String(path).split('/'); return docRef(p.slice(0, -1).join('/'), p[p.length - 1]); },
      setMany: async function (items) { items.forEach(function (it) { store[key(it.coll, it.id)] = copy(it.data); }); }
    });
  }
  function mkGuestAssets() {
    var n = 0;
    return Object.freeze({
      upload: async function (blob) {
        var id = 'guest' + Date.now().toString(36) + (++n).toString(36), type = (blob && blob.type) || 'image/jpeg';
        var url = URL.createObjectURL(blob);
        W.guestUrls[id] = url;
        return { id: id, url: url, sizeBytes: blob.size || 0, contentType: type };
      },
      delete: async function (id) { var u = W.guestUrls[id]; if (u) { try { URL.revokeObjectURL(u); } catch (e) {} delete W.guestUrls[id]; } },
      list: async function () { return { assets: [], usage: {} }; }
    });
  }

  /* ---------- shares: a deck or folder for another person, by code / QR (supabase/share.sql) ---------- */
  function mkShares() {
    function shareFail(res) {
      var e = (res && res.error) || {}, m = String(e.message || '');
      if (e.code === 'P0002' || /share_not_found/.test(m)) return { code: 'not_found', message: 'no such share' };
      if (e.code === '54000' || /share_too_large/.test(m) || (res && res.status === 413)) return { code: 'too_large', message: m || 'too large' };
      if (e.code === '42883' || e.code === 'PGRST202' || e.code === '42P01' || /could not find the function|does not exist/i.test(m)) return { code: 'not_set_up', message: m };
      return { code: 'unavailable', message: m || 'network error' };
    }
    var link = function (code) { return location.origin + BASE + '?s=' + encodeURIComponent(code); };
    return Object.freeze({
      link: link,
      /* publish (or refresh) the share of one deck / folder; the code stays the same for the same source */
      put: async function (src, kind, name, data) {
        var r = await sb.rpc('corpus_share_put', { p_src: String(src), p_kind: String(kind), p_name: String(name || ''), p_data: data });
        if (r.error) throw shareFail(r);
        var o = r.data || {};
        return { code: o.code, url: link(o.code), createdAt: o.createdAt || null };
      },
      /* what another person shared, by code */
      open: async function (code) {
        var r = await sb.rpc('corpus_share_open', { p_code: String(code || '').trim().toLowerCase() });
        if (r.error) throw shareFail(r);
        return r.data;
      },
      /* my own share of this source, if any (its code and how many times it was opened) */
      get: async function (src) {
        var r = await sb.from('shares').select('code,opens,created_at,updated_at').eq('owner', W.uid).eq('src', String(src)).maybeSingle();
        if (r.error) throw shareFail(r);
        return r.data ? { code: r.data.code, url: link(r.data.code), opens: r.data.opens | 0, createdAt: r.data.created_at, updatedAt: r.data.updated_at } : null;
      },
      /* stop sharing: the code and the QR stop working */
      drop: async function (src) {
        var r = await sb.from('shares').delete().eq('owner', W.uid).eq('src', String(src));
        if (r.error) throw shareFail(r);
      }
    });
  }

  /* ---------- assets: photos in Storage, random names ---------- */
  function mkAssets() {
    function newName() {
      if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
      var b = crypto.getRandomValues(new Uint8Array(16)), s = '';
      for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
      return s;
    }
    function upFail(e) {
      var sc = String((e && (e.statusCode || e.status)) || ''), m = String((e && e.message) || '');
      if (sc === '413' || /maximum allowed size|too large/i.test(m)) return { code: 'too_large', message: m };
      if (sc === '415' || /mime type/i.test(m)) return { code: 'unsupported_type', message: m };
      if (sc === '429' || /rate limit/i.test(m)) return { code: 'rate_limited', message: m };
      if (/quota|exceed/i.test(m)) return { code: 'quota_or_state', message: m };
      return { code: 'unavailable', message: m || 'upload failed' };
    }
    return Object.freeze({
      upload: async function (blob) {
        var id = newName(), type = (blob && blob.type) || 'image/jpeg';
        if (!blob.type) blob = new Blob([blob], { type: type });   // the part's type must pass the bucket's image/* rule
        var res = await sb.storage.from(BUCKET).upload(id, blob, { contentType: type, cacheControl: '31536000', upsert: false });
        if (res.error) throw upFail(res.error);
        return { id: id, url: W.blobBase + id, sizeBytes: blob.size || 0, contentType: type };
      },
      delete: async function (id) {
        var res = await sb.storage.from(BUCKET).remove([String(id)]);
        if (res.error) throw { code: 'unavailable', message: res.error.message || 'delete failed' };
        try { var c = await caches.open(CACHE); await c.delete(BASE + '_blob/' + id); } catch (e) {}
      },
      list: async function () { return { assets: [], usage: {} }; }
    });
  }

  /* ---------- downloads: a file the app generated ---------- */
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  function mkDownloads() {
    return Object.freeze({
      save: async function (opts) {
        var data = opts && opts.data, name = String((opts && opts.filename) || 'corpus-file');
        var blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : JSON.stringify(data)], { type: 'application/octet-stream' });
        var file = null;
        try { file = new File([blob], name, { type: blob.type || 'application/octet-stream' }); } catch (e) {}
        var phone = window.matchMedia && matchMedia('(pointer:coarse)').matches;
        if (file && phone && navigator.canShare && navigator.share) {
          var ok = false;
          try { ok = navigator.canShare({ files: [file] }); } catch (e) {}
          if (ok) return fileSheet(file, blob, name);
        }
        downloadBlob(blob, name);
      }
    });
  }
  /* the share sheet needs a fresh tap, so the file is offered on a small sheet first */
  function fileSheet(file, blob, name) {
    return new Promise(function (res, rej) {
      var ov = document.createElement('div');
      ov.className = 'cw-ov';
      ov.innerHTML = '<div class="cw-sheet" role="dialog" aria-modal="true"><b>Файл готов</b><span class="cw-fn"></span>' +
        '<button class="btn primary block" data-a="share">Отправить…</button>' +
        '<button class="btn line block" data-a="dl">Сохранить на устройство</button>' +
        '<button class="btn quiet block" data-a="x">Отмена</button></div>';
      ov.querySelector('.cw-fn').textContent = name;
      function close() { ov.remove(); }
      ov.addEventListener('click', function (e) {
        var b = e.target.closest('[data-a]'), a = b ? b.dataset.a : (e.target === ov ? 'x' : null);
        if (!a) return;
        if (a === 'share') {
          navigator.share({ files: [file] }).then(function () { close(); res(); }, function (er) {
            if (er && er.name === 'AbortError') return;      // closed the share sheet: offer the choices again
            close(); downloadBlob(blob, name); res();
          });
          return;
        }
        close();
        if (a === 'dl') { downloadBlob(blob, name); res(); }
        else rej({ code: 'declined', message: 'declined' });
      });
      document.body.appendChild(ov);
    });
  }

  /* ---------- sample: Claude through the corpus-ai function ---------- */
  async function fnFetch(method, body, signal) {
    if (W.guest) {
      return fetch(FN, {
        method: method, signal: signal,
        headers: { apikey: CFG.key, 'x-corpus-demo': '1', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
    }
    var s = await sb.auth.getSession();
    var tok = s && s.data && s.data.session ? s.data.session.access_token : '';
    return fetch(FN, {
      method: method, signal: signal,
      headers: { Authorization: 'Bearer ' + tok, apikey: CFG.key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
  }
  /* today's allowance, or null while the function is not deployed / has no API key */
  async function aiStatus() {
    try {
      var r = await fnFetch('GET');
      if (!r.ok) return null;
      var j = await r.json();
      return j && j.ready ? { plan: j.plan, limit: j.limit, used: j.used } : null;
    } catch (e) { return null; }
  }
  function toB64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result); res(s.slice(s.indexOf(',') + 1)); };
      fr.onerror = function () { rej({ code: 'image_rejected', message: 'could not read the image' }); };
      fr.readAsDataURL(blob);
    });
  }
  async function imageBlocks(images) {
    var list = !images ? [] : (images instanceof Blob ? [images] : Array.prototype.slice.call(images));
    if (list.length > 4) throw { code: 'image_rejected', message: 'at most 4 images' };
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var t = String(list[i].type || 'image/jpeg').toLowerCase();
      if (!/^image\/(jpeg|png|webp|gif)$/.test(t)) throw { code: 'image_rejected', message: 'unsupported image type ' + t };
      out.push({ type: 'image', source: { type: 'base64', media_type: t, data: await toB64(list[i]) } });
    }
    return out;
  }
  /* the whole reply as JSON; else one code fence; else from the first { or [ to the last } or ] */
  function parseLoose(text) {
    var t = String(text || '').trim();
    try { return { ok: true, v: JSON.parse(t) }; } catch (e) {}
    var m = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
    if (m) { try { return { ok: true, v: JSON.parse(m[1].trim()) }; } catch (e) {} }
    var a = t.search(/[[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a >= 0 && b > a) { try { return { ok: true, v: JSON.parse(t.slice(a, b + 1)) }; } catch (e) {} }
    return { ok: false };
  }
  function mkSample() {
    async function ask(input, opts, asJson) {
      opts = opts || {};
      if (opts.signal && opts.signal.aborted) throw { code: 'cancelled', message: 'cancelled' };
      var turns = typeof input === 'string' ? [{ role: 'user', content: input }]
        : (Array.isArray(input) ? input.map(function (t) { return { role: t.role, content: String(t.content) }; }) : []);
      if (!turns.length) throw { code: 'invalid_input', message: 'empty input' };
      var imgs = await imageBlocks(opts.images);
      if (imgs.length) {
        var last = turns[turns.length - 1];
        turns[turns.length - 1] = { role: last.role, content: imgs.concat([{ type: 'text', text: last.content }]) };
      }
      var r;
      try { r = await fnFetch('POST', { messages: turns, json: !!asJson, max_tokens: asJson ? 3000 : 1500 }, opts.signal); }
      catch (e) {
        if (e && e.name === 'AbortError') throw { code: 'cancelled', message: 'cancelled' };
        throw { code: 'unavailable', message: String((e && e.message) || e) };
      }
      var j = null;
      try { j = await r.json(); } catch (e) {}
      if (j && j.limit != null) W.ai = { plan: j.plan, limit: j.limit, used: j.used };
      if (!r.ok || !j) throw { code: (j && j.code) || 'unavailable', message: (j && j.message) || ('HTTP ' + r.status) };
      if (opts.onText) { try { opts.onText({ text: j.text, delta: j.text }); } catch (e) {} }
      return j;
    }
    var sample = async function (input, opts) {
      var j = await ask(input, opts, false);
      return { text: j.text, truncated: !!j.truncated };
    };
    sample.json = async function (input, opts) {
      var j = await ask(input, opts, true);
      var p = parseLoose(j.text);
      if (j.truncated || !p.ok) throw { code: 'invalid_json', message: j.truncated ? 'the answer was cut short' : 'no JSON in the answer', text: j.text };
      return p.v;
    };
    sample.limits = async function () {
      return { maxPromptBytes: 65536, images: { maxCount: 4, maxInputBytes: 5 * 1024 * 1024, mediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] } };
    };
    return Object.freeze(sample);
  }

  /* ---------- user ---------- */
  function mkUser(u) {
    var me = { id: u.id, email: u.email || '', name: '' };
    return Object.freeze({
      isOwner: async function () { return true; },     // everyone owns their own Corpus here
      canEdit: async function () { return true; },
      can: async function () { return true; },
      id: async function () { return u.id; },
      me: async function () { return me; },
      profiles: async function () { return {}; },
      search: async function () { return []; }
    });
  }

  /* ---------- screens shown before the app: sign in / sign up, not configured ---------- */
  function bodyReady() {
    if (document.body) return Promise.resolve();
    return new Promise(function (r) { document.addEventListener('DOMContentLoaded', r, { once: true }); });
  }
  function curLang() { try { var v = localStorage.getItem('corpus.lang'); if (v === 'ru' || v === 'en' || v === 'et') return v; } catch (e) {} return 'et'; }
  function langRow() {
    var cur = curLang();
    return '<div class="cw-lang">' + [['ru', 'Русский'], ['en', 'English'], ['et', 'Eesti']].map(function (o) {
      return '<button type="button" data-noi18n data-lang="' + o[0] + '" class="' + (o[0] === cur ? 'on' : '') + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function onLang(root) {
    root.addEventListener('click', function (e) {
      var b = e.target.closest('[data-lang]');
      if (!b) return;
      try { localStorage.setItem('corpus.lang', b.dataset.lang); } catch (er) {}
      location.reload();
    });
  }
  var AURORA = '<div class="cw-aur" aria-hidden="true"><i></i><i></i><i></i><i></i></div>';
  var BRAND = '<div class="cw-brand"><span class="cw-word">Corpus</span></div>';

  function notConfigured() {
    var d = document.createElement('div');
    d.className = 'cw-auth';
    d.innerHTML = AURORA + AURORA + '<div class="cw-card">' + BRAND + '<div class="cw-box"><div class="h2">Сайт ещё настраивается</div>' +
      '<p class="muted" style="margin:6px 0 0">Загляните чуть позже.</p></div>' + langRow() + '</div>';
    onLang(d);
    document.body.appendChild(d);
  }

  function authErrText(e) {
    var c = String((e && e.code) || ''), m = String((e && e.message) || ''), st = (e && e.status) | 0;
    if (c === 'invalid_credentials' || /invalid login credentials/i.test(m)) return 'Неверный email или пароль.';
    if (c === 'user_already_exists' || c === 'email_exists' || /already (been )?registered/i.test(m)) return 'Такой email уже зарегистрирован — войдите.';
    if (c === 'same_password' || /different from the old/i.test(m)) return 'Новый пароль должен отличаться от старого.';
    if (c === 'weak_password' || /at least \d+ char/i.test(m)) return 'Пароль — минимум 6 символов.';
    if (c === 'email_not_confirmed' || /not confirmed/i.test(m)) return 'Вход требует подтверждения почты, а письма отсюда не отправляются. Попросите администратора выключить «Confirm email» в Supabase.';
    if (c === 'signup_disabled' || /signups not allowed/i.test(m)) return 'Регистрация сейчас закрыта.';
    if (st === 429 || /rate limit/i.test(c + ' ' + m)) return 'Слишком много попыток — подождите пару минут.';
    if (c === 'email_address_invalid' || c === 'validation_failed' || /invalid format|unable to validate email/i.test(m)) return 'Проверьте email.';
    if (c === 'unexpected_failure' || /database error/i.test(m)) return 'Нужна ссылка-приглашение: откройте ссылку, которую вам прислали, или введите код.';
    if ((e && e.name === 'AuthRetryableFetchError') || /failed to fetch|network|load failed/i.test(m)) return 'Нет соединения. Попробуйте ещё раз.';
    return 'Не получилось войти. Попробуйте ещё раз.';
  }

  /* link from the password-reset e-mail: <site>/#access_token=…&type=recovery (or #error_code=otp_expired) */
  function recoveryParams() {
    var h = location.hash.replace(/^#/, '');
    return /(^|&)(type=recovery|error_code=)/.test(h) ? new URLSearchParams(h) : null;
  }
  async function recoveryScreen() {
    await bodyReady();
    return new Promise(function (resolve) {
      var d = document.createElement('div');
      d.className = 'cw-auth';
      d.innerHTML = AURORA + '<div class="cw-card">' + BRAND + '<p class="cw-sub">Придумайте новый пароль для входа в Corpus.</p>' +
        '<div class="cw-box"><form novalidate>' +
        '<label class="cw-f">Новый пароль<input name="password" type="password" minlength="6" autocomplete="new-password" required></label>' +
        '<div class="cw-err" role="alert"></div>' +
        '<button class="btn primary big block cw-go" type="submit">Сохранить пароль</button></form></div>' + langRow() + '</div>';
      var f = d.querySelector('form'), err = d.querySelector('.cw-err'), go = d.querySelector('.cw-go'), busy = false;
      onLang(d);
      f.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (busy) return;
        var pw = f.password.value;
        if (pw.length < 6) { err.textContent = 'Пароль — минимум 6 символов.'; f.password.focus(); return; }
        busy = true; go.disabled = true; err.textContent = '';
        try {
          var r = await sb.auth.updateUser({ password: pw });
          if (r.error) throw r.error;
          var g = await sb.auth.getSession();
          if (!g.data || !g.data.session) throw { message: 'no session' };
          d.classList.add('out');
          setTimeout(function () { d.remove(); }, 220);
          resolve(g.data.session);
        } catch (er) { err.textContent = authErrText(er); busy = false; go.disabled = false; }
      });
      document.body.appendChild(d);
      setTimeout(function () { try { f.password.focus({ preventScroll: true }); } catch (e) {} }, 60);
    });
  }

  async function authScreen(firstMsg) {
    await bodyReady();
    return new Promise(function (resolve) {
      var known = false;
      try { known = !!localStorage.getItem('corpus.known'); } catch (e) {}
      var mode = (!known && storedInvite()) ? 'up' : 'in';
      var d = document.createElement('div');
      d.className = 'cw-auth';
      d.innerHTML = AURORA + '<div class="cw-card">' + BRAND +
        '<p class="cw-sub">' + (W.shareCode ? 'Вам передали колоду Corpus. Войдите или создайте аккаунт — колода появится у вас.' : 'Анатомия по изображениям: колоды из фото атласа и интервальные повторения.') + '</p>' +
        '<div class="cw-box"><div class="cw-tabs" role="tablist">' +
        '<button type="button" role="tab" data-m="in">Вход</button><button type="button" role="tab" data-m="up">Регистрация</button></div>' +
        '<form novalidate>' +
        '<label class="cw-f">Email<input name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" required></label>' +
        '<label class="cw-f">Пароль<input name="password" type="password" minlength="6" required></label>' +
        '<label class="cw-f cw-inv">Код приглашения<input name="invite" autocomplete="off" autocapitalize="off" spellcheck="false"></label>' +
        '<div class="cw-err" role="alert"></div>' +
        '<button class="btn primary big block cw-go" type="submit"></button>' +
        '<button type="button" class="cw-forgot">Забыли пароль?</button></form></div>' +
        '<button type="button" class="cw-guest-btn"><b>Демо-режим</b><span>Посмотреть без аккаунта · 5 запросов ИИ</span></button>' +
        '<p class="cw-note"></p>' + langRow() + '</div>';
      var f = d.querySelector('form'), err = d.querySelector('.cw-err'), go = d.querySelector('.cw-go'), note = d.querySelector('.cw-note');
      var invWrap = d.querySelector('.cw-inv'), forgot = d.querySelector('.cw-forgot');
      var busy = false, showInvite = false;

      function paint() {
        d.querySelectorAll('[data-m]').forEach(function (b) {
          var on = b.dataset.m === mode;
          b.classList.toggle('on', on);
          b.setAttribute('aria-selected', String(on));
        });
        go.textContent = busy ? 'Подождите…' : (mode === 'in' ? 'Войти' : 'Создать аккаунт');
        go.disabled = busy;
        f.password.setAttribute('autocomplete', mode === 'in' ? 'current-password' : 'new-password');
        invWrap.style.display = mode === 'up' && (showInvite || !storedInvite()) ? '' : 'none';
        forgot.style.display = mode === 'in' ? '' : 'none';
        forgot.disabled = busy;
        note.textContent = mode === 'in' ? '' : 'Аккаунт хранит ваши колоды и прогресс — они будут доступны с любого устройства.';
      }
      function say(t, ok) { err.textContent = t || ''; err.classList.toggle('cw-ok', !!ok); }
      forgot.addEventListener('click', async function () {
        if (busy) return;
        var email = f.email.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('Введите email выше, и мы пришлём ссылку для нового пароля.'); f.email.focus(); return; }
        busy = true; say(''); paint();
        try {
          var rr = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + BASE });
          if (rr.error) throw rr.error;
          say('Если такой аккаунт есть, мы отправили письмо со ссылкой для нового пароля. Проверьте и папку «Спам».', true);
        } catch (er) { say(authErrText(er)); }
        finally { busy = false; if (d.isConnected) paint(); }
      });

      d.querySelector('.cw-tabs').addEventListener('click', function (e) {
        var b = e.target.closest('[data-m]');
        if (!b || busy) return;
        mode = b.dataset.m; say(''); paint();
      });
      onLang(d);
      d.querySelector('.cw-guest-btn').addEventListener('click', function () {
        if (busy) return;
        d.classList.add('out');
        setTimeout(function () { d.remove(); }, 220);
        resolve({ guest: true });
      });
      f.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (busy) return;
        var email = f.email.value.trim(), pw = f.password.value;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say('Проверьте email.'); f.email.focus(); return; }
        if (pw.length < 6) { say('Пароль — минимум 6 символов.'); f.password.focus(); return; }
        busy = true; say(''); paint();
        try {
          var res;
          if (mode === 'in') {
            res = await sb.auth.signInWithPassword({ email: email, password: pw });
            if (res.error) throw res.error;
            finish(res.data.session);
          } else {
            var inv = (f.invite.value || '').trim() || storedInvite();
            res = await sb.auth.signUp({ email: email, password: pw, options: { data: { invite: inv } } });
            if (res.error) throw res.error;
            if (res.data && res.data.session) {
              if (inv) { try { localStorage.setItem('corpus.invite', inv); } catch (er) {} }
              finish(res.data.session);
            } else if (res.data && res.data.user && Array.isArray(res.data.user.identities) && !res.data.user.identities.length) {
              say('Такой email уже зарегистрирован — войдите.');
            } else {
              say(authErrText({ code: 'email_not_confirmed' }));
            }
          }
        } catch (er) {
          var t = authErrText(er);
          if (mode === 'up' && /приглашение/.test(t)) { showInvite = true; }
          say(t);
        } finally {
          busy = false;
          if (d.isConnected) paint();
        }
      });
      function finish(session) {
        if (!session) { say('Не получилось войти. Попробуйте ещё раз.'); return; }
        d.classList.add('out');
        setTimeout(function () { d.remove(); }, 220);
        resolve(session);
      }
      paint();
      if (firstMsg) say(firstMsg);
      document.body.appendChild(d);
      setTimeout(function () { try { f.email.focus({ preventScroll: true }); } catch (e) {} }, 60);
    });
  }
})();
