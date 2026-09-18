# Direct Web Postman

Этот каталог содержит текущий production transport между локальным Harness-агентом и ChatGPT Web.

## Канонический flow

Главный документ:

```text
postman/POSTMAN_CURRENT_FLOW.md
```

Production entrypoint:

```text
postman/direct/postman.ps1
```

Основной путь:

```text
user intent
→ canonical REQ
→ Direct Postman
→ dedicated ChatGPT Web page
→ correlated assistant turn
→ exact ZIP attachment
→ validation
→ RESULT_DURABLE
```

## Структура

- `direct/` — direct CLI, durable handoff и дальнейший lifecycle результата;
- `web/` — browser bootstrap, submit/observe/download/validation pipeline;
- `task_package.py` — формирование task package;
- `POSTMAN_CURRENT_FLOW.md` — актуальная production-схема и инварианты.

Архивные GitHub-Issue wakeup flows и промежуточные milestone-схемы не являются частью текущего production transport.
