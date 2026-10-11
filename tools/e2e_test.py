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
Prints one line per check and exits non-zero on the first failure.
The test itself checks that its ports are free and stops all its servers (deno under npx too) however it ends."""
import asyncio, base64, io, json, os, pathlib, re, shutil, signal, socket, sqlite3, subprocess, sys, tempfile, time, urllib.request, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE_PORT, API_PORT, FN_PORT, INVITE, AI_LIMIT = 8765, 54321, 8000, 'test-invite', 6
API = f'http://localhost:{API_PORT}'
SITE = f'http://localhost:{SITE_PORT}/corpus/'


def port_open(port):
    """True if something listens on the port."""
    with socket.socket() as s:
        return s.connect_ex(('127.0.0.1', port)) == 0


def wait_port(port, t=10):
    end = time.time() + t
    while time.time() < end:
        if port_open(port):
            return
        time.sleep(0.1)
    raise RuntimeError(f'port {port} did not open')


def wait_port_closed(port, t=5):
    """True if the port stops listening within t seconds."""
    end = time.time() + t
    while time.time() < end:
        if not port_open(port):
            return True
        time.sleep(0.1)
    return not port_open(port)


def start(cmd, **kw):
    """Start a server in its own process group: npx runs deno as a child, so the whole tree has to be stopped."""
    return subprocess.Popen(cmd, start_new_session=True, **kw)


def stop(procs, t=10):
    """SIGTERM every server's process group, wait up to t seconds, then SIGKILL what is still alive."""
    for pr in procs:
        try:
            os.killpg(pr.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    end = time.time() + t
    for pr in procs:
        try:
            pr.wait(max(0.1, end - time.time()))
        except subprocess.TimeoutExpired:
            pass
    for pr in procs:
        try:
            os.killpg(pr.pid, 0)   # the group lives while any member does, even after npx itself has exited
        except ProcessLookupError:
            continue
        try:
            os.killpg(pr.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for pr in procs:
        try:
            pr.wait(5)
        except subprocess.TimeoutExpired:
            pass


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


def lesson_file(path):
    """A course folder, two parts (decks). Part one: a photo with a lesson (three cards with kind/note/prio, an intro with a bold line and an attack, two link questions).
    Part two: a photo with one card of importance 2 and a question about it. The name of part two and the title of its photo carry an <img onerror> tag:
    on screen it must stay text."""
    from PIL import Image
    buf = io.BytesIO(); Image.new('RGB', (600, 400), (235, 235, 225)).save(buf, 'JPEG', quality=80)
    data = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
    now = int(time.time() * 1000)
    cards = [{'id': 'c%d' % (i + 1), 'deckId': 'd1', 'plateId': 'p1', 'term': t, 'x': 5 + 30 * i, 'y': 20 + 10 * i, 'w': 16, 'h': 5, 'createdAt': now + i,
              'note': 'Märkus ' + t, 'src': 'KT', 'prio': 1 + i, 'kind': 'luu'} for i, t in enumerate(['os frontale', 'maxilla', 'mandibula'])]
    cards[1]['pt'] = [40.5, 60]
    cards.append({'id': 'c4', 'deckId': 'd2', 'plateId': 'p2', 'term': 'vomer', 'x': 40, 'y': 40, 'w': 16, 'h': 5, 'createdAt': now + 9, 'note': 'Märkus vomer', 'src': 'OC', 'prio': 2, 'kind': 'luu'})
    doc = {'app': 'corpus', 'kind': 'folder', 'version': 1, 'exportedAt': '2026-10-06T12:00:00Z',
           'folders': [{'id': 'f1', 'name': 'Urok', 'mode': 'hideAll'}],
           'decks': [{'id': 'd1', 'name': 'Urok', 'newPerDay': 20, 'mode': 'hideAll', 'folderId': 'f1', 'createdAt': now},
                     {'id': 'd2', 'name': 'Urok 2 <img src=x onerror=window.__xss=2>', 'newPerDay': 20, 'mode': 'hideAll', 'folderId': 'f1', 'createdAt': now + 5}],
           'plates': [{'id': 'p1', 'deckId': 'd1', 'w': 600, 'h': 400, 'createdAt': now, 'image': data, 'title': 'Esimene foto', 'page': 12,
                       'intro': ['Esimene rida on <b>paks</b>.', 'Atakk: <img src=x onerror=window.__xss=1>'],
                       'link': [{'item': 'c2', 'q': 'Mis on ülalõualuu?', 'ans': 'maxilla', 'opts': ['os frontale', 'mandibula', 'vomer'], 'src': 'KT', 'page': 5},
                                {'q': 'Mis on alalõualuu?', 'ans': 'mandibula', 'opts': ['maxilla', 'os nasale', 'vomer'], 'src': 'OC'}]},
                      {'id': 'p2', 'deckId': 'd2', 'w': 600, 'h': 400, 'createdAt': now + 6, 'image': data, 'lang': 'et', 'title': 'Teine foto <img src=x onerror=window.__xss=2>',
                       'link': [{'item': 'c4', 'q': 'Mis on atra?', 'ans': 'vomer', 'opts': ['maxilla', 'os nasale', 'zygoma'], 'src': 'OC', 'page': 8}]}],
           'cards': cards, 'stats': {}}
    pathlib.Path(path).write_text(json.dumps(doc))


ATK = '<img src=x onerror=window.__xss=7>'   # what the fake Claude answers instead of any line with ATTACK in it


def ru_lesson_file(path):
    """A small course in Russian (lang 'ru') for the translation checks: a photo with four structures (kinds luu, luu, ava and one the dictionary does not know), an intro with a bold word
    and a line with ATTACK, two questions (one answered in Latin, one in Russian). The note of the second structure carries ATTACK too: the fake Claude turns it into an <img onerror> tag
    (that note does not name its term: a translation that loses the term of the card from a note is not taken)."""
    from PIL import Image
    buf = io.BytesIO(); Image.new('RGB', (600, 400), (235, 235, 225)).save(buf, 'JPEG', quality=80)
    data = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
    now = int(time.time() * 1000)
    rows = [('os frontale', 'luu', 'KT', 1, 'Лобная кость (os frontale) образует лоб.'), ('maxilla', 'luu', 'OC', 2, 'Верхняя челюсть ATTACK'),
            ('foramen magnum', 'ava', 'PIC', 3, 'Большое затылочное отверстие (foramen magnum).'), ('sulcus sagittalis', 'sooned', 'KT', 1, 'Борозда (sulcus sagittalis) по средней линии.')]
    cards = [{'id': 'c%d' % (i + 1), 'deckId': 'd1', 'plateId': 'p1', 'term': t, 'x': 5 + 20 * i, 'y': 20 + 10 * i, 'w': 16, 'h': 5, 'createdAt': now + i,
              'note': n, 'src': s, 'prio': pr, 'kind': k} for i, (t, k, s, pr, n) in enumerate(rows)]
    doc = {'app': 'corpus', 'kind': 'folder', 'version': 1, 'exportedAt': '2026-10-06T12:00:00Z',
           'folders': [{'id': 'f1', 'name': 'Urok RU', 'mode': 'hideAll'}],
           'decks': [{'id': 'd1', 'name': 'Urok RU', 'newPerDay': 20, 'mode': 'hideAll', 'folderId': 'f1', 'createdAt': now}],
           'plates': [{'id': 'p1', 'deckId': 'd1', 'w': 600, 'h': 400, 'createdAt': now, 'image': data, 'lang': 'ru', 'title': 'Лобная и верхняя челюсть', 'page': 7,
                       'intro': ['Это <b>лобная</b> кость.', 'Смотрите ATTACK на рисунок.'],
                       'link': [{'item': 'c2', 'q': 'Как называется верхняя челюсть?', 'ans': 'maxilla', 'opts': ['os frontale', 'mandibula', 'vomer'], 'src': 'KT', 'page': 5},
                                {'q': 'Какая кость образует лоб?', 'ans': 'лобная кость', 'opts': ['нижняя челюсть', 'сошник', 'скуловая кость'], 'src': 'OC'}]}],
           'cards': cards, 'stats': {}}
    pathlib.Path(path).write_text(json.dumps(doc))


def big_lesson_file(path):
    """A Russian lesson that does not go into one request: 30 structures with notes (each note names its term), two questions; the last structure has a kind the dictionary lacks.
    Folder and part are called «Urok BIG»."""
    from PIL import Image
    buf = io.BytesIO(); Image.new('RGB', (600, 400), (235, 235, 225)).save(buf, 'JPEG', quality=80)
    data = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
    now = int(time.time() * 1000)
    cards = [{'id': 'c%d' % (i + 1), 'deckId': 'd1', 'plateId': 'p1', 'term': 'os testa %02d' % (i + 1), 'x': 2 + 3 * (i % 30), 'y': 10 + 2 * (i // 5), 'w': 4, 'h': 3, 'createdAt': now + i,
              'note': 'Заметка о кости номер %02d: это (os testa %02d) в черепе.' % (i + 1, i + 1), 'src': 'KT', 'prio': 1, 'kind': 'sooned' if i == 29 else 'luu'} for i in range(30)]
    doc = {'app': 'corpus', 'kind': 'folder', 'version': 1, 'exportedAt': '2026-10-06T12:00:00Z',
           'folders': [{'id': 'f1', 'name': 'Urok BIG', 'mode': 'hideAll'}],
           'decks': [{'id': 'd1', 'name': 'Urok BIG', 'newPerDay': 20, 'mode': 'hideAll', 'folderId': 'f1', 'createdAt': now}],
           'plates': [{'id': 'p1', 'deckId': 'd1', 'w': 600, 'h': 400, 'createdAt': now, 'image': data, 'lang': 'ru', 'title': 'Большой урок',
                       'intro': ['Это длинный урок.', 'Он не влезает в один запрос.'],
                       'link': [{'item': 'c2', 'q': 'Какая кость вторая?', 'ans': 'os testa 02', 'opts': ['os testa 03', 'os testa 04', 'os testa 05'], 'src': 'KT'},
                                {'q': 'Какая кость первая?', 'ans': 'первая кость', 'opts': ['вторая кость', 'третья кость', 'четвёртая кость'], 'src': 'OC'}]}],
           'cards': cards, 'stats': {}}
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
             'skull3.jpg': jpeg(700, 500, (220, 230, 240)), 'small.png': None,
             'scheme.svg': b'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect x="10" y="10" width="60" height="40" fill="#c33"/><script>alert(1)</script></svg>'}
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
        (6, MID_B, sep.join(['mandibula', 'alalõualuu <img src="scheme.svg">']))]
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
    # SIGTERM cancels only this task (as asyncio does for SIGINT): Playwright closes normally and the finally below stops the servers
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, asyncio.current_task().cancel)
    busy = [p for p in (SITE_PORT, API_PORT, FN_PORT) if port_open(p)]
    if busy:
        print('FAIL test ports already in use: ' + ', '.join(map(str, busy)) + ' (probably a server left from an earlier run; '
              'find it with: pgrep -af "corpus-ai/index.ts|fake-supabase|http.server")')
        raise SystemExit(1)
    tmp = pathlib.Path(tempfile.mkdtemp())
    site = tmp / 'corpus'
    shutil.copytree(ROOT, site, ignore=shutil.ignore_patterns('.git', 'tools', 'src', 'supabase', '*.md'))
    (site / 'config.js').write_text(f"self.CORPUS_CONFIG={{url:'{API}',key:'test-publishable-key',bucket:'plates'}};")
    folder_file(tmp / 'corpus-folder-Kolju.json')
    order_file(tmp / 'corpus-folder-order.json')
    lesson_file(tmp / 'corpus-folder-lesson.json')
    ru_lesson_file(tmp / 'corpus-folder-ru.json')
    big_lesson_file(tmp / 'corpus-folder-big.json')
    anki_file(tmp / 'Kolju.apkg')
    deno = [shutil.which('deno')] if shutil.which('deno') else ['npx', '--yes', 'deno']
    fn_env = dict(os.environ, SUPABASE_URL=API, ANTHROPIC_BASE_URL=API, ANTHROPIC_API_KEY='test-anthropic-key', SUPABASE_SERVICE_ROLE_KEY='service-key')
    api_env = dict(os.environ, FAKE_FN_URL=f'http://localhost:{FN_PORT}', FAKE_AI_LIMIT=str(AI_LIMIT), FAKE_ADMINS='lev@test.ee')
    procs = []
    ok = True

    def check(name, cond, extra=''):
        nonlocal ok
        print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra else ''))
        if not cond:
            ok = False
            raise SystemExit(1)

    try:
        procs.append(start(deno + ['run', '--allow-net', '--allow-env', '--allow-read', '--allow-sys', str(ROOT / 'supabase' / 'functions' / 'corpus-ai' / 'index.ts')],
                           env=fn_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        procs.append(start(['node', str(ROOT / 'tools' / 'fake-supabase.js'), str(API_PORT), INVITE], env=api_env, stdout=subprocess.DEVNULL))
        procs.append(start([sys.executable, '-m', 'http.server', str(SITE_PORT), '--directory', str(tmp)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        wait_port(API_PORT); wait_port(SITE_PORT); wait_port(FN_PORT, 120)
        for pr in procs:
            if pr.poll() is not None:
                raise RuntimeError(f'test server exited at start: {pr.args} (code {pr.returncode}); its port was probably taken by another process')
        async with async_playwright() as p:
            b = await p.chromium.launch()

            quota_window = {'on': False}   # True only while the test provokes refusals from the account limits
            refusal_window = {'on': False}   # True only while the test makes the fake model service refuse (the function answers 502)

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
                      and not ('/functions/v1/corpus-ai' in r.url and (r.status in (404, 429) or (r.status == 502 and refusal_window['on'])))   # provoked: function off, daily limit; the model service refuses (only inside refusal_window)
                      and not ('/rpc/corpus_share_open' in r.url and r.status == 404)             # provoked: a wrong share code
                      and not (quota_window['on'] and r.status in (400, 413, 503))                 # provoked: the account limits (see «limits» below)
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

            def watch_ai(page):
                """The bodies of the POST requests the page sends to the AI function (a list that grows)."""
                calls = []
                page.on('request', lambda r: '/functions/v1/corpus-ai' in r.url and r.method == 'POST' and calls.append(r.post_data_json))
                return calls

            async def ui_lang(page, lang):
                """Switch the interface language the way the reader does: in Settings."""
                await page.evaluate("go({name:'settings'})")
                await page.click(f'[data-act=setLang][data-v={lang}] >> nth=0')
                await page.wait_for_function(f"document.documentElement.lang==='{lang}'")

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
            check('AI JSON answer (text model)', r.get('ok') is True and r.get('model') == 'claude-haiku-5-5', json.dumps(r))
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

            # a folder can be switched off: its decks leave «today» and the shared session, and it is remembered
            fid0 = await pg.evaluate('S.folders[0].id')
            n_on = await pg.evaluate('(()=>{const c=globalCounts();return c.new+c.learn+c.review;})()')
            await pg.evaluate(f"go({{name:'folder',folderId:'{fid0}'}})")
            await pg.click('[data-act=folderMenu]')
            await pg.click('#layer [data-s="off"]')
            st = await state_when(lambda st: any(d['coll'] == 'folders' and d['data'].get('off') for d in st['docs']))
            n_off = await pg.evaluate('(()=>{const c=globalCounts();return c.new+c.learn+c.review;})()')
            check('switched-off folder: saved, its cards leave «today»', any(d['coll'] == 'folders' and d['data'].get('off') for d in st['docs']) and n_on > 0 and n_off == 0, f'{n_on} -> {n_off}')
            check('switched-off folder: a banner offers to switch it back on', await pg.is_visible('[data-act=folderOn]'))
            await pg.click('[data-act=folderOn]')
            check('folder switched back on', (await pg.evaluate('(()=>{const c=globalCounts();return c.new+c.learn+c.review;})()')) == n_on and not await pg.evaluate('!!S.folders[0].off'))

            # grading: the drag ring goes with touch gestures; with gestures off the plain buttons are back
            await pg.evaluate("go({name:'home'})")
            await pg.evaluate('startGlobalStudy()')
            await pg.wait_for_selector('#panel')
            ring = await pg.evaluate("!!document.querySelector('#panel .ring')")
            await pg.evaluate("META.swipe=false;updStudy()")
            plain = await pg.evaluate("!document.querySelector('#panel .ring')&&!!document.querySelector('#panel .btn[data-act=reveal]')")
            check('gestures on: grade ring; off: plain buttons', ring and plain)
            await pg.evaluate("META.swipe=true;go({name:'home'})")

            # strict mode: no Kostik and no fact of the day
            await pg.evaluate("META.calm=true;applyLook();go({name:'home'})")
            strict = await pg.evaluate("[document.querySelectorAll('#app .kk').length,!!document.querySelector('#app .svfact'),document.documentElement.classList.contains('calm')]")
            await pg.evaluate("META.calm=false;applyLook();go({name:'home'})")
            check('strict mode hides Kostik and the fact of the day', strict == [0, False, True], json.dumps(strict))

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

            # ---------- courses tab and lesson screen ----------
            plates_before_lesson = await pg.evaluate('S.plates.length')
            async def import_file(name, count_plates):
                n0 = await pg.evaluate('S.plates.length')
                await pg.evaluate("go({name:'settings'})")
                async with pg.expect_file_chooser() as fc:
                    await pg.click('[data-act=importPick] >> nth=0')
                await (await fc.value).set_files(str(tmp / name))
                await pg.click('#layer [data-s="1"]')
                await pg.wait_for_function(f'S.plates.length==={n0 + count_plates}', timeout=20000)

            await pg.evaluate("go({name:'library'})")
            await pg.click('.tabbar [data-v=courses]')
            await pg.wait_for_selector('.crs .sv-empty')
            tb = await pg.evaluate("""(()=>{const n=document.querySelector('.tabbar').getBoundingClientRect();const bs=[...document.querySelectorAll('.tabbar button')].map(b=>b.getBoundingClientRect());
              return {n:bs.length,inside:bs.every(r=>r.left>=n.left-1&&r.right<=n.right+1&&r.width>40),dw:Math.abs(document.querySelector('.tabpill').getBoundingClientRect().width-bs[0].width)};})()""")
            check('courses tab: six tabs fit the bar at 390px, the pill is one tab wide', tb['n'] == 6 and tb['inside'] and tb['dw'] < 3, json.dumps(tb))
            check('courses tab: no course yet, an empty state with an import button', bool(await pg.query_selector('.crs .sv-empty [data-act=importPick]')))

            await import_file('corpus-folder-lesson.json', 2)
            await pg.evaluate("go({name:'library'})")
            await pg.click('.tabbar [data-v=courses]')
            await pg.wait_for_selector('.crs.chome .clrow')
            home = await pg.evaluate("""(()=>{const q=s=>document.querySelectorAll('.crs.chome '+s);return {parts:q('.cpart').length,open:[...q('.cpart')].map(p=>p.classList.contains('open')),rows:q('.clrow').length,st:[...q('.clrow')].map(r=>r.dataset.st),
              hero:q('.chero .chn b')[0].textContent,legend:q('.cabout .chip').length,old:q('.kbubble,.svtile,.svcard').length,back:q('[data-act=crList]').length};})()""")
            check('course home: progress block, two parts (the first open, the second folded), one new lesson, importance legend, no old tiles',
                  home == {'parts': 2, 'open': [True, False], 'rows': 1, 'st': ['new'], 'hero': '0', 'legend': 3, 'old': 0, 'back': 0}, json.dumps(home))
            row = await pg.evaluate("document.querySelector('.crs.chome .clrow').innerText.replace(/\\n/g,' | ')")
            check('course home: a lesson row has the title and the counts', 'Esimene foto' in row and '3 struktuuri' in row and '2 küsimust' in row, row)
            cta = await pg.evaluate("document.querySelector('.crs.chome .ccta').innerText.replace(/\\n/g,' | ')")
            check('course home: the big button starts the first new lesson', 'Esimene foto' in cta and not await pg.query_selector('.crs.chome .ccta[data-step]'), cta)
            await pg.click('.cfbar [data-f="1"]')
            await pg.wait_for_function("document.querySelector('.cfbar [data-f=\"1\"]').classList.contains('on')")
            row = await pg.evaluate("document.querySelector('.crs.chome .clrow').innerText")
            check('importance filter P1: the lesson counts only P1; the choice is kept', await pg.evaluate('META.coursePrio') == 1 and '1 struktuur ' in row, row)
            check('importance filter P1: the second lesson (only P2) is gone from the whole screen, its row and the big button', 'Teine' not in await pg.inner_text('.crs.chome'))
            part2 = await pg.evaluate("(()=>{const p=document.querySelectorAll('.crs.chome .cpart')[1];return {rows:p.querySelectorAll('.clrow').length,note:p.querySelectorAll('.cempty').length,tag:p.querySelector('.cph').tagName,did:p.dataset.did};})()")
            await pg.click('.crs.chome .cpart >> nth=1 >> .cph')
            part2b = await pg.evaluate("did=>({open:CR_OPEN[did]===undefined?null:CR_OPEN[did],rows:document.querySelectorAll('.crs.chome .clrow').length})", part2['did'])
            check('importance filter P1: the part without P1 stays as a plain heading (not a button, a click does nothing), with a note instead of lessons',
                  part2['rows'] == 0 and part2['note'] == 1 and part2['tag'] == 'DIV' and part2b['open'] is None and part2b['rows'] == 1, json.dumps([part2, part2b]))
            await pg.click('.cfbar [data-f="3"]')
            await pg.wait_for_selector('.crs.chome .cpart >> nth=1 >> button.cph')
            await pg.click('.crs.chome .cpart >> nth=1 >> button.cph')   # the part with the lesson is opened by its own heading
            await pg.wait_for_function("document.querySelectorAll('.crs.chome .clrow').length===2")

            # the lesson of the first photo
            await pg.click('.crs.chome .clrow >> nth=0')
            await pg.wait_for_selector('.clesson .kbubble')
            check('lesson: header with the title and the step, five step buttons, photo shown',
                  await pg.inner_text('.clesson .bar-title b') == 'Esimene foto' and 'Ülevaade' in await pg.inner_text('#cstep') and 'lk 12' in await pg.inner_text('#cstep')
                  and await pg.locator('.cseg button').count() == 5 and bool(await pg.query_selector('.clesson #simg')), await pg.inner_text('#cstep'))
            txt = await pg.inner_text('.clesson .kbubble')
            check('lesson overview: <b> is bold, the attack line stays text, all labels visible',
                  await pg.inner_text('.clesson .kbubble b') == 'paks' and await pg.locator('#masks .cm').count() == 0 and await pg.evaluate('window.__xss') is None, txt)
            await pg.click('#cnx')
            txt = await pg.inner_text('.clesson .kbubble')
            check('lesson overview: second paragraph shows the attack as text', '<img src=x onerror=window.__xss=1>' in txt and not await pg.query_selector('.clesson .kbubble img') and await pg.evaluate('window.__xss') is None and '2 / 2' in await pg.inner_text('.ccount'), txt)
            await pg.click('#cnx')
            await pg.wait_for_selector('.cterm')
            check('lesson get-to-know: term, note, framed structure, chips', await pg.inner_text('.cterm') == 'os frontale' and 'Märkus os frontale' in await pg.inner_text('.cnote')
                  and await pg.locator('#masks .cm.cur').count() == 1 and await pg.locator('.clesson .chip.p1').count() == 1 and await pg.locator('#masks .cpt').count() == 0)
            await pg.click('[data-act=crBack]')
            await pg.wait_for_selector('.crs.chome')
            cont = await pg.evaluate("""(()=>{const r=document.querySelector('.crs.chome .clrow'),c=document.querySelector('.crs.chome .ccta');
              return {st:r.dataset.st,cta:c.innerText,step:c.dataset.step,last:META.courseLast&&META.courseLast.step,pid:!!META.courseLast&&META.courseLast.pid===r.dataset.pid};})()""")
            check('course home after leaving mid-lesson: the row is current, the big button names the lesson and the step, the step is saved',
                  cont['st'] == 'cur' and 'Esimene foto' in cont['cta'] and '2' in cont['cta'] and cont['step'] == 'tu' and cont['last'] == 'tu' and cont['pid'], json.dumps(cont))
            await pg.click('.crs.chome .ccta')
            await pg.wait_for_selector('.cterm')
            check('the big button opens the lesson on the saved step', await pg.evaluate("view.name==='courseLesson'&&CL.step==='tu'") and await pg.inner_text('.cterm') == 'os frontale')
            await pg.click('#cnx')
            check('lesson get-to-know: the point marker of the second structure', await pg.inner_text('.cterm') == 'maxilla' and await pg.locator('#masks .cpt').count() == 1)
            await pg.click('#cnx'); await pg.click('#cnx')   # third structure, then on to practice
            await pg.wait_for_selector('.copt')
            sched0 = await pg.evaluate("JSON.stringify(S.cards.map(c=>[c.id,c.reps||0,c.due,c.type]))")
            check('lesson practice: a hidden target, three options', await pg.locator('#masks .cm.tgt').count() == 1 and await pg.locator('.copt').count() == 3)
            for k in range(3):
                term = await pg.evaluate('CL.st.q[CL.st.i].term')
                if k == 1:
                    await pg.evaluate("[...document.querySelectorAll('.copt')].find(b=>b.textContent!==CL.st.q[CL.st.i].term).click()")
                    check('lesson practice: a wrong option is marked, the frame shakes red, the right one shows', await pg.locator('.copt.no').count() == 1 and await pg.locator('.copt.ok').count() == 1 and await pg.locator('#masks .cm.bad').count() == 1)
                else:
                    await pg.click(f'.copt >> text="{term}"')
                    if k == 0:
                        check('lesson practice: the right option turns green with the note', await pg.locator('.copt.ok').count() == 1 and await pg.locator('#masks .cm.okk').count() == 1 and 'Märkus' in await pg.inner_text('#cfb'))
                await pg.click('#cnx')
            check('lesson practice: result 2 / 3', '2 / 3' in await pg.inner_text('.cdone b'), await pg.inner_text('.cdone b'))
            check('lesson practice does not touch the schedule', await pg.evaluate("JSON.stringify(S.cards.map(c=>[c.id,c.reps||0,c.due,c.type]))") == sched0)
            await pg.click('#cnx')
            await pg.wait_for_selector('#cshow')
            check('lesson recall: target frame, hint and show-answer buttons', await pg.locator('#masks .cm.tgt').count() == 1 and bool(await pg.query_selector('#chint')))
            await pg.click('#chint')
            check('lesson recall: the hint shows the kind, the masked note and the first letters', bool(await pg.query_selector('.hintbox')) and 'luu' in await pg.inner_text('.hintbox') and '…' in await pg.inner_text('.hintbox'), await pg.inner_text('.hintbox'))
            first = await pg.evaluate('CL.st.q[0].id')
            await pg.click('#cshow')
            ivs = await pg.evaluate("[...document.querySelectorAll('.crate button small')].map(x=>x.textContent)")
            check('lesson recall: four ratings with real, translated intervals', len(ivs) == 4 and all(ivs) and not re.search('[а-яА-Я]', ' '.join(ivs)) and await pg.locator('#masks .cm.open').count() == 1, json.dumps(ivs))
            await pg.click('.crate .r3')
            c1 = await pg.evaluate(f"(()=>{{const c=cardById('{first}');return {{reps:c.reps,type:c.type,due:c.due>Date.now()}};}})()")
            check('lesson recall: Good writes the card schedule', c1['reps'] == 1 and c1['type'] != 'new' and c1['due'], json.dumps(c1))
            await pg.click('#cshow'); await pg.click('.crate .r1')
            check('lesson recall: Again puts the structure back into the queue', await pg.evaluate('CL.st.q.length') == 4)
            for _ in range(6):
                if await pg.query_selector('.cdone'):
                    break
                await pg.click('#cshow'); await pg.click('.crate .r3')
            await pg.wait_for_selector('.cdone')
            reps = await pg.evaluate("S.cards.filter(c=>c.plateId===CL.pid).map(c=>c.reps||0).sort().join()")
            check('lesson recall: every structure rated at least once', all(int(x) >= 1 for x in reps.split(',')), reps)
            # a second pass the same day: cards not due yet keep their schedule
            await pg.click('.cseg [data-s=me]')
            await pg.wait_for_selector('#cshow')
            q0 = await pg.evaluate('CL.st.q[0].id')
            before = await pg.evaluate(f"(c=>[c.reps,c.due])(cardById('{q0}'))")
            await pg.click('#cshow'); await pg.click('.crate .r3')
            check('lesson recall: a card that is not due yet keeps its schedule', await pg.evaluate(f"(c=>[c.reps,c.due])(cardById('{q0}'))") == before, json.dumps(before))
            for _ in range(8):
                if await pg.query_selector('.cdone'):
                    break
                await pg.click('#cshow'); await pg.click('.crate .r3')
            await pg.wait_for_selector('.cdone')
            sched1 = await pg.evaluate("JSON.stringify(S.cards.map(c=>[c.id,c.reps||0,c.due,c.type]))")
            await pg.click('#cnx')
            await pg.wait_for_selector('.cq')
            seen = []
            for k in range(2):
                q = await pg.evaluate('CL.st.q[CL.st.i]')
                frame = await pg.locator('#masks .cm.cur').count()
                seen.append((bool(q.get('item')), frame, 'lk' in await pg.inner_text('.clesson .chip.src') or not q.get('page')))
                if k == 0:
                    await pg.evaluate("[...document.querySelectorAll('.copt')].find(b=>b.textContent!==CL.st.q[CL.st.i].ans).click()")
                    check('lesson connect: a wrong option is marked, the answer is shown', await pg.locator('.copt.no').count() == 1 and await pg.locator('.copt.ok').count() == 1 and bool(await pg.query_selector('.cverdict.no')))
                else:
                    await pg.click(f'.copt >> text="{q["ans"]}"')
                    check('lesson connect: a right option is green', bool(await pg.query_selector('.cverdict.ok')))
                await pg.click('#cnx')
            check('lesson connect: the structure of the question is framed, a question without one frames nothing and the page shows', all((has and frame == 1) or (not has and frame == 0) for has, frame, _ in seen) and any(has for has, _, _ in seen) and all(pg_ for _, _, pg_ in seen), json.dumps(seen))
            check('lesson connect: result 1 / 2 and a way back', '1 / 2' in await pg.inner_text('.cdone b') and bool(await pg.query_selector('#cnx')))
            check('lesson connect does not touch the schedule', await pg.evaluate("JSON.stringify(S.cards.map(c=>[c.id,c.reps||0,c.due,c.type]))") == sched1)
            await pg.click('#cnx')
            await pg.wait_for_selector('.crs.chome')
            if not await pg.evaluate("document.querySelector('.crs.chome .cpart').classList.contains('open')"):
                await pg.click('.crs.chome .cpart >> nth=0 >> .cph')   # the big button moved on to the next part, which opened
            end = await pg.evaluate("""(()=>({st:document.querySelector('.crs.chome .clrow').dataset.st,last:META.courseLast===undefined,hero:document.querySelector('.crs.chome .chero .chn b').textContent,cta:document.querySelector('.crs.chome .ccta').innerText}))()""")
            check('lesson finished: the row says repeat or done, nothing is left to continue, the big button moves to the next lesson',
                  end['st'] in ('due', 'done') and end['last'] and end['hero'] == '1' and 'Teine foto' in end['cta'], json.dumps(end))
            nrev = await pg.evaluate("+document.querySelector('.crs.chome .crev b').textContent")
            nwant = await pg.evaluate("(()=>{const d=new Date();d.setHours(24,0,0,0);const p=S.plates.find(p=>p.title==='Esimene foto');return S.cards.filter(c=>c.plateId===p.id&&c.type!=='new'&&c.due<d.getTime()).length;})()")
            check('course home: "repeat today" counts the cards of the course that are due', nrev == nwant and nrev > 0, f'{nrev} / {nwant}')
            await pg.click('.crs.chome button.crev')
            await pg.wait_for_function("view.name==='study'")
            check('"repeat today" starts a session over the cards of the course only (the new ones of the second part are left out)',
                  await pg.evaluate("(()=>{const d2=S.decks.find(d=>d.name.startsWith('Urok 2')).id;return SS.folderId===S.folders.find(f=>f.name==='Urok').id&&SS.deckIds.length===2&&SS.exclude.size>0&&S.cards.filter(c=>c.deckId===d2).every(c=>SS.exclude.has(c.id));})()"))
            await pg.evaluate("go({name:'courses'})")

            # statuses and the "repeat" counters with schedules set by hand. Only in memory and only for lesson one: nothing below depends on them
            # (the reload below brings back what was saved; lesson one comes back as passed either way)
            pid1 = await pg.evaluate("S.plates.find(p=>p.title==='Esimene foto').id")
            ids1 = await pg.evaluate("p=>S.cards.filter(c=>c.plateId===p).map(c=>c.id)", pid1)
            fid1 = await pg.evaluate("S.folders.find(f=>f.name==='Urok').id")

            async def sched(offsets):   # card id -> when it is due, in ms from now
                await pg.evaluate("m=>{CR_OPEN[plateById('" + pid1 + "').deckId]=true;Object.keys(m).forEach(id=>{const c=cardById(id);c.type='review';c.ivl=3;c.due=Date.now()+m[id];});render();}", offsets)

            async def lesson_state():
                return await pg.evaluate("""pid=>{const r=document.querySelector('.crs.chome .clrow[data-pid="'+pid+'"]'),t=document.querySelector('.crs.chome .ctile.crev b, .crs.chome .ctile.crnone b');
                  return {st:r&&r.dataset.st,pill:r&&r.querySelector('.cpill').innerText.trim(),tile:t&&+t.textContent,btn:!!document.querySelector('.crs.chome button.crev'),hero:+document.querySelector('.crs.chome .chero .chn b').textContent};}""", pid1)

            DAY = 86400000
            await sched({i: 3 * DAY for i in ids1})
            st = await lesson_state()
            check('course home: every structure seen and none due today -> the lesson is done, nothing to repeat', st['st'] == 'done' and st['pill'] == 'Läbitud' and st['tile'] == 0 and not st['btn'] and st['hero'] == 1, json.dumps(st))
            await sched({ids1[0]: -3600000})
            st = await lesson_state()
            check('course home: one structure due today -> the lesson says repeat 1, the tile counts 1 and is a button', st['st'] == 'due' and st['pill'] == 'Korda 1' and st['tile'] == 1 and st['btn'] and st['hero'] == 1, json.dumps(st))
            await sched({ids1[0]: -3600000, ids1[1]: -7200000})
            st = await lesson_state()
            check('course home: two structures due -> repeat 2 in the lesson and in the tile', st['pill'] == 'Korda 2' and st['tile'] == 2, json.dumps(st))
            await pg.evaluate("META.mode='hideOne'")   # the session takes the mode of the course folder, not the global one
            await pg.click('.crs.chome button.crev')
            await pg.wait_for_function("view.name==='study'")
            sess = await pg.evaluate("a=>({view:view.name,cur:a.slice(0,2).includes(SS.cur),out:a.slice(0,2).some(id=>SS.exclude.has(id)),mode:SS.mode,folder:SS.folderId})", ids1)
            await pg.evaluate("delete META.mode")
            check('"repeat today": a study session, the first card is one of the course cards due, none of them is left out, the mode is the folder one',
                  sess == {'view': 'study', 'cur': True, 'out': False, 'mode': 'hideAll', 'folder': fid1}, json.dumps(sess))
            await pg.evaluate("go({name:'courses'})")
            await pg.wait_for_selector('.crs.chome')
            await pg.evaluate("a=>{cardById(a[0]).grp='g1';cardById(a[1]).grp='g1';render();}", ids1)   # two cards of one group are learned as one
            st = await lesson_state()
            check('course home: cards of one group count once (tile and lesson)', st['pill'] == 'Korda 1' and st['tile'] == 1, json.dumps(st))
            await pg.click('.crs.chome button.crev')
            await pg.wait_for_function("view.name==='study'")
            sess = await pg.evaluate("a=>({cur:a.slice(0,2).includes(SS.cur),left:a.slice(0,2).filter(id=>SS.exclude.has(id)).length})", ids1)
            check('"repeat today" over a group: one card of the group goes into the session, the other waits outside', sess == {'cur': True, 'left': 1}, json.dumps(sess))
            await pg.evaluate("go({name:'courses'})")
            await pg.evaluate("a=>{delete cardById(a[0]).grp;delete cardById(a[1]).grp;render();}", ids1)

            # a step can be opened directly and the same screen opens from the deck
            did = await pg.evaluate("S.decks.find(d=>d.name==='Urok').id")
            await pg.evaluate(f"go({{name:'deck',deckId:'{did}',tab:'photos'}})")
            check('lesson: the deck has a Lesson button', bool(await pg.query_selector('[data-act=lesson]')))
            await pg.click('[data-act=lesson]')
            await pg.wait_for_selector('.clesson .cseg')
            await pg.click('.cseg button[data-s=se]')
            await pg.wait_for_selector('.cq')
            check('lesson from the deck: the same screen, any step can be opened', await pg.evaluate("view.name==='courseLesson'&&CL.step==='se'"))
            check('repeating a passed lesson does not touch "Continue"', await pg.evaluate("META.courseLast===undefined"))
            await pg.click('[data-act=crBack]')
            await pg.wait_for_function("view.name==='deck'")

            # the importance filter and the place in a lesson survive a reload
            pid2 = await pg.evaluate("S.plates.find(p=>p.title&&p.title.startsWith('Teine foto')).id")
            await pg.evaluate("go({name:'courses'})")
            await pg.click('.cfbar [data-f="2"]')
            await pg.click(f'.crs.chome .clrow[data-pid="{pid2}"]')
            await pg.wait_for_selector('.clesson .cseg')
            await pg.click('.cseg [data-s=ha]')
            await pg.wait_for_selector('.copt')
            await pg.click('[data-act=crBack]')
            await pg.wait_for_selector('.crs.chome')
            await pg.wait_for_function('WQ.jobs.size===0', timeout=20000)
            await pg.reload()
            await app_ready(pg)
            kept = await pg.evaluate("({prio:META.coursePrio,last:META.courseLast})")
            check('after a reload the importance filter and the lesson step are still there', kept['prio'] == 2 and kept['last'] == {'pid': pid2, 'step': 'ha'}, json.dumps(kept))
            await pg.evaluate("go({name:'courses'})")
            await pg.wait_for_selector('.crs.chome .ccta')
            back = await pg.evaluate("({on:document.querySelector('.cfbar .on').dataset.f,pid:document.querySelector('.ccta').dataset.pid,step:document.querySelector('.ccta').dataset.step,st:document.querySelector('.clrow[data-pid=\"'+META.courseLast.pid+'\"]').dataset.st})")
            check('after a reload the course home shows the filter and continues on the saved step', back == {'on': '2', 'pid': pid2, 'step': 'ha', 'st': 'cur'}, json.dumps(back))

            # text from a file never becomes markup: a part name and a lesson title with an <img onerror> tag in them, on the course home
            tag = '<img src=x onerror=window.__xss=2>'
            await pg.evaluate("CR_OPEN[plateById('" + pid1 + "').deckId]=true;CR_OPEN[plateById('" + pid2 + "').deckId]=true;render()")
            xs = await pg.evaluate("""p2=>{const q=s=>document.querySelectorAll('.crs.chome '+s);
              return {x:window.__xss===undefined,cph:q('.cph img').length,lat:q('.clrow .latin img').length,cta:q('.ccta img').length,
                      part:q('.cpart')[1].querySelector('.cph').innerText,row:q('.clrow[data-pid="'+p2+'"]')[0].innerText,ctat:q('.ccta')[0].innerText};}""", pid2)
            check('course home: a part name and a lesson title with markup stay text (no tag is created, no script runs)',
                  xs['x'] and xs['cph'] == 0 and xs['lat'] == 0 and xs['cta'] == 0 and tag in xs['part'] and tag in xs['row'] and tag in xs['ctat'], json.dumps(xs))

            # a passed lesson, repeated from the home, neither moves "Continue" nor clears the place saved in another lesson
            await pg.click('.crs.chome .clrow[data-pid="' + pid1 + '"]')
            await pg.wait_for_selector('.clesson .cseg')
            await pg.click('.cseg [data-s=se]')
            await pg.wait_for_selector('.cq')
            for _ in range(2):
                await pg.click('.copt >> nth=0'); await pg.click('#cnx')
            await pg.wait_for_selector('.cdone')
            kept2 = await pg.evaluate('META.courseLast')
            check('finishing a passed lesson leaves the place saved in another lesson alone', kept2 == {'pid': pid2, 'step': 'ha'}, json.dumps(kept2))
            await pg.click('#cnx')
            await pg.wait_for_selector('.crs.chome')

            # a lesson of questions only: a photo without cards (and without a picture) in the second part
            qid = await pg.evaluate("""(()=>{const d=S.decks.find(d=>d.name.startsWith('Urok 2'));const p={id:newId('plates'),deckId:d.id,w:0,h:0,createdAt:Date.now(),title:'Ainult küsimused',
              link:[{q:'Mis on ülalõualuu?',ans:'maxilla',opts:['vomer','mandibula']}]};S.plates.push(p);persist('plates',p.id);CR_OPEN[d.id]=true;render();return p.id;})()""")
            rows = {}
            for lvl in (1, 2, 3):
                await pg.click('.cfbar [data-f="' + str(lvl) + '"]')
                await pg.wait_for_function("document.querySelector('.cfbar [data-f=\"" + str(lvl) + "\"]').classList.contains('on')")
                rows[lvl] = await pg.evaluate("""q=>{const r=document.querySelector('.crs.chome .clrow[data-pid="'+q+'"]');return r&&{st:r.dataset.st,t:r.innerText.replace(/\\n/g,' | ')};}""", qid)
            check('course home: a lesson of questions only is listed at every importance filter, new, with its question count',
                  all(rows[k] and rows[k]['st'] == 'new' and 'Ainult küsimused' in rows[k]['t'] and '1 küsimus' in rows[k]['t'] and 'struktuur' not in rows[k]['t'] for k in rows), json.dumps(rows))
            hero0 = await pg.evaluate("+document.querySelector('.crs.chome .chero .chn b').textContent")
            await pg.click('.crs.chome .clrow[data-pid="' + qid + '"]')
            await pg.wait_for_selector('.clesson .kbubble')
            check('question-only lesson: two steps (overview, connect), the photo is missing and it still opens',
                  await pg.evaluate('CL.steps.join()') == 'ov,se' and await pg.locator('.cseg button').count() == 2 and bool(await pg.query_selector('.clesson .noimg')))
            await pg.click('#cnx')   # no intro of its own: one default line, then the questions
            await pg.wait_for_selector('.cq')
            await pg.click('[data-act=crBack]')
            await pg.wait_for_selector('.crs.chome')
            mid = await pg.evaluate("""q=>{const r=document.querySelector('.crs.chome .clrow[data-pid="'+q+'"]'),c=document.querySelector('.crs.chome .ccta');
              return {st:r.dataset.st,pill:r.querySelector('.cpill').innerText.trim(),pid:c.dataset.pid===q,step:c.dataset.step,t:c.innerText.replace(/\\n/g,' | ')};}""", qid)
            check('question-only lesson left on the questions: the row is current and "Continue" returns to that step',
                  mid['st'] == 'cur' and mid['pill'] == 'Samm 2 / 2' and mid['pid'] and mid['step'] == 'se' and 'Jätka' in mid['t'], json.dumps(mid))
            await pg.click('.crs.chome .ccta')
            await pg.wait_for_selector('.cq')
            await pg.click('.copt >> text="maxilla"')
            await pg.click('#cnx')
            await pg.wait_for_selector('.cdone')
            fin = await pg.evaluate("q=>({done:!!plateById(q).lsDone,last:META.courseLast===undefined})", qid)
            check('question-only lesson: the last answer marks the photo done and clears the saved place', fin == {'done': True, 'last': True}, json.dumps(fin))
            await pg.click('#cnx')
            await pg.wait_for_selector('.crs.chome')
            end = await pg.evaluate("""q=>{const r=document.querySelector('.crs.chome .clrow[data-pid="'+q+'"]'),c=document.querySelector('.crs.chome .ccta');
              return {st:r.dataset.st,pill:r.querySelector('.cpill').innerText.trim(),hero:+document.querySelector('.crs.chome .chero .chn b').textContent,cta:c?c.dataset.pid:null};}""", qid)
            check('question-only lesson: the row is done, the lesson counts as passed, the big button moves on to another lesson',
                  end['st'] == 'done' and end['pill'] == 'Läbitud' and end['hero'] == hero0 + 1 and end['cta'] == pid2, json.dumps([end, hero0]))

            # the course list: two courses, a cover and a status pill on each; a new course is "not started"
            await import_file('corpus-folder-lesson.json', 2)
            await pg.evaluate("go({name:'library'})")
            await pg.click('.tabbar [data-v=courses]')
            await pg.wait_for_selector('.crs .ccards .ccard')
            fids = await pg.evaluate("S.folders.filter(f=>f.name.startsWith('Urok')).sort((a,b)=>a.createdAt-b.createdAt).map(f=>f.id)")
            lst = await pg.evaluate("""fids=>({n:document.querySelectorAll('.crs .ccard').length,x:window.__xss===undefined,tags:document.querySelectorAll('.crs .ccn img').length,
              cards:fids.map(id=>{const c=document.querySelector('.crs .ccard[data-fid="'+id+'"]');return c&&{imgs:c.querySelectorAll('.ccov img').length,pill:c.querySelector('.cpill').className,txt:c.querySelector('.cpill').innerText.trim()};})})""", fids)
            check('course list: two cards, each with a cover and a pill; the started course has due or done, the new one says it is not started',
                  len(fids) == 2 and lst['n'] == 2 and lst['x'] and lst['tags'] == 0 and all(c and c['imgs'] >= 1 for c in lst['cards'])
                  and lst['cards'][0]['pill'] in ('cpill due', 'cpill done') and lst['cards'][1] == {'imgs': 2, 'pill': 'cpill new', 'txt': 'Alustamata'}, json.dumps(lst))
            await pg.click('.crs .ccard[data-fid="' + fids[1] + '"]')
            await pg.wait_for_selector('.crs.chome [data-act=crList]')
            home2 = await pg.evaluate("""fid=>({name:document.querySelector('.crs.chome .chname').textContent===S.folders.find(f=>f.id===fid).name,x:window.__xss===undefined,imgs:document.querySelectorAll('.crs.chome .cph img').length,
              rows:document.querySelectorAll('.crs.chome .clrow').length,st:[...new Set([...document.querySelectorAll('.crs.chome .clrow')].map(r=>r.dataset.st))].join()})""", fids[1])
            check('course list: a click opens that course (its name, a way back to the list), nothing started in it',
                  home2['name'] and home2['x'] and home2['imgs'] == 0 and home2['rows'] >= 1 and home2['st'] == 'new', json.dumps(home2))
            await pg.click('[data-act=crList]')
            await pg.wait_for_selector('.crs .ccards .ccard')
            check('course list: the way back shows the list again', await pg.locator('.crs .ccard').count() == 2 and not await pg.query_selector('.crs.chome'))

            # settings from the database are not trusted: a broken saved place in a lesson and a wrong filter are dropped on load
            await pg.evaluate("(()=>{META.courseLast={pid:'x'.repeat(200),step:'ov'};META.coursePrio=7;persistMeta();})()")
            await pg.wait_for_function('WQ.jobs.size===0', timeout=20000)
            await pg.reload()
            await app_ready(pg)
            bad = await pg.evaluate('[META.courseLast===undefined,META.coursePrio===undefined]')
            check('settings load: a broken saved place in a lesson and a wrong importance filter are dropped', bad == [True, True], json.dumps(bad))
            await pg.evaluate("go({name:'courses',fid:'" + fids[0] + "'})")
            await pg.evaluate("q=>{CR_OPEN[plateById(q).deckId]=true;render();}", qid)
            check('a lesson of questions only is still done after a reload', await pg.evaluate("""q=>{const r=document.querySelector('.crs.chome .clrow[data-pid="'+q+'"]');return r&&r.dataset.st;}""", qid) == 'done')

            # lesson fields survive export and import (kind, page, note, src, prio, pt, intro, link; link item follows the new card ids)
            exp3 = await pg.evaluate(f"buildExport(['{did}']).then(r=>r.out)")
            pl3, cs3 = exp3['plates'][0], {c['term']: c for c in exp3['cards']}
            check('deck export carries intro, link, page and card kind/note/src/prio/pt',
                  len(pl3.get('intro', [])) == 2 and len(pl3.get('link', [])) == 2 and pl3.get('title') == 'Esimene foto' and pl3.get('page') == 12 and pl3['link'][0].get('page') == 5
                  and all(c.get('note') and c.get('src') == 'KT' and c.get('prio') and c.get('kind') == 'luu' for c in cs3.values()) and cs3['maxilla'].get('pt') == [40.5, 60],
                  json.dumps(pl3.get('link'))[:200])
            exp3['plates'][0]['intro'].append(7)   # junk in the file must be dropped, not break the import
            exp3['plates'][0]['link'][1]['page'] = 1000
            exp3['cards'][0]['prio'] = 9
            exp3['cards'][0]['kind'] = 'x' * 50
            exp3['cards'][1]['kind'] = 7
            (tmp / 'corpus-deck-lesson2.json').write_text(json.dumps(exp3))
            await import_file('corpus-deck-lesson2.json', 1)
            res = await pg.evaluate("""(()=>{const p=S.plates[S.plates.length-1];const cs=cardsOfPlate(p.id);const it=cs.find(c=>c.id===p.link[0].item);
              return {intro:p.intro.length,n:cs.length,item:it&&it.term,second:p.link[1].item,note:cs.every(c=>c.note),prio:cs.map(c=>c.prio).filter(Boolean).sort().join(),pt:cs.filter(c=>c.pt).length,
                page:p.page,lp:[p.link[0].page,p.link[1].page],kinds:cs.map(c=>c.kind||'-').sort().join()};})()""")
            check('imported lesson: link points at the new card, page kept, junk dropped', res == {'intro': 2, 'n': 3, 'item': 'maxilla', 'second': None, 'note': True, 'prio': '2,3', 'pt': 1,
                                                                                           'page': 12, 'lp': [5, None], 'kinds': '-,luu,' + 'x' * 20}, json.dumps(res))

            # tools/lessons2corpus.py
            from PIL import Image
            cdir = tmp / 'course'; (cdir / 'img').mkdir(parents=True)
            Image.new('RGB', (80, 60), (200, 200, 200)).save(cdir / 'img' / 'a.jpg')
            (cdir / 'course.json').write_text(json.dumps({'lang': 'ru', 'lessons': [
                {'id': 'a', 'lang': 'et', 'title': 'A', 'sub': 'sub', 'part': 1, 'page': 7, 'img': 'img/a.jpg', 'intro': ['x <b>y</b>'],
                 'items': [{'id': 'i1', 'term': 'Os frontale', 'kind': 'luu', 'box': [1, 2, 3, 4], 'note': 'n', 'src': 'KT', 'prio': 1}], 'link': []},
                {'id': 'b', 'title': 'B', 'part': 1, 'img': None, 'items': [],
                 'link': [{'term': 'os frontale', 'q': 'q?', 'ans': 'a', 'opts': ['b', 'c', 'd'], 'src': 'KT', 'page': 3}]}]}))
            subprocess.run([sys.executable, str(ROOT / 'tools' / 'lessons2corpus.py'), str(cdir / 'course.json'), '-o', str(cdir / 'out.json')], check=True, capture_output=True)
            out = json.loads((cdir / 'out.json').read_text())
            check('lessons2corpus: folder file with the question bound to its frame, kind and pages kept',
                  out['kind'] == 'folder' and len(out['plates']) == 1 and out['plates'][0]['title'] == 'A' and out['plates'][0]['page'] == 7 and out['plates'][0]['image'].startswith('data:image/jpeg')
                  and out['cards'][0]['id'] == 'a:i1' and out['cards'][0]['kind'] == 'luu' and out['plates'][0]['link'][0]['item'] == 'a:i1' and out['plates'][0]['link'][0]['page'] == 3
                  and out['plates'][0].get('lang') == 'et', json.dumps(out['plates'][0].get('link')))

            (cdir / 'course2.json').write_text(json.dumps({'lang': 'ru', 'lessons': [
                {'id': 'c', 'title': 'C', 'part': 1, 'img': 'img/a.jpg', 'items': [], 'link': []},
                {'id': 'd', 'lang': 'en', 'title': 'D', 'part': 1, 'img': 'img/a.jpg', 'items': [], 'link': []}]}))
            subprocess.run([sys.executable, str(ROOT / 'tools' / 'lessons2corpus.py'), str(cdir / 'course2.json'), '-o', str(cdir / 'out2.json')], check=True, capture_output=True)
            out2 = json.loads((cdir / 'out2.json').read_text())
            check('lessons2corpus: a lesson without lang takes the language of its course, one with its own keeps it', [p.get('lang') for p in out2['plates']] == ['ru', 'en'], json.dumps([p.get('lang') for p in out2['plates']]))

            # the language of a lesson: from the file; without it guessed from the text (shares of letters), each time, never written down
            guess = await pg.evaluate("""['Лобная кость','Märkus: õlavarreluu','Frontal bone','Küünarvars ja käsi','Os frontale (лоб)','os frontale','Märkus os frontale','Šoom',
              'Otsmikuluu (os frontale) moodustab õhukese laeluu ja laubaosa (лоб)','Müller described the foramen magnum and the cranial base in detail'].map(crGuessLang)""")
            check('course language: more than 30% Cyrillic is Russian, an õ (or two of äöüšž) is Estonian, the rest English; a word in brackets or the name «Müller» decides nothing',
                  guess == ['ru', 'et', 'en', 'et', 'en', 'en', 'en', 'en', 'et', 'en'], json.dumps(guess, ensure_ascii=False))
            lg = await pg.evaluate(f"(()=>{{const p=plateById(S.plates.find(p=>p.title==='Esimene foto').id);return [p.lang||null,crSrcLang(p)];}})()")
            check('course language: a lesson without lang in the file is guessed (Estonian here) but the guess is not written down: not on the photo, not in the export, not after an import',
                  lg[0] is None and lg[1] == 'et' and pl3.get('lang') is None and await pg.evaluate("S.plates[S.plates.length-1].lang||null") is None, json.dumps([lg, pl3.get('lang')]))
            cl = await pg.evaluate("""(()=>{const big={tr:{et:{notes:Object.fromEntries(Array.from({length:80},(_,i)=>['k'+i,'я'.repeat(4000)]))}}};
              return {bytes:crBytes({a:'я'}),clean:crTrClean(big.tr)};})()""")
            check('a translation is counted in bytes: 320 000 two-byte letters are over the limit although the text is shorter than it', cl['bytes'] == 10 and cl['clean'] is None, json.dumps(cl)[:100])

            # a lesson in Russian, the reader's language is Estonian, and the AI has nothing left for today: the lesson works in Russian with a quiet note
            ai_a = watch_ai(pg)
            await import_file('corpus-folder-ru.json', 1)
            ru_did = await pg.evaluate("S.decks.find(d=>d.name==='Urok RU').id")
            ru_fid = await pg.evaluate("S.folders.find(f=>f.name==='Urok RU').id")
            ru_pid = await pg.evaluate("S.plates.find(p=>p.title==='Лобная и верхняя челюсть').id")
            ru_sel = f'.crs.chome .clrow[data-pid="{ru_pid}"]'

            async def ru_from_deck():
                await pg.evaluate(f"go({{name:'deck',deckId:'{ru_did}',tab:'photos'}})")
                await pg.click('[data-act=lesson]')
                await pg.wait_for_selector('.clesson .kbubble', timeout=15000)

            await ru_from_deck()
            await pg.wait_for_function("document.querySelector('#ctrs').textContent.includes('Tõlge pole saadaval')", timeout=15000)
            na = await pg.evaluate("({bubble:document.querySelector('.kbubble').innerText,retry:!!document.querySelector('#ctrRetry'),tog:!document.querySelector('#ctog').hidden,busy:!!document.querySelector('.ctrbusy'),err:CL.trErr,title:document.querySelector('#cttl').textContent,steps:document.querySelectorAll('.cseg button').length})")
            check('translation refused (daily limit): the lesson opens in its own language, a quiet «Tõlge pole saadaval», no retry button, no original/translation switch',
                  na['bubble'] == 'Это лобная кость.' and not na['retry'] and not na['tog'] and not na['busy'] and na['err'] == 'quota_exceeded' and na['title'] == 'Лобная и верхняя челюсть' and na['steps'] == 5, json.dumps(na, ensure_ascii=False))
            check('translation refused: exactly one request, for the course purpose', len(ai_a) == 1 and ai_a[0].get('purpose') == 'course', json.dumps([c.get('purpose') for c in ai_a]))
            await pg.click('#cnx'); await pg.click('#cnx')
            await pg.wait_for_selector('.cterm')
            tu = await pg.evaluate("({term:document.querySelector('.cterm').textContent,note:document.querySelector('.cnote').textContent,meta:document.querySelector('.meta').innerText})")
            check('lesson in its own language: the note as in the file, kind and source from the Estonian dictionary', tu['term'] == 'os frontale' and tu['note'] == 'Лобная кость (os frontale) образует лоб.' and 'luu' in tu['meta'] and 'Kolju tervikuna' in tu['meta'], json.dumps(tu, ensure_ascii=False))
            await pg.click('[data-act=crBack]')
            await pg.wait_for_function("view.name==='deck'")
            await pg.evaluate(f"go({{name:'courses',fid:'{ru_fid}'}})")
            await pg.wait_for_selector('.crs.chome .ccta')
            await pg.evaluate(f"CR_OPEN['{ru_did}']=true;render()")
            await pg.click(ru_sel)
            await pg.wait_for_selector('.clesson .kbubble')
            check('after a refusal the lesson is not sent again by itself (course home and reopening): still one request, the note is shown at once',
                  len(ai_a) == 1 and 'Tõlge pole saadaval' in await pg.inner_text('#ctrs') and not await pg.query_selector('.ctrbusy'))
            await pg.click('[data-act=crBack]')
            await pg.wait_for_selector('.crs.chome')
            await pg.evaluate("CR_TRERR.clear();window.__smp=S.sample;S.sample=null")
            await pg.click(ru_sel)
            await pg.wait_for_selector('.clesson .kbubble')
            check('no AI at all: the lesson opens in its own language with the same quiet note and no retry, nothing is asked',
                  len(ai_a) == 1 and 'Tõlge pole saadaval' in await pg.inner_text('#ctrs') and not await pg.query_selector('#ctrRetry') and await pg.evaluate("CL.trErr") == 'no_ai')
            await pg.click('[data-act=crBack]')   # back on the course home while there is no AI: it asks for nothing there either
            await pg.wait_for_selector('.crs.chome')
            await pg.evaluate("S.sample=window.__smp;0")

            # the names of the kinds and sources come from the dictionary in the reader's language; Russian lesson, Russian reader: nothing to translate
            dic = {}
            for lang in ('ru', 'en', 'et'):
                await ui_lang(pg, lang)
                dic[lang] = await pg.evaluate("[crKind('luu'),crSrcName('KT'),crKind('ava'),crSrcName('PIC'),crSrcName('OC'),crKind('õmblus'),crKind('õõs'),crKind('muu'),crKind('zzz'),crSrcName('QQ'),crKind('')]")
            check('kinds and sources are shown in the reader’s language (ru, en, et); an unknown kind or source stays as it is',
                  dic == {'ru': ['кость', 'Череп целиком', 'отверстие / канал', 'рисунок практикума', 'Ossa cranii', 'шов', 'полость / пазуха', 'структура', 'zzz', 'QQ', ''],
                          'en': ['bone', 'The skull as a whole', 'foramen / canal', 'practical image', 'Ossa cranii', 'suture', 'cavity / sinus', 'structure', 'zzz', 'QQ', ''],
                          'et': ['luu', 'Kolju tervikuna', 'ava / kanal', 'praktikumi pilt', 'Ossa cranii', 'õmblus', 'õõs / siinus', 'struktuur', 'zzz', 'QQ', '']}, json.dumps(dic, ensure_ascii=False))
            await ui_lang(pg, 'ru')
            await ru_from_deck()
            await pg.click('#cnx'); await pg.click('#cnx')
            await pg.wait_for_selector('.cterm')
            rr = await pg.evaluate("({err:CL.trErr,busy:CL.busy,tog:!document.querySelector('#ctog').hidden,ctrs:document.querySelector('#ctrs').textContent,meta:document.querySelector('.meta').innerText,note:document.querySelector('.cnote').textContent})")
            check('Russian reader, Russian lesson: nothing is translated or asked, kind and source in Russian, no note about the translation',
                  rr['err'] is None and not rr['busy'] and not rr['tog'] and rr['ctrs'] == '' and 'кость' in rr['meta'] and 'Череп целиком' in rr['meta'] and rr['note'].startswith('Лобная кость') and len(ai_a) == 1, json.dumps(rr, ensure_ascii=False))
            await pg.click('[data-act=crBack]')
            await ui_lang(pg, 'et')

            # clean up, so the counts in the later scenarios stay as they were
            await pg.evaluate("""(()=>{const ds=S.decks.filter(d=>d.name.startsWith('Urok')),ids=new Set(ds.map(d=>d.id));
              S.cards.filter(c=>ids.has(c.deckId)).forEach(c=>removeCard(c.id));S.plates.filter(p=>ids.has(p.deckId)).forEach(p=>dropPlate(p));
              ds.forEach(d=>{S.decks=S.decks.filter(x=>x.id!==d.id);removeDoc('decks',d.id);});
              S.folders.filter(f=>f.name.startsWith('Urok')).forEach(f=>{S.folders=S.folders.filter(x=>x.id!==f.id);removeDoc('folders',f.id);});delete META.coursePrio;delete META.courseLast;persistMeta();})()""")
            await pg.wait_for_function(f'S.plates.length==={plates_before_lesson} && WQ.jobs.size===0', timeout=20000)

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
            st = await state_when(lambda st: sum(1 for d in st['docs'] if d['coll'] == 'plates') == 9 and sum(1 for o in st['objects']) == 11)
            log = json.loads(urllib.request.urlopen(API + '/__log').read())
            posts = [l for l in log if l == 'POST /rest/v1/docs']
            check('Anki import: 3 photos + 2 pictures inside text cards uploaded', sum(1 for o in st['objects']) == 11)
            check('Anki import: an SVG picture is stored as JPEG, never as SVG', not any('svg' in o['type'] for o in st['objects']), json.dumps(sorted(set(o['type'] for o in st['objects']))))
            check('Anki import: documents written in batches, not one request per document', 0 < len(posts) <= 3, f'{len(posts)} POST /rest/v1/docs')
            anki = await pg.evaluate("""(()=>{const ds=S.decks.filter(d=>d.ad);const ph=ds.find(d=>!d.kind),tx=ds.find(d=>d.kind==='text');
                const cs=cardsOfDeck(ph.id).sort((a,b)=>a.createdAt-b.createdAt);const c0=cs[0];const t=cardsOfDeck(tx.id).map(c=>c.front+'|'+c.back);
                return {names:ds.map(d=>d.name),frames:cs.length,photos:platesOf(ph.id).map(p=>[p.w,p.h]),rect:[c0.x,c0.y,c0.w,c0.h],note:c0.note,extra:(c0.extra||[]).length,text:t,img:/_blob\\//.test(cardsOfDeck(tx.id).find(c=>c.front==='maxilla').bh),svg:/_blob\\//.test(cardsOfDeck(tx.id).find(c=>c.front==='mandibula').bh)};})()""")
            check('Anki import: one photo deck and one text deck', anki['names'] == ['Kolju', 'Kolju — текст'], json.dumps(anki['names']))
            check('Anki import: masks became frames in percent of the photo', anki['frames'] == 4 and anki['rect'] == [10, 20, 20, 10] and anki['extra'] == 0 and anki['note'] == 'Os frontale', json.dumps(anki))
            check('Anki import: photos kept their size and order', anki['photos'] == [[800, 600], [640, 480], [700, 500]], json.dumps(anki['photos']))
            check('Anki import: text cards with the picture moved into storage', sorted(anki['text']) == ['mandibula|alalõualuu', 'maxilla|ülalõualuu', 'os frontale|otsmikuluu'] and anki['img'] and anki['svg'], json.dumps(anki))
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

            # ---------- limits per account (supabase/quota.sql): the database refuses, the app gets clear error codes ----------
            for _ in range(20):   # let the app finish its background saves: the number of stored documents stops changing
                before = len(state()['docs']); await asyncio.sleep(0.7)
                if len(state()['docs']) == before:
                    break
            uid = await pg.evaluate('CORPUS_WEB.uid')
            n_docs = sum(d['owner'] == uid for d in state()['docs']); n_obj = sum(o['owner'] == uid for o in state()['objects'])
            quota_window['on'] = True
            urllib.request.urlopen(API + f'/__quota?docs={n_docs + 1}&photos={n_obj}')
            qa = await pg.evaluate("""(async()=>{
                const db=await claude.use('db'),as=await claude.use('assets'),out={};
                const code=async f=>{try{await f();return 'ok';}catch(e){return e&&e.code||String(e);}};
                out.first=await code(()=>db.doc('qa/one').set({n:1}));
                out.second=await code(()=>db.doc('qa/two').set({n:2}));
                out.photo=await code(()=>as.upload(new Blob([new Uint8Array(100)],{type:'image/png'})));
                await db.doc('qa/one').delete();
                out.again=await code(()=>db.doc('qa/two').set({n:2}));
                await db.doc('qa/two').delete();
                return out;})()""")
            urllib.request.urlopen(API + '/__quota?reset=1&docKb=1')
            qa['big'] = await pg.evaluate("(async()=>{const db=await claude.use('db');try{await db.doc('qa/big').set({p:'x'.repeat(5000)});return 'ok';}catch(e){return e.code;}})()")
            qa['grow'] = await pg.evaluate("(async()=>{const db=await claude.use('db');await db.doc('qa/ok').set({n:1});try{await db.doc('qa/ok').update({p:'x'.repeat(5000)});return 'ok';}catch(e){return e.code;}})()")
            urllib.request.urlopen(API + '/__quota?reset=1')
            quota_window['on'] = False
            await pg.evaluate("(async()=>{const db=await claude.use('db');await db.doc('qa/ok').delete();})()")
            check('limits: a document over the account limit gets quota_exceeded, one that fits is saved', qa['first'] == 'ok' and qa['second'] == 'quota_exceeded' and qa['again'] == 'ok', json.dumps(qa))
            check('limits: a photo over the account limit gets quota_or_state (the app says there is no room)', qa['photo'] == 'quota_or_state', json.dumps(qa))
            check('limits: a document over the size limit is refused, also when it grows by an update', qa['big'] == 'invalid_argument' and qa['grow'] == 'invalid_argument', json.dumps(qa))
            st = state()
            check('limits: refused writes stored nothing and the test documents are gone',
                  sum(d['owner'] == uid for d in st['docs']) == n_docs and sum(o['owner'] == uid for o in st['objects']) == n_obj and not any(d['coll'] == 'qa' for d in st['docs']))

            # account section and sign out
            await pg.evaluate("go({name:'settings'})")
            acc = await pg.inner_text('.page')
            check('settings show the account', 'lev@test.ee' in acc and 'Konto' in acc)
            check("settings show today's AI allowance", f'TI täna: {AI_LIMIT} / {AI_LIMIT}' in acc, [l for l in acc.split('\n') if 'TI' in l][:1])
            await pg.wait_for_selector('#siteStats .stat-grid', timeout=10000)
            st = await pg.inner_text('#siteStats')
            check('admin sees site statistics', 'Saidi statistika' in st and 'kasutajat' in st and 'lev@test.ee' in st and 'viimati täna' in st, st.replace('\n', ' | ')[:200])
            check('site statistics: ranking of people', 'Aktiivsuse edetabel' in st and '1' in st, st.replace('\n', ' | ')[:200])
            d = await pg.evaluate("diffHtml('sulcus praechiamatis','Sulcus praechiasmatis')")
            check('typo diff shows a missing letter as a gap, not as the letter', 'class="gap"' in d and '>_<' in d, d)
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
            check('share link: the folder is offered with its contents and the sender', 'Kolju' in dlg and 'le***@test.ee' in dlg and 'lev@test.ee' not in dlg and 'Jagaja' in dlg, dlg.replace('\n', ' ')[:200])
            await pg.click('#layer [data-s="1"]')
            await pg.wait_for_function('S.plates.length===1 && S.cards.length===2 && S.folders.length===1', timeout=20000)
            check('share link: folder, photo and cards copied', (await pg.evaluate('view.name')) == 'folder')
            check('share link: the code is removed from the address', 's=' not in pg.url, pg.url)
            me = await pg.evaluate('CORPUS_WEB.uid')
            st = await state_when(lambda st: sum(1 for o in st['objects'] if o['owner'] == me) == 1 and any(d['coll'] == 'plates' and d['owner'] == me for d in st['docs']))   # the photo, then its document
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
            # ---------- introduction: a new photo is shown 6 labels at a time before they are learned ----------
            ch = await pg.evaluate("[0,1,2,6,7,13].map(n=>introChunks(Array.from({length:n},(_,i)=>i),INTRO_CHUNK).map(g=>g.length))")
            check('intro: chunks of 6 for 0, 1, 2, 6, 7, 13 labels', ch == [[], [1], [2], [6], [6, 1], [6, 6, 1]], json.dumps(ch))
            plans = await pg.evaluate("""(()=>{const L=(n,old)=>Array.from({length:n},(_,i)=>({id:'x'+i,createdAt:100-i,type:old.indexOf(i)>=0?'review':'new'}));
              const f=p=>p&&{k:p.k,fresh:p.fresh,n:p.ids.length,first:p.ids[0]};
              return [f(introPlan(L(2,[]))),f(introPlan(L(13,[]))),f(introPlan(L(13,[12,11,10,9,8,7]))),f(introPlan(L(13,[0,7]))),f(introPlan(L(13,[12,11]))),f(introPlan(L(4,[0,1,2,3])))];})()""")
            # createdAt runs backwards here, so the first label in order is x12
            check('intro: which chunk is next and whether it is fresh', plans == [None, {'k': 0, 'fresh': True, 'n': 6, 'first': 'x12'}, {'k': 1, 'fresh': True, 'n': 6, 'first': 'x6'},
                  None, {'k': 0, 'fresh': False, 'n': 6, 'first': 'x12'}, None], json.dumps(plans))
            await pg.evaluate("""window.__introDeck=(n,name,old)=>{const p0=S.plates[0];const t0=Date.now();
              const did=newId('decks');S.decks.push({id:did,name:name,newPerDay:100,mode:'hideAll',createdAt:t0});persist('decks',did);
              const pid=newId('plates');S.plates.push({id:pid,deckId:did,assetId:p0.assetId,w:p0.w,h:p0.h,createdAt:t0});persist('plates',pid);
              for(let i=n-1;i>=0;i--){const c=normCard({id:newId('terms'),deckId:did,plateId:pid,term:'pars '+(i+1),note:'osa '+(i+1),x:2+(i%4)*24,y:2+Math.floor(i/4)*20,w:18,h:5,type:'new',createdAt:t0+i});
                if(old&&old.indexOf(i)>=0){c.type='review';c.reps=3;c.ivl=5;c.due=t0+5*86400000;}S.cards.push(c);persist('terms',c.id);}
              return did;};
              window.__srs=did=>JSON.stringify([cardsOfDeck(did).map(c=>Object.keys(c).sort().map(k=>k+'='+JSON.stringify(c[k])).join(',')),deckById(did).newToday||null,S.stats[did]||null]);
              window.__ord=did=>cardsOfDeck(did).slice().sort((a,b)=>a.createdAt-b.createdAt).map(c=>c.id);""")
            check('intro: switched on by default (old settings have no such key)', await pg.evaluate("META.intro===undefined && metaOn('intro')"))
            did = await pg.evaluate("__introDeck(13,'Intro 13')")
            before = await pg.evaluate(f"__srs('{did}')")
            await pg.evaluate(f"go({{name:'home'}});startStudy('{did}')")
            await pg.wait_for_selector('.full.study.intro #panel .intro-nav')
            it = await pg.evaluate(f"(()=>{{const o=__ord('{did}');return {{ids:SS.intro.ids,want:o.slice(0,6),k:SS.intro.k,n:SS.intro.n,shown:document.querySelector('#panel .latin').textContent,open:document.querySelectorAll('#masks .mk.open').length,masks:document.querySelectorAll('#masks .mk').length}};}})()")
            check('intro: a new 13-label photo opens with the first 6 labels in their order', it['ids'] == it['want'] and it['k'] == 0 and it['n'] == 3, json.dumps(it))
            check('intro: the current label is highlighted, its name shown', it['shown'] == 'pars 1' and it['open'] == 1 and it['masks'] == 13, json.dumps(it))
            title = (await pg.inner_text('#introTitle')).replace('\n', ' ')
            check('intro: translated, says which part and label', 'Tutvumine' in title and '1/3' in title and '1/6' in title, title)
            await pg.click('[data-act=introNext]')
            await pg.click('[data-act=introNext]')
            await pg.keyboard.press('ArrowLeft')
            step = await pg.evaluate("[SS.intro.i,document.querySelector('#panel .latin').textContent,document.querySelector('#panel .anote').textContent,document.querySelectorAll('#masks .mk.peek').length]")
            check('intro: Next / Back (button and arrow key) move between labels; seen ones stay visible', step == [1, 'pars 2', 'osa 2', 1], json.dumps(step))
            for _ in range(4):
                await pg.keyboard.press('ArrowRight')
            last = await pg.inner_text('[data-act=introNext]')
            check('intro: the last label offers to learn them', 'Õpi need sildid' in last, last)
            check('intro: looking through labels writes nothing to the schedule', await pg.evaluate(f"__srs('{did}')") == before and await pg.evaluate('SS.done===0'))
            await pg.click('[data-act=introNext]')
            await pg.wait_for_selector('.full.study:not(.intro) #panel')
            st1 = await pg.evaluate(f"(()=>{{const c=cardById(SS.cur);return {{intro:!!SS.intro,inChunk:__ord('{did}').slice(0,6).indexOf(SS.cur)>=0,type:c.type,reps:c.reps}};}})()")
            check('intro: learning of these 6 starts right away, as a brand-new card', st1 == {'intro': False, 'inChunk': True, 'type': 'new', 'reps': 0}, json.dumps(st1))
            newSeen = []
            for _ in range(40):
                if await pg.evaluate('!!SS.intro || !SS.cur'):
                    break
                cur = await pg.evaluate("(()=>{const c=cardById(SS.cur);return c.type==='new'?c.id:null;})()")
                if cur:
                    newSeen.append(cur)
                await pg.evaluate('doReveal();rate(3)')
                await asyncio.sleep(0.3)
            first6 = await pg.evaluate(f"__ord('{did}').slice(0,6)")
            it2 = await pg.evaluate(f"SS.intro&&{{k:SS.intro.k,ids:SS.intro.ids,want:__ord('{did}').slice(6,12)}}")
            check('intro: exactly those 6 new labels were learned, then the next part is introduced',
                  sorted(newSeen) == sorted(first6) and it2 and it2['k'] == 1 and it2['ids'] == it2['want'], json.dumps([newSeen, it2]))
            check('intro: learned labels went through the usual schedule', await pg.evaluate(f"__ord('{did}').slice(0,6).every(id=>{{const c=cardById(id);return c.type!=='new'&&c.reps===1;}}) && deckById('{did}').newToday.count===6"))
            # leave in the middle of an introduction, come back: the same part starts from its first label
            await pg.click('[data-act=introNext]')
            await pg.click('[data-act=introNext]')
            mid = await pg.evaluate(f"__srs('{did}')")
            await pg.click('[data-act=studyExit]')
            await pg.evaluate(f"startStudy('{did}')")
            await pg.wait_for_selector('.full.study.intro')
            back = await pg.evaluate('[SS.intro.k,SS.intro.i]')
            check('intro: interrupted half-way → back at the start of the same part', back == [1, 0] and await pg.evaluate(f"__srs('{did}')") == mid, json.dumps(back))
            await pg.click('[data-act=introSkip]')
            await pg.wait_for_selector('.full.study:not(.intro) #panel')
            sk = await pg.evaluate(f"(()=>{{const c=cardById(SS.cur);return {{inChunk:__ord('{did}').slice(6,12).indexOf(SS.cur)>=0,type:c.type,same:__srs('{did}')==={json.dumps(mid)}}};}})()")
            check('intro: «Skip» goes straight to learning this part, nothing written', sk == {'inChunk': True, 'type': 'new', 'same': True}, json.dumps(sk))
            skipText = await pg.evaluate("document.querySelector('#app .intro')===null")
            check('intro: no introduction screen left behind', skipText)
            await pg.click('[data-act=studyExit]')
            # introduction on request: the small button on the deck, even though the labels are no longer new
            await pg.evaluate(f"go({{name:'deck',deckId:'{did}'}})")
            await pg.wait_for_selector('[data-act=introAgain]')
            before = await pg.evaluate(f"__srs('{did}')")
            await pg.click('[data-act=introAgain]')
            await pg.wait_for_selector('.full.study.intro #panel')
            ir = await pg.evaluate("({n:SS.intro.ids.length,review:!!SS.intro.review,parts:SS.intro.n})")
            check('intro on request: a button on the deck opens the first part', ir['review'] and ir['n'] == 6 and ir['parts'] == 3, json.dumps(ir))
            for _ in range(6):
                await pg.click('[data-act=introNext]')
            await pg.wait_for_function('SS.intro && SS.intro.k===1')
            for _ in range(7):
                await pg.click('[data-act=introNext]')
            await pg.wait_for_function('!SS.intro')
            await pg.wait_for_selector('.tabs')
            check('intro on request: ends back at the deck, nothing written', await pg.evaluate("view.name==='deck'") and await pg.evaluate(f"__srs('{did}')") == before)
            # small photos, old progress, the switch
            did2 = await pg.evaluate("__introDeck(2,'Intro 2')")
            await pg.evaluate(f"startStudy('{did2}')")
            await pg.wait_for_selector('.full.study #panel')
            check('intro: a photo with 2 labels is learned straight away', await pg.evaluate('!SS.intro && !!SS.cur'))
            await pg.click('[data-act=studyExit]')
            did3 = await pg.evaluate("__introDeck(13,'Intro old',[2,9])")
            await pg.evaluate(f"startStudy('{did3}')")
            await pg.wait_for_selector('.full.study #panel')
            check('intro: a photo with earlier progress is learned as before, no introduction', await pg.evaluate('!SS.intro && !!SS.cur'))
            await pg.click('[data-act=studyExit]')
            await pg.evaluate("go({name:'settings'})")
            await pg.click('[data-act=tgl][data-k=intro]')
            check('intro: switch in settings (translated), saved off', await pg.evaluate("META.intro===false") and 'Tutvumine enne õppimist' in await pg.inner_text('#app'))
            await state_when(lambda st: any(d['coll'] == 'meta' and d['id'] == 'settings' and d['data'].get('intro') is False for d in st['docs']))
            did4 = await pg.evaluate("__introDeck(8,'Intro off')")
            await pg.evaluate(f"startStudy('{did4}')")
            await pg.wait_for_selector('.full.study #panel')
            check('intro: switched off → new photos are learned straight away', await pg.evaluate('!SS.intro && !!SS.cur'))
            await pg.click('[data-act=studyExit]')
            await pg.reload()
            await app_ready(pg)
            check('intro: the switch is remembered after a reload', await pg.evaluate("META.intro===false && !metaOn('intro')"))
            await pg.evaluate("META.intro=true;persistMeta()")

            urllib.request.urlopen(API + '/__fn?off=0')
            errs_b = list(errs)
            # ---------- summary after a study session: answers, accuracy, the cards missed, review them, back to home ----------
            did_s = await pg.evaluate("""(()=>{const p0=S.plates[0],t0=Date.now(),did=newId('decks');
              S.decks.push({id:did,name:'Kokkuvõte',newPerDay:100,mode:'hideAll',createdAt:t0});persist('decks',did);
              const pid=newId('plates');S.plates.push({id:pid,deckId:did,assetId:p0.assetId,w:p0.w,h:p0.h,createdAt:t0});persist('plates',pid);
              for(let i=1;i>=0;i--){const c=normCard({id:newId('terms'),deckId:did,plateId:pid,term:'pars '+(i+1),note:'osa '+(i+1),x:2+i*24,y:2,w:18,h:5,type:'new',createdAt:t0+i});S.cards.push(c);persist('terms',c.id);}
              return did;})()""")
            await pg.evaluate(f"startStudy('{did_s}')")
            await pg.wait_for_selector('.full.study')
            for n in range(8):   # the first answer is wrong ("again"), every later one is "easy", until the queue is empty
                if not await pg.evaluate('!!SS.cur'):
                    break
                await pg.evaluate('doReveal()')
                await pg.wait_for_function("SS.phase==='answer'", timeout=5000)
                await pg.evaluate(f'rate({1 if n == 0 else 4})')
                await asyncio.sleep(0.4)
            await pg.wait_for_selector('.donebox .sumrow', timeout=10000)
            tiles = await pg.eval_on_selector_all('.sumc', 'els => els.map(e => e.innerText.replace(/\\s+/g, " ").trim())')
            check('summary: 3 answers, 67% correct (one wrong, two easy)', len(tiles) >= 2 and tiles[0].startswith('3 ') and tiles[1].startswith('67%'), json.dumps(tiles, ensure_ascii=False))
            hard = await pg.eval_on_selector_all('.sumhard li', 'els => els.map(e => e.innerText.replace(/\\s+/g, " ").trim())')
            check('summary: the missed card is listed once with how often', len(hard) == 1 and hard[0].endswith('×1'), json.dumps(hard, ensure_ascii=False))
            btns = await pg.eval_on_selector_all('.done-btns button', 'els => els.map(e => e.innerText.trim())')
            check('summary: buttons are translated (review difficult cards, back to home)', 'Korda rasked kaarte' in btns and 'Avalehele' in btns, json.dumps(btns, ensure_ascii=False))
            before = await pg.evaluate(f"JSON.stringify(cardsOfDeck('{did_s}').map(c=>[c.id,c.type,c.reps,c.due,c.ivl,c.ease,c.step,c.lapses]))")
            await pg.click('[data-act=sessHard]')
            await pg.wait_for_selector('.full.study')
            check('summary: «review difficult cards» starts a practice session on exactly that card', await pg.evaluate('SS.cram===true && SS.cramQueue.length+(SS.cur?1:0)===1'))
            await pg.evaluate('doReveal()')
            await pg.wait_for_function("SS.phase==='answer'", timeout=5000)
            await pg.evaluate('rate(3)')
            await pg.wait_for_selector('.donebox .sumrow', timeout=10000)
            check('summary: practice does not touch the schedule', await pg.evaluate(f"JSON.stringify(cardsOfDeck('{did_s}').map(c=>[c.id,c.type,c.reps,c.due,c.ivl,c.ease,c.step,c.lapses]))") == before)
            check('summary: nothing missed → no «review» button', not await pg.query_selector('[data-act=sessHard]'))
            await pg.click('[data-act=studyHome]')
            await pg.wait_for_function("view.name==='home'", timeout=5000)
            check('summary: «back to home» leads to the home screen', True)
            check('summary: a session without answers shows no summary', await pg.evaluate("(()=>{const o=SS;SS={log:[],deckIds:[]};const r=sessSummary();SS=o;return r.html===''&&r.hard===0;})()"))

            # ---------- a course in another language: translated once by the AI, kept on the photo, shown in the reader's language ----------
            await pg.reload()   # the AI function is back (see above): this page gets it
            await app_ready(pg)
            calls = watch_ai(pg)
            n_err = len(errs)
            me = await pg.evaluate('CORPUS_WEB.uid')
            objs0 = sum(1 for o in state()['objects'] if o['owner'] == me)
            check('translation: the friend has the AI again and has used nothing today', await pg.evaluate('!!S.sample && !!CORPUS_WEB.ai && CORPUS_WEB.ai.used===0'), await pg.evaluate('JSON.stringify(CORPUS_WEB.ai)'))
            await import_file('corpus-folder-ru.json', 1)
            pid = await pg.evaluate("S.plates.find(p=>p.title==='Лобная и верхняя челюсть').id")
            fid_r = await pg.evaluate("S.folders.find(f=>f.name==='Urok RU').id")
            did_r = await pg.evaluate("S.decks.find(d=>d.name==='Urok RU').id")
            cids = await pg.evaluate(f"cardsOfPlate('{pid}').map(c=>c.id)")
            check('translation: importing a course in another language asks the AI for nothing; the language of the file is kept',
                  len(calls) == 0 and await pg.evaluate(f"plateById('{pid}').lang") == 'ru' and len(cids) == 4)
            row_r = f'.crs.chome .clrow[data-pid="{pid}"]'

            # on the course home the lesson of «Continue» is translated quietly
            await pg.evaluate(f"go({{name:'courses',fid:'{fid_r}'}})")
            await pg.wait_for_selector('.crs.chome .ccta')
            await pg.wait_for_function(f"!!(plateById('{pid}').tr&&plateById('{pid}').tr.et)", timeout=20000)
            check('course home: the «Continue» lesson is translated in the background, one request, nothing on screen about it', len(calls) == 1 and await pg.evaluate("view.name==='courses'") and not await pg.query_selector('.ctrbusy'))
            msg = calls[0]['messages'][0]['content']
            check('translation request: JSON mode, for the course purpose, Russian into Estonian, the dictionary kinds are not sent, the unknown one is',
                  calls[0].get('purpose') == 'course' and calls[0].get('json') is True and calls[0].get('max_tokens') == 4096 and len(calls[0]['messages']) == 1 and msg.startswith('CORPUS-TRANSLATE ru>et\n') and '"sooned"' in msg and '"luu"' not in msg and '"ava"' not in msg and '\nINPUT:\n{' in msg)
            tr = await pg.evaluate(f"JSON.parse(JSON.stringify(plateById('{pid}').tr.et))")
            notes = {c: tr['notes'][c] for c in tr['notes']}
            ids_note = {}
            for c in cids:
                ids_note[c] = await pg.evaluate(f"cardById('{c}').note")
            check('translation kept on the photo: title, intro, questions, one table of terms, notes by card id, kinds',
                  tr['title'] == '[et] Лобная и верхняя челюсть' and tr['intro'] == ['[et] Это <b>лобная</b> кость.', ATK] and tr['q'] == ['[et] Как называется верхняя челюсть?', '[et] Какая кость образует лоб?']
                  and set(tr['notes']) == set(cids) and sorted(tr['notes'].values()).count(ATK) == 1 and all(v == '[et] ' + ids_note[c] for c, v in notes.items() if v != ATK)
                  and len(tr['terms']) == 8 and tr['terms']['лобная кость'] == '[et] лобная кость' and tr['terms']['maxilla'] == '[et] maxilla' and tr['kinds'] == {'sooned': '[et] sooned'} and tr['at'] > 0,
                  json.dumps(tr, ensure_ascii=False)[:300])

            # the lesson opens in Estonian at once (already translated)
            await pg.click('.crs.chome .ccta')
            await pg.wait_for_selector('.clesson .kbubble')
            ov = await pg.evaluate("""({t:document.querySelector('.kbubble').innerText,b:document.querySelector('.kbubble b')&&document.querySelector('.kbubble b').textContent,from:document.querySelector('.ctrfrom').innerText,
              title:document.querySelector('#cttl').textContent,tog:!document.querySelector('#ctog').hidden,code:document.querySelector('#ctog').textContent,lab:document.querySelector('#ctog').getAttribute('aria-label'),
              pressed:document.querySelector('#ctog').getAttribute('aria-pressed'),ctrs:document.querySelector('#ctrs').textContent})""")
            check('translated lesson: overview in Estonian with the bold word kept, «Tõlgitud vene keelest», translated title, the button with the original language (RU)',
                  ov['t'] == '[et] Это лобная кость.' and ov['b'] == 'лобная' and ov['from'] == 'Tõlgitud vene keelest' and ov['title'] == '[et] Лобная и верхняя челюсть' and ov['tog'] and ov['code'] == 'RU'
                  and ov['lab'] == 'Näita originaali' and ov['pressed'] == 'false' and ov['ctrs'] == '' and len(calls) == 1, json.dumps(ov, ensure_ascii=False))
            await pg.click('#ctog')
            og = await pg.evaluate("({t:document.querySelector('.kbubble').innerText,from:!!document.querySelector('.ctrfrom'),title:document.querySelector('#cttl').textContent,pressed:document.querySelector('#ctog').getAttribute('aria-pressed'),orig:CL.orig})")
            check('the RU button shows the original: Russian text, no «translated» line, Russian title', og == {'t': 'Это лобная кость.', 'from': False, 'title': 'Лобная и верхняя челюсть', 'pressed': 'true', 'orig': True}, json.dumps(og, ensure_ascii=False))
            await pg.click('#ctog')
            check('…and back to the translation', (await pg.inner_text('.kbubble')) == '[et] Это лобная кость.' and await pg.evaluate('CL.orig===false'))
            await pg.click('#cnx')
            x = await pg.evaluate("({t:document.querySelector('.kbubble').textContent,img:document.querySelectorAll('.kbubble img,#cpanel img').length,xss:window.__xss===undefined})")
            check('an answer of the AI with a tag in it stays text in the overview (no element, no script)', x == {'t': ATK, 'img': 0, 'xss': True}, json.dumps(x))
            await pg.click('#cnx')
            await pg.wait_for_selector('.cterm')
            seen = []
            for k in range(4):
                seen.append(await pg.evaluate("({term:document.querySelector('.cterm').textContent,note:document.querySelector('.cnote').textContent,meta:document.querySelector('.meta').innerText,img:document.querySelectorAll('#cpanel img').length})"))
                if k < 3:
                    await pg.click('#cnx')
            want = [('os frontale', '[et] Лобная кость (os frontale) образует лоб.', 'luu', 'Kolju tervikuna'), ('maxilla', ATK, 'luu', 'Ossa cranii'),
                    ('foramen magnum', '[et] Большое затылочное отверстие (foramen magnum).', 'ava / kanal', 'praktikumi pilt'), ('sulcus sagittalis', '[et] Борозда (sulcus sagittalis) по средней линии.', '[et] sooned', 'Kolju tervikuna')]
            check('get to know: Latin names stay, notes in Estonian, kinds and sources from the dictionary (Estonian), the kind the dictionary lacks from the translation; a tag stays text',
                  all(a['term'] == w[0] and a['note'] == w[1] and w[2] in a['meta'] and w[3] in a['meta'] and a['img'] == 0 for a, w in zip(seen, want)) and await pg.evaluate('window.__xss===undefined'), json.dumps(seen, ensure_ascii=False))
            await pg.click('#ctog')
            og = await pg.evaluate("({note:document.querySelector('.cnote').textContent,meta:document.querySelector('.meta .chip').textContent,i:CL.st.i})")
            await pg.click('#ctog')
            check('the RU button on a step shows the original note and kind and keeps the place', og == {'note': 'Борозда (sulcus sagittalis) по средней линии.', 'meta': 'sooned', 'i': 3}, json.dumps(og, ensure_ascii=False))
            await pg.click('#cnx')
            await pg.wait_for_selector('.copt')
            # practice: the note after the answer is the translation; the button keeps the answer and the score
            term = await pg.evaluate('CL.st.q[CL.st.i].term')
            await pg.click(f'.copt >> text="{term}"')
            fb = await pg.evaluate("(()=>{const it=CL.st.q[CL.st.i],t=crT(plateById(CL.pid));return {note:document.querySelector('#cfb .cnote').textContent,want:t.notes[it.id],ok:CL.st.ok};})()")
            check('practice: the note after the answer is the translated one', fb['note'] == fb['want'] and fb['ok'] == 1, json.dumps(fb, ensure_ascii=False))
            await pg.click('#ctog')
            fb2 = await pg.evaluate("({note:document.querySelector('#cfb .cnote').textContent,ok:CL.st.ok,okBtn:document.querySelectorAll('.copt.ok').length,verdict:document.querySelectorAll('.cverdict.ok').length})")
            await pg.click('#ctog')
            fb3 = await pg.evaluate("({ok:CL.st.ok,okBtn:document.querySelectorAll('.copt.ok').length})")
            check('practice: the RU button mid-question shows the original note, keeps the answer given and does not count it twice',
                  fb2['note'] != fb['note'] and fb2['note'] == await pg.evaluate("cardById(CL.st.q[CL.st.i].id).note") and fb2['ok'] == 1 and fb2['okBtn'] == 1 and fb2['verdict'] == 1 and fb3 == {'ok': 1, 'okBtn': 1}, json.dumps([fb2, fb3], ensure_ascii=False))
            for _ in range(4):
                if await pg.query_selector('.cdone'):
                    break
                if not await pg.query_selector('#cnx'):
                    await pg.click('.copt >> nth=0')
                await pg.click('#cnx')
            await pg.wait_for_selector('.cdone')
            await pg.click('#cnx')
            await pg.wait_for_selector('#chint')
            await pg.click('#chint')
            hb = await pg.evaluate("(()=>{const it=CL.st.q[CL.st.i],n=crT(plateById(CL.pid)).notes[it.id];return {box:document.querySelector('.hintbox').textContent,want:n.split(it.term).join('…')};})()")
            check('recall: the hint masks the term in the translated note', hb['want'] in hb['box'] and (hb['want'] == ATK or '…' in hb['box']), json.dumps(hb, ensure_ascii=False))
            await pg.click('.cseg [data-s=se]')
            await pg.wait_for_selector('.cq')
            rights = []
            for k in range(2):
                q = await pg.evaluate("CL.st.q[CL.st.i]")
                shown = await pg.evaluate("({q:document.querySelector('.cq').textContent,opts:[...document.querySelectorAll('.copt')].map(b=>b.textContent).sort(),chip:document.querySelector('.meta').innerText})")
                want_q = tr['q'][0] if q['q'].startswith('Как называется') else tr['q'][1]
                want_o = sorted(tr['terms'][o] for o in [q['ans']] + q['opts'])
                rights.append(shown['q'] == want_q and shown['opts'] == want_o)
                if k == 0:
                    await pg.click(f'.copt >> text="{tr["terms"][q["ans"]]}"')
                    ok1 = await pg.evaluate("({ok:document.querySelectorAll('.cverdict.ok').length,green:document.querySelectorAll('.copt.ok').length,n:CL.st.ok})")
                    await pg.click('#ctog')
                    ok2 = await pg.evaluate("({q:document.querySelector('.cq').textContent,ok:document.querySelectorAll('.cverdict.ok').length,green:document.querySelectorAll('.copt.ok').length,n:CL.st.ok,opts:[...document.querySelectorAll('.copt')].map(b=>b.textContent).sort()})")
                    await pg.click('#ctog')
                    rights.append(ok1 == {'ok': 1, 'green': 1, 'n': 1} and ok2['q'] == q['q'] and ok2['ok'] == 1 and ok2['green'] == 1 and ok2['n'] == 1 and ok2['opts'] == sorted([q['ans']] + q['opts']))
                else:
                    wrong = await pg.evaluate("(()=>{const l=CL.st.q[CL.st.i],t=crT(plateById(CL.pid));return t.terms[l.opts[0]];})()")
                    await pg.click(f'.copt >> text="{wrong}"')
                    rights.append(await pg.locator('.copt.no').count() == 1 and await pg.locator('.copt.ok').count() == 1 and bool(await pg.query_selector('.cverdict.no')))
                await pg.click('#cnx')
            check('connect: the question and the options are shown through the translation, the right translated option counts, the original shows the same screen; a wrong one is marked', all(rights), json.dumps(rights))
            await pg.wait_for_selector('.cdone')
            check('connect: result 1 / 2 (the right one counted once)', '1 / 2' in await pg.inner_text('.cdone b'))
            check('all of this took one request', len(calls) == 1)
            await pg.click('#cnx')
            await pg.wait_for_selector('.crs.chome')

            # opened for the first time (no translation yet): the panel says so, the photo is in place, the steps wait; then the lesson shows the translation at its step
            await pg.evaluate(f"delete plateById('{pid}').tr")

            urllib.request.urlopen(API + '/__fn?delay=1500')   # the function answers 1.5 s late
            await pg.click(row_r)
            await pg.wait_for_selector('.ctrbusy')
            bz = await pg.evaluate("({txt:document.querySelector('.ctrbusy').innerText,photo:!!document.querySelector('#simg'),bubble:!!document.querySelector('.kbubble'),step:CL.step,ctrs:document.querySelector('#ctrs').textContent})")
            await pg.click('.cseg [data-s=tu]')
            bz2 = await pg.evaluate("({busy:!!document.querySelector('.ctrbusy'),step:CL.step,term:!!document.querySelector('.cterm'),tab:document.querySelector('.cseg .on').dataset.s})")
            check('first opening: «Tõlgin õppetundi…» with the photo in place; the steps wait (a click on «Tutvumine» does not leave the wait)',
                  bz['txt'] == 'Tõlgin õppetundi…' and bz['photo'] and not bz['bubble'] and bz['ctrs'] == '' and bz2 == {'busy': True, 'step': 'tu', 'term': False, 'tab': 'tu'}, json.dumps([bz, bz2], ensure_ascii=False))
            await pg.wait_for_selector('.cterm', timeout=15000)
            urllib.request.urlopen(API + '/__fn?off=0')
            tn = await pg.evaluate("({note:document.querySelector('.cnote').textContent,busy:!!document.querySelector('.ctrbusy'),step:CL.step})")
            check('…when the translation arrives the step the reader chose is shown, translated; one more request, kept on the photo',
                  tn['note'] == '[et] Лобная кость (os frontale) образует лоб.' and not tn['busy'] and tn['step'] == 'tu' and len(calls) == 2 and await pg.evaluate(f"!!plateById('{pid}').tr.et"), json.dumps([tn, len(calls)], ensure_ascii=False))
            await pg.click('[data-act=crBack]')
            await pg.wait_for_selector('.crs.chome')

            # a study session over the same cards shows the translated note, also in the introduction of the photo
            await pg.evaluate(f"startStudy('{did_r}')")
            await pg.wait_for_selector('.full.study.intro #panel .intro-nav', timeout=10000)
            n1 = await pg.evaluate("(()=>{const id=SS.intro.ids[SS.intro.i],el=document.querySelector('#panel .anote');return {t:el&&el.textContent,want:crT(plateById(cardById(id).plateId)).notes[id],raw:cardById(id).note,img:document.querySelectorAll('#panel .anote img').length};})()")
            await pg.click('[data-act=introSkip]')
            await pg.wait_for_selector('.full.study:not(.intro) #panel')
            await pg.evaluate('doReveal()')
            await pg.wait_for_function("SS.phase==='answer'", timeout=5000)
            n2 = await pg.evaluate("(()=>{const id=SS.cur,el=document.querySelector('#panel .anote');return {t:el&&el.textContent,want:crT(plateById(cardById(id).plateId)).notes[id],raw:cardById(id).note,img:document.querySelectorAll('#panel .anote img').length};})()")
            check('study session: the note under the answer is the translated one (in the introduction and in the question); a tag in it stays text',
                  all(n['t'] == n['want'] and n['t'] != n['raw'] and n['img'] == 0 for n in (n1, n2)) and await pg.evaluate('window.__xss===undefined'), json.dumps([n1, n2], ensure_ascii=False))
            await pg.click('[data-act=studyExit]')
            check('study session: a card that is not in a translated lesson keeps its own note', await pg.evaluate("crNoteOf({note:'Märkus',plateId:S.plates[0].id})==='Märkus' && crNoteOf({note:'x'})==='x' && crNoteOf({})===''"))

            # export and import: the language and the translation travel; the notes follow the new card ids; junk in the file is dropped
            exp = await pg.evaluate(f"buildExport(['{did_r}']).then(r=>JSON.parse(JSON.stringify(r.out)))")
            ep = exp['plates'][0]
            check('export carries the language and the translation, the notes keyed by the exported card ids',
                  ep.get('lang') == 'ru' and list(ep.get('tr', {})) == ['et'] and set(ep['tr']['et']['notes']) == {c['id'] for c in exp['cards']} and ep['tr']['et']['title'] == tr['title'])
            ep['lang'] = 'xx'
            ep['tr']['xx'] = {'title': 'x'}
            ep['tr']['en'] = {'title': 7, 'intro': 'x', 'terms': ['a'], 'notes': {'c': 5}, 'kinds': None}
            ep['tr']['et']['title'] = 'T' * 500
            ep['tr']['et']['notes']['nope'] = 'a note of nobody'
            ep['tr']['et']['terms']['__proto__'] = 'polluted'
            ep['tr']['et']['terms']['x' * 400] = 'a key that is too long'
            ep['tr']['et']['kinds']['k' * 30] = 'a kind that is too long'
            (tmp / 'corpus-deck-ru2.json').write_text(json.dumps(exp))
            await import_file('corpus-deck-ru2.json', 1)
            res = await pg.evaluate(f"""(()=>{{const p=S.plates.find(p=>p.id!=='{pid}'&&p.title==='Лобная и верхняя челюсть');const cs=cardsOfPlate(p.id).map(c=>c.id).sort().join();const t=p.tr.et;
              return {{id:p.id,lang:p.lang||null,src:crSrcLang(p),langs:Object.keys(p.tr),title:t.title.length,notes:Object.keys(t.notes).sort().join()===cs,n:Object.keys(t.notes).length,
                proto:Object.getPrototypeOf(t.terms)===null&&Object.getPrototypeOf(p.tr)===null,pol:Object.keys(t.terms).includes('__proto__'),longk:Object.keys(t.terms).some(k=>k.length>300),kinds:Object.keys(t.kinds),
                oldids:Object.keys(t.notes).some(k=>{json.dumps(cids)}.includes(k))}};}})()""")
            check('import: the language of the file is kept only if it is ru/en/et (else not set: the text is guessed each time, Russian here), only ru/en/et translations, limits applied, notes follow the new card ids, objects without a prototype, junk dropped',
                  res['lang'] is None and res['src'] == 'ru' and res['langs'] == ['et'] and res['title'] == 200 and res['notes'] and res['n'] == 4 and res['proto'] and not res['pol'] and not res['longk'] and res['kinds'] == ['sooned'] and not res['oldids'], json.dumps(res))
            pid2 = res['id']
            did2 = await pg.evaluate(f"plateById('{pid2}').deckId")
            await pg.evaluate(f"go({{name:'deck',deckId:'{did2}',tab:'photos'}})")
            await pg.click('[data-act=lesson]')
            await pg.wait_for_selector('.clesson .kbubble')
            await pg.click('#cnx'); await pg.click('#cnx')
            await pg.wait_for_selector('.cterm')
            ni = await pg.evaluate("({term:document.querySelector('.cterm').textContent,note:document.querySelector('.cnote').textContent,busy:CL.busy})")
            check('imported lesson opens translated at once (the notes found their cards), no request', ni['term'] == 'os frontale' and ni['note'] == '[et] Лобная кость (os frontale) образует лоб.' and not ni['busy'] and len(calls) == 2, json.dumps(ni, ensure_ascii=False))
            await pg.click('[data-act=crBack]')

            # the translation is saved: after a reload the lesson opens translated, nothing is asked
            await pg.wait_for_function('WQ.jobs.size===0', timeout=20000)
            await pg.reload()
            await app_ready(pg)
            await pg.evaluate(f"go({{name:'deck',deckId:'{did_r}',tab:'photos'}})")
            await pg.click('[data-act=lesson]')
            await pg.wait_for_selector('.clesson .kbubble')
            check('after a reload the translated lesson opens at once, without a request', (await pg.inner_text('.kbubble')) == '[et] Это лобная кость.' and len(calls) == 2 and await pg.evaluate("CL.busy===false"))
            await pg.click('[data-act=crBack]')

            # English reader: the AI function does not answer → the lesson in Russian, a quiet note and «Retry»; then it works again
            await ui_lang(pg, 'en')
            urllib.request.urlopen(API + '/__fn?off=1')
            await pg.evaluate(f"go({{name:'deck',deckId:'{did_r}',tab:'photos'}})")
            await pg.click('[data-act=lesson]')
            await pg.wait_for_selector('.clesson .kbubble')
            await pg.wait_for_function("document.querySelector('#ctrs').textContent.includes('Translation unavailable')", timeout=15000)
            fl = await pg.evaluate("({bubble:document.querySelector('.kbubble').innerText,retry:!!document.querySelector('#ctrRetry'),retryText:document.querySelector('#ctrRetry')&&document.querySelector('#ctrRetry').textContent,tog:!document.querySelector('#ctog').hidden,err:CL.trErr})")
            check('English reader, the AI function is down: the lesson stays Russian, «Translation unavailable» and «Retry», no switch', fl == {'bubble': 'Это лобная кость.', 'retry': True, 'retryText': 'Retry', 'tog': False, 'err': 'unavailable'} and len(calls) == 3, json.dumps(fl, ensure_ascii=False))
            await pg.click('[data-act=crBack]')
            await pg.click('[data-act=lesson]')
            await pg.wait_for_selector('.clesson .kbubble')
            check('a failed lesson is not sent again by reopening it: the note and «Retry» are there at once, no request', len(calls) == 3 and await pg.evaluate("!!document.querySelector('#ctrRetry')"))
            urllib.request.urlopen(API + '/__fn?off=0')
            await pg.click('#ctrRetry')
            await pg.wait_for_function("document.querySelector('.kbubble')&&document.querySelector('.kbubble').innerText.startsWith('[en] ')", timeout=20000)
            en = await pg.evaluate("({t:document.querySelector('.kbubble').innerText,from:document.querySelector('.ctrfrom').innerText,ctrs:document.querySelector('#ctrs').textContent,lab:document.querySelector('#ctog').getAttribute('aria-label'),used:CORPUS_WEB.ai.used})")
            check('«Retry» asks again and shows the English translation; the counter counts the requests that were answered (3)',
                  en == {'t': '[en] Это лобная кость.', 'from': 'Translated from Russian', 'ctrs': '', 'lab': 'Show original', 'used': 3} and len(calls) == 4, json.dumps(en, ensure_ascii=False))
            await pg.click('#cnx'); await pg.click('#cnx')
            await pg.wait_for_selector('.cterm')
            em = await pg.evaluate("document.querySelector('.meta').innerText")
            check('English reader: kind and source from the English dictionary', 'bone' in em and 'The skull as a whole' in em, em)
            await pg.click('[data-act=crBack]')

            # Russian reader: the lesson is in Russian, nothing to translate; the tr.et stays on the photo for Estonian readers
            await ui_lang(pg, 'ru')
            await pg.evaluate(f"go({{name:'deck',deckId:'{did_r}',tab:'photos'}})")
            await pg.click('[data-act=lesson]')
            await pg.wait_for_selector('.clesson .kbubble')
            check('Russian reader: the lesson is shown as it is, no switch, no request', await pg.evaluate("document.querySelector('#ctog').hidden&&CL.trErr===null&&!CL.busy") and (await pg.inner_text('.kbubble')) == 'Это лобная кость.' and len(calls) == 4)
            await pg.click('[data-act=crBack]')
            await ui_lang(pg, 'et')
            check('translation scenario: no script errors or failed requests of its own', len(errs) == n_err, '; '.join(errs[n_err:])[:300])

            # clean up (both photos with their translations), so the counts in the later scenarios stay as they were
            await pg.evaluate("""(()=>{const ds=S.decks.filter(d=>d.name.startsWith('Urok')),ids=new Set(ds.map(d=>d.id));
              S.cards.filter(c=>ids.has(c.deckId)).forEach(c=>removeCard(c.id));S.plates.filter(p=>ids.has(p.deckId)).forEach(p=>dropPlate(p));
              ds.forEach(d=>{S.decks=S.decks.filter(x=>x.id!==d.id);removeDoc('decks',d.id);});
              S.folders.filter(f=>f.name.startsWith('Urok')).forEach(f=>{S.folders=S.folders.filter(x=>x.id!==f.id);removeDoc('folders',f.id);});delete META.coursePrio;delete META.courseLast;persistMeta();})()""")
            await pg.wait_for_function('WQ.jobs.size===0', timeout=20000)
            st = await state_when(lambda st: sum(1 for o in st['objects'] if o['owner'] == me) == objs0)
            check('translation scenario cleaned up: the photos are gone from Storage', sum(1 for o in st['objects'] if o['owner'] == me) == objs0)

            await ctx.close()

            # ---------- translation of a course, the hard cases: a lesson in several requests, a partial answer, refusals, a failed try is remembered, one request at a time, no AI for a guest ----------
            # (a new account: the friend's allowance of AI requests (6 a day) is used up by now; this one has six for what follows: 3 + 1 + 1 + 1)
            urllib.request.urlopen(API + '/__fn')   # every mode of the fake Claude is off
            ctx, pg, errs = await open_ctx()
            await pg.goto(SITE + '?i=' + INVITE)
            await pg.wait_for_selector('.cw-auth .cw-tabs .on')
            await pg.fill('input[name=email]', 'trans@test.ee')
            await pg.fill('input[name=password]', 'kolju2026')
            await pg.click('.cw-go')
            await app_ready(pg)
            n_err = len(errs)
            me_t = await pg.evaluate('CORPUS_WEB.uid')
            calls = watch_ai(pg)
            ev = []   # 'req' / 'res' for every request to the AI function, in the order they happen
            pg.on('request', lambda r: '/functions/v1/corpus-ai' in r.url and r.method == 'POST' and ev.append('req'))
            pg.on('response', lambda r: '/functions/v1/corpus-ai' in r.url and r.request.method == 'POST' and ev.append('res'))
            check('hard cases: the new account has its AI allowance', await pg.evaluate(f'!!S.sample && CORPUS_WEB.ai.limit==={AI_LIMIT} && CORPUS_WEB.ai.used===0'))
            await import_file('corpus-folder-ru.json', 1)
            await import_file('corpus-folder-big.json', 1)
            ids = await pg.evaluate("""({ru:S.plates.find(p=>p.title==='Лобная и верхняя челюсть').id,rf:S.folders.find(f=>f.name==='Urok RU').id,
              big:S.plates.find(p=>p.title==='Большой урок').id,bf:S.folders.find(f=>f.name==='Urok BIG').id})""")
            ru_pid, ru_fid, big_pid, big_fid = ids['ru'], ids['rf'], ids['big'], ids['bf']

            def J(code):
                return code.replace('@RU@', ru_pid).replace('@BIG@', big_pid)

            async def reset_ru(extra=''):
                """The small lesson as if it had never been translated: no translation, no memory of a failure, no lock, the allowance as the page knew it at the start."""
                await pg.evaluate(J("""(()=>{const p=plateById('@RU@');delete p.tr;persist('plates',p.id);CR_TRERR.clear();delete META.courseLast;
                  localStorage.removeItem('corpus.trfail.@RU@.et');localStorage.removeItem('corpus.trlock.@RU@.et');CORPUS_WEB.ai={plan:'free',limit:6,used:0};""" + extra + "})()"))

            nch = await pg.evaluate(J("[crTrChunks(crTrParts(plateById('@BIG@'))).length,crTrChunks(crTrParts(plateById('@RU@'))).length]"))
            check('hard cases: the big lesson needs two requests, the small one needs one', nch == [2, 1], json.dumps(nch))

            # a lesson of several requests: not translated quietly on the course home; the requests go one after another; the second is refused (429), the first answer lacks the terms
            urllib.request.urlopen(API + '/__fn?delay=300&drop=1&fail_after=1')
            await pg.evaluate(f"go({{name:'courses',fid:'{big_fid}'}})")
            await pg.wait_for_selector('.crs.chome .ccta')
            await pg.wait_for_timeout(900)
            check('big lesson: the course home does not translate it quietly (more than one request): no request', len(calls) == 0 and not await pg.query_selector('.ctrbusy'))
            refusal_window['on'] = True
            await pg.click('.crs.chome .ccta')
            await pg.wait_for_selector('.ctrbusy')
            await pg.wait_for_selector('.clesson .kbubble', timeout=20000)
            await pg.wait_for_timeout(600)
            refusal_window['on'] = False
            ph = await pg.evaluate(J("""(()=>{const p=plateById('@BIG@'),t=p.tr&&p.tr.et;return {n:t?Object.keys(t.notes).length:-1,terms:t?Object.keys(t.terms).length:-1,title:t&&t.title,miss:crTrMissing(p).length,err:CL.trErr,
              busy:CL.busy,ctrs:document.querySelector('#ctrs').innerText,retry:!!document.querySelector('#ctrRetry'),tog:!document.querySelector('#ctog').hidden,bubble:document.querySelector('.kbubble').innerText};})()"""))
            check('big lesson: two requests, one after the other (request, answer, request, answer), and no third one after the refusal', len(calls) == 2 and ev == ['req', 'res', 'req', 'res'], json.dumps([len(calls), ev]))
            check('big lesson: what the first request brought is kept (title, 25 notes), the terms the model left out and the rest are missing; «Tõlge on poolik» with «Proovi uuesti»',
                  ph['n'] == 25 and ph['terms'] == 0 and ph['title'] == '[et] Большой урок' and ph['miss'] == 14 and ph['err'] == 'rate_limited' and not ph['busy'] and 'Tõlge on poolik' in ph['ctrs']
                  and 'Proovi uuesti' in ph['ctrs'] and ph['retry'] and ph['tog'] and ph['bubble'] == '[et] Это длинный урок.', json.dumps(ph, ensure_ascii=False))
            await pg.click('.cseg [data-s=tu]')
            await pg.wait_for_selector('.cterm')
            sh = await pg.evaluate("""(()=>{const t=crT(plateById(CL.pid)),it=CL.L.items,a=it.findIndex(c=>crHas(t.notes,c.id)),b=it.findIndex(c=>!crHas(t.notes,c.id));
              const note=i=>{CL.st.i=i;CL.redraw();return document.querySelector('.cnote').textContent;};
              const na=note(a),nb=note(b);CL.st.i=0;CL.redraw();return {na:na,nb:nb,ca:cardById(it[a].id).note,cb:cardById(it[b].id).note};})()""")
            check('big lesson: a note that was translated is shown translated, one that was not — as it is in the file', sh['na'] == '[et] ' + sh['ca'] and sh['nb'] == sh['cb'] and sh['nb'] != '', json.dumps(sh, ensure_ascii=False))

            # «Retry» in the middle of a step: asks for the missing lines only, one request; the step stays where it is
            await pg.click('.cseg [data-s=ha]')
            await pg.wait_for_selector('.copt')
            await pg.click('.copt >> nth=0')
            await pg.wait_for_selector('#cfb .cverdict')
            mid = "({i:CL.st.i,pick:CL.st.o.pick,ok:CL.st.ok,q:CL.st.q.map(c=>c.id).join(),verdict:document.querySelectorAll('#cfb .cverdict').length,opts:document.querySelectorAll('.copt').length,step:CL.step})"
            m0 = await pg.evaluate(mid)
            urllib.request.urlopen(API + '/__fn?delay=500')   # all the other modes off
            await pg.click('#ctrRetry')
            await pg.wait_for_selector('#ctrs .spin')
            run = await pg.evaluate("({txt:document.querySelector('#ctrs').innerText,busy:!!document.querySelector('.ctrbusy'),verdict:document.querySelectorAll('#cfb .cverdict').length})")
            await pg.wait_for_function("!CL.trRun&&document.querySelector('#ctrs').textContent===''", timeout=20000)
            m1 = await pg.evaluate(mid)
            check('«Retry» mid-step: the step stays on the screen with «Tõlgin…» while it waits, no wait screen; afterwards the same question, the same answer, the same score (the step is not started again)',
                  'Tõlgin…' in run['txt'] and not run['busy'] and run['verdict'] == 1 and m0 == m1 and m1['verdict'] == 1 and m1['step'] == 'ha', json.dumps([run, m0, m1]))
            inp3 = json.loads(calls[2]['messages'][0]['content'].split('\nINPUT:\n', 1)[1])
            check('«Retry» asks for the missing lines only, in one request: the terms, the 5 notes of the second part, the kind; not the title, the intro, the questions',
                  len(calls) == 3 and set(inp3) == {'terms', 'notes', 'kinds'} and len(inp3['terms']) == 8 and len(inp3['notes']) == 5 and len(inp3['kinds']) == 1, json.dumps(sorted(inp3)) + str(len(calls)))
            full = await pg.evaluate(J("""(()=>{const p=plateById('@BIG@'),t=p.tr.et;return {miss:crTrMissing(p).length,notes:Object.keys(t.notes).length,terms:Object.keys(t.terms).length,kinds:t.kinds,err:CL.trErr,used:CORPUS_WEB.ai.used,
              all:Object.values(t.notes).every(v=>v.startsWith('[et] '))};})()"""))
            check('big lesson: after «Retry» the translation is whole: 30 notes, 8 terms, the kind; no line about it; the allowance counts 3 (one request was refused, the daily count includes it)',
                  full == {'miss': 0, 'notes': 30, 'terms': 8, 'kinds': {'sooned': '[et] sooned'}, 'err': None, 'used': 3, 'all': True}, json.dumps(full, ensure_ascii=False))
            await pg.wait_for_function('WQ.jobs.size===0', timeout=20000)

            # an answer cut short (the model stopped at its limit): paid for, no use; remembered for a day, in this tab and in the next visit; only «Retry» asks again
            urllib.request.urlopen(API + '/__fn?trunc=1')
            n0 = len(calls)
            await pg.evaluate(f"go({{name:'courses',fid:'{ru_fid}'}})")
            await pg.wait_for_selector('.crs.chome .ccta')
            await pg.wait_for_function(J("!!localStorage.getItem('corpus.trfail.@RU@.et')"), timeout=20000)
            mk = await pg.evaluate(J("({mark:+localStorage.getItem('corpus.trfail.@RU@.et'),err:(CR_TRERR.get('@RU@>et')||{}).code,tr:!!plateById('@RU@').tr,lock:localStorage.getItem('corpus.trlock.@RU@.et'),view:view.name})"))
            check('a truncated answer on the course home (quiet translation): one request, the failure is marked with the time, no translation, no lock left behind',
                  len(calls) == n0 + 1 and mk['mark'] > 1e12 and mk['err'] == 'invalid_json' and not mk['tr'] and mk['lock'] is None and mk['view'] == 'courses' and not await pg.query_selector('.ctrbusy'), json.dumps(mk))
            await pg.wait_for_function('WQ.jobs.size===0', timeout=20000)
            await pg.reload()
            await app_ready(pg)
            n0 = len(calls)
            await pg.evaluate(f"go({{name:'courses',fid:'{ru_fid}'}})")
            await pg.wait_for_selector('.crs.chome .ccta')
            await pg.wait_for_timeout(900)
            await pg.click('.crs.chome .ccta')
            await pg.wait_for_selector('.clesson .kbubble')
            fm = await pg.evaluate("({err:CL.trErr,busy:CL.busy,ctrs:document.querySelector('#ctrs').innerText,retry:!!document.querySelector('#ctrRetry'),bubble:document.querySelector('.kbubble').innerText})")
            check('after a reload: the course home and the lesson do not ask again (the mark is in the browser): 0 requests, «Tõlge pole saadaval» with «Proovi uuesti»',
                  len(calls) == n0 and not fm['busy'] and fm['err'] == 'bad_answer' and 'Tõlge pole saadaval' in fm['ctrs'] and fm['retry'] and fm['bubble'] == 'Это лобная кость.', json.dumps(fm, ensure_ascii=False))
            urllib.request.urlopen(API + '/__fn?case=1')   # the model now writes the Latin names with capitals
            await pg.click('#ctrRetry')
            await pg.wait_for_function("!CL.trRun&&!!crT(plateById(CL.pid))", timeout=20000)
            rt = await pg.evaluate(J("({mark:localStorage.getItem('corpus.trfail.@RU@.et'),lock:localStorage.getItem('corpus.trlock.@RU@.et'),ctrs:document.querySelector('#ctrs').textContent,bubble:document.querySelector('.kbubble').innerText,used:CORPUS_WEB.ai.used})"))
            check('«Retry» asks once, the translation arrives in the same screen; the mark of the failure is gone', len(calls) == n0 + 1 and rt['mark'] is None and rt['lock'] is None and rt['ctrs'] == '' and rt['bubble'].startswith('[et] ') and rt['used'] == 5, json.dumps(rt, ensure_ascii=False))
            # the hint of «Recall» hides the term whatever its case in the translated note
            await pg.click('.cseg [data-s=me]')
            await pg.wait_for_selector('#chint')
            await pg.click('#chint')
            hb = await pg.evaluate("""(()=>{const k=CL.st.q.findIndex(c=>c.term==='os frontale');CL.st.i=k;CL.redraw();const it=CL.st.q[k];
              return {note:crNoteT(crT(plateById(CL.pid)),it),box:document.querySelector('.hintbox').textContent};})()""")
            check('recall: the translated note has the Latin name in other case («os Frontale»), the hint still hides it', 'os Frontale' in hb['note'] and 'frontale' not in hb['box'].lower() and '…' in hb['box'], json.dumps(hb, ensure_ascii=False))
            mask = await pg.evaluate("""[crMask({id:'c',term:'os frontale'},{notes:{c:'(OS Frontale) i os frontale'}}),crMask({id:'c',term:'a.b (x)'},{notes:{c:'aXb x i a.b x'}}),crMask({id:'c',term:''},{notes:{c:'tekst'}})]""")
            check('the mask ignores case, and a term with special characters is not a pattern', mask == ['(…) i …', 'aXb x i …', 'tekst'], json.dumps(mask, ensure_ascii=False))
            fit = await pg.evaluate("""({lost:crTrFits('[et] Лобная кость образует лоб.','Лобная кость (os frontale) образует лоб.','notes','os frontale'),kept:crTrFits('[et] Лобная кость (OS FRONTALE) образует лоб.','Лобная кость (os frontale) образует лоб.','notes','os frontale'),
              free:crTrFits('[et] Лобная кость.','Лобная кость.','notes','os frontale'),order:crTrFits('<b>a</b>','</b>a<b>','intro',''),same:crTrFits('<b>a</b>','<b>b</b>','intro',''),empty:crTrFits('  ','x','intro','')})""")
            check('a translated note that lost the term of its card is not taken, one that keeps it in other case is; the <b> tags must stand in the same order',
                  fit == {'lost': False, 'kept': True, 'free': True, 'order': False, 'same': True, 'empty': False}, json.dumps(fit))
            cap = await pg.evaluate(J("""(()=>{const p=plateById('@RU@');delete p.tr;const rq=crTrReq(crTrChunks(crTrParts(p))[0]),out=JSON.parse(JSON.stringify(rq.req));p.pad='x'.repeat(700000);
              let code=null;try{crTrAccept(p,'et',rq,out);}catch(e){code=e.code;}const had=!!p.tr;delete p.pad;const n=crTrAccept(p,'et',rq,out);const ok=!!(p.tr&&p.tr.et);delete p.tr;persist('plates',p.id);return {code:code,had:had,n:n>0,ok:ok};})()"""))
            check('a translation that would take the photo over 700 KB (bytes) is not saved («too_large»); the same one fits a photo of the usual size', cap == {'code': 'too_large', 'had': False, 'n': True, 'ok': True}, json.dumps(cap))

            # another tab asks for the lesson already (a fresh lock in the browser): this tab does not ask; the allowance known to the page says fewer than three requests left: no quiet translation
            n0 = len(calls)
            await reset_ru("localStorage.setItem('corpus.trlock.@RU@.et',String(Date.now()));")
            await pg.evaluate(f"go({{name:'library'}});go({{name:'courses',fid:'{ru_fid}'}})")
            await pg.wait_for_selector('.crs.chome .ccta')
            await pg.wait_for_timeout(700)
            await pg.click('.crs.chome .ccta')
            await pg.wait_for_selector('.clesson .kbubble')
            lk = await pg.evaluate("({err:CL.trErr,ctrs:document.querySelector('#ctrs').innerText})")
            check('another tab holds the lock: neither the course home nor the lesson sends a request; the lesson says «Tõlge pole saadaval»', len(calls) == n0 and lk['err'] == 'busy' and 'Tõlge pole saadaval' in lk['ctrs'], json.dumps(lk))
            await reset_ru("CORPUS_WEB.ai.used=4;")
            await pg.evaluate(f"go({{name:'library'}});go({{name:'courses',fid:'{ru_fid}'}})")
            await pg.wait_for_selector('.crs.chome .ccta')
            await pg.wait_for_timeout(900)
            check('fewer than three requests left today: no quiet translation on the course home', len(calls) == n0 and not await pg.query_selector('.ctrbusy'))

            # the lesson is on its way (quietly, from the course home) when the reader opens it: the same request is taken over
            urllib.request.urlopen(API + '/__fn?delay=1500')
            await reset_ru()
            await pg.evaluate(f"go({{name:'library'}});go({{name:'courses',fid:'{ru_fid}'}})")
            await pg.wait_for_selector('.crs.chome .ccta')
            await pg.wait_for_function('CR_TRQ.size===1', timeout=5000)
            await pg.click('.crs.chome .ccta')
            await pg.wait_for_selector('.ctrbusy')
            await pg.wait_for_selector('.clesson .kbubble', timeout=20000)
            check('the quiet request is taken over by the lesson that is opened meanwhile: one request in all, the translation on the screen',
                  len(calls) == n0 + 1 and (await pg.inner_text('.kbubble')).startswith('[et] ') and await pg.evaluate('CR_TRQ.size===0'), str(len(calls) - n0))
            urllib.request.urlopen(API + '/__fn')

            # Anki: a photo from the import, or a photo with a card from it, keeps its own notes: nothing is asked, the translation (if the file has one) is not used
            ak = await pg.evaluate(J("""(()=>{const p=plateById('@RU@'),c=cardsOfPlate(p.id).find(x=>x.term==='os frontale'),a=crNoteOf(c);p.ai='deck|1';const b=crNoteOf(c),t1=crT(p),n1=crNeedTr(p);delete p.ai;
              c.ai='7';const d=crNoteOf(c),t2=crT(p);delete c.ai;return {tr:a===('[et] '+c.note),photo:b===c.note,card:d===c.note,t1:t1,t2:t2,n1:n1};})()"""))
            check('Anki: the note of such a card is the one in the file, the photo has no translation and needs none', ak == {'tr': True, 'photo': True, 'card': True, 't1': None, 't2': None, 'n1': False}, json.dumps(ak))
            n0 = len(calls)
            for what, mark in (('photo', "p.ai='deck|1';"), ('card', "cardsOfPlate(p.id)[1].ai='9';")):
                await reset_ru(f"const p2=plateById('{ru_pid}');(p=>{{{mark}}})(p2);")
                await pg.evaluate(f"go({{name:'library'}});go({{name:'courses',fid:'{ru_fid}'}})")
                await pg.wait_for_selector('.crs.chome .ccta')
                await pg.wait_for_timeout(500)
                await pg.click('.crs.chome .ccta')
                await pg.wait_for_selector('.clesson .kbubble')
                an = await pg.evaluate("({err:CL.trErr,busy:CL.busy,ctrs:document.querySelector('#ctrs').textContent,bubble:document.querySelector('.kbubble').innerText,tog:!document.querySelector('#ctog').hidden})")
                check('Anki (the ' + what + ' carries the mark): the lesson opens in its own language at once, nothing is asked, no line about a translation',
                      len(calls) == n0 and an == {'err': None, 'busy': False, 'ctrs': '', 'bubble': 'Это лобная кость.', 'tog': False}, json.dumps(an, ensure_ascii=False))
                await pg.evaluate(J("(()=>{const p=plateById('@RU@');delete p.ai;cardsOfPlate(p.id).forEach(c=>{delete c.ai;});})()"))

            # the quiet requests of a tab are limited; «Retry» is not: it asks (here the daily allowance is spent, the function says so)
            await reset_ru("__crAuto(12);")
            await pg.evaluate(f"go({{name:'library'}});go({{name:'courses',fid:'{ru_fid}'}})")
            await pg.wait_for_selector('.crs.chome .ccta')
            await pg.wait_for_timeout(700)
            await pg.click('.crs.chome .ccta')
            await pg.wait_for_selector('.clesson .kbubble')
            cp = await pg.evaluate("({err:CL.trErr,ctrs:document.querySelector('#ctrs').innerText,retry:!!document.querySelector('#ctrRetry')})")
            check('twelve quiet requests are enough for one tab: the next lesson is not sent, «Tõlge pole saadaval» with «Proovi uuesti»', len(calls) == n0 and cp['err'] == 'too_many' and cp['retry'], json.dumps(cp))
            await pg.click('#ctrRetry')
            await pg.wait_for_function("!CL.trRun&&CL.trErr==='quota_exceeded'", timeout=20000)
            check('«Retry» ignores that limit: one request, refused by the daily allowance (6 of 6), the line stays without «Retry»',
                  len(calls) == n0 + 1 and not await pg.query_selector('#ctrRetry') and 'Tõlge pole saadaval' in await pg.inner_text('#ctrs'))
            await pg.evaluate("__crAuto(0)")
            check('hard cases: no script errors or failed requests of its own', len(errs) == n_err, '; '.join(errs[n_err:])[:300])
            # clean up (both photos with their translations), so the counts in the later scenarios stay as they were
            await pg.evaluate("go({name:'library'})")
            await pg.evaluate("""(()=>{const ds=S.decks.filter(d=>d.name.startsWith('Urok')),ids=new Set(ds.map(d=>d.id));
              S.cards.filter(c=>ids.has(c.deckId)).forEach(c=>removeCard(c.id));S.plates.filter(p=>ids.has(p.deckId)).forEach(p=>dropPlate(p));
              ds.forEach(d=>{S.decks=S.decks.filter(x=>x.id!==d.id);removeDoc('decks',d.id);});
              S.folders.filter(f=>f.name.startsWith('Urok')).forEach(f=>{S.folders=S.folders.filter(x=>x.id!==f.id);removeDoc('folders',f.id);});delete META.coursePrio;delete META.courseLast;persistMeta();})()""")
            await pg.wait_for_function('WQ.jobs.size===0', timeout=20000)
            st = await state_when(lambda st: sum(1 for o in st['objects'] if o['owner'] == me_t) == 0)
            check('hard cases cleaned up: the photos of this account are gone from Storage', sum(1 for o in st['objects'] if o['owner'] == me_t) == 0)
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
            # empty account: a ready-made folder offered on the home screen (CORPUS_CONFIG.starter = a share code)
            check('no starter code configured → no offer', not await pg.evaluate("!!document.querySelector('[data-act=starter]')"))
            await pg.evaluate(f"CORPUS_WEB.starter='{code}';go({{name:'library'}});go({{name:'home'}})")
            btn = await pg.inner_text('#app [data-act=starter]')
            check('empty home offers the ready-made folder (translated)', 'Alusta valmis kaustaga' in btn and await pg.evaluate("!!document.querySelector('.page [data-act=starter]')"), btn)
            first = await pg.evaluate("(()=>{const b=[...document.querySelectorAll('.sv-empty button')];return {primary:b[0].dataset.act+':'+b[0].className,rest:b.slice(1,4).map(x=>x.dataset.act+':'+x.className)};})()")
            check('first run: the ready-made folder is the one primary action; creating a deck and importing stay as secondary', first['primary'] == 'starter:btn primary big' and first['rest'] == ['newDeck:btn line', 'ankiPick:btn line', 'settings:btn quiet'], json.dumps(first))
            await pg.click('#app [data-act=starter]')
            await pg.wait_for_selector('#layer .dlg')
            await pg.click('#layer [data-s="1"]')
            await pg.wait_for_function('S.folders.length===1 && S.plates.length===1 && S.cards.length===2', timeout=20000)
            check('starter folder imported into the empty account; offer gone', not await pg.evaluate("go({name:'home'}),!!document.querySelector('[data-act=starter]')"))
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
                  sum(o['owner'] == me for o in objs) == 2 and sum(o['owner'] != me for o in objs) == 12, json.dumps([o['owner'][:8] for o in objs]))
            await ctx.close()

            # ---------- guest: look around without an account, nothing reaches the server ----------
            ctx, pg, errs_g = await open_ctx()
            await pg.goto(SITE)
            await pg.wait_for_selector('.cw-guest-btn')
            await pg.wait_for_timeout(1500)
            await pg.screenshot(path=os.environ.get('SHOT', '/tmp/auth.png'))
            docs_before = len(state().get('docs', [])) if isinstance(state().get('docs'), list) else None
            await pg.click('.cw-guest-btn')
            await app_ready(pg)
            check('guest enters the app with a notice banner', bool(await pg.query_selector('.cw-guest')) and await pg.evaluate('CORPUS_WEB.guest === true'))
            await pg.evaluate("S.decks.push({id:'gd1',name:'Gost',newPerDay:20,mode:'hideAll',createdAt:1});persist('decks','gd1')")
            await pg.wait_for_timeout(800)
            check('guest data is kept in memory only', await pg.evaluate("S.decks.some(d=>d.id==='gd1')") and (docs_before is None or len(state().get('docs', [])) == docs_before))
            check('demo has AI, 5 requests', await pg.evaluate('!!S.sample && CORPUS_WEB.ai && CORPUS_WEB.ai.limit') == 5)
            res = await pg.evaluate("(async()=>{const o=[];for(let i=0;i<6;i++){try{await S.sample('hi');o.push('ok')}catch(e){o.push(e.code)}}return o})()")
            check('demo AI stops after 5 requests', res == ['ok'] * 5 + ['quota_exceeded'], json.dumps(res))
            # a guest: the lesson of a course in another language is not translated at all (not quietly, not on opening), the line says so and offers no «Retry»
            ai_g = watch_ai(pg)
            await import_file('corpus-folder-ru.json', 1)
            g_fid = await pg.evaluate("S.folders.find(f=>f.name==='Urok RU').id")
            await pg.evaluate(f"CORPUS_WEB.ai.used=0;go({{name:'courses',fid:'{g_fid}'}})")
            await pg.wait_for_selector('.crs.chome .ccta')
            await pg.wait_for_timeout(900)
            check('guest: the course home does not translate quietly', len(ai_g) == 0 and not await pg.query_selector('.ctrbusy'))
            await pg.click('.crs.chome .ccta')
            await pg.wait_for_selector('.clesson .kbubble')
            gs = await pg.evaluate("({err:CL.trErr,busy:CL.busy,ctrs:document.querySelector('#ctrs').innerText,retry:!!document.querySelector('#ctrRetry'),bubble:document.querySelector('.kbubble').innerText})")
            check('guest: opening the lesson asks for nothing; «Tõlge pole saadaval» without «Proovi uuesti», the lesson in its own language',
                  len(ai_g) == 0 and gs['err'] == 'guest' and not gs['busy'] and 'Tõlge pole saadaval' in gs['ctrs'] and not gs['retry'] and gs['bubble'] == 'Это лобная кость.', json.dumps(gs, ensure_ascii=False))
            await pg.click('[data-act=crBack]')
            await pg.evaluate("go({name:'settings'})")
            check('guest settings offer to sign in', bool(await pg.query_selector('[data-act=signOut]')) and not await pg.evaluate('!!CORPUS_WEB.push'))
            await pg.click('.cw-guest-go')
            await pg.wait_for_selector('.cw-auth .cw-tabs .on')
            check('guest banner leads back to sign-in', True)
            check('no script errors in guest mode', not errs_g, '; '.join(errs_g)[:400])
            await ctx.close()

            # ---------- password reset: the e-mail request, then the link from the e-mail ----------
            ctx, pg, errs_r = await open_ctx()
            await pg.goto(SITE)
            await pg.wait_for_selector('.cw-auth .cw-forgot')
            await pg.click('.cw-forgot')
            check('forgot password without an email asks for it', bool((await pg.inner_text('.cw-err')).strip()))
            await pg.fill('input[name=email]', 'friend@test.ee')
            await pg.click('.cw-forgot')
            await pg.wait_for_function("document.querySelector('.cw-err.cw-ok')")
            rec = [e for e in json.loads(urllib.request.urlopen(API + '/__log').read()) if isinstance(e, dict) and e.get('recover')]
            check('forgot password sends the reset e-mail request', rec and rec[0]['recover'] == 'friend@test.ee', json.dumps(rec))
            await pg.goto(SITE + '#error_code=otp_expired&error=access_denied')
            await pg.wait_for_selector('.cw-auth .cw-err')
            check('expired reset link says so on the sign-in screen', bool((await pg.inner_text('.cw-err')).strip()))
            req = urllib.request.Request(API + '/auth/v1/token?grant_type=password', json.dumps({'email': 'friend@test.ee', 'password': 'kolju2026'}).encode(), {'Content-Type': 'application/json'})
            tok = json.loads(urllib.request.urlopen(req).read())
            await pg.goto('about:blank')
            await pg.goto(SITE + '#access_token=' + tok['access_token'] + '&refresh_token=' + tok['refresh_token'] + '&type=recovery')
            await pg.wait_for_selector('.cw-auth input[name=password]')
            check('reset link opens the new-password screen', not await pg.query_selector('.cw-tabs'))
            await pg.fill('input[name=password]', 'uus-parool-26')
            await pg.click('.cw-go')
            await app_ready(pg)
            check('new password saved: signed in, link cleared from the address', '#' not in pg.url)
            await pg.evaluate('CORPUS_WEB.signOut()')
            await pg.wait_for_selector('.cw-auth .cw-tabs .on')
            await pg.fill('input[name=email]', 'friend@test.ee')
            await pg.fill('input[name=password]', 'uus-parool-26')
            await pg.click('.cw-go')
            await app_ready(pg)
            check('signing in with the new password works', True)
            await ctx.close()

            check('no script errors or failed requests in the browser', not errs_a and not errs_b and not errs_c and not errs_r, '; '.join(errs_a + errs_b + errs_c + errs_r)[:600])
            await b.close()
    finally:
        stop(procs)
        shutil.rmtree(tmp, ignore_errors=True)
        left = [p for p in (SITE_PORT, API_PORT, FN_PORT) if not wait_port_closed(p)]
        if left:
            print('FAIL test servers still listening after the run on ports ' + ', '.join(map(str, left)))
            ok = False
    print('ALL PASSED' if ok else 'FAILED')
    if not ok:
        raise SystemExit(1)


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except asyncio.CancelledError:   # SIGTERM: exit code 128+15, no traceback
        sys.exit(143)
