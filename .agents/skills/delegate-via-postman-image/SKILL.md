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
3. Отправку доказывают exact prompt + exact image membership + empty composer + bound URL + 0→1 user turn. После possible click `UNKNOWN` сохраняется; в этом вызове повторного клика нет, следующую явную команду решает Leader или пользователь. Не делай manual browser upload.
4. Generated image proof → IMAGE_TURN_COMPLETED → прежний packaging turn ровно один раз → verified ZIP → IMAGE_RESULT_DURABLE. Не объединяй generation и packaging.
5. При IMAGE_RESULT_DURABLE сообщи trusted requestId/resultImage metadata; не читай и не реконструируй image, не регистрируй implementation artifact, не запрашивай continuation. При ошибке верни trusted status; не выдумывай результат. Host не создаёт восстановительную отправку по исходу или тексту ошибки. Новую команду выбирает Leader либо пользователь; перед повторным Send проверь известные результаты и историю, чтобы не повторить уже выполненное. Старый Send/UNKNOWN сам по себе не блокирует новую явную команду, но не является разрешением transport child повторить её самостоятельно. В одном вызове одна попытка Send. Явный `--chat` использует собственную сохранённую беседу и отдельный REQ; готовые результаты не переигрываются.
