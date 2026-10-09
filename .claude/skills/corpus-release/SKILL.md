---
name: corpus-release
description: Выкладка Corpus на corpusapp.ee и передача Льву SQL/Edge Function, с откатом. Только после явного «деплой T-xxx» от Льва в текущем разговоре.
---
1. Условия, иначе стоп: задача в журнале ready; на последнем коммите ветки — `ALL PASSED` (и зелёный CI, если он есть); ревью закрыты; Лев написал «деплой T-xxx».
2. Есть SQL/функция → сначала Лев вставляет их (SQL Editor / Edge Functions) и подтверждает; затем сайт. SQL должен работать и со старой версией сайта.
3. `git fetch origin main gh-pages`. Если main ушёл вперёд → `git merge origin/main` в ветку задачи и заново corpus-verify. Запиши в журнал `откат: $(git rev-parse origin/gh-pages)`.
4. `git switch main && git merge --ff-only claude/T-xxx-<slug> && git push origin main main:gh-pages` — хук спросит подтверждение.
5. Через 1–2 минуты: `curl -s https://corpusapp.ee/ | grep -o 'web.js?v=[0-9a-f]*'` совпадает с тем же в `index.html`.
6. Журнал: deployed, sha, sha отката. Закоммитить в main не нужно — журнал живёт в ветке задачи.

Откат сайта: `git revert <sha>` в новой ветке → corpus-verify → снова «деплой». Аварийно (только Лев): `git push origin <sha отката>:gh-pages --force-with-lease`.
Откат SQL/функции: фрагмент отката из итога задачи; код функции — `git show <прежний sha>:supabase/functions/<имя>/index.ts`.
Артефакт claude.ai — отдельно и только по прямой просьбе.
