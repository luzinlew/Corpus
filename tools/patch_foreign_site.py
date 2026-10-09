"""Visitors of someone else's Corpus on claude.ai are sent to the website instead of being asked to copy the artifact."""
import sys, json
p = sys.argv[1]
s = open(p, encoding='utf8').read()
lines = s.split('\n')
a = next(i for i, l in enumerate(lines) if l.startswith('const COPY_PROMPT='))
b = next(i for i, l in enumerate(lines) if l.startswith('SCREENS.foreign='))
e = next(i for i in range(b, len(lines)) if lines[i].endswith("'</section></div>'};"))
assert a == b - 1
lines[a:e + 1] = [
    "const SITE_URL='https://corpusapp.ee/';",
    "SCREENS.foreign={html:()=>'<div class=\"page\"><header class=\"hhead\"><div class=\"brand\"><span class=\"brand-mark\" aria-hidden=\"true\"><i></i><b></b></span>Corpus</div></header>'+",
    "  '<section class=\"overview\"><div class=\"h2\">Это Corpus другого человека</div>'+",
    "  '<p class=\"muted\" style=\"margin:6px 0 10px;line-height:1.55\">Здесь колоды и прогресс его владельца, поэтому учиться и импортировать файлы в этом окне нельзя.</p>'+",
    "  '<p class=\"muted\" style=\"margin:0 0 14px;line-height:1.55\">Corpus работает и как сайт: зарегистрируйтесь — у вас будут свои колоды и свой прогресс на любом устройстве. Файл колоды или папки, который вам прислали, импортируйте уже там.</p>'+",
    "  '<a class=\"btn primary big block\" href=\"'+SITE_URL+'\" target=\"_blank\" rel=\"noopener\">'+ic('play',18)+'Открыть Corpus</a>'+",
    "  '<p class=\"muted sm\" style=\"margin:8px 0 0;text-align:center;overflow-wrap:anywhere\" data-noi18n>'+esc(SITE_URL.replace(/^https:\\/\\//,''))+'</p>'+",
    "  '<button class=\"btn quiet block\" data-act=\"foreignPeek\" style=\"margin-top:6px\">Посмотреть колоды владельца</button></section>'+",
    "  '<section class=\"overview\">'+langRowHtml()+'</section></div>'};",
]
s = '\n'.join(lines)
# the copy-the-artifact action is gone with its screen
start = s.index('  copyPrompt:async()=>{')
end = s.index('  foreignPeek:', start)
s = s[:start] + s[end:]
new = [
 ["Здесь колоды и прогресс его владельца, поэтому учиться и импортировать файлы в этом окне нельзя.",
  "It holds its owner’s decks and progress, so you can’t study or import files in this window.",
  "Siin on omaniku pakid ja edenemine, seega selles aknas õppida ega faile importida ei saa."],
 ["Corpus работает и как сайт: зарегистрируйтесь — у вас будут свои колоды и свой прогресс на любом устройстве. Файл колоды или папки, который вам прислали, импортируйте уже там.",
  "Corpus also works as a website: sign up there to get your own decks and progress on any device. Import the deck or folder file you received there.",
  "Corpus töötab ka veebilehena: registreeru seal — sul on oma pakid ja edenemine igas seadmes. Saadud paki või kausta faili impordi juba seal."],
 ["Открыть Corpus", "Open Corpus", "Ava Corpus"],
]
lines = s.split('\n')
i = next(k for k, l in enumerate(lines) if l.startswith('const I18N_DICT=['))
have = {r[0] for r in json.loads(lines[i][len('const I18N_DICT='):-1])}
add = [x for x in new if x[0] not in have]
lines[i] = lines[i][:-2] + ',' + ','.join(json.dumps(x, ensure_ascii=False) for x in add) + '];'
open(p, 'w', encoding='utf8').write('\n'.join(lines))
print('foreign screen now links to the site; dict +', len(add))
