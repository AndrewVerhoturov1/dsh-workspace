#!/usr/bin/env python3
from __future__ import annotations
from pathlib import Path
import argparse

def _read(path: Path):
    raw=path.read_bytes().decode('utf-8-sig')
    crlf=raw.count('\r\n'); lf=raw.count('\n')
    eol='\r\n' if crlf and crlf >= max(1, lf//2) else '\n'
    return raw.replace('\r\n','\n'), eol

def _write(path: Path,text: str,eol: str):
    data=text if eol=='\n' else text.replace('\n','\r\n')
    path.write_bytes(data.encode('utf-8'))

def rep(text,old,new,label):
    c=text.count(old)
    if c!=1: raise SystemExit(f'PATCH_GUARD_FAILED:{label}: expected 1 match, got {c}')
    return text.replace(old,new,1)

def patch_skill(text):
    text=rep(text,'`DIRECT_POSTMAN_SKILL_VERSION: 11`','`DIRECT_POSTMAN_SKILL_VERSION: 12`','version')
    old='''## 0. Золотой путь

После активации этого skill нормальный production-flow всегда такой:

```text
точный user intent
→ один canonical REQ
→ один foreground-вызов Direct Postman
→ ждать terminal JSON
→ RESULT_DURABLE
→ PREPARE: один вызов prepare_result.ps1
→ READY_FOR_TEST
→ TEST: один вызов test_result.ps1
→ TEST_PASSED
→ PUBLISH: один вызов publish_result.ps1
→ PUBLISHED
→ RESULT_WORKSPACE_REGISTERED
→ RESULT_PRESENTED (если известна пользовательская точка входа)
→ отчёт пользователю
```

Не проектируй другой transport flow.

После загрузки этого skill не вызывай `delegate-via-postman` повторно в этой же операции.
'''
    new='''## 0. Золотой путь

После активации этого skill нормальный production-flow всегда такой:

```text
точный user intent
→ один canonical REQ
→ один foreground-вызов Direct Postman
→ ждать terminal JSON
→ RESULT_DURABLE
→ определить один task-scoped semantic test
→ создать UTF-8 TestScript/TestSpec вне implementation worktree
→ RESUME: использовать только resume_request.ps1
→ READY_FOR_TEST → TEST_PASSED → PUBLISHED внутри resumable state machine
→ RESULT_WORKSPACE_REGISTERED
→ RESULT_PRESENTED (если известна пользовательская точка входа)
→ отчёт пользователю с кликабельными ссылками на authoritative changedFiles
```

`resume_request.ps1` — единственный normal local-finalization entrypoint после
`RESULT_DURABLE`. PREPARE, TEST и PUBLISH остаются внутренними детерминированными
стадиями state machine, а не отдельными командами Luna.

Если semantic test нельзя корректно определить до PREPARE, разрешены два вызова
ТОГО ЖЕ `resume_request.ps1`: первый без test input доводит exact REQ только до
`READY_FOR_TEST`; после создания TestScript/TestSpec второй продолжает тот же REQ до
`PUBLISHED`. Это resume одного lifecycle, а не новый transport flow.

Не проектируй другой transport flow.

После загрузки этого skill не вызывай `delegate-via-postman` повторно в этой же операции.
'''
    text=rep(text,old,new,'golden')
    s=text.index('### Канонический durable handoff и resume'); e=text.index('\n## 10. Что Direct Postman уже доказал',s)
    new='''### Канонический durable handoff и resume

После успешного `RESULT_DURABLE` Direct Postman атомарно сохраняет канонический
terminal JSON в deterministic path:

```text
C:\\Users\\andre\\AppData\\Local\\DSH\\Postman\\direct\\results\\<REQ>.json
```

Этот файл является durable источником истины для локального продолжения. Он
содержит `ok=true`, `code=RESULT_DURABLE`, `state=RESULT_DURABLE`, transport identity,
`baseCommit`, `taskPublicationCommit`, `taskUrl`, `expectedFilename`, `resultZip`,
`sha256`, `resultRoot` и `statePath`.

Normal resume entrypoint:

```text
C:\\Users\\andre\\.dsh\\postman\\direct\\resume_request.ps1
```

Никогда не реконструировать `$jsonText` и не передавать direct state как
`-ResultJsonText` для normal continuation. Использовать exact immutable REQ:

```powershell
$resumeText = & 'C:\\Users\\andre\\.dsh\\postman\\direct\\resume_request.ps1' `
  -RequestId $requestId `
  -RepoRoot 'C:\\Users\\andre\\.dsh'
$resume = $resumeText | ConvertFrom-Json
```

Без TestScript/TestSpec resume может вернуть `READY_FOR_TEST`. После определения
semantic test вызвать этот же entrypoint снова с exact `-TestScript` или `-TestSpec`.
Если valid `ready.json`/`test.json`/`published.json` уже существуют, resume проверяет
их identity и продолжает только первую отсутствующую стадию. Valid `PUBLISHED`
возвращается идемпотентно без повторного commit/push/PR.

Resume никогда не вызывает Direct Postman, не обращается к Ч1 и не создаёт новый REQ.
Для недоказанного legacy durable state допускается только существующий строгий
`PREPARE_RESUME_NOT_DURABLE` fail-closed путь внутри state machine; Luna не делает
собственную реконструкцию receipt/path.
'''
    text=text[:s]+new+text[e:]
    s=text.index('## 14. WP-018B deterministic local finalization'); e=text.index('\n## 15. Что Luna больше не делает вручную после RESULT_DURABLE',s)
    new='''## 14. Unified resumable local finalization

После exact `RESULT_DURABLE` normal production entrypoint только один:

```text
C:\\Users\\andre\\.dsh\\postman\\direct\\resume_request.ps1
```

State machine:

```text
RESULT_DURABLE
→ READY_FOR_TEST
→ TEST_PASSED
→ PUBLISHED
```

`resume_request.py` программно передаёт exact `readyJson → testJson → publishedJson`,
проверяет request/repository/branch/worktree identity и не пересчитывает пути по
догадке. Existing valid receipts делают resume идемпотентным.

### Task test input

Normal production test input — argv-safe файл вне implementation worktree:

```text
%LOCALAPPDATA%\\DSH\\Postman\\handoff\\<REQ>\\task_test.py
```

или `test-spec.json` в том же handoff-каталоге.

Для одной semantic assertion создать UTF-8 `task_test.py` штатным Harness file
write/edit tool. Не строить содержимое теста как shell-строку. Затем:

```powershell
$resumeText = & 'C:\\Users\\andre\\.dsh\\postman\\direct\\resume_request.ps1' `
  -RequestId $requestId `
  -RepoRoot 'C:\\Users\\andre\\.dsh' `
  -TestScript $testScript
$resume = $resumeText | ConvertFrom-Json
```

Для существующей repository/project test-команды разрешён argv-only `TestSpec`,
например:

```json
{
  "command": ["python", "-m", "pytest", "-q", "tests/task_test.py"]
}
```

или spec со script:

```json
{
  "script": "task_test.py",
  "args": []
}
```

После этого использовать `-TestSpec <exact path>`.

`-TestCommand` остаётся legacy compatibility mode runtime, но НЕ является normal
production path Luna. В normal flow запрещены `python -c`, PowerShell command-string
reconstruction и многострочные shell-quoting трюки.

Если тест нельзя выбрать до PREPARE, сначала вызвать `resume_request.ps1` без test
input. Exact `READY_FOR_TEST` receipt даст authoritative `worktree` и `changedFiles`.
Разрешено минимально изучить эти файлы для выбора semantic test, создать TestScript/
TestSpec вне worktree и повторно вызвать `resume_request.ps1` для того же REQ.

Внутри resume PREPARE по-прежнему владеет policy/Git/worktree и canonical applicator,
TEST — semantic receipt/fingerprint, PUBLISH — stage/commit/push/remote-SHA/PR.
`C:\\Users\\andre\\.dsh\\postman\\direct\\integrate_result.ps1` остаётся canonical
applicator maintenance entrypoint, но Luna не вызывает его напрямую в normal flow.

Прямые `prepare_result.ps1`, `test_result.ps1`, `publish_result.ps1` остаются
низкоуровневыми implementation/diagnostic boundary и targeted-test surface. В обычной
пользовательской `@Postman` операции Luna их отдельно НЕ вызывает.

Успех normal finalization: exact `PUBLISHED`, `semanticTest=TEST_PASSED`, один OPEN PR
в `main`, `mergePerformed=false`. Любой `ok=false`/invalid receipt — STOP без ручного
fallback, нового REQ или повторного transport.
'''
    text=text[:s]+new+text[e:]
    text=rep(text,'''## 15. Что Luna больше не делает вручную после RESULT_DURABLE

В normal path не запускать отдельными tool calls:

```text
git status / branch / ls-remote / worktree preflight
gh pr list
git fetch
git worktree add
integrate_result.ps1 напрямую
Get-FileHash результата
повторный manifest/base/staleness check
git add
git commit
git push
remote SHA verification
gh pr create
повторное чтение только что созданного PR
```

Эти обязанности принадлежат PREPARE/TEST/PUBLISH.

Запрещены по-прежнему `git reset --hard`, `git clean`, automatic stash, force push и
ручная перепись artifact через LLM tools.
''','''## 15. Что Luna больше не делает вручную после RESULT_DURABLE

В normal path не запускать отдельными tool calls:

```text
prepare_result.ps1
test_result.ps1
publish_result.ps1
git status / branch / ls-remote / worktree preflight
gh pr list
git fetch
git worktree add
integrate_result.ps1 напрямую
Get-FileHash результата
повторный manifest/base/staleness check
git add
git commit
git push
remote SHA verification
gh pr create
повторное чтение только что созданного PR
```

Эти обязанности принадлежат `resume_request.ps1` и его внутренним
PREPARE/TEST/PUBLISH стадиям.

Запрещены по-прежнему `git reset --hard`, `git clean`, automatic stash, force push и
ручная перепись artifact через LLM tools.
''','manual')
    text=rep(text,'''## 16. Failure handling local finalization

PREPARE/TEST/PUBLISH являются fail-closed. Не заменять failure собственными shell-командами.
Не создавать второй branch и новый Postman REQ из-за локальной finalization failure.

Если PREPARE после ошибки имеет чистый owned worktree, он может удалить только свой
чистый worktree и пустую локальную branch. Dirty failure worktree сохраняется для диагностики.

TEST receipt связан SHA-256 с exact READY JSON и fingerprint implementation bytes.
PUBLISH не merge-ит PR и не удаляет remote branch.
''','''## 16. Failure handling local finalization

`resume_request.ps1` и его внутренние PREPARE/TEST/PUBLISH стадии являются
fail-closed. Не заменять failure собственными shell-командами и не обходить resume
низкоуровневыми boundary wrappers.

Не создавать второй branch и новый Postman REQ из-за local-finalization failure.
Existing RESULT_DURABLE и valid receipts сохраняются; последующий retry должен быть
тем же `resume_request.ps1 -RequestId <exact REQ>`.

Dirty failure worktree сохраняется для диагностики. TEST receipt связан SHA-256 с
exact READY JSON, TestScript SHA-256 и fingerprint implementation bytes. PUBLISH не
merge-ит PR и не удаляет remote branch.
''','failure')
    text=rep(text,'''## 17. Task-specific test selection

Единственное содержательное решение Л1 после READY_FOR_TEST — выбрать одну проверку,
которая лучше всего доказывает пользовательский intent. Приоритет: тесты Ч1,
repository-defined test, существующая project command, одна минимальная semantic assertion.
Для UI допускается один цельный E2E/script. BrowserSmoke не является task test.
''','''## 17. Task-specific test selection

Единственное содержательное решение Л1 после RESULT_DURABLE/READY_FOR_TEST — выбрать
одну проверку, которая лучше всего доказывает пользовательский intent. Приоритет:
тесты Ч1, repository-defined test, существующая project command, одна минимальная
semantic assertion.

TestScript/TestSpec должен проверять именно объективные требования пользователя, не
их ослабленную замену. Если пользователь потребовал «чёрную кнопку», недостаточно
проверить лишь наличие `background`; semantic test должен доказать чёрный цвет. Если
есть требования к количеству элементов, тексту, конкретному файлу, hover/active,
сохранности остального и т.п., проверять соответствующие объективные свойства.

Для субъективных UI-требований (`стильно`, `красиво`, `современно`) semantic test
проверяет только объективно формализуемую часть. Визуальная presentation и user
acceptance остаются отдельными состояниями и не подменяются `TEST_PASSED`.

Для UI допускается один цельный UTF-8 E2E/script вне implementation worktree.
BrowserSmoke не является task test. Normal test path не использует `python -c` или
`-TestCommand`; использовать `-TestScript`/`-TestSpec` через resume.
''','selection')
    text=rep(text,'''## 19. Финальный отчёт

При успехе сообщить как минимум:

```text
Postman requestId
RESULT_DURABLE
artifact SHA256
что было внедрено
результаты тестов
commit SHA
remote synchronization
PR/link
merge status
```

Не перегружать пользователя browser/CDP внутренностями без диагностической
необходимости.

При failure сообщить:

```text
exact REQ
terminal code
terminal state
точный blocker
что не было выполнено после blocker
```
''','''## 19. Финальный отчёт

При успехе сообщить как минимум:

```text
Postman requestId
RESULT_DURABLE
artifact SHA256
что было внедрено
результаты semantic test
presentation status
commit SHA
remote synchronization
PR/link
merge status
```

### Кликабельные изменённые файлы в Harness Web

Authoritative список брать только из exact `PUBLISHED` receipt `changedFiles`.
Для каждого файла построить exact существующий локальный путь от retained
`published.worktree` + relative `changedFiles`.

В финальном ответе каждый изменённый локальный файл упомянуть как Markdown inline
code — отдельным элементом, например:

`C:\\Users\\andre\\AppData\\Local\\DSH\\Postman\\worktrees\\REQ_xxx\\docs\\example.html`

Harness Web делает такие существующие file-path references кликабельными. Использовать
exact path из receipt, а не придумывать `C:\\Users\\andre\\.dsh\\postman\\worktrees`.
Если штатный file tool уже surfaced файл и basename уникален среди изменённых файлов
этого turn, допустим inline-code basename; иначе использовать абсолютный exact path.

Для локальных файлов не использовать bare path, `file://` и не придумывать Markdown
URL. Web/PR URL оформлять обычной Markdown-ссылкой.

Не перегружать пользователя browser/CDP внутренностями без диагностической
необходимости.

При failure сообщить:

```text
exact REQ
terminal code
terminal state
точный blocker
что не было выполнено после blocker
```
''','final')
    text=rep(text,'''17. После RESULT_DURABLE normal local path — только PREPARE → TEST → PUBLISH.
18. PREPARE является единственным владельцем branch/worktree/preflight и canonical applicator.
19. TEST требует exact `TEST_PASSED` receipt и запрещает незамеченную мутацию implementation.
20. PUBLISH является единственным владельцем stage/commit/push/remote-SHA/PR в normal path.
21. `files/` payload копируется exact bytes; Л1 не переписывает его через LLM tools.
22. `RESULT_DIAGNOSTIC_ONLY` не является implementation success и не разрешает automatic resend.
23. Ни PREPARE, ни TEST, ни PUBLISH не создают новый Postman REQ.
24. PUBLISH никогда не merge-ит PR автоматически.
25. Нет validated correlated artifact → нет успешного Postman результата.
''','''17. После RESULT_DURABLE normal local-finalization entrypoint — только `resume_request.ps1`.
18. PREPARE/TEST/PUBLISH — внутренние deterministic стадии resume; Luna не вызывает их wrappers отдельно в normal path.
19. Normal semantic test передаётся argv-safe через `TestScript`/`TestSpec`; `python -c` и `TestCommand` не являются normal path.
20. Resume передаёт exact `readyJson → testJson → publishedJson`, не реконструируя handoff paths.
21. TEST требует exact `TEST_PASSED` receipt и запрещает незамеченную мутацию implementation.
22. PUBLISH внутри resume является владельцем stage/commit/push/remote-SHA/PR и никогда не merge-ит PR автоматически.
23. `files/` payload копируется exact bytes; Л1 не переписывает его через LLM tools.
24. `RESULT_DIAGNOSTIC_ONLY` не является implementation success и не разрешает automatic resend.
25. Resume/PREPARE/TEST/PUBLISH не создают новый Postman REQ и не обращаются повторно к Ч1.
26. Финальный отчёт перечисляет authoritative changedFiles кликабельными inline-code local paths из exact retained worktree.
27. Нет validated correlated artifact → нет успешного Postman результата.
''','invariants')
    return text

def patch_agents(text):
    text=rep(text,'''Links and files
Do not output bare URLs or paths. Format all links to web pages and local files as Markdown links. When linking to files, use an absolute path in the format supported by the current Codex environment.
''','''Links and files
Do not output bare URLs or paths. Web URLs use normal Markdown links. In Harness Web, references to existing local files that should be clickable are formatted as Markdown inline code using the exact file-tool/local path; a basename is allowed only when it is unique among files surfaced/changed in that turn. Do not use `file://` for local-file links. For Postman result files, prefer the exact retained result-worktree path from the authoritative receipt.
''','agents-links')
    return rep(text,'''Postman local finalization invariant.
После exact `RESULT_DURABLE` normal production path: `prepare_result.ps1` →
`test_result.ps1` → `publish_result.ps1`. Эти deterministic boundary владеют
соответственно Git/policy/worktree+applicator, одним task-specific test receipt и
stage/commit/push/remote-SHA/PR. Luna не должна разлагать normal path обратно на
множество ручных Git/gh/shell вызовов. Любой `ok=false` от boundary — fail-closed
`STOP`; ручной fallback и новый REQ запрещены. `publish_result.ps1` не выполняет merge.
''','''Postman local finalization invariant.
После exact `RESULT_DURABLE` единственный normal production local-finalization entrypoint —
`C:\\Users\\andre\\.dsh\\postman\\direct\\resume_request.ps1`. PREPARE, TEST и PUBLISH
остаются внутренними deterministic стадиями resume и владеют соответственно
Git/policy/worktree+applicator, одним task-specific test receipt и
stage/commit/push/remote-SHA/PR. Luna не вызывает `prepare_result.ps1`,
`test_result.ps1` или `publish_result.ps1` отдельно в normal `@Postman` flow и не
разлагает resume обратно на ручные Git/gh/shell вызовы. Normal task test передаётся
argv-safe через `TestScript`/`TestSpec`; `python -c` и `TestCommand` не являются normal
path. Если test нельзя выбрать до PREPARE, первый resume без test input может вернуть
`READY_FOR_TEST`, после чего тот же REQ продолжается вторым resume с TestScript/TestSpec.
Любой `ok=false` — fail-closed `STOP`; ручной fallback, новый REQ и повторный Ch1
запрещены. PUBLISH внутри resume не выполняет merge.
''','agents-finalization')

def patch_test(text):
    text=rep(text,'self.assertIn("DIRECT_POSTMAN_SKILL_VERSION: 11", self.skill)','self.assertIn("DIRECT_POSTMAN_SKILL_VERSION: 12", self.skill)','test-version')
    old='''    def test_wp018b_three_boundary_finalization_contract(self):
        for name in ("prepare_result.ps1", "test_result.ps1", "publish_result.ps1"):
            self.assertIn(name, self.skill)
            self.assertIn(name, self.agents)
        for code in ("READY_FOR_TEST", "TEST_PASSED", "PUBLISHED"):
            self.assertIn(code, self.skill)
        self.assertIn("PREPARE → TEST → PUBLISH", self.skill)
        self.assertIn("не выполняет merge", self.agents)

'''
    new='''    def test_unified_resume_finalization_contract(self):
        self.assertIn(r"C:\\Users\\andre\\.dsh\\postman\\direct\\resume_request.ps1", self.skill)
        self.assertIn(r"C:\\Users\\andre\\.dsh\\postman\\direct\\resume_request.ps1", self.agents)
        for code in ("READY_FOR_TEST", "TEST_PASSED", "PUBLISHED"):
            self.assertIn(code, self.skill)
        self.assertIn("PREPARE/TEST/PUBLISH", self.skill)
        self.assertIn("внутренними deterministic стадиями resume", self.agents)
        section = self.skill.split("## 14. Unified resumable local finalization", 1)[1].split(
            "## 15. Что Luna больше не делает вручную", 1
        )[0]
        self.assertIn("-TestScript", section)
        self.assertIn("-TestSpec", section)
        self.assertIn("НЕ вызывает", section)
        self.assertNotIn("-TestCommand @(", section)
        self.assertIn("запрещены `python -c`", section)
        self.assertIn("не выполняет merge", self.agents)

'''
    text=rep(text,old,new,'test-finalization')
    old='''    def test_durable_handoff_resume_contract(self):
        self.assertIn(r"C:\\Users\\andre\\AppData\\Local\\DSH\\Postman\\direct\\results\\<REQ>.json", self.skill)
        self.assertIn("-RequestId $requestId", self.skill)
        self.assertIn("-ResultJsonText $jsonText", self.skill)
        self.assertIn("Direct state нельзя передавать как `-ResultJsonText`", self.skill)
        self.assertIn("resume не запускает Postman и не создаёт новый REQ", self.skill)
        self.assertIn("PREPARE_RESUME_NOT_DURABLE", self.skill)

'''
    new='''    def test_durable_handoff_resume_contract(self):
        self.assertIn(r"C:\\Users\\andre\\AppData\\Local\\DSH\\Postman\\direct\\results\\<REQ>.json", self.skill)
        self.assertIn("-RequestId $requestId", self.skill)
        self.assertIn("resume_request.ps1", self.skill)
        self.assertIn("не передавать direct state как", self.skill)
        self.assertIn("Resume никогда не вызывает Direct Postman", self.skill)
        self.assertIn("не создаёт новый REQ", self.skill)
        self.assertIn("PREPARE_RESUME_NOT_DURABLE", self.skill)
        self.assertIn("идемпотентно", self.skill)

'''
    text=rep(text,old,new,'test-durable')
    needle='    def test_normal_smoke_is_forbidden(self):\n'
    add='''    def test_clickable_changed_file_contract(self):
        for marker in ("Кликабельные изменённые файлы", "Markdown inline code", "changedFiles", "published.worktree"):
            self.assertIn(marker, self.skill)
        self.assertIn("file://", self.skill)
        self.assertIn("Markdown inline code", self.agents)
        self.assertIn("retained result-worktree", self.agents)

    def test_normal_path_uses_argv_safe_test_input(self):
        section = self.skill.split("## 14. Unified resumable local finalization", 1)[1].split(
            "## 15. Что Luna больше не делает вручную", 1
        )[0]
        self.assertIn("-TestScript", section)
        self.assertIn("-TestSpec", section)
        self.assertIn("`-TestCommand` остаётся legacy", section)
        self.assertIn("запрещены `python -c`", section)
        self.assertIn("`TestScript`/`TestSpec`", self.agents)

'''
    if needle not in text: raise SystemExit('PATCH_GUARD_FAILED:test-insert')
    return text.replace(needle,add+needle,1)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--repo-root',required=True); a=ap.parse_args(); root=Path(a.repo_root).resolve()
    items=[(root/'.agents/skills/delegate-via-postman/SKILL.md',patch_skill),(root/'AGENTS.md',patch_agents),(root/'postman/direct/tests/test_delegate_skill_contract.py',patch_test)]
    for p,fn in items:
        if not p.is_file(): raise SystemExit(f'PATCH_TARGET_MISSING:{p}')
        t,e=_read(p); _write(p,fn(t),e); print('PATCHED',p)
if __name__=='__main__': main()
