# Direct Web Postman

`postman/` содержит production transport между локальным Harness agent и ChatGPT Web. Входные файлы и временная публикация описаны в [Postman Input Files](POSTMAN_INPUT_FILES.md).

## Три transport mode

Artifact mode:

```text
@Postman <intent>
→ trusted current-turn capture
→ postman/direct/postman.ps1
→ ChatGPT Web
→ correlated ZIP
→ RESULT_DURABLE | ASSISTANT_COMPLETED_NO_ARTIFACT | ARTIFACT_REJECTED
```

Text mode:

```text
@PostmanAsk <intent>
→ trusted current-turn capture
→ postman/direct/postman-ask.ps1
→ ChatGPT Web
→ exact REQ-bound text envelope
→ TEXT_RESULT_DURABLE
```

Image MVP:

```text
@PostmanImage <описание одной картинки>
→ REQ_A: генерация одной картинки, завершение подтверждается ходом assistant с изображением, без текстового маркера
→ REQ_B: на той же открытой browser page автоматическая отправка в тот же чат — упаковка только что созданной картинки без изменений в ZIP
→ обычная проверка и загрузка ZIP → извлечение ровно одного PNG/JPEG/WEBP
→ IMAGE_RESULT_DURABLE с resultImage, imageSha256 и метаданными изображения (REQ_A)
```

В репозитории нет общего механизма Python-зависимостей. Для декодирования картинки установи `Pillow>=12,<13` в тот же Python, которым запускается `postman.ps1`: `python -m pip install "Pillow>=12,<13"`. Без него image flow завершается `IMAGE_DECODER_UNAVAILABLE` и не выдаёт непроверенный результат. В ZIP допускаются посторонние не-графические файлы, но изображение должно быть ровно одно. REQ_B — внутренний ход без отдельного task commit; ZIP сохраняется как промежуточное доказательство, но не регистрируется как implementation artifact. Поддерживается одна native PNG/JPEG/WebP/GIF reference image с exact bytes/SHA/card proof; несколько references, non-image inputs, редактирование и ручной `@PostmanImage --chat` пока unsupported. Normal current/local staging private; GitHub только existing immutable source или separately approved public fallback.

Artifact и text режимы поддерживают manual continuation:

```text
@Postman --chat <old REQ> <new intent>
@PostmanAsk --chat <old REQ> <new intent>
```

Автоматическое восстановление — одна попытка на исходный REQ/root chain, во всех трёх режимах. Direct принимает решение по capability: exact locally saved conversation, доказанный original Send (`PROVEN_SENT` или read-only reproof UNKNOWN), нет unresolved Send, durable результата или уже созданного Web artifact. Перед публикацией/Send новый REQ эксклюзивно фиксирует durable `recovery-<rootREQ>.claim`; restart и конкурирующий вызов не дают вторую попытку. Новый короткий intent продолжает работу, а не повторяет исходный запрос. `PROVEN_NOT_SENT` и недоказанный UNKNOWN → STOP. Ошибка download при уже созданном Web artifact не запускает новый Web message. Ручной `--chat` остаётся независимым новым запросом. Для Image обычный `--chat` создаёт новое изображение; automatic recovery после готового изображения сначала read-only доказывает исходный image assistant identity и запускает только упаковку без generation. Подробности — в [Current Flow](POSTMAN_CURRENT_FLOW.md).

## Supervisor mode: Postman Bridge

Для обычного пользовательского запроса умная локальная модель может работать как supervisor через:

```text
postman_bridge({ message: "@PostmanAsk ..." })
postman_bridge({ message: "@Postman ..." })
postman_bridge({ message: "@PostmanImage ..." })
```

`postman_bridge` доступен только top-level Agent с preset `postman-leader`; остальные Agents
получают runtime deny, а execute path повторно проверяет caller fail-closed. Для Leader модель
выбирается отдельно в model selector (`GPT-6 Sol`); preset намеренно не меняет model routing.

Bridge создаёт fresh one-shot Luna, передаёт ей exact model-authored delegation как child
`user/message`, после чего используются те же current-turn tools и Direct wrappers. Parent получает
trusted terminal result напрямую; Luna prose не является authority.

Canonical Bridge contract:

```text
postman/POSTMAN_BRIDGE_FLOW.md
```

Strategy skill:

```text
.agents/skills/postman-leader/SKILL.md
```

## Production entrypoints

```text
<current workspace>\postman\direct\postman.ps1
<current workspace>\postman\direct\postman-ask.ps1
```

Hardcoded Windows username не является частью production contract.

## Структура

- `POSTMAN_CURRENT_FLOW.md` — artifact transport lifecycle.
- `POSTMAN_ASK_FLOW.md` — text transport lifecycle.
- `POSTMAN_BRIDGE_FLOW.md` — supervisor → Luna Bridge → Direct Postman lifecycle.
- `direct/` — production wrappers, task publication и durable handoff.
- `web/` — Chrome/CDP, submit, observer, recovery, artifact/text correlation.
- `tests/`, `direct/tests/`, `web/tests/` — regression tests.

Artifact contract:

```text
docs/web-postman-artifact-contract.md
```

## Граница normal transport

Normal Postman не:

- применяет ZIP к repository;
- применяет artifact автоматически;
- создаёт implementation branch/commit/PR;
- делает blind resend после неопределённого transport outcome.

`postman_bridge` также не применяет artifact: следующий шаг выбирает parent Leader.
