# Граница раунда для сообщений агентов

Штатный пакет DSH `@deepseek-ai/dsh-agent-loop` версии `0.1.1-rc.2` уже завершает текущий шаг при появлении `next-turn` и захватывает все ожидающие сообщения в следующий раунд. Но после асинхронного `preStep` он пропускает эту проверку на первом шаге. Накладка удаляет только условие `phase.step > 0`: захваченные сообщения возвращаются в начало очереди, новый пакет забирается штатным `Inbox.claim`; выполняемая модель и инструмент не отменяются.

Из корня репозитория с установленным DSH:

```powershell
$root = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh"
node tools/agent-message-boundary/apply-overlay.mjs --root $root --verify
node tools/agent-message-boundary/apply-overlay.mjs --root $root --apply --backup-dir "$env:LOCALAPPDATA\dsh-agent-message-boundary-backup"
node tools/agent-message-boundary/apply-overlay.mjs --root $root --verify
```

Сценарий отказывается менять неизвестную версию или другой исходный фрагмент, сохраняет исходник до изменения и не перезаписывает старую копию. Для отката остановить DSH и вернуть `dsh-agent-loop-index.js` из каталога копии на место `node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`. Повторная установка DSH может потребовать повторного применения. Чтобы изменения самого плагина стали доступны работающему Web-интерфейсу, обновить его установленный пакет и перестроить соответствующие артефакты; без этого файл репозитория не влияет на запущенный процесс.

Проверки исходного цикла без изменения установки:

```powershell
node --test tools/agent-message-boundary/agent-message-boundary.test.mjs
```
