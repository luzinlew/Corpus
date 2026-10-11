#!/usr/bin/env python3
"""Turn a lessons file into a Corpus folder file (import it in the app: Library -> import).

    python3 tools/lessons2corpus.py IN.json -o OUT.json

IN is either a course ({"lessons": [...]}) or a plain list of lessons. A lesson is
{id, title, sub, part, img, intro[], items[{id, term, box[x,y,w,h], note, src, prio, pt}], link[{term, q, ans, opts, src, item}]}.
img is a path relative to IN's folder or a data: URI. The result holds slides: keep it for your own use,
do not publish it or put it into the repository.
"""
import argparse, base64, io, json, pathlib, sys, time

PARTS = {1: 'Kolju tervikuna', 2: 'Ossa cranii', 3: 'Praktikum'}


def load_image(ref, base):
    """-> (data URI, w, h) or None"""
    from PIL import Image
    if not ref:
        return None
    if ref.startswith('data:'):
        raw = base64.b64decode(ref.split(',', 1)[1]); uri = ref
    else:
        f = base / ref
        if not f.is_file():
            print('warning: no image file', f, file=sys.stderr); return None
        raw = f.read_bytes()
        uri = None
    im = Image.open(io.BytesIO(raw)); w, h = im.size
    if uri is None:
        uri = 'data:image/%s;base64,' % ('png' if im.format == 'PNG' else 'jpeg') + base64.b64encode(raw).decode()
    return uri, w, h


def convert(lessons, base):
    now = int(time.time() * 1000)
    parts = sorted({L.get('part') for L in lessons}, key=lambda x: (x is None, x or 0))
    decks, did = [], {}
    for k, part in enumerate(parts):
        did[part] = 'd%d' % (k + 1)
        name = PARTS.get(part, 'Kolju') if part is not None else 'Kolju'
        decks.append({'id': did[part], 'name': name, 'newPerDay': 20, 'mode': 'hideAll', 'folderId': 'f1', 'createdAt': now + k})
    plates, cards, photo_of = [], [], {}   # photo_of[lesson index] -> plate
    by_term = {}                            # term.lower() -> (lesson index, card id)
    t = now
    for li, L in enumerate(lessons):
        img = load_image(L.get('img'), base)
        if not img:
            continue
        t += 1
        p = {'id': 'p%d' % (len(plates) + 1), 'deckId': did[L.get('part')], 'w': img[1], 'h': img[2], 'createdAt': t, 'image': img[0],
             'title': L.get('title', '') + (' — ' + L['sub'] if L.get('sub') else '')}
        if L.get('intro'):
            p['intro'] = list(L['intro'])
        plates.append(p); photo_of[li] = p
        for it in L.get('items', []):
            t += 1
            b = it['box']
            c = {'id': '%s:%s' % (L['id'], it['id']), 'deckId': p['deckId'], 'plateId': p['id'], 'term': it['term'],
                 'x': b[0], 'y': b[1], 'w': b[2], 'h': b[3], 'createdAt': t}
            for k in ('note', 'src', 'prio', 'pt'):
                if it.get(k) is not None:
                    c[k] = it[k]
            cards.append(c)
            by_term.setdefault(it['term'].lower(), (li, c['id']))
    ids = {c['id'] for c in cards}
    first_in_part = {}
    for li, p in photo_of.items():
        first_in_part.setdefault(lessons[li].get('part'), li)
    bound = loose = 0
    for li, L in enumerate(lessons):
        for q in L.get('link', []):
            lnk = {'q': q['q'], 'ans': q['ans'], 'opts': list(q.get('opts', []))}
            if q.get('src'):
                lnk['src'] = q['src']
            target, item = None, None
            if q.get('item') and li in photo_of and '%s:%s' % (L['id'], q['item']) in ids:
                target, item = li, '%s:%s' % (L['id'], q['item'])
            if item is None and q.get('term'):
                term = q['term'].lower()
                own = [c['id'] for c in cards if c['plateId'] == photo_of[li]['id'] and c['term'].lower() == term] if li in photo_of else []
                if own:
                    target, item = li, own[0]
                elif term in by_term:
                    target, item = by_term[term]
            if item is not None:
                lnk['item'] = item; bound += 1
            else:
                target = li if li in photo_of else first_in_part.get(L.get('part'), next(iter(photo_of), None))
                if target is None:
                    print('warning: question dropped, no photo for it:', q.get('q'), file=sys.stderr)
                else:
                    loose += 1
                    print('warning: question without a frame:', q.get('q'), file=sys.stderr)
            if target is not None:
                photo_of[target].setdefault('link', []).append(lnk)
    doc = {'app': 'corpus', 'kind': 'folder', 'version': 1, 'exportedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'folders': [{'id': 'f1', 'name': 'Kolju', 'mode': 'hideAll'}], 'decks': decks, 'plates': plates, 'cards': cards, 'stats': {}}
    return doc, bound, loose


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('infile'); ap.add_argument('-o', '--out', required=True)
    a = ap.parse_args()
    src = pathlib.Path(a.infile)
    data = json.loads(src.read_text(encoding='utf-8'))
    lessons = data['lessons'] if isinstance(data, dict) else data
    doc, bound, loose = convert(lessons, src.parent)
    pathlib.Path(a.out).write_text(json.dumps(doc, ensure_ascii=False), encoding='utf-8')
    print('decks %d, photos %d, cards %d, questions %d (with a frame %d, without %d)' %
          (len(doc['decks']), len(doc['plates']), len(doc['cards']), bound + loose, bound, loose))
    print('Reminder: the file holds course slides - for your own import only, do not publish it or commit it.')


if __name__ == '__main__':
    main()
