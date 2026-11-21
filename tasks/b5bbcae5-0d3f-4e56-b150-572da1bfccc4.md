POSTMAN_REQUEST_ID: REQ_20261121T104422Z_7473
Режим: WRITE_TEST. Область для чтения: C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\dcb4843b-04c9-495e-a589-eee4ac229b21\workspace
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:b5bbcae5-0d3f-4e56-b150-572da1bfccc4'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\b5bbcae5-0d3f-4e56-b150-572da1bfccc4\workspace. Исходная область только для чтения.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 10d2b65f7ea089d66d879130224a643977c2d7a9b47a28a497aefc233a01ea10
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/55c6b48376f8dd3747eaf2c16a734c430a42e94c/docs/workflow/TASK_CONTRACT.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\b5bbcae5-0d3f-4e56-b150-572da1bfccc4\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
RT-PARITY: по завершённому RT-LATENCY (cold ~4s / warm ~1.6s в in-process) проверь один предметный кандидат ускорения: два поисковых прохода scoped→fallback в RouteCostWorker.ts:310–321. Почему первый вернул ok:false в обоих случаях — точный reason, branch/input diff, семантика последующего поля/геометрии, profiling двух поисков отдельно. Сравни одинаковые warm requests, а не разные цели cold/warm. Если действительно есть один дешёвый строгий early guard, который всегда ведёт в тот же fallback и не меняет маршрута/опасности, покажи паритет принятого плана/позы/первого шага на коротком, длинном, обходном и unreachable + измеренное уменьшение поиска; portable узкий патч только при доказанной эквивалентности. Иначе NO_DIFF + факты и конкретный безопасный следующий рычаг; запрет ослаблять локальную проверку, считать неизвестную опасность нулём, пропускать непроверенный шаг или делать полную карту на юнита. RT-CHURN уже отдельно изменил NavigationRouteReplanner — не трогай его, only RouteCostWorker/necessary focused test. При необходимости используй одну настоящую native route_worker_threads проверку через подход, доказанный R4; различай её от твоего shim. В прошлой работе найденный stray JSON в read-only source не трогай; теперь любые временные файлы только под собственным абсолютным writer, не process.chdir source, ни одного перенаправления в чужой каталог; см. текущий readRoot с fixture, точный game source только для чтения C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\7cd5b7c7-682a-4936-a4bb-3eda2aef76d6\workspace\app, проверенное дерево 2f62307de8a992c28bf81b33d11ef1ca3ea2122a. Никаких VUDA/preview/commit/remote writes.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261121T104422Z_7473>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261121T104422Z_7473>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
