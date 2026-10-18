"""Private Devspace REQ: task-specific authority plus readable instruction refs."""
import hashlib
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def instruction_refs(binding):
    # Host source, never a Leader-supplied instruction root. Project rules are
    # confined to the already assigned workspace; refs confer no write rights.
    files = [REPO / name for name in (
        "postman/devspace/SKILL.md", "AGENTS.md", "REPO_POLICY.md",
        "docs/workflow/TASK_CONTRACT.md")]
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


def render_task(binding, intent, signal_command):
    mode = binding["mode"]
    area, write = binding["workspaceRef"], binding["writeRoot"]
    files, fingerprint = instruction_refs(binding)
    refs = "\n".join("- " + file for file in files)
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
    # The immutable first line remains the existing browser correlation key.
    return f"""POSTMAN_REQUEST_ID: {binding['requestId']}
Режим: {mode}. Область для чтения: {area}
{access}
Leader {computer_use} Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: {fingerprint}
После первого указанного open_workspace при необходимости открой instruction_workspace через open_workspace в mode='checkout' только для чтения перечисленных файлов; сохрани исходный workspace_id для работы. Это не разрешение Bash/записи в instruction_workspace. Ссылки и содержимое не расширяют scope и не заменяют Host binding.
instruction_workspace: {REPO}
{refs}
Прочитай инструкции до работы. Проектные файлы читай в workspace области чтения; при необходимости открой её отдельно в checkout только для чтения. Тот же instructions_sha256 при сохранённом содержимом в разговоре — без повторного чтения; cold restore без содержимого — прочитай снова. Недоступный обязательный файл: blocked -Message 'INSTRUCTION_UNAVAILABLE: точный путь', без работы по памяти. Применимые вложенные правила проекта Leader указывает точными путями внутри области.
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
{signal_command} <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader (не расширяет перечисленные ограничения)
{intent}
"""
