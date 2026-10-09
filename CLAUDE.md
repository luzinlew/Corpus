# Corpus: как вносить изменения

Corpus — приложение Льва для карточек по анатомии. Этот репозиторий — сайт https://corpusapp.ee/ (GitHub Pages, раньше https://luzinlew.github.io/Corpus/), данные и аккаунты в Supabase. Подробности устройства в `README.md`.

## Порядок работы
1. Приложение — один файл `src/corpus.html`. Правки делаются там. `index.html` руками не трогать.
   Веб-обвязка: `web.js` (вход, Supabase, `window.claude.use`, push), `web.css`, `sw.js` (фото и push), `config.js`.
2. `python3 build.py`, чтобы пересобрать `index.html`.
3. Тест: `pip install playwright pillow --break-system-packages && python3 -m playwright install chromium`, нужен `deno` (или `npx deno`), затем `python3 tools/e2e_test.py`. Должно напечатать `ALL PASSED`. Для нового поведения добавлять проверку туда же. Подробно (облачная сессия, push-тест, висящие процессы) — скилл `corpus-verify`.
4. Выкладка — только после явного «деплой» от Льва, скилл `corpus-release`: коммит, потом `git push origin main main:gh-pages`. Pages публикует ветку `gh-pages`, сайт обновляется у всех примерно за минуту.

## Правила
- Интерфейс трёхъязычный (по умолчанию эстонский). Каждой новой русской строке интерфейса нужна запись `[ru, en, et]` в `I18N_DICT` в `src/corpus.html`.
- Тот же `src/corpus.html` работает как артефакт в claude.ai (https://claude.ai/code/artifact/0690ff56-d9ba-46c0-ac2b-b10f2a1c201e, с файлами `ocr/*` и `anki/*`). Там ИИ работает через Claude самого зрителя, на сайте — через функцию `corpus-ai`. Публиковать туда `src/corpus.html` — только по прямой просьбе Льва. Веб-хуки там ничего не делают: `window.CORPUS_WEB` нет.
- Порядок колод и фото задаёт `createdAt`. Экспорт и импорт должны его сохранять.
- В репозиторий никаких секретов: в `config.js` только публичные URL и publishable key Supabase. Репозиторий публичный.
- Изменения базы: идемпотентный SQL в `supabase/*.sql` (setup, ai, share, stats, reward, demo, push) плюс фрагмент и фрагмент отката для Льва, чтобы он запустил его в Supabase → SQL Editor.
- Push-уведомления: функция `supabase/functions/corpus-push` (рассылка по расписанию из `supabase/push.sql`), тест `tools/push_test.ts`. Функцию, как и `corpus-ai`, Лев вставляет в Supabase сам.
- ИИ на сайте: `web.js` даёт приложению `sample` через Edge Function `supabase/functions/corpus-ai` (ключ Claude API только в её секретах, лимиты — `corpus_ai_take`). Задеплоить функцию отсюда нельзя: изменения в ней Лев вставляет в Supabase → Edge Functions сам, дай ему точный код.

## Работа агентами
- Основная сессия — координатор (Opus), цикл — скилл `corpus-cycle`. Код пишет `implementer` (Sonnet), проверяет `qa-quick` (Haiku); `qa-review` и `security-reviewer` (Sonnet) — только по условиям из `corpus-cycle`. Параллельно — только ревьюеры.
- Очередь, журнал, бюджет и стоп-условия — `.claude/TASKS.md`. Одна задача — одна ветка `claude/T-xxx-<slug>` от main; журнал коммитится в неё после каждого шага.
- Без явного разрешения Льва в этом разговоре нельзя: пушить в main/gh-pages, публиковать артефакт, менять что-либо в Supabase (SQL, функции, секреты, настройки), удалять ветки, переписывать историю. `.claude/hooks/guard.py` страхует от случайностей, но не заменяет это правило.
- `src/corpus.html` ~650 КБ: не читать целиком, искать Grep и читать кусками ≤200 строк; не выводить строку `const I18N_DICT=` (~78 КБ).
- Не ослаблять RLS, проверки и тесты ради зелёного прогона. «Тесты прошли» — только с выводом `ALL PASSED`.
- Чужие незакоммиченные изменения не трогать: если дерево грязное, спросить.
