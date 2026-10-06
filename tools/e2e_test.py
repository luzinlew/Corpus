#!/usr/bin/env python3
"""End-to-end test of the website against tools/fake-supabase.js (no real Supabase needed).

    pip install playwright && python3 -m playwright install chromium
    python3 tools/e2e_test.py

Covers: invite sign-up, sign in / out, importing a folder file (photos to Storage, cards to packs),
progress saved through the merge RPC and restored after reload, photos served by the service worker
and readable on a canvas, exporting a folder, isolation between two accounts, and the no-service-worker
fallback. Prints one line per check and exits non-zero on the first failure."""
import asyncio, base64, io, json, os, pathlib, shutil, socket, subprocess, sys, tempfile, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE_PORT, API_PORT, INVITE = 8765, 54321, 'p8wyzmtw'
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


async def main():
    from playwright.async_api import async_playwright
    tmp = pathlib.Path(tempfile.mkdtemp())
    site = tmp / 'corpus'
    shutil.copytree(ROOT, site, ignore=shutil.ignore_patterns('.git', 'tools', 'src', 'supabase', '*.md'))
    (site / 'config.js').write_text(f"self.CORPUS_CONFIG={{url:'{API}',key:'test-publishable-key',bucket:'plates'}};")
    folder_file(tmp / 'corpus-folder-Kolju.json')
    order_file(tmp / 'corpus-folder-order.json')
    procs = [subprocess.Popen(['node', str(ROOT / 'tools' / 'fake-supabase.js'), str(API_PORT), INVITE], stdout=subprocess.DEVNULL),
             subprocess.Popen([sys.executable, '-m', 'http.server', str(SITE_PORT), '--directory', str(tmp)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)]
    wait_port(API_PORT); wait_port(SITE_PORT)
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
                pg.on('response', lambda r: r.status >= 400 and not ('/auth/v1/token' in r.url or '/auth/v1/signup' in r.url) and errs.append(f'http {r.status}: {r.url}'))
                return ctx, pg, errs

            async def app_ready(pg):
                await pg.wait_for_function('window.S && S.ready && !document.querySelector(".cw-auth")', timeout=20000)

            async def import_folder(pg):
                await pg.evaluate("go({name:'settings'})")
                async with pg.expect_file_chooser() as fc:
                    await pg.click('[data-act=importPick] >> nth=0')
                await (await fc.value).set_files(str(tmp / 'corpus-folder-Kolju.json'))
                await pg.click('#layer [data-s="1"]')
                await pg.wait_for_function('S.plates.length===1 && S.cards.length===2 && S.folders.length===1', timeout=20000)

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
            info = await pg.evaluate("({ctrl:!!navigator.serviceWorker.controller,base:CORPUS_WEB.blobBase,sample:S.sample,email:CORPUS_WEB.email})")
            check('service worker controls the page', info['ctrl'], json.dumps(info))
            check('photos served from the site itself', info['base'] == '/corpus/_blob/', info['base'])
            check('Claude-only features are off on the web', info['sample'] is None)

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

            # account section and sign out
            await pg.evaluate("go({name:'settings'})")
            acc = await pg.inner_text('.page')
            check('settings show the account', 'lev@test.ee' in acc and 'Konto' in acc)
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
            check('signed back in: data is there', await pg.evaluate('S.cards.length===7 && S.plates.length===6 && S.folders.length===2'))
            errs_a = [e for e in errs if 'favicon' not in e]
            await ctx.close()

            # ---------- user B: no invite, then a wrong one, then the right one ----------
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
                  sum(o['owner'] == me for o in objs) == 1 and sum(o['owner'] != me for o in objs) == 6, json.dumps([o['owner'][:8] for o in objs]))
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
