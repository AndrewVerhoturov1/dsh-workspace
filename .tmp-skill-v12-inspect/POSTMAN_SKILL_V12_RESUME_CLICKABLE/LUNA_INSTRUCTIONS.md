# LUNA_INSTRUCTIONS — Postman Skill v12

Repository: `AndrewVerhoturov1/dsh-workspace`.

Read-only baseline пакета:
- `main`: `2f41626d457c8ed7f4265cb391c4cd45b21b58ba`
- SKILL blob: `dd01c5788cff0d833ab22accf800cd3bc4e4bdf5`
- AGENTS blob: `abe43f3db145ce65ab1008a6a7b98f93348e72a4`
- contract-test blob: `ea23e6985c5d55743affbd81a94a55fd5e4317c7`
- `resume_request.ps1`: `a8149a0b5299f2aef089c453ce1b2147a2dd5d27`
- `test_result.py`: `8472a1879fa957ce06ed2c9a4f0ab280dc26e9d9`

На момент подготовки открыт Postman result PR #97. Соблюдай `REPO_POLICY.md`: не создавай новую implementation branch, пока существующий временный branch/PR не разрешён по политике. Не закрывай и не merge #97 без отдельной команды пользователя.

## Запреты

- Direct Postman НЕ запускать.
- Новый REQ НЕ создавать.
- Ch1 НЕ вызывать.
- ORCA / Playwright / Computer Use НЕ использовать.
- Dirty main не clean/stash/reset.
- Force push не использовать.
- Runtime Postman не менять.

## Применение

Когда `REPO_POLICY.md` позволяет работать в implementation branch/worktree от актуального main:

```text
python -X utf8 <PACKAGE>/tools/apply_skill_v12.py --repo-root C:\Users\andre\.dsh
```

Скрипт guarded и должен изменить ровно 3 файла:
- `.agents/skills/delegate-via-postman/SKILL.md`
- `AGENTS.md`
- `postman/direct/tests/test_delegate_skill_contract.py`

## Новый normal flow

```text
RESULT_DURABLE
→ выбрать semantic test
→ создать UTF-8 TestScript/TestSpec вне implementation worktree
→ resume_request.ps1
→ READY_FOR_TEST → TEST_PASSED → PUBLISHED
→ REGISTER
→ PRESENT
→ final report
```

Если semantic test нельзя выбрать до PREPARE:

```text
resume_request.ps1 без test
→ READY_FOR_TEST
→ создать TestScript/TestSpec
→ resume_request.ps1 того же REQ с test
→ PUBLISHED
```

Normal path НЕ вызывает отдельно `prepare_result.ps1`, `test_result.ps1`, `publish_result.ps1`.
Normal test НЕ использует `python -c`, `-TestCommand` или shell quoting reconstruction.

Semantic test не ослабляет explicit intent: если пользователь требует чёрный цвет, проверять чёрный цвет, а не просто наличие `background`.

## Кликабельные changedFiles

Финальный успешный ответ должен перечислить authoritative `changedFiles` из exact PUBLISHED receipt.
Каждый local result path строить только как exact `published.worktree + changedFiles` и форматировать Markdown inline code, например:

`C:\Users\andre\AppData\Local\DSH\Postman\worktrees\REQ_xxx\docs\postman-wp018-e2e.html`

Это формат Harness Web для кликабельной ссылки на существующий local file. Не использовать `file://`, bare path или выдуманный `C:\Users\andre\.dsh\postman\worktrees...`. Web/PR URL — обычные Markdown links.

## Проверки

```text
python -X utf8 <PACKAGE>/tests/validate_v12_contract.py --repo-root C:\Users\andre\.dsh
python -X utf8 -m pytest -q postman/direct/tests/test_delegate_skill_contract.py
python -X utf8 -m pytest -q postman/direct/tests postman/web/tests postman/tests
git diff --check
```

Нужно 0 failed.

После PASS, только если repo policy позволяет: commit, push, один PR в main, НЕ merge.
Если #97/другой live resource блокирует branch — STOP и отчитай blocker, не обходи policy.

Финальный отчёт: base SHA, branch, commit, PR если создан, 3 changed files, targeted/full tests, diff-check и flags:
`Postman invoked=false`, `new REQ created=false`, `Ch1 contacted=false`, `ORCA invoked=false`, `forcePushUsed=false`, `mergePerformed=false`.
