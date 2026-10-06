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
| `supabase/stats.sql` | Статистика для админов: отметка «заходил сегодня» (`activity`), `corpus_site_stats` |
| `supabase/ai.sql` | Тарифы и дневные лимиты ИИ: `ai_plans`, `ai_usage`, функция `corpus_ai_take` |
| `supabase/share.sql` | Обмен колодами по коду / QR: таблица `shares`, функции `corpus_share_put`, `corpus_share_open` |
| `supabase/functions/corpus-ai/` | Edge Function: единственное место с ключом Claude API; проверяет вход и лимит, зовёт Claude |
| `ocr/`, `anki/`, `vendor/` | Tesseract.js, sql.js, fflate, fzstd, supabase-js, qrcode-generator |
| `tools/` | Тестовый сервер-заглушка Supabase и сквозной тест в браузере |

Данные лежат в одной таблице `public.docs (owner, coll, id) → data jsonb`. Коллекции те же, что в claude.ai: `decks`, `plates`, `packs`, `terms`, `stats`, `folders`, `meta`. Частичные обновления идут через RPC `corpus_doc_update` с рекурсивным слиянием, как у `update()` в claude.ai.

ИИ (подсказки, чат, распознавание подписей по фото, сверка с конспектом) на сайте идёт через функцию `corpus-ai` с ключом Claude API владельца. Текст обрабатывает Haiku 4.5, фото — Sonnet 5.5. Каждый запрос списывается с дневного лимита пользователя (фото = 1 + число фото). Пока функция не развёрнута, ИИ-кнопки на сайте скрыты. Распознавание подписей на устройстве (Tesseract) работает всегда.

## Обмен колодами по QR-коду

В меню колоды и папки есть «Поделиться по QR-коду». Приложение сохраняет снимок колоды (названия, рамки, текстовые карточки и ссылки на фото, без прогресса) в таблицу `public.shares` под случайным кодом из 10 букв и показывает QR-код, сам код и кнопку «Отправить ссылку». Другой человек наводит камеру на QR (ссылка вида `https://luzinlew.github.io/Corpus/?s=<код>`), либо вводит код в «Ещё → Получить по коду». После входа колода предлагается к импорту; фото копируются из общего бакета в его собственный Corpus, так что удаление у автора ничего не ломает.

У одной колоды или папки один код: открыв «Поделиться по QR-коду» снова, автор обновляет снимок, код не меняется. «Отозвать» удаляет снимок — ссылка и QR перестают работать, у тех, кто уже импортировал, колода остаётся. Открыть код может только вошедший пользователь; новому человеку по-прежнему нужна ссылка-приглашение для регистрации.

Настройка: Supabase → SQL Editor → выполнить `supabase/share.sql`. Пока таблицы нет, пункт меню показывает «Обмен по коду ещё не настроен на сайте».

```sql
-- кто что раздаёт и сколько раз открывали
select u.email, s.kind, s.name, s.code, s.opens, s.updated_at from public.shares s join auth.users u on u.id = s.owner order by s.updated_at desc;

-- отозвать чужой код
delete from public.shares where code = 'abcde23456';
```

## Импорт из Anki

Файл `.apkg` / `.colpkg` не распаковывается целиком: приложение читает оглавление архива и достаёт только коллекцию и те картинки, которые нужны выбранным колодам, прямо из файла по смещению (поддерживается zip64). Картинки декодируются вне главного потока, готовятся и загружаются по четыре одновременно, а документы (фото, колоды, пачки карточек) сохраняются в базу пакетами по сто штук в одном запросе — за это отвечает `setMany` в `web.js`. На claude.ai, где пакетной записи нет, документы по-прежнему пишутся по одному.

## ИИ: настройка и лимиты

1. Ключ: platform.claude.com → пополнить баланс → API Keys → Create key. Там же стоит поставить месячный лимит расходов.
2. Supabase → Edge Functions → Secrets: `ANTHROPIC_API_KEY` = ключ.
3. Supabase → Edge Functions → Deploy a new function → Via Editor: имя `corpus-ai`, код из `supabase/functions/corpus-ai/index.ts`.
4. Supabase → SQL Editor: выполнить `supabase/ai.sql`.

Сайт сам заметит функцию и включит ИИ. Модели можно сменить секретами `CORPUS_AI_MODEL` (текст) и `CORPUS_AI_VISION_MODEL` (фото).

```sql
-- бесплатный дневной лимит для всех
update private.settings set value = '30' where key = 'ai_free_daily';

-- тариф Pro / свой лимит конкретному человеку
insert into public.ai_plans (user_id, plan, daily_limit)
select id, 'pro', 200 from auth.users where email = 'friend@example.com'
on conflict (user_id) do update set plan = excluded.plan, daily_limit = excluded.daily_limit, updated_at = now();

-- кто сколько потратил за неделю
select u.email, a.day, a.used from public.ai_usage a join auth.users u on u.id = a.user_id
 where a.day > current_date - 7 order by a.day desc, a.used desc;
```

## Обновить приложение

1. Изменить `src/corpus.html` (и при необходимости `web.js` / `web.css` / `sw.js`).
2. `python3 build.py`, чтобы пересобрать `index.html` (у скриптов меняется `?v=`, и браузеры сразу берут новую версию).
3. `python3 tools/e2e_test.py`: сквозной тест на заглушке Supabase (включая импорт сгенерированного `.apkg` и обмен по коду между двумя аккаунтами), функция `corpus-ai` при этом работает по-настоящему в Deno. Нужны `pip install playwright pillow && python3 -m playwright install chromium` и `deno` (или `npx deno`).
4. Закоммитить и запушить: `git push origin main main:gh-pages`. Сайт публикуется из ветки `gh-pages`, GitHub Pages обновит его за минуту-две.

Чтобы обновить и артефакт в claude.ai, опубликуйте туда `src/corpus.html` вместе с `ocr/*` и `anki/*`.

## Администрирование (Supabase → SQL Editor)

Сайт: https://luzinlew.github.io/Corpus/ (адрес чувствителен к регистру: `Corpus`). Ссылка для друзей: `https://luzinlew.github.io/Corpus/?i=<код>`. Код из ссылки сохраняется на устройстве и подставляется при регистрации.

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

## Статистика сайта

Админы (email через запятую в `private.settings`, ключ `admins`) видят в приложении «Veel → Saidi statistika»: сколько людей зарегистрировано и заходило сегодня, за 7 и 30 дней, сколько ответов и ИИ-запросов, график по дням и список людей с последним заходом. Считаются только вошедшие пользователи: сайт раз в день отмечает, что человек его открывал. Сторонних счётчиков и cookies нет.

```sql
update private.settings set value = 'you@example.com, other@example.com' where key = 'admins';
```

## Ограничения бесплатного Supabase

- 500 МБ базы и 1 ГБ хранилища фото на весь проект. Для 5–10 человек обычно хватает.
- Проект засыпает после недели без активности. Разбудить: открыть его в панели Supabase и нажать Restore. Данные сохраняются.
- Встроенная почта Supabase шлёт письма только участникам команды проекта. Поэтому подтверждение email выключено, а пароль сбрасывается через SQL выше.

## Сторонний код

supabase-js (MIT), tesseract.js (Apache-2.0), sql.js (MIT), fflate (MIT), fzstd (MIT), qrcode-generator (MIT, Kazuhiko Arase; лицензия в шапке `vendor/qrcode.js`). Лицензия supabase-js лежит в `vendor/supabase-LICENSE.txt`.
