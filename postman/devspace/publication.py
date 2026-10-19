"""DevSpace documents on the existing GitHub transport, never a Git writer grant."""
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.request import urlopen

from postman import input_files
from postman.devspace import task
from postman.devspace.signal import atomic_json
from postman.direct.process_lock import lock_publication

BRANCH = "transport/postman-devspace"
BASE = "https://raw.githubusercontent.com/" + input_files.REPOSITORY + "/"
SOURCE_FILES = task.SOURCE_FILES
OWNER = ("requestId", "jobId", "leaderSessionId", "lunaSessionId", "mode", "workspaceRef", "writeRoot", "computerUse")
_SHA = re.compile(r"^[0-9a-f]{40}$")
_SECRET = re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b|\b(?:authorization\s*:\s*bearer|(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token|client[_-]?secret)['\"]?\s*[:=]\s*['\"]?[^\s'\"]+)", re.I)


def render_launch(task_url, rules_url):
    return ("Пожалуйста, выполни задание. Перед началом обязательно прочитай задание и правила по ссылкам ниже и соблюдай их. "
            "Если любой документ недоступен, сообщи об этом и не начинай работу.\n"
            "Задание: " + task_url + "\nПравила: " + rules_url)


def _receipt(binding, value):
    if (value.get("version") != 1 or any(value.get(key) != binding.get(key) for key in OWNER) or
            not _SHA.fullmatch(value.get("commit", "")) or not _SHA.fullmatch(value.get("sourceCommit", "")) or
            value.get("taskUrl") != BASE + value["commit"] + "/tasks/" + binding["jobId"] + ".md" or
            value.get("rulesUrl") != BASE + value["sourceCommit"] + "/postman/devspace/SKILL.md"):
        raise ValueError("POSTMAN_DEVSPACE_PUBLICATION_BINDING_CHANGED")
    return value


def read_publication(binding):
    file = Path(binding["channel"]) / "publication.json"
    if file.is_symlink() or file.resolve() != file.absolute() or file.stat().st_size > 65536:
        raise ValueError("POSTMAN_DEVSPACE_PUBLICATION_BINDING_CHANGED")
    return _receipt(binding, json.loads(file.read_text(encoding="utf-8")))


def bound_prompt(binding, prompt, *, task_url=None):
    try:
        if (Path(binding["channel"]) / "publication.json").exists():
            saved = read_publication(binding)
            return (task_url is None or task_url == saved["taskUrl"]) and prompt == render_launch(saved["taskUrl"], saved["rulesUrl"])
        return prompt.startswith("POSTMAN_REQUEST_ID: " + binding["requestId"] + "\n")
    except (OSError, ValueError, KeyError):
        return False


def saved_prompt(binding):
    if (Path(binding["channel"]) / "publication.json").exists():
        saved = read_publication(binding)
        return render_launch(saved["taskUrl"], saved["rulesUrl"])
    file = Path(binding["channel"]) / "task.md"
    if not file.exists():
        return "POSTMAN_REQUEST_ID: " + binding["requestId"] + "\n"  # old persisted channels
    if file.is_symlink() or file.resolve() != file.absolute() or file.stat().st_size > 1024 * 1024:
        raise ValueError("POSTMAN_DEVSPACE_PUBLICATION_BINDING_CHANGED")
    prompt = file.read_text(encoding="utf-8")
    if not bound_prompt(binding, prompt):
        raise ValueError("POSTMAN_DEVSPACE_PUBLICATION_BINDING_CHANGED")
    return prompt


def source_snapshot():
    commit = subprocess.check_output(["git", "-C", str(task.REPO), "rev-parse", "HEAD"], text=True).strip()
    if not _SHA.fullmatch(commit):
        raise ValueError("POSTMAN_DEVSPACE_INSTRUCTION_UNAVAILABLE: source revision")
    contents = {}
    for name in SOURCE_FILES:
        content = (task.REPO / name).read_bytes()
        tracked = subprocess.check_output(["git", "-C", str(task.REPO), "show", commit + ":" + name])
        if content.replace(b"\r\n", b"\n") != tracked.replace(b"\r\n", b"\n"):
            raise ValueError("POSTMAN_DEVSPACE_INSTRUCTION_UNAVAILABLE: unpublished " + name)
        contents[name] = tracked
    return commit, contents


def public_read(url):
    # No Authorization header, OAuth or credentials: the recipient must have the
    # same public access. Reject content redirected to another host.
    with urlopen(url, timeout=20) as response:
        if not response.url.startswith(BASE):
            raise ValueError("POSTMAN_DEVSPACE_PUBLICATION_UNAVAILABLE")
        return response.read(1024 * 1024 + 1)


def publish_assignment(binding, intent, command, *, publisher=None, fetch=public_read, source=source_snapshot):
    if _SECRET.search(intent) or binding.get("capability") and binding["capability"] in intent:
        raise ValueError("POSTMAN_DEVSPACE_PUBLICATION_CREDENTIAL_REJECTED")
    # Validate only the known instruction files, never serialize private binding.
    task.instruction_refs(binding)
    root = Path(binding["channel"])
    publisher = publisher or input_files.GitHubInputPublisher(branch=BRANCH)
    if publisher.branch != BRANCH:
        raise ValueError("POSTMAN_DEVSPACE_PUBLICATION_BINDING_CHANGED")
    with lock_publication(root.parent, input_files.REPOSITORY, BRANCH):
        receipt = root / "publication.json"
        reused = receipt.exists()
        if reused:
            value = read_publication(binding)
            if value.get("intentSha256") != hashlib.sha256(intent.encode("utf-8")).hexdigest():
                raise ValueError("POSTMAN_DEVSPACE_PUBLICATION_BINDING_CHANGED")
            content = (root / "assignment.md").read_bytes()
            if hashlib.sha256(content).hexdigest() != value["taskSha256"]:
                raise ValueError("POSTMAN_DEVSPACE_PUBLICATION_BINDING_CHANGED")
        else:
            revision, rules = source()
            if not _SHA.fullmatch(revision) or set(rules) != set(SOURCE_FILES):
                raise ValueError("POSTMAN_DEVSPACE_INSTRUCTION_UNAVAILABLE: incomplete source snapshot")
            content = task.render_task(binding, intent, command, source_commit=revision).encode("utf-8")
            rules_url = BASE + revision + "/postman/devspace/SKILL.md"
            for name, expected in rules.items():
                try:
                    if fetch(BASE + revision + "/" + name) != expected:
                        raise ValueError("different public instruction")
                except Exception as error:
                    raise ValueError("POSTMAN_DEVSPACE_INSTRUCTION_UNAVAILABLE: " + name) from error
            parent = publisher._head()
            path = "tasks/" + binding["jobId"] + ".md"
            # Recover publication-before-receipt crashes by reading the same
            # immutable job path; never overwrite a different assignment.
            existing = None
            if parent:
                try:
                    entry = publisher.api(f"repos/{input_files.REPOSITORY}/contents/{path}?ref={parent}")
                    existing = base64.b64decode(entry["content"])
                except input_files.InputStageError as error:
                    if "404" not in str(error):
                        raise
            if existing is not None:
                if existing != content:
                    raise ValueError("POSTMAN_DEVSPACE_PUBLICATION_BINDING_CHANGED")
                commit = parent
            else:
                blob = publisher.api(f"repos/{input_files.REPOSITORY}/git/blobs", "POST",
                                     {"content": base64.b64encode(content).decode("ascii"), "encoding": "base64"})["sha"]
                commit = publisher._commit(parent, [{"path": path, "mode": "100644", "type": "blob", "sha": blob}],
                                           "postman: publish DevSpace assignment " + binding["jobId"])
            value = _receipt(binding, {"version": 1, **{key: binding.get(key) for key in OWNER},
                "commit": commit, "sourceCommit": revision, "taskUrl": BASE + commit + "/" + path,
                "rulesUrl": rules_url, "taskSha256": hashlib.sha256(content).hexdigest(),
                "intentSha256": hashlib.sha256(intent.encode("utf-8")).hexdigest()})
            (root / "assignment.md").write_bytes(content)
            atomic_json(receipt, value)
        if fetch(value["taskUrl"]) != content:
            raise ValueError("POSTMAN_DEVSPACE_PUBLICATION_UNAVAILABLE")
        if reused:
            for name in SOURCE_FILES:
                try:
                    fetch(BASE + value["sourceCommit"] + "/" + name).decode("utf-8")
                except Exception as error:
                    raise ValueError("POSTMAN_DEVSPACE_INSTRUCTION_UNAVAILABLE: " + name) from error
        return {**value, "prompt": render_launch(value["taskUrl"], value["rulesUrl"])}
