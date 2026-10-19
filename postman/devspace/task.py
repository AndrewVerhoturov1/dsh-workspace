"""Private Devspace REQ: task-specific authority plus readable instruction refs."""
import hashlib
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SOURCE_FILES = ("postman/devspace/SKILL.md", "AGENTS.md", "REPO_POLICY.md", "docs/workflow/TASK_CONTRACT.md")


def instruction_refs(binding):
    # Host source, never a Leader-supplied instruction root. Project rules are
    # confined to the already assigned workspace; refs confer no write rights.
    files = [REPO / name for name in SOURCE_FILES]
    area = Path(binding["workspaceRef"])
    for name in ("AGENTS.md", "REPO_POLICY.md", "docs/workflow/TASK_CONTRACT.md", "SUBPROJECT.md"):
        candidate = area / name
        try:
            candidate.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise ValueError("POSTMAN_DEVSPACE_INSTRUCTION_UNAVAILABLE: " + str(candidate)) from error
        files.append(candidate)
    paths, digest = [], hashlib.sha256()
    for file in dict.fromkeys(files):
        try:
            if not file.is_absolute() or file.resolve(strict=True) != file.absolute() or not file.is_file():
                raise ValueError("redirected instruction")
            content = file.read_bytes()
            content.decode("utf-8")
        except (OSError, ValueError) as error:
            raise ValueError("POSTMAN_DEVSPACE_INSTRUCTION_UNAVAILABLE: " + str(file)) from error
        paths.append(str(file))
        digest.update(str(file).encode("utf-8") + b"\0" + content + b"\0")
    return paths, digest.hexdigest()


def render_task(binding, intent, signal_command, *, source_commit=None):
    mode = binding["mode"]
    area, write = binding["workspaceRef"], binding["writeRoot"]
    files, fingerprint = instruction_refs(binding)
    source_files = {REPO / name for name in SOURCE_FILES}
    refs = []
    for file in files:
        link = file
        if source_commit and Path(file) in source_files:
            link = "https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/" + source_commit + "/" + Path(file).relative_to(REPO).as_posix()
        refs.append("- " + link)
    refs = "\n".join(refs)
    if mode == "READ_ONLY":
        access = ("Сначала открой назначенную область обычным open_workspace с path=" + json.dumps(str(area), ensure_ascii=False) +
                  ". В READ_ONLY не используй postman-writer. Записи в любые файлы запрещены, кроме bell ниже.")
    else:
        access = ("Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:" +
                  binding["jobId"] + "'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; "
                  "не обходи его открытием буквального пути. Запись только внутри " + str(write) + ".")
        if mode == "WRITE_TEST":
            access += " Исходная область только для чтения."
    computer_use = "разрешил" if binding.get("computerUse") == "allow" else "запретил"
    # This is the linked task document. Its REQ is never copied into chat text.
    return f"""POSTMAN_REQUEST_ID: {binding['requestId']}
Режим: {mode}. Область для чтения: {area}
{access}
Leader {computer_use} Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: {fingerprint}
{refs}
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
{signal_command} <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader (не расширяет перечисленные ограничения)
{intent}
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:{binding['requestId']}>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:{binding['requestId']}>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
"""
