"""One-time patch: the small hooks that let src/corpus.html run both on claude.ai and as the website.
Every hook is inert on claude.ai (window.CORPUS_WEB is undefined there)."""
import sys, json
p = sys.argv[1]
s = open(p, encoding='utf8').read()

def rep(old, new):
    global s
    n = s.count(old)
    assert n == 1, (n, old[:100])
    s = s.replace(old, new)

# photo URLs: /_blob/<id> on claude.ai, <site>/_blob/<id> (service worker) on the web
rep("""function plateUrl(p){if(!p)return '';if(p.assetId)return '/_blob/'+p.assetId;""",
    """function blobUrl(id){return ((window.CORPUS_WEB&&window.CORPUS_WEB.blobBase)||'/_blob/')+id;}
function plateUrl(p){if(!p)return '';if(p.assetId)return blobUrl(p.assetId);""")
rep("""mediaUrl.set(nm,'/_blob/'+r.id);""", """mediaUrl.set(nm,blobUrl(r.id));""")
rep("""      if(mode==='show'){if(/^\\/_blob\\/[A-Za-z0-9_-]+$/.test(src))out='<img src="'+src+'" alt="" loading="lazy">';}""",
    """      if(mode==='show'){const bm=src.match(/^(?:[^?#]*\\/)?_blob\\/([A-Za-z0-9_-]+)$/);if(bm)out='<img src="'+blobUrl(bm[1])+'" alt="" loading="lazy">';}""")
# images drawn into canvases stay readable if they ever come straight from storage
rep("""function loadImage(src){return new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src=src;});}""",
    """function loadImage(src){return new Promise((res,rej)=>{const im=new Image();if(window.CORPUS_WEB&&!/^(?:blob|data):/.test(src))im.crossOrigin='anonymous';im.onload=()=>res(im);im.onerror=rej;im.src=src;});}""")
# the website has no 5 000-document cap
rep("""  if(S.db&&dbDocCount()+estDocs>4950){""", """  if(S.db&&!window.CORPUS_WEB&&dbDocCount()+estDocs>4950){""")
# account (web only): who is signed in, and sign out
rep("""function settingsBody(){
  const np=S.plates.length,nc=S.cards.length;
  const old=S.cards.length&&(!META.lastBackup||Date.now()-META.lastBackup>WEEK);
  return lookSectionHtml()+""",
    """function accountSectionHtml(){
  const W=window.CORPUS_WEB;if(!W)return '';
  return '<section class="overview"><div class="h2">Аккаунт</div><p class="muted" style="margin:4px 0 12px;line-height:1.5;overflow-wrap:anywhere" data-noi18n>'+esc(W.email||'')+'</p>'+
    '<button class="btn line block" data-act="signOut">Выйти</button></section>';
}
function settingsBody(){
  const np=S.plates.length,nc=S.cards.length;
  const old=S.cards.length&&(!META.lastBackup||Date.now()-META.lastBackup>WEEK);
  return accountSectionHtml()+lookSectionHtml()+""")
rep("""const A={
  copyPrompt:""", """const A={
  signOut:async()=>{if(!window.CORPUS_WEB)return;
    if(!(await confirmDialog({title:'Выйти из аккаунта?',text:'Колоды и прогресс останутся в аккаунте — войдите снова, чтобы продолжить.',ok:'Выйти',danger:false})))return;
    window.CORPUS_WEB.signOut();},
  copyPrompt:""")

# translations for the strings above and for the web runtime (web.js); the app translates any Russian text node it shows
new = [
 ["Аккаунт","Account","Konto"],
 ["Выйти","Sign out","Logi välja"],
 ["Выйти из аккаунта?","Sign out?","Kas logid välja?"],
 ["Колоды и прогресс останутся в аккаунте — войдите снова, чтобы продолжить.","Your decks and progress stay in your account — sign in again to continue.","Pakid ja edenemine jäävad kontole — jätkamiseks logi uuesti sisse."],
 ["Анатомия по изображениям: колоды из фото атласа и интервальные повторения.","Anatomy from images: decks made from atlas photos, with spaced repetition.","Anatoomia piltide järgi: pakid atlase fotodest ja vahedega kordamine."],
 ["Вход","Sign in","Sisselogimine"],
 ["Регистрация","Sign up","Registreerimine"],
 ["Пароль","Password","Parool"],
 ["Код приглашения","Invite code","Kutsekood"],
 ["Войти","Sign in","Logi sisse"],
 ["Создать аккаунт","Create account","Loo konto"],
 ["Подождите…","Please wait…","Oota…"],
 ["Забыли пароль? Попросите того, кто дал вам ссылку, сбросить его.","Forgot your password? Ask the person who gave you the link to reset it.","Unustasid parooli? Palu lingi saatjal see lähtestada."],
 ["Аккаунт хранит ваши колоды и прогресс — они будут доступны с любого устройства.","Your account keeps your decks and progress — available on any device.","Konto hoiab sinu pakke ja edenemist — need on kättesaadavad igast seadmest."],
 ["Проверьте email.","Check the email address.","Kontrolli e-posti aadressi."],
 ["Пароль — минимум 6 символов.","The password needs at least 6 characters.","Parool peab olema vähemalt 6 märki."],
 ["Неверный email или пароль.","Wrong email or password.","Vale e-post või parool."],
 ["Такой email уже зарегистрирован — войдите.","This email is already registered — sign in.","See e-post on juba registreeritud — logi sisse."],
 ["Регистрация сейчас закрыта.","Sign-up is closed right now.","Registreerimine on praegu suletud."],
 ["Слишком много попыток — подождите пару минут.","Too many attempts — wait a couple of minutes.","Liiga palju katseid — oota paar minutit."],
 ["Нужна ссылка-приглашение: откройте ссылку, которую вам прислали, или введите код.","You need an invite: open the link you were sent, or enter the code.","Vaja on kutset: ava saadetud link või sisesta kood."],
 ["Вход требует подтверждения почты, а письма отсюда не отправляются. Попросите администратора выключить «Confirm email» в Supabase.","Sign-in needs email confirmation, but this site sends no emails. Ask the admin to turn off “Confirm email” in Supabase.","Sisselogimine nõuab e-posti kinnitamist, kuid siit kirju ei saadeta. Palu administraatoril Supabase’is „Confirm email“ välja lülitada."],
 ["Нет соединения. Попробуйте ещё раз.","No connection. Try again.","Ühendus puudub. Proovi uuesti."],
 ["Не получилось войти. Попробуйте ещё раз.","Couldn’t sign in. Try again.","Sisselogimine ebaõnnestus. Proovi uuesti."],
 ["Сайт ещё настраивается","The site is still being set up","Lehte alles seadistatakse"],
 ["Загляните чуть позже.","Please check back a little later.","Vaata veidi hiljem uuesti."],
 ["Файл готов","The file is ready","Fail on valmis"],
 ["Отправить…","Send…","Saada…"],
 ["Сохранить на устройство","Save to device","Salvesta seadmesse"],
 ["Отмена","Cancel","Tühista"],
]
import re
lines = s.split('\n')
i = next(k for k, l in enumerate(lines) if l.startswith('const I18N_DICT=['))
have = set(json.loads(lines[i][len('const I18N_DICT='):-1]) and [r[0] for r in json.loads(lines[i][len('const I18N_DICT='):-1])])
add = [e for e in new if e[0] not in have]
if add:
    lines[i] = lines[i][:-2] + ',' + ','.join(json.dumps(e, ensure_ascii=False) for e in add) + '];'
s = '\n'.join(lines)
open(p, 'w', encoding='utf8').write(s)
print('patched; dict entries added:', len(add), 'skipped (already there):', [e[0] for e in new if e[0] in have])
