# GitHub wakeup handler

`github-wakeup.ps1` — единственная точка обработки события `issues: edited` для протокола `POSTMAN REQ_<id>`. Он принимает путь к официальному `GITHUB_EVENT_PATH`, извлекает только служебный заголовок Issue и атомарно сохраняет READY-сигнал вне репозитория.

Для локальной проверки:

```powershell
pwsh -NoProfile -File .\postman\test-github-wakeup.ps1
```

Ответ Issue никогда не рассматривается как PowerShell или другой исполняемый код.
