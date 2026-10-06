/* Corpus — web runtime.
   The app (src/corpus.html) was written for claude.ai, where a page reaches storage through
   window.claude.use(name). This file provides the same namespaces on top of Supabase, so the very
   same app runs as a website:
     db        — the user's documents (table public.docs, row-level security: only the owner sees them)
     assets    — photos in Supabase Storage, served same-origin at <site>/_blob/<id> by sw.js
     downloads — save a generated file (on phones: the share sheet, e.g. straight to Telegram)
     user      — the signed-in person
   'sample' (asking Claude) does not exist outside claude.ai; the app hides those features. */
(function () {
  'use strict';
  var CFG = window.CORPUS_CONFIG || {};
  var BASE = new URL('./', location.href).pathname;            // e.g. /corpus/
  var BUCKET = CFG.bucket || 'plates';
  var CACHE = 'corpus-blobs-v1';
  var configured = !!(CFG.url && CFG.key && window.supabase && window.supabase.createClient);
  var PUBLIC = configured ? CFG.url.replace(/\/+$/, '') + '/storage/v1/object/public/' + BUCKET + '/' : '';

  var W = { blobBase: BASE + '_blob/', email: '', uid: '', signOut: signOut };
  window.CORPUS_WEB = W;

  /* the invite code arrives in the link (?i=...) and is kept for the sign-up form */
  try {
    var u0 = new URL(location.href), inv0 = u0.searchParams.get('i');
    if (inv0) {
      localStorage.setItem('corpus.invite', inv0);
      u0.searchParams.delete('i');
      history.replaceState(null, '', u0.pathname + u0.search + u0.hash);
    }
  } catch (e) {}
  function storedInvite() { try { return localStorage.getItem('corpus.invite') || ''; } catch (e) { return ''; } }

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
    var r = await sb.auth.getSession();
    var session = r && r.data && r.data.session;
    if (!session) session = await authScreen();
    if (!(await swP)) W.blobBase = PUBLIC;    // no service worker (rare): load photos straight from Storage
    W.uid = session.user.id;
    W.email = session.user.email || '';
    try { localStorage.setItem('corpus.known', '1'); } catch (e) {}
    /* signed out elsewhere (or the session was revoked): start over at the sign-in screen */
    sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT' && !leaving) setTimeout(function () { location.reload(); }, 0); });
    return { db: mkDb(session.user.id), assets: mkAssets(), downloads: mkDownloads(), user: mkUser(session.user) };
  })();

  window.claude = Object.freeze({
    use: async function (name) {
      if (name === 'sample') return null;
      var ns = await ready;
      return (ns && ns[name]) || null;
    }
  });

  var leaving = false;
  async function signOut() {
    leaving = true;
    try { await sb.auth.signOut({ scope: 'local' }); } catch (e) {}
    try { await caches.delete(CACHE); } catch (e) {}
    location.reload();
  }

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
          var docs = [], PAGE = 200;
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
    return Object.freeze({
      collection: collection,
      doc: function (path) { var p = String(path).split('/'); return docRef(p.slice(0, -1).join('/'), p[p.length - 1]); }
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
  var BRAND = '<div class="cw-brand"><span class="brand-mark" aria-hidden="true"><i></i><b></b></span><span>Corpus</span></div>';

  function notConfigured() {
    var d = document.createElement('div');
    d.className = 'cw-auth';
    d.innerHTML = '<div class="cw-card">' + BRAND + '<div class="cw-box"><div class="h2">Сайт ещё настраивается</div>' +
      '<p class="muted" style="margin:6px 0 0">Загляните чуть позже.</p></div>' + langRow() + '</div>';
    onLang(d);
    document.body.appendChild(d);
  }

  function authErrText(e) {
    var c = String((e && e.code) || ''), m = String((e && e.message) || ''), st = (e && e.status) | 0;
    if (c === 'invalid_credentials' || /invalid login credentials/i.test(m)) return 'Неверный email или пароль.';
    if (c === 'user_already_exists' || c === 'email_exists' || /already (been )?registered/i.test(m)) return 'Такой email уже зарегистрирован — войдите.';
    if (c === 'weak_password' || /at least \d+ char/i.test(m)) return 'Пароль — минимум 6 символов.';
    if (c === 'email_not_confirmed' || /not confirmed/i.test(m)) return 'Вход требует подтверждения почты, а письма отсюда не отправляются. Попросите администратора выключить «Confirm email» в Supabase.';
    if (c === 'signup_disabled' || /signups not allowed/i.test(m)) return 'Регистрация сейчас закрыта.';
    if (st === 429 || /rate limit/i.test(c + ' ' + m)) return 'Слишком много попыток — подождите пару минут.';
    if (c === 'email_address_invalid' || c === 'validation_failed' || /invalid format|unable to validate email/i.test(m)) return 'Проверьте email.';
    if (c === 'unexpected_failure' || /database error/i.test(m)) return 'Нужна ссылка-приглашение: откройте ссылку, которую вам прислали, или введите код.';
    if ((e && e.name === 'AuthRetryableFetchError') || /failed to fetch|network|load failed/i.test(m)) return 'Нет соединения. Попробуйте ещё раз.';
    return 'Не получилось войти. Попробуйте ещё раз.';
  }

  async function authScreen() {
    await bodyReady();
    return new Promise(function (resolve) {
      var known = false;
      try { known = !!localStorage.getItem('corpus.known'); } catch (e) {}
      var mode = (!known && storedInvite()) ? 'up' : 'in';
      var d = document.createElement('div');
      d.className = 'cw-auth';
      d.innerHTML = '<div class="cw-card">' + BRAND +
        '<p class="cw-sub">Анатомия по изображениям: колоды из фото атласа и интервальные повторения.</p>' +
        '<div class="cw-box"><div class="cw-tabs" role="tablist">' +
        '<button type="button" role="tab" data-m="in">Вход</button><button type="button" role="tab" data-m="up">Регистрация</button></div>' +
        '<form novalidate>' +
        '<label class="cw-f">Email<input name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" required></label>' +
        '<label class="cw-f">Пароль<input name="password" type="password" minlength="6" required></label>' +
        '<label class="cw-f cw-inv">Код приглашения<input name="invite" autocomplete="off" autocapitalize="off" spellcheck="false"></label>' +
        '<div class="cw-err" role="alert"></div>' +
        '<button class="btn primary big block cw-go" type="submit"></button></form></div>' +
        '<p class="cw-note"></p>' + langRow() + '</div>';
      var f = d.querySelector('form'), err = d.querySelector('.cw-err'), go = d.querySelector('.cw-go'), note = d.querySelector('.cw-note');
      var invWrap = d.querySelector('.cw-inv');
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
        note.textContent = mode === 'in'
          ? 'Забыли пароль? Попросите того, кто дал вам ссылку, сбросить его.'
          : 'Аккаунт хранит ваши колоды и прогресс — они будут доступны с любого устройства.';
      }
      function say(t) { err.textContent = t || ''; }

      d.querySelector('.cw-tabs').addEventListener('click', function (e) {
        var b = e.target.closest('[data-m]');
        if (!b || busy) return;
        mode = b.dataset.m; say(''); paint();
      });
      onLang(d);
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
      document.body.appendChild(d);
      setTimeout(function () { try { f.email.focus({ preventScroll: true }); } catch (e) {} }, 60);
    });
  }
})();
