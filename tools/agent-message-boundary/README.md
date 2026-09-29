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
node --test tools/agent-message-boundary/agent-message-boundary.test.mjs tools/agent-message-boundary/subagent-result-overlay.test.mjs
```

Отдельная накладка `subagent-result-overlay.mjs` касается установленного `@deepseek-ai/dsh-subagent@0.1.1-rc.2`: если для хода отсутствует `turn/end`, успешный drain не означает успешное выполнение. Последний tool-call и текст старого хода не объявляются closing message текущего исполнения. Сценарий проверяет точный SHA-256 исходного пакета, сохраняет исходник в новом каталоге резервной копии и отказывает при повторном применении либо иной версии. Только после отдельного решения о развёртывании и остановки Host: `node tools/agent-message-boundary/subagent-result-overlay.mjs --root $root --verify`, затем `--apply --backup-dir <новый каталог копии>`; откат — вернуть `dsh-subagent-index.js` из копии. В рамках локальной разработки установка не меняется; проверен лишь offline apply на временной копии.

Для локальных регрессий Worker с этим offline-исправлением, не меняя установленный пакет, запускайте `node --import ./tools/agent-message-boundary/subagent-overlay-test-loader.mjs --test plugins/dsh-postman-harness/lib/postman-worker-n2.test.js plugins/dsh-postman-harness/lib/postman-worker-real-cycle.test.js`. Загрузчик использует тот же SHA-256 guard и подменяет только модуль `dsh-subagent` внутри тестового процесса. Накладка также добавляет `closeContinuableChild(parent, childId, verify)`: проверка завершения и запрет нового native followup сериализованы существующим child lock, а освобождение resident Activation остаётся штатным. Установка DSH от этого не меняется.

Накладка выбирает последнее сообщение **после последнего `turn/start`**, и лишь затем оставляет допустимые непустые текстовые блоки. При «Начинаю проверку» → сообщение только с вызовом инструмента → обрыв текст предшественника не превращается в итог. Предыдущий completed не скрывает новый открытый ход; отсутствие `turn/end` остаётся ошибкой неизвестной причины. Применение — только к совместимому SHA в отдельном обслуживании Host, с резервной копией и откатом `--rollback --backup-dir <папка>`: откат сверяет SHA-256 обеих версий перед заменой. Offline-тест применяет и откатывает поправку на временной копии.
