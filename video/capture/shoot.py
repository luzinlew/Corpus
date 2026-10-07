#!/usr/bin/env python3
"""Screens of the real app for the promo video.

Runs the site against tools/fake-supabase.js (like tools/e2e_test.py), signs up, loads a demo
backup (an illustrated atlas plate with 12 labels, a text deck, progress, a test in the calendar),
then drives the app in Estonian, dark theme, at 3x and saves PNGs to video/public/shots/.
Claude's answers are canned (the corpus-ai function is answered by a route here).

    python3 video/capture/shoot.py            # all scenes
    python3 video/capture/shoot.py home study # some of them
"""
import asyncio, base64, json, pathlib, shutil, socket, subprocess, sys, tempfile, time

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT = HERE.parent / 'public' / 'shots'
SITE_PORT, API_PORT, INVITE = 8765, 54321, 'p8wyzmtw'
API = f'http://localhost:{API_PORT}'
SITE = f'http://localhost:{SITE_PORT}/corpus/'
CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
W, H, DPR = 390, 844, 3
DAY = 86400000


def wait_port(port, t=15):
    end = time.time() + t
    while time.time() < end:
        with socket.socket() as s:
            if s.connect_ex(('127.0.0.1', port)) == 0:
                return
        time.sleep(0.1)
    raise RuntimeError(f'port {port} did not open')


def backup():
    now = int(time.time() * 1000)
    img = 'data:image/jpeg;base64,' + base64.b64encode((HERE / 'atlas-skull.jpg').read_bytes()).decode()
    labels = json.loads((HERE / 'labels.json').read_text())
    cards = []
    # progress: the first labels are known well, a couple are hard, the rest new
    for i, b in enumerate(labels):
        c = dict(id=f'c{i}', deckId='d1', plateId='p1', term=b['term'], x=b['x'], y=b['y'], w=b['w'], h=b['h'], createdAt=now - 9 * DAY + i)
        if i < 9:
            c.update(type='review', ivl=[6, 3, 12, 4, 2, 9, 5, 1, 3][i], due=now - DAY if i in (1, 2, 4, 6, 8) else now + 3 * DAY,
                     ease=2.5, reps=4 + i % 3, ok=4, last=now - 2 * DAY, fs=[9, 4, 15, 5, 2.5, 11, 6, 1.4, 4][i], fd=5)
        if i in (2, 7):
            c.update(lapses=3, miss=3, ok=2)
        cards.append(c)
    texts = [('os frontale', 'otsmikuluu'), ('os parietale', 'kiiruluu'), ('os occipitale', 'kuklaluu'), ('os temporale', 'oimuluu'),
             ('maxilla', 'ülalõualuu'), ('mandibula', 'alalõualuu'), ('os nasale', 'ninaluu'), ('os zygomaticum', 'sarnaluu')]
    for i, (f, b) in enumerate(texts):
        cards.append(dict(id=f't{i}', deckId='d2', kind='text', front=f, back=b, dir='f', noteId=f'n{i}', createdAt=now - 5 * DAY + i))
    days = {}
    for k in range(0, 26):
        t = now - k * DAY
        if k > 12 and k % 6 == 3:
            continue
        n = 12 + (k * 7) % 25
        d = time.strftime('%Y-%m-%d', time.localtime(t / 1000))
        days[d] = {'n': n, 'ok': int(n * 0.86)}
    exam = time.strftime('%Y-%m-%d', time.localtime((now + 9 * DAY) / 1000))
    return {'app': 'corpus', 'kind': 'backup', 'version': 1, 'exportedAt': '2026-10-07T10:00:00Z',
            'folders': [{'id': 'f1', 'name': 'Kolju', 'mode': 'hideAll', 'createdAt': now - 10 * DAY}],
            'decks': [{'id': 'd1', 'name': 'Kolju luud', 'newPerDay': 20, 'mode': 'hideAll', 'folderId': 'f1', 'createdAt': now - 10 * DAY},
                      {'id': 'd2', 'name': 'Ladina — eesti', 'newPerDay': 20, 'mode': 'hideAll', 'kind': 'text', 'folderId': 'f1', 'createdAt': now - 9 * DAY}],
            'plates': [{'id': 'p1', 'deckId': 'd1', 'w': 1400, 'h': 1000, 'createdAt': now - 10 * DAY, 'image': img}],
            'cards': cards, 'stats': {'d1': {'days': days}},
            'exams': [{'id': 'e1', 'title': 'Kolju kontrolltöö', 'date': exam, 'folderIds': ['f1'], 'deckIds': [], 'createdAt': now - DAY}]}


AI = {
    'hints': ['Kreeka „zygon“ = ike: sarnaluu on nagu ike, mis seob näo luud oimuluuga — koos moodustavad nad sarnakaare.',
              'Sigu-maa: kujuta ette põrsast, kes magab sinu põsenukil — just seal, kõrgel põse peal, asub os zygomaticum.',
              'Pane sõrmed põsenukile ja libista kõrva poole: tunned luusilda — see ongi zygomaticum ja tema kaar.'],
    'hint': 'Zygoma — kreeka keeles „ike“: sarnaluu on nagu ike, mis ühendab näo ja oimu. Kujuta ette, kuidas härjaike toetub põsele.',
    'chat': '**Os zygomaticum** ehk sarnaluu moodustab põsenuki ja osa silmakoopa välisseinast.\n\n'
            '• Ees ühendub see **ülalõualuuga** (maxilla)\n• Üleval — **otsmikuluuga**\n• Taga moodustab koos oimuluuga **sarnakaare** (arcus zygomaticus)\n\n'
            'Mäluvihje: „zygon“ = ike — luu, mis seob näo ja kolju külje kokku.',
}


async def ai_route(route):
    req = route.request
    if req.method == 'GET':
        return await route.fulfill(json={'ready': True, 'plan': 'free', 'limit': 30, 'used': 4})
    if req.method == 'OPTIONS':
        return await route.fulfill(status=204, headers={'access-control-allow-origin': '*', 'access-control-allow-headers': '*'})
    body = json.loads(req.post_data or '{}')
    text = json.dumps(body.get('messages', []), ensure_ascii=False)
    if body.get('json'):
        ans = json.dumps({'hints': AI['hints']}, ensure_ascii=False)
    else:
        ans = AI['chat'] if 'zygom' in text.lower() or len(body.get('messages', [])) > 0 else AI['hint']
    await asyncio.sleep(0.4)
    await route.fulfill(json={'text': ans, 'truncated': False, 'plan': 'free', 'limit': 30, 'used': 5})


class App:
    def __init__(self, pg):
        self.pg = pg

    async def shot(self, name, settle=0.5):
        await asyncio.sleep(settle)
        await self.clean()
        OUT.mkdir(parents=True, exist_ok=True)
        await self.pg.screenshot(path=str(OUT / f'{name}.png'))
        print('shot', name)

    async def js(self, code, *a):
        return await self.pg.evaluate(code, *a)

    async def clean(self):
        await self.js("document.querySelectorAll('.toast,.ftip,.feat-tip').forEach(e=>e.remove())")

    async def home(self):
        await self.js("go({name:'home'})")
        await self.pg.wait_for_timeout(600)


SCENES = {}


def scene(f):
    SCENES[f.__name__] = f
    return f


@scene
async def home(app):
    await app.home()
    await app.pg.wait_for_timeout(3500)
    await app.shot('home')


TERMS = {'c0': 'Os frontale', 'c2': 'Os zygomaticum', 'c3': 'Maxilla', 'c5': 'Os parietale'}


async def study_card(app, mode, cid='c2'):
    await app.js(f"(()=>{{const d=D1();d.mode='{mode}';const c=S.cards.find(c=>c.term==='{TERMS[cid]}');if(c.type==='review')c.due=Date.now()-60000;startStudy(d.id,false,[c]);}})()")
    await app.pg.wait_for_timeout(900)


@scene
async def study(app):
    await study_card(app, 'hideAll')
    await app.shot('study_q')
    await app.pg.click('[data-act=reveal]')
    await app.shot('study_a', 0.9)


@scene
async def choice(app):
    await study_card(app, 'choice', 'c0')
    await app.shot('choice_q')
    ok = await app.js("[...document.querySelectorAll('[data-act=pick]')].findIndex(b=>/frontale/i.test(b.textContent))")
    await app.pg.click(f'[data-act=pick] >> nth={ok}')
    await app.shot('choice_a', 0.7)


@scene
async def typing(app):
    await study_card(app, 'type', 'c3')
    await app.shot('type_dbg')
    inp = app.pg.locator('#typeIn')
    await inp.fill('Maxila')
    await app.shot('type_q')
    await app.pg.click('[data-act=check]')
    await app.shot('type_a', 0.8)


@scene
async def find(app):
    await study_card(app, 'find', 'c5')
    await app.shot('find_q')


@scene
async def chat(app):
    await study_card(app, 'hideAll')
    await app.pg.click('[data-act=reveal]')
    await app.pg.wait_for_timeout(500)
    await app.pg.click('[data-act=askOpen]')
    await app.pg.wait_for_timeout(700)
    await app.shot('chat_open')
    chip = app.pg.locator('#chChips button').nth(1)
    if await chip.count():
        await chip.click()
    await app.pg.wait_for_timeout(2500)
    await app.shot('chat_answer')
    await app.js("go({name:'home'})")


@scene
async def editor(app):
    await app.js("openEditor(P1().id,null)")
    await app.pg.wait_for_timeout(1500)
    await app.shot('editor')
    await app.js("openEditor(P1().id,S.cards.find(c=>c.term==='Os zygomaticum').id)")
    await app.pg.wait_for_timeout(1200)
    await app.shot('editor_sel')
    b = app.pg.locator('[data-act=edHintAI]')
    if await b.count():
        await b.click()
        await app.pg.wait_for_timeout(2500)
        await app.shot('hint_ai')
        await app.pg.click('#layer .sheet button >> nth=0')
        await app.pg.wait_for_timeout(900)
        await app.shot('hint_saved')


@scene
async def autodetect(app):
    # a fresh deck with the same photo and no frames: on-device detection + OCR names the labels
    await app.js("""(()=>{const p=P1();const d={id:'dx',name:'Uus pakk',newPerDay:20,mode:'hideAll',createdAt:Date.now()};S.decks.push(d);
      S.plates.push({id:'px',deckId:'dx',w:p.w,h:p.h,assetId:p.assetId,createdAt:Date.now()});S.imgOK=false;openEditor('px',null);})()""")
    await app.pg.wait_for_timeout(1500)
    await app.shot('auto_empty')
    await app.pg.click('[data-act=edAI]')
    await app.pg.wait_for_timeout(1200)
    await app.shot('auto_busy', 0)
    await app.pg.wait_for_function("!document.querySelector('#busy.on, #busy:not([hidden])') || cardsOfPlate('px').filter(c=>c.term).length>=8", timeout=120000)
    await app.pg.wait_for_timeout(2000)
    await app.shot('auto_raw')
    # tidy up like a user would: drop the frames on the title and the plate number
    await app.js("cardsOfPlate('px').filter(c=>!/^(Os|Maxilla|Mandibula|Porus|Sutura|Proc)/.test(c.term)).forEach(c=>removeCard(c.id));openEditor('px',null)")
    await app.pg.wait_for_timeout(1200)
    await app.shot('auto_done')
    await app.js("openEditor('px',cardsOfPlate('px').find(c=>c.term==='Os temporale').id)")
    await app.pg.wait_for_timeout(1200)
    await app.shot('auto_sel')
    print('auto terms', await app.js("cardsOfPlate('px').map(c=>c.term)"))


@scene
async def calendar(app):
    await app.js("go({name:'calendar'})")
    await app.shot('calendar', 1.2)


@scene
async def stats(app):
    await app.js("go({name:'globalStats'})")
    await app.shot('stats', 1.2)


@scene
async def library(app):
    await app.js("go({name:'library'})")
    await app.shot('library', 1.0)


@scene
async def share(app):
    await app.js("go({name:'folder',folderId:S.folders[0].id})")
    await app.pg.wait_for_timeout(600)
    await app.shot('folder')
    await app.pg.click('[data-act=folderMenu]')
    await app.pg.wait_for_timeout(600)
    await app.pg.click('#layer >> text=Jaga QR-koodiga')
    await app.pg.wait_for_timeout(2500)
    await app.shot('share_qr')
    await app.pg.click('#layer >> text=Valmis')
    await app.pg.wait_for_timeout(500)
    await app.js("go({name:'home'})")


@scene
async def themes(app):
    for t in ('paper', 'light'):
        await app.js(f"META.theme='{t}';applyLook();go({{name:'home'}})")
        await app.shot('home_' + t, 1.0)
    await app.js("META.theme='paper';applyLook()")
    await study_card(app, 'hideAll')
    await app.pg.click('[data-act=reveal]')
    await app.shot('study_paper', 0.9)
    await app.js("META.theme='auto';applyLook();go({name:'home'})")


@scene
async def settings(app):
    await app.js("META.speakOn=true;go({name:'settings'})")
    await app.shot('settings', 1.0)


async def main(want):
    from playwright.async_api import async_playwright
    tmp = pathlib.Path(tempfile.mkdtemp())
    site = tmp / 'corpus'
    shutil.copytree(ROOT, site, ignore=shutil.ignore_patterns('.git', 'tools', 'src', 'supabase', '*.md', 'video'))
    (site / 'config.js').write_text(f"self.CORPUS_CONFIG={{url:'{API}',key:'test-publishable-key',bucket:'plates'}};")
    bk = tmp / 'corpus-backup.json'
    bk.write_text(json.dumps(backup()))
    procs = [subprocess.Popen(['node', str(ROOT / 'tools' / 'fake-supabase.js'), str(API_PORT), INVITE], stdout=subprocess.DEVNULL),
             subprocess.Popen([sys.executable, '-m', 'http.server', str(SITE_PORT), '--directory', str(tmp)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)]
    try:
        wait_port(API_PORT); wait_port(SITE_PORT)
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path=CHROME)
            ctx = await b.new_context(viewport={'width': W, 'height': H}, device_scale_factor=DPR, color_scheme='dark',
                                      locale='et-EE', timezone_id='Europe/Tallinn', has_touch=True, accept_downloads=True)
            fonts = ROOT / 'video' / 'node_modules' / '@fontsource'
            css = ''
            for fam, pkg, weights, style in [('Onest', 'onest', [300, 400, 500, 600, 700], 'normal'), ('Source Serif 4', 'source-serif-4', [500, 600], 'italic')]:
                for w in weights:
                    fn = f'{pkg}-latin-ext-{w}-{style}.woff2'
                    css += f"@font-face{{font-family:'{fam}';font-style:{style};font-weight:{w};src:url(data:font/woff2;base64,{base64.b64encode((fonts / pkg / 'files' / fn).read_bytes()).decode()}) format('woff2')}}\n"
            await ctx.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(body=css, content_type='text/css'))
            await ctx.route('https://fonts.gstatic.com/**', lambda r: r.abort())
            await ctx.route('**/functions/v1/corpus-ai*', ai_route)
            await ctx.add_init_script('window.__TEST__=true;window.__TOUR_TEST__=true;')
            pg = await ctx.new_page()
            pg.on('pageerror', lambda e: print('pageerror', e))
            await pg.goto(SITE + '?i=' + INVITE)
            await pg.wait_for_selector('.cw-auth .cw-tabs .on')
            await pg.fill('input[name=email]', 'kostik@corpus.ee')
            await pg.fill('input[name=password]', 'anatoomia1')
            await pg.click('.cw-go')
            try:
                await pg.wait_for_function("window.S && S.ready && !document.querySelector('.cw-auth')", timeout=20000)
            except Exception:
                await pg.screenshot(path='/tmp/claude-0/debug.png'); raise
            app = App(pg)
            await pg.wait_for_selector('#layer .tour', timeout=8000)
            if 'tour' in want or not want:
                await app.shot('tour', 0.8)
            await pg.evaluate("closeOverlay&&closeOverlay()") if await pg.evaluate("typeof closeOverlay==='function'") else None
            await pg.evaluate("document.querySelector('#layer .tour [data-tour=skip]')&&document.querySelector('#layer .tour [data-tour=skip]').click()")
            await pg.wait_for_timeout(500)
            if 'home_empty' in want or not want:
                await app.shot('home_empty', 1.5)
            await pg.evaluate("go({name:'settings'})")
            async with pg.expect_file_chooser() as fc:
                await pg.click('[data-act=importPick] >> nth=0')
            await (await fc.value).set_files(str(bk))
            await pg.wait_for_timeout(500)
            await pg.click('#layer >> text=Asenda kõik praegune')
            await pg.wait_for_timeout(400)
            if await pg.locator('#layer [data-s="1"]').count():
                await pg.click('#layer [data-s="1"]')
            try:
                await pg.wait_for_function('S.plates.length===1 && S.cards.length>=20', timeout=20000)
            except Exception:
                await pg.screenshot(path='/tmp/claude-0/debug.png'); print(await pg.evaluate('[S.plates.length,S.cards.length,S.decks.length]')); raise
            await pg.evaluate("window.D1=()=>S.decks.find(d=>d.name==='Kolju luud');window.P1=()=>S.plates.find(p=>p.deckId===D1().id)")
            await pg.evaluate("META.tourSeen=1;META.lastBackup=Date.now();persistMeta()")
            await pg.wait_for_timeout(800)
            for name in (want or list(SCENES)):
                if name in SCENES:
                    await SCENES[name](app)
            await b.close()
    finally:
        for pr in procs:
            pr.terminate()


if __name__ == '__main__':
    asyncio.run(main(sys.argv[1:]))
