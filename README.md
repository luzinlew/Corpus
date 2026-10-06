# Corpus — веб-версия

Corpus — карточки по анатомии из фото атласа: рамки на подписях, интервальные повторения (FSRS / SM-2), режимы «Скрыть все», «Выбор», «Ввод», импорт из Anki, распознавание подписей на устройстве.

Сайт работает на GitHub Pages, аккаунты, колоды и фото хранятся в Supabase. Каждый пользователь видит только свои данные. Менять само приложение может только владелец репозитория.

## Как устроено

| Файл | Что это |
|---|---|
| `src/corpus.html` | Само приложение. Тот же файл, что артефакт Corpus в claude.ai |
| `web.js` | Веб-среда: даёт приложению `window.claude.use('db' / 'assets' / 'downloads' / 'user')` поверх Supabase, экран входа и регистрации |
| `sw.js` | Service worker: отдаёт фото по адресу `<сайт>/_blob/<id>` из Supabase Storage и кэширует их на устройстве |
| `config.js` | URL проекта Supabase и publishable key (оба публичные) |
| `index.html` | Собирается из `src/corpus.html` командой `python3 build.py`. Руками не править |
| `supabase/setup.sql` | Разовая настройка базы: таблица `docs` с RLS, бакет `plates`, проверка кода приглашения |
| `ocr/`, `anki/`, `vendor/` | Tesseract.js, sql.js, fflate, fzstd, supabase-js |
| `tools/` | Тестовый сервер-заглушка Supabase и сквозной тест в браузере |

Данные лежат в одной таблице `public.docs (owner, coll, id) → data jsonb`. Коллекции те же, что в claude.ai: `decks`, `plates`, `packs`, `terms`, `stats`, `folders`, `meta`. Частичные обновления идут через RPC `corpus_doc_update` с рекурсивным слиянием, как у `update()` в claude.ai.

Функции, которым нужен Claude (подсказки, чат, распознавание через ИИ), есть только в версии на claude.ai. На сайте они скрыты. Распознавание подписей на устройстве (Tesseract) работает везде.

## Обновить приложение

1. Изменить `src/corpus.html` (и при необходимости `web.js` / `web.css` / `sw.js`).
2. `python3 build.py`, чтобы пересобрать `index.html` (у скриптов меняется `?v=`, и браузеры сразу берут новую версию).
3. `python3 tools/e2e_test.py`: сквозной тест на заглушке Supabase. Нужен `pip install playwright && python3 -m playwright install chromium`.
4. Закоммитить и запушить в `main`. GitHub Pages обновит сайт за минуту-две.

Чтобы обновить и артефакт в claude.ai, опубликуйте туда `src/corpus.html` вместе с `ocr/*` и `anki/*`.

## Администрирование (Supabase → SQL Editor)

Ссылка для друзей: `https://<логин>.github.io/corpus/?i=<код>`. Код из ссылки сохраняется на устройстве и подставляется при регистрации.

```sql
-- сменить код приглашения (старые ссылки перестанут работать для новых регистраций)
update private.settings set value = 'новыйкод' where key = 'invite';

-- открыть регистрацию всем, у кого есть адрес сайта
update private.settings set value = '' where key = 'invite';

-- задать пользователю новый пароль (письма для сброса пароля не отправляются)
update auth.users set encrypted_password = extensions.crypt('новый-пароль', extensions.gen_salt('bf'))
 where email = 'friend@example.com';

-- кто зарегистрирован
select email, created_at, last_sign_in_at from auth.users order by created_at;
```

Удалить пользователя: Authentication → Users → Delete user. Его колоды удалятся вместе с ним, фото останутся в бакете `plates`.

Пользователей, созданных кнопкой «Add user» в панели Supabase, блокирует проверка приглашения: у них нет кода. Друзья регистрируются сами по ссылке.

## Ограничения бесплатного Supabase

- 500 МБ базы и 1 ГБ хранилища фото на весь проект. Для 5–10 человек обычно хватает.
- Проект засыпает после недели без активности. Разбудить: открыть его в панели Supabase и нажать Restore. Данные сохраняются.
- Встроенная почта Supabase шлёт письма только участникам команды проекта. Поэтому подтверждение email выключено, а пароль сбрасывается через SQL выше.

## Сторонний код

supabase-js (MIT), tesseract.js (Apache-2.0), sql.js (MIT), fflate (MIT), fzstd (MIT). Лицензия supabase-js лежит в `vendor/supabase-LICENSE.txt`.
