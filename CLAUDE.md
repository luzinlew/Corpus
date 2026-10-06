# Corpus: как вносить изменения

Corpus — приложение Льва для карточек по анатомии. Этот репозиторий — сайт https://luzinlew.github.io/Corpus/ (GitHub Pages), данные и аккаунты в Supabase. Подробности устройства в `README.md`.

## Порядок работы
1. Приложение — один файл `src/corpus.html`. Правки делаются там. `index.html` руками не трогать.
   Веб-обвязка: `web.js` (вход, Supabase, `window.claude.use`, push), `web.css`, `sw.js` (фото и push), `config.js`.
2. `python3 build.py`, чтобы пересобрать `index.html`.
3. Тест: `pip install playwright pillow --break-system-packages && python3 -m playwright install chromium`, нужен `deno` (или `npx deno`), затем `python3 tools/e2e_test.py`. Должно напечатать `ALL PASSED`. Для нового поведения добавлять проверку туда же.
4. Выкладка: коммит, потом `git push origin main main:gh-pages`. Pages публикует ветку `gh-pages`, сайт обновляется у всех примерно за минуту.

## Правила
- Интерфейс трёхъязычный (по умолчанию эстонский). Каждой новой русской строке интерфейса нужна запись `[ru, en, et]` в `I18N_DICT` в `src/corpus.html`.
- Тот же `src/corpus.html` работает как артефакт в claude.ai (https://claude.ai/code/artifact/0690ff56-d9ba-46c0-ac2b-b10f2a1c201e, с файлами `ocr/*` и `anki/*`). Там ИИ работает через Claude самого зрителя, на сайте — через функцию `corpus-ai`. Если Лев хочет обновить и его, опубликовать туда `src/corpus.html`. Веб-хуки там ничего не делают: `window.CORPUS_WEB` нет.
- Порядок колод и фото задаёт `createdAt`. Экспорт и импорт должны его сохранять.
- В репозиторий никаких секретов: в `config.js` только публичные URL и publishable key Supabase.
- Изменения базы: идемпотентный SQL в `supabase/setup.sql` / `supabase/ai.sql` / `supabase/share.sql` плюс фрагмент для Льва, чтобы он запустил его в Supabase → SQL Editor.
- Push-уведомления: функция `supabase/functions/corpus-push` (рассылка по расписанию из `supabase/push.sql`), тест `tools/push_test.ts`. Функцию, как и `corpus-ai`, Лев вставляет в Supabase сам.
- ИИ на сайте: `web.js` даёт приложению `sample` через Edge Function `supabase/functions/corpus-ai` (ключ Claude API только в её секретах, лимиты — `corpus_ai_take`). Задеплоить функцию отсюда нельзя: изменения в ней Лев вставляет в Supabase → Edge Functions сам, дай ему точный код.
