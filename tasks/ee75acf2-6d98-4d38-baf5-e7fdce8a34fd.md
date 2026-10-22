POSTMAN_REQUEST_ID: REQ_20261022T150115Z_4868
Режим: READ_ONLY. Область для чтения: C:\PROJECTS\Real-tactic-wargame
Сначала открой назначенную область обычным open_workspace с path="C:\\PROJECTS\\Real-tactic-wargame". В READ_ONLY не используй postman-writer. Записи в любые файлы запрещены, кроме bell ниже.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 291170eb9f1e384b74b7ae05bb566105fde44a468fbe40610204467f9e08ffdf
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ddab1baba737e9fd52566d130f32472be0c5f76e/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ddab1baba737e9fd52566d130f32472be0c5f76e/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ddab1baba737e9fd52566d130f32472be0c5f76e/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/ddab1baba737e9fd52566d130f32472be0c5f76e/docs/workflow/TASK_CONTRACT.md
- C:\PROJECTS\Real-tactic-wargame\AGENTS.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\ee75acf2-6d98-4d38-baf5-e7fdce8a34fd\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Найди актуальные практические рекомендации для ChatGPT Images/GPT Image: как использовать несколько прикреплённых референсов с разными ролями (геометрия солдат, рисованные фактуры окружения, тонкий тёмный контур), чтобы модель не смешивала все стили и не копировала композицию. Пользователь хочет ZIP с образцами и подробным MD-промптом, который вставит в ChatGPT вместе с ZIP. Нужны подтверждённые официальными источниками факты: может ли ChatGPT image generation видеть/использовать PNG внутри ZIP непосредственно; надёжнее ли приложить сами изображения отдельно; как называть/адресовать refs, явно разделять положительные признаки и ограничения; лучше ли итеративное редактирование одного изображения вместо повторного полного длинного задания. Отдели web ChatGPT UI от API input_fidelity/quality и прочих API-only параметров. Не утверждай автоматическую загрузку ref из ZIP без источника. Приоритет OpenAI Help/официальная документация/cookbook, максимум 4–6 полезных источников с буквальными полными URL, дата чтения, конкретные применимые советы. Запрос только на веб-исследование, без локальных файлов, картинки НЕ генерировать, DSH/игру не трогать. Заверши обычным русским текстом БЕЗ местного bell. Если веб-инструмент недоступен, явно CAPABILITY_UNAVAILABLE, не имитируй поиск. Готово после достаточных рекомендаций и точных ссылок, затем остановись.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261022T150115Z_4868>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261022T150115Z_4868>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
