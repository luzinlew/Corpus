#!/usr/bin/env python3
"""End-to-end test of the website against tools/fake-supabase.js (no real Supabase needed).

    pip install playwright && python3 -m playwright install chromium
    python3 tools/e2e_test.py

The AI function (supabase/functions/corpus-ai) runs for real in Deno (`deno` on PATH, else `npx deno`),
talking to the fake backend and to a fake Claude API inside it.

Covers: invite sign-up, sign in / out, AI through the function (text, JSON, images, daily limit,
hidden when the function is not deployed), importing a folder file (photos to Storage, cards to packs),
progress saved through the merge RPC and restored after reload, photos served by the service worker
and readable on a canvas, exporting a folder, importing an Anki .apkg (pictures read from the zip by
offset, uploaded in parallel, documents written in batches), sharing a folder by code / QR and receiving
it in another account, isolation between two accounts, and the no-service-worker fallback.
Prints one line per check and exits non-zero on the first failure."""
import asyncio, base64, io, json, os, pathlib, re, shutil, socket, sqlite3, subprocess, sys, tempfile, time, urllib.request, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE_PORT, API_PORT, FN_PORT, INVITE, AI_LIMIT = 8765, 54321, 8000, 'p8wyzmtw', 6
API = f'http://localhost:{API_PORT}'
SITE = f'http://localhost:{SITE_PORT}/corpus/'


def wait_port(port, t=10):
    end = time.time() + t
    while time.time() < end:
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', port)) == 0:
                return
        time.sleep(0.1)
    raise RuntimeError(f'port {port} did not open')


def state():
    return json.loads(urllib.request.urlopen(API + '/__state').read())


async def state_when(cond, t=10):
    """Server state once cond(state) holds — the app writes in the background, a moment after the UI updates."""
    end = time.time() + t
    while True:
        st = state()
        if cond(st) or time.time() > end:
            return st
        await asyncio.sleep(0.2)


def folder_file(path):
    """A small 'Kolju' folder export with one atlas photo and two labelled frames."""
    from PIL import Image, ImageDraw
    im = Image.new('RGB', (640, 420), (245, 240, 230))
    d = ImageDraw.Draw(im)
    d.ellipse([170, 60, 470, 360], outline=(120, 90, 60), width=6)
    d.text((40, 60), 'os frontale', fill=(0, 0, 0))
    d.text((40, 300), 'maxilla', fill=(0, 0, 0))
    buf = io.BytesIO(); im.save(buf, 'JPEG', quality=85)
    data = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
    now = int(time.time() * 1000)
    doc = {'app': 'corpus', 'kind': 'folder', 'version': 1, 'exportedAt': '2026-10-06T12:00:00Z',
           'folders': [{'id': 'f1', 'name': 'Kolju', 'mode': 'hideAll'}],
           'decks': [{'id': 'd1', 'name': 'Kolju — luud', 'newPerDay': 20, 'mode': 'hideAll', 'folderId': 'f1'}],
           'plates': [{'id': 'p1', 'deckId': 'd1', 'w': 640, 'h': 420, 'createdAt': now, 'image': data}],
           'cards': [{'id': 'c1', 'deckId': 'd1', 'plateId': 'p1', 'term': 'os frontale', 'x': 5, 'y': 12, 'w': 16, 'h': 5, 'createdAt': now},
                     {'id': 'c2', 'deckId': 'd1', 'plateId': 'p1', 'term': 'maxilla', 'x': 5, 'y': 70, 'w': 14, 'h': 5, 'createdAt': now}],
           'stats': {}}
    pathlib.Path(path).write_text(json.dumps(doc))


def order_file(path):
    """Decks and photos listed in a scrambled order in the file; their createdAt says the real order.
    Two photos share a createdAt: the file order decides between them."""
    from PIL import Image
    def img(w):
        buf = io.BytesIO(); Image.new('RGB', (w, 300), (230, 230, 230)).save(buf, 'JPEG'); return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
    t = 1_700_000_000_000
    decks = [{'id': 'd3', 'name': 'Kolju 3', 'createdAt': t + 3000, 'folderId': 'f1'},
             {'id': 'd1', 'name': 'Kolju 1', 'createdAt': t + 1000, 'folderId': 'f1'},
             {'id': 'd2', 'name': 'Kolju 2', 'createdAt': t + 2000, 'folderId': 'f1'}]
    plates = [{'id': 'p13', 'deckId': 'd1', 'w': 413, 'h': 300, 'createdAt': t + 30},
              {'id': 'p11', 'deckId': 'd1', 'w': 411, 'h': 300, 'createdAt': t + 10},
              {'id': 'p12a', 'deckId': 'd1', 'w': 412, 'h': 300, 'createdAt': t + 20},
              {'id': 'p12b', 'deckId': 'd1', 'w': 414, 'h': 300, 'createdAt': t + 20},
              {'id': 'p21', 'deckId': 'd2', 'w': 421, 'h': 300, 'createdAt': t + 5}]
    for p in plates: p['image'] = img(p['w'])
    cards = [{'id': 'c' + p['id'], 'deckId': p['deckId'], 'plateId': p['id'], 'term': 'term ' + p['id'], 'x': 10, 'y': 10, 'w': 14, 'h': 4, 'createdAt': p['createdAt']} for p in plates]
    doc = {'app': 'corpus', 'kind': 'folder', 'version': 1, 'folders': [{'id': 'f1', 'name': 'Järjekord', 'mode': 'hideAll'}],
           'decks': [dict(d, newPerDay=20, mode='hideAll') for d in decks], 'plates': plates, 'cards': cards, 'stats': {}}
    pathlib.Path(path).write_text(json.dumps(doc))


def anki_file(path):
    """A small Anki 2.1 package (schema 11): deck 'Kolju' with 3 image-occlusion notes (one picture each,
    two masks on the first) and 3 Basic notes, one of them with a picture inside the answer."""
    from PIL import Image, ImageDraw
    def jpeg(w, h, color):
        im = Image.new('RGB', (w, h), color); d = ImageDraw.Draw(im); d.rectangle([w * .1, h * .2, w * .3, h * .3], outline=(0, 0, 0), width=4)
        buf = io.BytesIO(); im.save(buf, 'JPEG', quality=80); return buf.getvalue()
    media = {'skull1.jpg': jpeg(800, 600, (240, 230, 220)), 'skull2.jpg': jpeg(640, 480, (230, 240, 220)),
             'skull3.jpg': jpeg(700, 500, (220, 230, 240)), 'small.png': None}
    im = Image.new('RGB', (60, 40), (200, 100, 100)); buf = io.BytesIO(); im.save(buf, 'PNG'); media['small.png'] = buf.getvalue()
    db_path = pathlib.Path(path).with_suffix('.sqlite')
    if db_path.exists(): db_path.unlink()
    db = sqlite3.connect(db_path)
    db.executescript('''
      create table col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer,
                        conf text, models text, decks text, dconf text, tags text);
      create table notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
      create table cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer,
                          ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
      create table graves (usn integer, oid integer, type integer);''')
    MID_IO, MID_B, DID = 1700000000001, 1700000000002, 1700000000003
    models = {
        str(MID_IO): {'id': MID_IO, 'name': 'Image Occlusion', 'type': 1,
                      'flds': [{'name': n, 'ord': i} for i, n in enumerate(['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments'])],
                      'tmpls': [{'name': 'Image Occlusion', 'ord': 0, 'qfmt': '{{#Header}}<div>{{Header}}</div>{{/Header}}<div style="display:none">{{cloze:Occlusion}}</div><div id=container>{{Image}}</div>',
                                 'afmt': '{{#Header}}<div>{{Header}}</div>{{/Header}}<div style="display:none">{{cloze:Occlusion}}</div><div id=container>{{Image}}</div><div>{{Back Extra}}</div>'}]},
        str(MID_B): {'id': MID_B, 'name': 'Basic', 'type': 0, 'flds': [{'name': 'Front', 'ord': 0}, {'name': 'Back', 'ord': 1}],
                     'tmpls': [{'name': 'Card 1', 'ord': 0, 'qfmt': '{{Front}}', 'afmt': '{{FrontSide}}<hr id=answer>{{Back}}'}]}}
    decks = {'1': {'id': 1, 'name': 'Default'}, str(DID): {'id': DID, 'name': 'Kolju'}}
    db.execute('insert into col values (1, 1600000000, 0, 0, 11, 0, 0, 0, ?, ?, ?, ?, ?)', ('{}', json.dumps(models), json.dumps(decks), '{}', '{}'))
    sep = '\x1f'
    notes = [
        (1, MID_IO, sep.join(['{{c1::image-occlusion:rect:left=.1:top=.2:width=.2:height=.1:oi=1}} {{c2::image-occlusion:rect:left=.5:top=.5:width=.1:height=.1:oi=1}}', '<img src="skull1.jpg">', 'Os frontale', '', ''])),
        (2, MID_IO, sep.join(['{{c1::image-occlusion:rect:left=.2:top=.3:width=.2:height=.1:oi=1}}', '<img src="skull2.jpg">', '', '', ''])),
        (3, MID_IO, sep.join(['{{c1::image-occlusion:rect:left=.3:top=.4:width=.2:height=.1:oi=1}}', '<img src="skull3.jpg">', '', '', ''])),
        (4, MID_B, sep.join(['os frontale', 'otsmikuluu'])),
        (5, MID_B, sep.join(['maxilla', 'ülalõualuu <img src="small.png">'])),
        (6, MID_B, sep.join(['mandibula', 'alalõualuu']))]
    cid = 100
    for nid, mid, flds in notes:
        db.execute('insert into notes values (?, ?, ?, 0, 0, "", ?, "", 0, 0, "")', (nid, str(nid), mid, flds))
        for ord_ in ([0, 1] if nid == 1 else [0]):
            cid += 1
            db.execute('insert into cards values (?, ?, ?, ?, 0, 0, 0, 0, ?, 0, 2500, 0, 0, 0, 0, 0, 0, "")', (cid, nid, DID, ord_, cid))
    db.commit(); db.close()
    names = list(media.keys())
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('collection.anki2', db_path.read_bytes())
        z.writestr('media', json.dumps({str(i): n for i, n in enumerate(names)}))
        for i, n in enumerate(names):
            z.writestr(str(i), media[n])
    db_path.unlink()


async def main():
    from playwright.async_api import async_playwright
    tmp = pathlib.Path(tempfile.mkdtemp())
    site = tmp / 'corpus'
    shutil.copytree(ROOT, site, ignore=shutil.ignore_patterns('.git', 'tools', 'src', 'supabase', '*.md'))
    (site / 'config.js').write_text(f"self.CORPUS_CONFIG={{url:'{API}',key:'test-publishable-key',bucket:'plates'}};")
    folder_file(tmp / 'corpus-folder-Kolju.json')
    order_file(tmp / 'corpus-folder-order.json')
    anki_file(tmp / 'Kolju.apkg')
    deno = [shutil.which('deno')] if shutil.which('deno') else ['npx', '--yes', 'deno']
    fn_env = dict(os.environ, SUPABASE_URL=API, ANTHROPIC_BASE_URL=API, ANTHROPIC_API_KEY='test-anthropic-key')
    api_env = dict(os.environ, FAKE_FN_URL=f'http://localhost:{FN_PORT}', FAKE_AI_LIMIT=str(AI_LIMIT), FAKE_ADMINS='lev@test.ee')
    procs = [subprocess.Popen(deno + ['run', '--allow-net', '--allow-env', '--allow-read', '--allow-sys', str(ROOT / 'supabase' / 'functions' / 'corpus-ai' / 'index.ts')],
                              env=fn_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
             subprocess.Popen(['node', str(ROOT / 'tools' / 'fake-supabase.js'), str(API_PORT), INVITE], env=api_env, stdout=subprocess.DEVNULL),
             subprocess.Popen([sys.executable, '-m', 'http.server', str(SITE_PORT), '--directory', str(tmp)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)]
    wait_port(API_PORT); wait_port(SITE_PORT); wait_port(FN_PORT, 120)
    ok = True

    def check(name, cond, extra=''):
        nonlocal ok
        print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra else ''))
        if not cond:
            ok = False
            raise SystemExit(1)

    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()

            async def open_ctx(**kw):
                ctx = await b.new_context(viewport={'width': 390, 'height': 844}, accept_downloads=True, **kw)
                await ctx.add_init_script('window.__TEST__=true;')
                pg = await ctx.new_page()
                errs = []
                pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
                pg.on('console', lambda m: m.type == 'error' and 'Failed to load resource' not in m.text and errs.append('console: ' + m.text))
                # network problems other than web fonts (the test sandbox has no internet) and
                # HTTP errors other than the ones a test provokes on purpose (wrong password, missing invite)
                # (/logout is answered 204 and supabase-js never reads that empty body, so the reload right after
                #  sign-out makes Chrome report it as aborted even though the server handled it; likewise any
                #  ERR_ABORTED is a request cut short by the test's own reloads, not a failure)
                pg.on('requestfailed', lambda r: 'fonts.g' not in r.url and 'ERR_ABORTED' not in str(r.failure) and errs.append('failed: ' + r.url + ' (' + str(r.failure) + ')'))
                pg.on('response', lambda r: r.status >= 400 and not ('/auth/v1/token' in r.url or '/auth/v1/signup' in r.url)
                      and not ('/functions/v1/corpus-ai' in r.url and r.status in (404, 429))   # provoked: function off, daily limit
                      and not ('/rpc/corpus_share_open' in r.url and r.status == 404)             # provoked: a wrong share code
                      and errs.append(f'http {r.status}: {r.url}'))
                return ctx, pg, errs

            async def app_ready(pg):
                await pg.wait_for_function('window.S && S.ready && !document.querySelector(".cw-auth")', timeout=20000)

            async def import_folder(pg):
                before = await pg.evaluate('[S.plates.length, S.cards.length, S.folders.length]')
                await pg.evaluate("go({name:'settings'})")
                async with pg.expect_file_chooser() as fc:
                    await pg.click('[data-act=importPick] >> nth=0')
                await (await fc.value).set_files(str(tmp / 'corpus-folder-Kolju.json'))
                await pg.click('#layer [data-s="1"]')
                await pg.wait_for_function(f'S.plates.length==={before[0] + 1} && S.cards.length==={before[1] + 2} && S.folders.length==={before[2] + 1}', timeout=20000)

            async def photo_check(pg):
                return await pg.evaluate("""async()=>{
                  const p=S.plates[0];const url=plateUrl(p);
                  const r=await fetch(url);const ct=r.headers.get('content-type');
                  const im=await new Promise((res,rej)=>{const i=new Image();if(!/^\\//.test(url))i.crossOrigin='anonymous';i.onload=()=>res(i);i.onerror=()=>rej('img error');i.src=url;});
                  const cv=document.createElement('canvas');cv.width=20;cv.height=20;const x=cv.getContext('2d');x.drawImage(im,0,0,20,20);
                  let readable=true;try{x.getImageData(0,0,1,1);}catch(e){readable=false;}
                  return {url,status:r.status,ct,w:im.naturalWidth,readable};}""")

            # ---------- user A: sign up through the invite link ----------
            ctx, pg, errs = await open_ctx()
            await pg.add_init_script('window.__TOUR_TEST__=true;')
            await pg.goto(SITE + '?i=' + INVITE)
            await pg.wait_for_selector('.cw-auth .cw-tabs .on')
            check('auth screen opens on sign-up for an invite link', (await pg.get_attribute('.cw-tabs .on', 'data-m')) == 'up')
            check('invite code is taken from the link and hidden', not await pg.is_visible('.cw-inv'))
            check('invite code stays in the address bar (a copied link still invites)', '?i=' + INVITE in pg.url, pg.url)
            tab = (await pg.inner_text('.cw-tabs .on')).strip()
            check('sign-in screen is translated (Estonian by default)', tab == 'Registreerimine', tab)
            await pg.fill('input[name=email]', 'lev@test.ee')
            await pg.fill('input[name=password]', '123')
            await pg.click('.cw-go')
            check('short password rejected', 'vähemalt 6' in (await pg.inner_text('.cw-err')), await pg.inner_text('.cw-err'))
            await pg.fill('input[name=password]', 'anatoomia1')
            await pg.click('.cw-go')
            await app_ready(pg)
            check('signed up and the app opened', True)
            # ---------- first-run tour: opens by itself for a new account, skippable, remembered ----------
            await pg.wait_for_selector('#layer .tour', timeout=5000)
            check('new account: the tour opens by itself', True)
            n_dots = await pg.evaluate("document.querySelectorAll('.tour-dots i').length")
            check('tour has AI, speech and QR slides here (5 in total)', n_dots == 5, str(n_dots))
            await pg.click('.tour [data-tl=ru]')
            check('tour: language switch works inside it', (await pg.inner_text('.tour h3')).strip() == 'Фото → карточки')
            await pg.click('.tour [data-tl=et]')
            check('tour: Estonian text', (await pg.inner_text('.tour h3')).strip() == 'Foto → kaardid')
            for _ in range(4):
                await pg.click('.tour [data-tour=next]')
            check('tour: last slide is about sharing by QR', (await pg.inner_text('.tour h3')).strip() == 'Jaga QR-koodiga' and (await pg.inner_text('.tour')).count('QR') >= 3)
            await pg.click('.tour [data-tour=end]')
            await pg.wait_for_function("!document.querySelector('#layer .tour')")
            check('tour closes and is remembered', await pg.evaluate('META.tourSeen===1'))
            await pg.click('[data-act=tour]')
            await pg.wait_for_selector('#layer .tour')
            await pg.click('.tour [data-tour=skip]')
            await pg.wait_for_function("!document.querySelector('#layer .tour')")
            check('tour can be reopened from the ? button and skipped', True)
            info = await pg.evaluate("({ctrl:!!navigator.serviceWorker.controller,base:CORPUS_WEB.blobBase,sample:S.sample,email:CORPUS_WEB.email})")
            check('service worker controls the page', info['ctrl'], json.dumps(info))
            check('photos served from the site itself', info['base'] == '/corpus/_blob/', info['base'])
            ai = await pg.evaluate('({on:!!S.sample, img:S.imgOK, ai:CORPUS_WEB.ai||null})')
            check('AI is on: the function is deployed', ai['on'] and ai['img'] and ai['ai'] and ai['ai']['limit'] == AI_LIMIT, json.dumps(ai))
            r = await pg.evaluate("S.sample.json('Reply with JSON')")
            check('AI JSON answer (text model)', r.get('ok') is True and r.get('model', '').startswith('claude-haiku'), json.dumps(r))
            r = await pg.evaluate("""(async()=>{let seen='';const r=await S.sample([{role:'user',content:'Mis on os frontale?'}],{onText:u=>{seen=u.text;}});return {text:r.text,seen};})()""")
            check('AI chat answer reaches onText', 'os frontale' in r['text'] and r['seen'] == r['text'], r['text'])
            r = await pg.evaluate("""(async()=>{const c=document.createElement('canvas');c.width=40;c.height=30;const b=await new Promise(r=>c.toBlob(r,'image/jpeg'));
                                   return S.sample.json('Read the labels',{images:[b]});})()""")
            check('AI with a photo uses the vision model', r.get('images') == 1 and r.get('model') == 'claude-sonnet-5-5', json.dumps(r))
            used = await pg.evaluate('CORPUS_WEB.ai.used')
            check('each call is counted (photo = 2)', used == 4, str(used))
            r = await pg.evaluate("""(async()=>{const out=[];for(let i=0;i<4;i++){try{await S.sample('more');out.push('ok');}catch(e){out.push(e.code);}}return out;})()""")
            check('daily limit stops further calls', r == ['ok', 'ok', 'quota_exceeded', 'quota_exceeded'], json.dumps(r))

            await import_folder(pg)
            st = await state_when(lambda st: {'decks', 'folders', 'packs', 'plates'} <= set(d['coll'] for d in st['docs']))
            check('folder imported: 1 folder, 1 deck, 1 photo, 2 cards', True)
            check('photo uploaded to Storage as an image', len(st['objects']) == 1 and st['objects'][0]['type'] == 'image/jpeg', json.dumps(st['objects']))
            colls = sorted(set(d['coll'] for d in st['docs']))
            check('documents written (decks, folders, packs, plates)', all(c in colls for c in ['decks', 'folders', 'packs', 'plates']), ','.join(colls))
            ph = await photo_check(pg)
            check('photo loads through the service worker and is canvas-readable', ph['status'] == 200 and ph['w'] == 640 and ph['readable'] and ph['ct'] == 'image/jpeg', json.dumps(ph))
            check('folder screen opened after import', (await pg.evaluate('view.name')) == 'folder')

            # progress on a packed card goes through the merge RPC
            cid = await pg.evaluate("(()=>{const c=S.cards.find(c=>c.term==='os frontale');c.reps=5;c.ivl=3;c.type='review';persist('terms',c.id);return c.id;})()")
            st = await state_when(lambda st: any(d['coll'] == 'packs' and d['data']['c'].get(cid, {}).get('reps') == 5 for d in st['docs']))
            packs = [d for d in st['docs'] if d['coll'] == 'packs']
            saved = packs and packs[0]['data']['c'].get(cid, {})
            check('progress saved into the pack (partial update)', saved and saved.get('reps') == 5 and saved.get('ivl') == 3, json.dumps(saved))
            check('other card in the pack untouched by the partial update', len(packs[0]['data']['c']) == 2)

            await pg.reload()
            await app_ready(pg)
            back = await pg.evaluate(f"(()=>{{const c=cardById('{cid}');return c&&{{reps:c.reps,ivl:c.ivl,type:c.type}};}})()")
            check('after reload: still signed in, progress restored', back and back['reps'] == 5 and back['type'] == 'review', json.dumps(back))
            ph = await photo_check(pg)
            check('after reload: photo still loads', ph['status'] == 200 and ph['readable'], json.dumps(ph))

            # share the folder → a file with the photo inside
            fid = await pg.evaluate('S.folders[0].id')
            await pg.evaluate(f"go({{name:'folder',folderId:'{fid}'}})")
            await pg.click('[data-act=folderMenu]')
            async with pg.expect_download() as dl:
                await pg.click('#layer [data-s="share"]')
            path = await (await dl.value).path()
            exp = json.loads(pathlib.Path(path).read_text())
            check('folder exported as a file with its photo', exp['kind'] == 'folder' and exp['plates'][0]['image'].startswith('data:image/jpeg') and len(exp['cards']) == 2,
                  f"kind={exp['kind']} cards={len(exp['cards'])}")
            check('exported file carries no progress', all('reps' not in c and 'ivl' not in c for c in exp['cards']))

            # order: decks and photos come back in the order they were added, also after a reload
            await pg.evaluate("go({name:'settings'})")
            async with pg.expect_file_chooser() as fc:
                await pg.click('[data-act=importPick] >> nth=0')
            await (await fc.value).set_files(str(tmp / 'corpus-folder-order.json'))
            await pg.click('#layer [data-s="1"]')
            await pg.wait_for_function("S.folders.some(f=>f.name==='Järjekord') && S.plates.length===6", timeout=20000)
            await state_when(lambda st: sum(1 for d in st['docs'] if d['coll'] == 'plates') == 6)
            q = """(()=>{const f=S.folders.find(f=>f.name==='Järjekord');const ds=decksInFolder(f.id);
                     return {decks:ds.map(d=>d.name),photos:platesOf(ds[0].id).map(p=>p.w)};})()"""
            want = {'decks': ['Kolju 1', 'Kolju 2', 'Kolju 3'], 'photos': [411, 412, 414, 413]}
            got = await pg.evaluate(q)
            check('import keeps the order decks and photos were added', got == want, json.dumps(got))
            await pg.reload()
            await app_ready(pg)
            got = await pg.evaluate(q)
            check('…and keeps it after a reload', got == want, json.dumps(got))
            fid2 = await pg.evaluate("S.folders.find(f=>f.name==='Järjekord').id")
            await pg.evaluate(f"go({{name:'folder',folderId:'{fid2}'}})")
            await pg.click('[data-act=folderMenu]')
            async with pg.expect_download() as dl:
                await pg.click('#layer [data-s="share"]')
            exp2 = json.loads(pathlib.Path(await (await dl.value).path()).read_text())
            check('a re-shared folder lists decks and photos in that order',
                  [d['name'] for d in exp2['decks']] == want['decks'] and [p['w'] for p in exp2['plates'] if p['deckId'] == exp2['decks'][0]['id']] == want['photos'],
                  json.dumps([d['name'] for d in exp2['decks']]))

            # share the folder by code / QR
            await pg.evaluate(f"go({{name:'folder',folderId:'{fid}'}})")
            await pg.click('[data-act=folderMenu]')
            await pg.click('#layer [data-s="qr"]')
            await pg.wait_for_selector('#shareCode', timeout=15000)
            code = await pg.get_attribute('#shareCode', 'data-code') or ''
            qr = await pg.evaluate("(()=>{const p=document.querySelector('.dlg.share .qr svg path');return p?p.getAttribute('d').length:0;})()")
            check('folder shared by code: a 10-letter code and a QR code are shown', re.fullmatch(r'[23456789abcdefghjkmnpqrstuvwxyz]{10}', code) is not None and qr > 500, f'code={code} qr={qr}')
            shown = (await pg.inner_text('#shareCode')).replace(' ', '')
            check('the code on screen matches', shown == code, shown)
            sdlg = await pg.inner_text('#layer .dlg.share')
            check('share dialog is translated', 'Kogu kaust: 1 foto, 2 kaarti. Ilma edenemiseta.' in sdlg and 'Tühista' in sdlg and 'Saada link' in sdlg, sdlg.replace('\n', ' ')[:160])
            sh = state()['shares']
            check('the share holds photo ids, not pictures, and no progress',
                  len(sh) == 1 and sh[0]['kind'] == 'folder' and sh[0]['data']['plates'][0].get('asset') and 'image' not in sh[0]['data']['plates'][0]
                  and all('reps' not in c for c in sh[0]['data']['cards']), json.dumps(sh)[:200])
            await pg.click('#layer [data-s="ok"]')
            await pg.click('[data-act=folderMenu]')
            await pg.click('#layer [data-s="qr"]')
            await pg.wait_for_selector('#shareCode', timeout=15000)
            check('sharing again keeps the same code (the snapshot is refreshed)', (await pg.get_attribute('#shareCode', 'data-code')) == code and len(state()['shares']) == 1)
            await pg.click('#layer [data-s="ok"]')

            # Anki: a .apkg with image-occlusion and Basic notes
            urllib.request.urlopen(API + '/__log')                 # clear the request log
            await pg.evaluate("go({name:'settings'})")
            async with pg.expect_file_chooser() as fc:
                await pg.click('[data-act=ankiPick] >> nth=0')
            await (await fc.value).set_files(str(tmp / 'Kolju.apkg'))
            await pg.wait_for_selector('#akGo', timeout=20000)
            summ = await pg.inner_text('#akSum')
            check('Anki picker counts the cards: 4 frames on 3 photos, 3 text cards', '4' in summ and '3' in summ, summ.replace('\n', ' '))
            await pg.click('#akGo')
            await pg.wait_for_function('S.plates.length===9 && S.cards.length===14', timeout=40000)
            await pg.wait_for_selector('#layer .dlg', timeout=10000)   # "read the labels under the frames?"
            await pg.click('#layer [data-s="0"]')
            st = await state_when(lambda st: sum(1 for d in st['docs'] if d['coll'] == 'plates') == 9 and sum(1 for o in st['objects']) == 10)
            log = json.loads(urllib.request.urlopen(API + '/__log').read())
            posts = [l for l in log if l == 'POST /rest/v1/docs']
            check('Anki import: 3 photos + 1 picture inside a text card uploaded', sum(1 for o in st['objects']) == 10)
            check('Anki import: documents written in batches, not one request per document', 0 < len(posts) <= 3, f'{len(posts)} POST /rest/v1/docs')
            anki = await pg.evaluate("""(()=>{const ds=S.decks.filter(d=>d.ad);const ph=ds.find(d=>!d.kind),tx=ds.find(d=>d.kind==='text');
                const cs=cardsOfDeck(ph.id).sort((a,b)=>a.createdAt-b.createdAt);const c0=cs[0];const t=cardsOfDeck(tx.id).map(c=>c.front+'|'+c.back);
                return {names:ds.map(d=>d.name),frames:cs.length,photos:platesOf(ph.id).map(p=>[p.w,p.h]),rect:[c0.x,c0.y,c0.w,c0.h],note:c0.note,extra:(c0.extra||[]).length,text:t,img:/_blob\\//.test(cardsOfDeck(tx.id).find(c=>c.front==='maxilla').bh)};})()""")
            check('Anki import: one photo deck and one text deck', anki['names'] == ['Kolju', 'Kolju — текст'], json.dumps(anki['names']))
            check('Anki import: masks became frames in percent of the photo', anki['frames'] == 4 and anki['rect'] == [10, 20, 20, 10] and anki['extra'] == 0 and anki['note'] == 'Os frontale', json.dumps(anki))
            check('Anki import: photos kept their size and order', anki['photos'] == [[800, 600], [640, 480], [700, 500]], json.dumps(anki['photos']))
            check('Anki import: text cards with the picture moved into storage', sorted(anki['text']) == ['mandibula|alalõualuu', 'maxilla|ülalõualuu', 'os frontale|otsmikuluu'] and anki['img'], json.dumps(anki))
            await pg.reload()
            await app_ready(pg)
            check('Anki import: everything is there after a reload', await pg.evaluate('S.plates.length===9 && S.cards.length===14 && S.decks.filter(d=>d.ad).length===2'))

            # ---------- calendar of tests and push reminders ----------
            await pg.click('.tabbar [data-v=calendar]')
            await pg.wait_for_selector('.cgrid .cday.ctd')
            check('calendar tab opens (translated)', (await pg.inner_text('.page .h1t')).strip() == 'Kalender')
            day = await pg.evaluate("(()=>{const d=new Date();d.setDate(d.getDate()+5);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');})()")
            await pg.evaluate("()=>{editExamDlg(null,{folderIds:[S.folders[0].id]});}")
            await pg.fill('#exT', 'Kollokvium: kolju')
            await pg.fill('#exD', day)
            await pg.click('#layer [data-s="1"]')
            st = await state_when(lambda s: any(d['coll'] == 'exams' for d in s['docs']))
            ex = [d for d in st['docs'] if d['coll'] == 'exams']
            check('a test is saved with its date and folder', len(ex) == 1 and ex[0]['data']['date'] == day and ex[0]['data']['folderIds'] == [await pg.evaluate('S.folders[0].id')], json.dumps(ex)[:200])
            check('the test drives the plan of its decks', await pg.evaluate("S.decks.filter(d=>d.folderId===S.folders[0].id).every(d=>planQuota(d)!=null)"))
            await pg.wait_for_function("document.querySelector('#pushBox') && document.querySelector('#pushBox').dataset.st", timeout=10000)
            pst = await pg.evaluate("[pushBox.dataset.st, pushSt.textContent]")
            check('push box: notifications blocked → says where to allow them', pst[0] == 'denied' and 'Seaded' in pst[1], json.dumps(pst, ensure_ascii=False))
            # headless Chromium always reports "denied"; a phone asks first ("default")
            await pg.evaluate("Object.defineProperty(Notification,'permission',{configurable:true,get:()=>'default'});pushBox.dataset.st='';pushPaint()")
            await pg.wait_for_function("pushBox.dataset.st", timeout=10000)
            pst = await pg.evaluate("[pushBox.dataset.st, pushSt.textContent, pushBtns.textContent]")
            check('push box: allowed but not subscribed → offered to turn on', pst[0] == 'off' and 'Lülita sisse' in pst[2], json.dumps(pst, ensure_ascii=False))
            await pg.evaluate("META.pushOn=true;META.remTime='19:00';pushSync()")
            st = await state_when(lambda s: any(d['coll'] == 'meta' and d['id'] == 'notify' for d in s['docs']))
            nt = next((d['data'] for d in st['docs'] if d['coll'] == 'meta' and d['id'] == 'notify'), {})
            check('reminder summary kept for the push service', nt.get('daily') == '19:00' and len(nt.get('due', {})) == 14 and nt.get('tz') and
                  [e['date'] for e in nt.get('exams', [])] == [day] and 'cards' not in nt, json.dumps(nt)[:300])
            await pg.evaluate("META.pushOn=false")
            await pg.goto(SITE + '?v=cal')
            await app_ready(pg)
            await pg.wait_for_function("view.name==='calendar'", timeout=5000)
            check('a reminder link opens the calendar, then leaves the address clean', '?v=' not in pg.url, pg.url)

            # account section and sign out
            await pg.evaluate("go({name:'settings'})")
            acc = await pg.inner_text('.page')
            check('settings show the account', 'lev@test.ee' in acc and 'Konto' in acc)
            check("settings show today's AI allowance", f'TI täna: {AI_LIMIT} / {AI_LIMIT}' in acc, [l for l in acc.split('\n') if 'TI' in l][:1])
            await pg.wait_for_selector('#siteStats .stat-grid', timeout=10000)
            st = await pg.inner_text('#siteStats')
            check('admin sees site statistics', 'Saidi statistika' in st and 'kasutajat' in st and 'lev@test.ee' in st and 'viimati täna' in st, st.replace('\n', ' | ')[:200])
            await pg.click('[data-act=signOut]')
            await pg.click('#layer [data-s="1"]')
            await pg.wait_for_selector('.cw-auth .cw-tabs .on', timeout=15000)
            check('signed out → sign-in screen', (await pg.get_attribute('.cw-tabs .on', 'data-m')) == 'in')
            await pg.fill('input[name=email]', 'lev@test.ee')
            await pg.fill('input[name=password]', 'wrong-password')
            await pg.click('.cw-go')
            await pg.wait_for_function("document.querySelector('.cw-err').textContent.length>0")
            check('wrong password → clear message', 'Vale e-post või parool' in (await pg.inner_text('.cw-err')), await pg.inner_text('.cw-err'))
            await pg.fill('input[name=password]', 'anatoomia1')
            await pg.click('.cw-go')
            await app_ready(pg)
            check('signed back in: data is there', await pg.evaluate('S.cards.length===14 && S.plates.length===9 && S.folders.length===2'))
            errs_a = [e for e in errs if 'favicon' not in e]
            await ctx.close()

            # ---------- user B: no invite, then a wrong one, then the right one ----------
            urllib.request.urlopen(API + '/__fn?off=1')           # as if the AI function were not deployed
            ctx, pg, errs = await open_ctx()
            await pg.goto(SITE)
            await pg.wait_for_selector('.cw-auth .cw-tabs .on')
            await pg.click('[data-m=up]')
            check('without an invite link the code field is shown', await pg.is_visible('.cw-inv'))
            await pg.fill('input[name=email]', 'friend@test.ee')
            await pg.fill('input[name=password]', 'kolju2026')
            await pg.click('.cw-go')
            await pg.wait_for_function("document.querySelector('.cw-err').textContent.length>0")
            check('sign-up without the code is refused', 'kutse' in (await pg.inner_text('.cw-err')), await pg.inner_text('.cw-err'))
            await pg.fill('input[name=invite]', 'wrongcode')
            await pg.click('.cw-go')
            await pg.wait_for_function("document.querySelector('.cw-err').textContent.length>0")
            check('wrong code is refused', 'kutse' in (await pg.inner_text('.cw-err')))
            await pg.fill('input[name=invite]', INVITE)
            await pg.click('.cw-go')
            await app_ready(pg)
            check("friend signed up and sees an empty Corpus, not Lev's", await pg.evaluate('S.decks.length===0 && S.cards.length===0 && S.folders.length===0'))

            # the friend opens Lev's share link (as if the QR were scanned): the folder is offered and copied
            await pg.goto(SITE + '?s=' + code)
            await app_ready(pg)
            await pg.wait_for_selector('#layer .dlg', timeout=15000)
            dlg = await pg.inner_text('#layer .dlg')
            check('share link: the folder is offered with its contents and the sender', 'Kolju' in dlg and 'lev@test.ee' in dlg and 'Jagaja' in dlg, dlg.replace('\n', ' ')[:200])
            await pg.click('#layer [data-s="1"]')
            await pg.wait_for_function('S.plates.length===1 && S.cards.length===2 && S.folders.length===1', timeout=20000)
            check('share link: folder, photo and cards copied', (await pg.evaluate('view.name')) == 'folder')
            check('share link: the code is removed from the address', 's=' not in pg.url, pg.url)
            me = await pg.evaluate('CORPUS_WEB.uid')
            st = await state_when(lambda st: sum(1 for o in st['objects'] if o['owner'] == me) == 1)
            check("share link: the photo is the friend's own copy", sum(1 for o in st['objects'] if o['owner'] == me) == 1 and
                  any(d['coll'] == 'plates' and d['owner'] == me for d in st['docs']))
            ph = await photo_check(pg)
            check('share link: the copied photo loads', ph['status'] == 200 and ph['w'] == 640 and ph['readable'], json.dumps(ph))
            check('share link: opening was counted', state()['shares'][0]['opens'] == 1)
            # by code, typed in: a wrong code is refused clearly
            await pg.evaluate("go({name:'settings'})")
            await pg.click('[data-act=shareCode]')
            await pg.fill('#dlgIn', 'zzzzz zzzzz')
            await pg.click('#layer [data-s="1"]')
            await pg.wait_for_function("Array.from(document.querySelectorAll('.toast')).some(t=>/Koodi ei leitud/.test(t.textContent))", timeout=10000)
            check('a wrong code: clear message', True)
            acc = await pg.inner_text('.page')
            check('settings offer "get by code" (translated)', 'Hangi koodiga' in acc and 'Jaga QR-koodiga' in acc, [l for l in acc.split('\n') if 'kood' in l][:2])
            check('no AI function deployed → AI features hidden', await pg.evaluate('S.sample===null'))
            await pg.evaluate("go({name:'settings'})")
            await pg.wait_for_timeout(800)
            check('a friend does not see site statistics', await pg.evaluate("!document.querySelector('#siteStats')"))
            urllib.request.urlopen(API + '/__fn?off=0')
            errs_b = list(errs)
            await ctx.close()

            # ---------- storage blocked: the code from the link still works ----------
            ctx, pg, errs_d = await open_ctx()
            await pg.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}});")
            await pg.goto(SITE + '?i=' + INVITE)
            await pg.wait_for_selector('.cw-auth .cw-tabs .on')
            check('storage blocked: sign-up opens without asking for the code', (await pg.get_attribute('.cw-tabs .on', 'data-m')) == 'up' and not await pg.is_visible('.cw-inv'))
            await pg.fill('input[name=email]', 'third@test.ee')
            await pg.fill('input[name=password]', 'kolju2026')
            await pg.click('.cw-go')
            await pg.wait_for_function('window.S && S.ready && !document.querySelector(".cw-auth")', timeout=20000)
            check('storage blocked: signed up with the code from the link', True)
            await ctx.close()

            # ---------- fallback: browser without service workers ----------
            ctx, pg, errs_c = await open_ctx(service_workers='block')
            await pg.goto(SITE)
            await pg.wait_for_selector('.cw-auth .cw-tabs .on')
            await pg.fill('input[name=email]', 'friend@test.ee')
            await pg.fill('input[name=password]', 'kolju2026')
            await pg.click('.cw-go')
            await app_ready(pg)
            base = await pg.evaluate('CORPUS_WEB.blobBase')
            check('without a service worker photos come straight from Storage', base.startswith(API + '/storage/v1/object/public/plates/'), base)
            await import_folder(pg)
            ph = await photo_check(pg)
            check('fallback: photo loads and stays canvas-readable', ph['status'] == 200 and ph['w'] == 640 and ph['readable'], json.dumps(ph))
            me = await pg.evaluate('CORPUS_WEB.uid')
            objs = state()['objects']
            check("friend's import made the friend's own photo copy; Lev's photos untouched",
                  sum(o['owner'] == me for o in objs) == 2 and sum(o['owner'] != me for o in objs) == 10, json.dumps([o['owner'][:8] for o in objs]))
            await ctx.close()

            check('no script errors or failed requests in the browser', not errs_a and not errs_b and not errs_c, '; '.join(errs_a + errs_b + errs_c)[:600])
            await b.close()
    finally:
        for pr in procs:
            pr.terminate()
        shutil.rmtree(tmp, ignore_errors=True)
    print('ALL PASSED' if ok else 'FAILED')


if __name__ == '__main__':
    asyncio.run(main())
