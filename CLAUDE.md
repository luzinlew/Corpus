# Corpus: как вносить изменения

Corpus — приложение Льва для карточек по анатомии. Этот репозиторий — сайт https://luzinlew.github.io/Corpus/ (GitHub Pages), данные и аккаунты в Supabase. Подробности устройства в `README.md`.

## Порядок работы
1. Приложение — один файл `src/corpus.html`. Правки делаются там. `index.html` руками не трогать.
   Веб-обвязка: `web.js` (вход, Supabase, `window.claude.use`), `web.css`, `sw.js` (фото), `config.js`.
2. `python3 build.py`, чтобы пересобрать `index.html`.
3. Тест: `pip install playwright pillow --break-system-packages && python3 -m playwright install chromium`, затем `python3 tools/e2e_test.py`. Должно напечатать `ALL PASSED`. Для нового поведения добавлять проверку туда же.
4. Выкладка: коммит, потом `git push origin main main:gh-pages`. Pages публикует ветку `gh-pages`, сайт обновляется у всех примерно за минуту.

## Правила
- Интерфейс трёхъязычный (по умолчанию эстонский). Каждой новой русской строке интерфейса нужна запись `[ru, en, et]` в `I18N_DICT` в `src/corpus.html`.
- Тот же `src/corpus.html` работает как артефакт в claude.ai (https://claude.ai/code/artifact/0690ff56-d9ba-46c0-ac2b-b10f2a1c201e, с файлами `ocr/*` и `anki/*`). Там есть ИИ-функции, на сайте их нет. Если Лев хочет обновить и его, опубликовать туда `src/corpus.html`. Веб-хуки там ничего не делают: `window.CORPUS_WEB` нет.
- Порядок колод и фото задаёт `createdAt`. Экспорт и импорт должны его сохранять.
- В репозиторий никаких секретов: в `config.js` только публичные URL и publishable key Supabase.
- Изменения базы: идемпотентный SQL в `supabase/setup.sql` плюс фрагмент для Льва, чтобы он запустил его в Supabase → SQL Editor.
