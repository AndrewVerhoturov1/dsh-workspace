# Codex OAuth в DeepSeek Harness

Актуальная схема для текущего `web` profile использует локальный пакет `dsh-codex-oauth` версии `0.1.8` и provider route `codex`.

## Где находится реализация

Исходники локальной версии:

```text
packages/dsh-codex-oauth/
```

Production profile подключает готовый пакет:

```text
vendor/dsh-codex-oauth-0.1.8.tgz
```

через `profiles/web/package.json`.

## Где хранятся OAuth-данные

Плагин хранит Codex OAuth credentials в:

```text
$DSH_HOME/codex-oauth.json
```

Для стандартного локального Harness это обычно:

```text
C:\Users\Andrew\.dsh\codex-oauth.json
```

Этот файл содержит секреты и не должен попадать в Git. Он уже исключён через `.gitignore`.

Старая схема `llm-pi-ai/openai-codex` + `.credentials.yaml` из истории репозитория не является текущей схемой этого плагина.

## Вход через Web UI

В Harness выполнить человеческую команду:

```text
/codex login
```

Плагин запускает OAuth flow, открывает страницу авторизации и после успешного входа сохраняет credentials в `codex-oauth.json`.

Полезные команды:

```text
/codex status
/codex logout
```

## Вход из терминала

Для обычного browser flow:

```powershell
npx dsh-codex-oauth login
```

Для device-code flow:

```powershell
npx dsh-codex-oauth login --method device
```

Проверка состояния:

```powershell
npx dsh-codex-oauth status
```

Выход:

```powershell
npx dsh-codex-oauth logout
```

Web UI и CLI используют одно и то же хранилище credentials.

## Выбор provider и модели

Текущий provider route:

```text
codex
```

В Web UI модель выбирается через model picker.

Для конфигурации через patch используется форма:

```yaml
- id: agent-default-model
  config:
    provider: codex
    model: <model-id-from-current-catalog>
```

Пакет `0.1.8` сохраняет проверенный transport/image path из `0.1.7` на `@earendil-works/pi-ai` `0.85.1`, но локально backfill-ит metadata для `gpt-6-sol` и `gpt-6-luna` из upstream `pi-ai` `0.87.1`. Обе модели объявлены как `text + image`; существующие записи `pi-ai` имеют приоритет, поэтому после будущего обновления каталога shim не создаёт дубликаты.

Не следует фиксировать в этой инструкции конкретный модельный ID как обязательный: доступный каталог может меняться вместе с пакетом и `pi-ai`.

## Конфигурация плагина

Основные параметры `dsh-codex-oauth`:

- `provider` — route id, по умолчанию `codex`;
- `storePath` — путь к OAuth store, по умолчанию `$DSH_HOME/codex-oauth.json`;
- `transport` — `sse`, `websocket`, `websocket-cached` или `auto`;
- `cacheRetention` — режим prompt-cache retention;
- `streamIdleTimeoutMs` — idle timeout provider stream.

Точные defaults и поддерживаемые опции находятся в:

```text
packages/dsh-codex-oauth/README.md
packages/dsh-codex-oauth/package.json
```

## Если авторизация перестала работать

Порядок проверки:

1. Выполнить `/codex status` или `npx dsh-codex-oauth status`.
2. При необходимости повторить `/codex login` либо CLI login.
3. Перезапустить Harness, если текущий процесс был запущен до обновления credentials или пакета.
4. Проверить, что выбран provider `codex`.
5. Если нужной модели нет в picker, сначала проверить текущий catalog `pi-ai`, а не менять OAuth credentials вслепую.

Не удалять `.credentials.yaml` ради ремонта `dsh-codex-oauth`: это отдельное хранилище, которое может относиться к другим provider integrations.

## Security

Не публиковать содержимое:

```text
codex-oauth.json
.credentials.yaml
```

в Git, логах, task-файлах, сообщениях или implementation packages.

Не вставлять OAuth token в обычное поле OpenAI API key. Codex subscription OAuth и OpenAI Platform API key — разные механизмы.
