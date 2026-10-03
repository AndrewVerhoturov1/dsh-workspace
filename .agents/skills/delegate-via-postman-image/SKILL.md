---
name: delegate-via-postman-image
description: >-
  Использовать только когда ТЕКУЩЕЕ сообщение после начальных пробелов начинается
  с exact @PostmanImage. Trusted Host выполняет native image transport через
  no-argument postman_send_current_turn(), затем прежнюю упаковку результата.
---

# Direct PostmanImage

Триггер: `^\s*@PostmanImage(?:\s|$)`. Разработка Postman не даёт разрешения на отправку. При недоступности skill — STOP, без альтернативной отправки.

Native ChatGPT attachment is the primary input-file transport. Never publish a user/local input to GitHub merely so ChatGPT can read it when native attachment delivery is available. GitHub public staging is fallback-only and requires explicit user approval.

Visual references are native image attachments whenever Host can resolve their bytes. Host-authorized descriptors/grants передаёт parent Host/Leader без изменения. 1–7 reference images PNG/JPEG/WebP/GIF → private request-bound snapshot → exact SHA/length/type → native image FilePayload в первом generation user turn. Восемь references или non-image inputs явно unsupported; никакого raw_url fallback. Текущий SDK читает current images только через readImage; generic current files дают capability-unavailable, не path guessing.

1. После загрузки этого skill вызови `postman_send_current_turn()` без аргументов. Не копируй current text, descriptors или bytes в shell/Base64/новый prompt; child не строит attachments и не публикует inputs.
2. Жди через `postman_current_turn_status()` до terminal; не создавай второй REQ.
3. Отправку доказывают exact prompt + exact image membership + empty composer + bound URL + 0→1 user turn. После possible click `UNKNOWN` запрещает resend. Не делай manual browser upload.
4. Generated image proof → IMAGE_TURN_COMPLETED → прежний packaging turn ровно один раз → verified ZIP → IMAGE_RESULT_DURABLE. Не объединяй generation и packaging.
5. При IMAGE_RESULT_DURABLE сообщи trusted requestId/resultImage metadata; не читай и не реконструируй image, не регистрируй implementation artifact, не запрашивай continuation. При ошибке верни trusted status; не выдумывай результат. Автоматическое восстановление — одна попытка на исходный REQ/root chain, во всех трёх режимах. Direct принимает решение по capability: exact locally saved conversation, доказанный original Send (`PROVEN_SENT` или read-only reproof UNKNOWN), нет unresolved Send, durable результата или уже созданного Web artifact. Перед публикацией/Send новый REQ эксклюзивно фиксирует durable `recovery-<rootREQ>.claim`; restart и конкурирующий вызов не дают вторую попытку. Новый короткий intent продолжает работу, а не повторяет исходный запрос. `PROVEN_NOT_SENT` и недоказанный UNKNOWN → STOP. Ошибка download при уже созданном Web artifact не запускает новый Web message. Ручной `--chat` остаётся независимым новым запросом. Для Image обычный `--chat` создаёт новое изображение; automatic recovery после готового изображения сначала read-only доказывает исходный image assistant identity и запускает только упаковку без generation.
