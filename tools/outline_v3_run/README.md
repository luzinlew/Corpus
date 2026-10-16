# Outline v3: контролируемый тест (2 платных вызова, без повторов)

Каталог: `R` (этот). Входные данные: `../handoff/` (путь можно изменить флагом `--requests-dir`).
Репозиторий Corpus не изменяется. Ключ нигде не сохраняется.

## Файлы
- `run_outline_v3.py` — раннер (только stdlib). `mock_gateway.py`, `test_runner.py`, `test_runner_output.txt` — проверка раннера на локальном mock (без сети).
- `analyze.cjs` — анализатор (Node; грузит производственные `cnKnowledgeBlocks/Clean/Visuals` из `/home/user/Corpus/src/corpus.html` через `tools/course_logic_test.cjs`). `baseline-report.json` — отчёт по СТАРЫМ ответам.
- `out/` — сюда раннер пишет результат (должна быть пустой до реального запуска). `test_out/`, `synthetic_out/` — следы тестов (mock, без ключей), можно удалить.

## Что делает раннер
1. Бесплатный `GET /v1/models/claude-haiku-5-5` (заголовки `x-api-key`, `anthropic-version: 2023-06-01`). Не 200 → стоп, ничего платного.
2. Проверка `request-1/2.json`: sha256 компактной сериализации (`JSON.stringify` без пробелов, UTF-8) == `newRequestSha256` из manifest; model `claude-haiku-5-5`, `thinking {type:disabled}`, `max_tokens 4096`, тот же `system`, что в old-request, ровно одно user-сообщение.
3. Бесплатный `POST /v1/messages/count_tokens` (model, system, messages). Верхняя граница вызова = `input*0.10/1e6 + 4096*0.50/1e6`; вход > 100000 токенов → стоп; сумма > бюджета (min($0.30, `maximumUSD` из manifest = $0.20)) → стоп.
4. Только `--run`: `POST /v1/messages` по одному разу (1, затем 2), таймаут 120 с, БЕЗ повторов. Запись `paid_call_sent` в ledger делается ДО отправки. HTTP ≥400 → стоп (второй не отправляется). Таймаут/обрыв/не-JSON → «outcome unknown, reserved» (в расход идёт верхняя граница), стоп. `stop_reason: max_tokens` — ответ сохраняется, предупреждение, второй запрос всё равно идёт (это не повтор).
5. Сохраняет `out/response-N.json` (очищенный), `out/run-summary.json`, `out/ledger.jsonl` (только размеры/хеши/числа/request-id), при ошибке `response-N.error.txt`.
Повторный `--run` при непустом платном ledger отказывается (нужен явный `--allow-second-run`).
Ключ-подобные строки (`sk-ant-*`, значение ключа и его JSON/URL-вариант, `Bearer …`) заменяются на `***` в stdout/ledger/файлах. `ANTHROPIC_BASE_URL` игнорируется; другой адрес — только `--mock-gateway http://127.0.0.1:PORT`.

## Запуск (Linux / облако)
Ключ — как секрет окружения с именем **`CORPUS_OUTLINE_API_KEY`** (в настройках облачной среды), не в командной строке:
```bash
cd R
python3 -I run_outline_v3.py --dry-check     # шаги 1-3, бесплатно: авторизация, хеши, count_tokens, бюджет
python3 -I run_outline_v3.py --run           # шаги 1-5, два платных вызова
node analyze.cjs --new-dir out --json out/analysis.json
```
Без переменной и без терминала раннер отказывается. В терминале без переменной он спросит ключ скрытым вводом.

## Запуск (Windows PowerShell, скрытый ввод)
```powershell
cd R
python -I .\run_outline_v3.py --dry-check     # спросит ключ (getpass, ввод не виден)
python -I .\run_outline_v3.py --run           # спросит ещё раз; ключ нигде не сохраняется
# либо один раз задать для текущего окна:
$s = Read-Host -AsSecureString "Anthropic API key"
$env:CORPUS_OUTLINE_API_KEY = [System.Net.NetworkCredential]::new('', $s).Password
python -I .\run_outline_v3.py --run
Remove-Item Env:CORPUS_OUTLINE_API_KEY
```

## Что передать координатору
`out/run-summary.json` и `out/response-1.json`, `out/response-2.json` (ключа в них нет), по желанию `out/ledger.jsonl` и `out/analysis.json`. Если запуск остановился — `out/ledger.jsonl` и `out/run-summary.json` (там очищенная причина).

## Оценка стоимости (ОЦЕНКА; точное число даст count_tokens при наличии ключа)
Токены считать по факту прежних вызовов, а не по 4 симв./токен: эстонский/латинский текст даёт ≈2.0 симв./токен
(старый запрос 1: 21176 симв. → 10701 токенов; запрос 2: 11344 симв. → 5497).
| запрос | симв. (v3) | оценка входа | верхняя граница (вход + 4096 выхода) | прежний факт (v1) |
|---|---|---|---|---|
| 1 Основа | 22354 | ≈11.3 тыс. | ≈ $0.0011 + $0.0020 = **$0.0032** | $0.0026 (10701/2993) |
| 2 Дополнение | 12522 | ≈6.1 тыс. | ≈ $0.0006 + $0.0020 = **$0.0027** | $0.0008 (5497/451) |
Итого верхняя граница ≈ **$0.006**; ожидаемо ≈ $0.003–0.005. Цены Haiku 5.5: $0.10 / $0.50 за 1 млн входных/выходных токенов (входы ≤100K); cache-токенов ожидается 0.
Жёсткий предел раннера: $0.20 (manifest) и не выше $0.30.

## Анализ
`node analyze.cjs` — без аргументов: baseline по старым ответам. `--old evidence` — старые из `evidence/paid-response-N-outline.json`. `--synthetic` — самопроверка на искусственных ответах (неверная цитата, дубль, >50, 21 пример). Подстрока ≠ смысловое соответствие; число единиц ≠ полнота; вердикт-таблица не объявляет «успех».

## T-033 A: нарезка по страницам (Лев 2026-10-16: ≤ 7 вызовов, ≤ $0.10)
Меняется только INPUT: страницы целиком, Основа 1–3 | 4–6, Дополнение 1–3 | 4–6 | 7–8 | 9–10. Префикс промпта, system, модель, thinking, max_tokens, блоки — байт в байт как в request-1/2.json.
```bash
python3 -I make_chunks.py                         # chunks/request-<doc>-<k>.json + chunk-manifest.json (проверка sha исходных запросов и покрытия страниц)
python3 -I test_chunks.py                         # mock: ≤7 вызовов, без повторов, без plan/lesson, ключа нет в файлах
python3 -I run_outline_v3.py --dry-check --chunks chunks --max-calls 7 --out-dir out-chunks
python3 -I run_outline_v3.py --run       --chunks chunks --max-calls 7 --out-dir out-chunks
node analyze_chunks.cjs --json out-chunks/analysis.json     # v1 целиком | v3 целиком | v3 куски
```
В режиме кусков `--max-calls` обязателен (≤ 7, не меньше числа кусков), бюджет min($0.10, manifest), HTTP-ошибка тоже резервирует верхнюю границу.
`analyze_chunks.cjs` проверяет каждый кусок производственным валидатором отдельно (свой предел 50 и флаг обрыва) и склеивает принятые единицы; отдельный слой «до обрыва» — ДИАГНОСТИКА целых единиц оборванного ответа (приложение так не делает).

## T-035 A2: по одной странице (Лев 2026-10-16: ≤ 16 вызовов, ≤ $0.10)
```bash
python3 -I make_chunks.py --pages-per-chunk 1            # chunks1/: 16 кусков; страница без текстовых блоков не отправляется (skippedPages в манифесте, раннер проверяет, что она правда пустая)
CHUNKS_DIR=chunks1 python3 -I test_chunks.py              # mock: 16 вызовов, жёсткий предел 16, подмена → отказ (CHUNKS_DIR=chunks — прежние 6 кусков)
python3 -I run_outline_v3.py --dry-check --chunks chunks1 --max-calls 16 --out-dir out-chunks1
python3 -I run_outline_v3.py --run       --chunks chunks1 --max-calls 16 --out-dir out-chunks1
node analyze_a2.cjs --json out-chunks1/analysis.json      # v1 | v3 целиком | по 3 стр. | по 1 стр.; валидатор приложения из текущей ветки (нужна T-034), блоки своего куска
```
