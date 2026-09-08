# Postman Skill v12 — resume + argv-safe tests + clickable changed files

Пакет обновляет только инструктивный слой Direct Postman и contract-test. Runtime не меняется.

Изменяемые repo-файлы:
- `.agents/skills/delegate-via-postman/SKILL.md`
- `AGENTS.md`
- `postman/direct/tests/test_delegate_skill_contract.py`

Цели:
1. normal finalization после `RESULT_DURABLE` только через `resume_request.ps1`;
2. `TestScript` / `TestSpec` вместо `python -c` / `TestCommand`;
3. authoritative `changedFiles` в финальном отчёте как кликабельные Harness Web local-file references через Markdown inline code exact path;
4. fail-closed, один REQ, без повторного Ch1.
