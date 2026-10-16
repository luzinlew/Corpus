---
name: corpus-verify
description: Как собрать и проверить Corpus — build.py --check, сквозной e2e в браузере, тест push-функции, с точными признаками успеха. Использовать перед каждым коммитом и в QA.
---
# Проверка Corpus

Временный каталог TMPD — вне репозитория (в облачной сессии — scratchpad сессии, локально — /tmp/corpus-check).

1. Сборка: `python3 build.py`, затем `python3 build.py --check` → `index.html is up to date`.
2. Окружение (один раз):
   - локально: `pip install playwright pillow --break-system-packages && python3 -m playwright install chromium`; deno или `npx --yes deno`.
   - облачная сессия (есть /opt/pw-browsers): `playwright install` не запускать. `python3 -m venv $TMPD/venv && $TMPD/venv/bin/pip install -q playwright==1.56.0 pillow` — версия под имеющийся chromium-1194 (проверено 2026-10-09; если каталог другой — подобрать версию под него).
3. До запуска: `pgrep -af "corpus-ai/index.ts|fake-supabase|http.server 8765"` должно быть пусто; иначе остановить эти процессы, иначе тест молча возьмёт старую функцию с порта 8000.
4. e2e: `<python> tools/e2e_test.py > $TMPD/e2e.log 2>&1; echo exit=$?; grep -c '^PASS' $TMPD/e2e.log; grep -v '^PASS' $TMPD/e2e.log | tail -20`.
   Успех: exit=0, последняя строка `ALL PASSED`, число PASS не меньше прежнего (126 на 2026-10-09).
5. Push (если менялись corpus-push или push.sql): `CORPUS_PUSH_NO_SERVE=1 npx --yes deno run --allow-net --allow-env --allow-read --allow-sys tools/push_test.ts | tail -3` → `ALL PUSH TESTS PASSED`.
5a. Офлайн-тесты курсов (node, без браузера и сети; запускать после правок курсов/реестра знаний в `src/corpus.html` или `supabase/functions/corpus-ai`). Каждый — exit=0 и строка успеха:
   - `node tools/course_logic_test.cjs` → `COURSE LOGIC TESTS PASSED (`
   - `node tools/course_discovery_test.cjs` → `DISCOVERY SYNTHETIC PASSED:`
   - `node tools/course_replay_test.cjs` → `DISCOVERY/CONTEXT/VISUAL TESTS PASSED` и `BUILD RESUME TESTS PASSED`
   - `node tools/course_limits_test.cjs` → `COURSE LIMITS TESTS PASSED`
   - `node tools/course_truncated_test.cjs` → `ALL TRUNCATED-OUTLINE TESTS PASSED`
   - `node tools/course_groups_test.cjs` → строка успеха в конце вывода (план по группам, T-037)
   - `node tools/course_chunks_test.cjs` → `ALL CHUNK TESTS PASSED` (нарезка outline по плотности и повтор оборванных кусков половинами, T-039)
   - `node tools/pdf_visual_test.mjs` → `PDF VISUAL REGRESSION TESTS PASSED`
   Предупреждение `ExperimentalWarning: stripTypeScriptTypes` — норма. Режимы на реальных данных (`--evidence`, путь к evidence) здесь не нужны.
6. После: повторить п.3 и `git status --short` — тест не оставляет файлов.

Докладывать команды, exit-коды и последние строки. Никогда «прошло» без них.
