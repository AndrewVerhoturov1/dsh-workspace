# Проверки Postman GitHub Integration M6

Дата актуализации: 29 августа 2026 года.

## Локальные проверки

- `node --check` для `plugins/dsh-postman-harness/lib/index.js`, Runtime и транспорта — PASS.
- `node --test plugins/dsh-postman-harness/lib/index.test.js plugins/dsh-postman-harness/lib/runtime.test.js plugins/dsh-postman-harness/lib/transport.test.js` — PASS, 43/43.
- `postman/test-github-wakeup.ps1` — PASS, 40/40; строгий старый протокол, отрицательные сценарии и независимость ключа от временной метки сохранены.
- `chatgpt-desktop-uia-bridge/test-fresh-contract.ps1` — PASS, 13/13; отказ Fresh происходит до разрешения очистки composer, вставки и Send, а SubmitOnly требует подтверждённое пользовательское сообщение без ожидания ассистента и Copy.
- `chatgpt-desktop-uia-bridge/test-desktop-surface-contract.ps1` — PASS, 15/15; host, Codex, обычный Chat, fail-closed navigation и общий Fresh/SubmitOnly flow проверены синтетически.
- Проверка PowerShell parser для `github-wakeup.ps1`, `test-github-wakeup.ps1` и `chatgpt_chat.ps1` — PASS.
- Проверены миграция схемы M4 → M6, точные SHA-256, unknown REQ, повторный deliveryKey, повторный signal, сохранение issue metadata и spoofing origin.
- `git diff --check` — PASS.
- `dsh --dump-config --profile web --patch ./.tmp-m1-m3-auth.patch.yml` — PASS; в конфигурации присутствуют Flowglass и Postman, `agent-loop.agents=[]`.
- Целевой поиск секретов по изменяемым файлам — PASS, совпадений нет.

## Сценарии M6

Заполняются после живого прогона на опубликованной ветке:

| Сценарий | Ожидание | Факт |
|---|---|---|
| Unified Desktop Codex → ordinary Chat → Fresh → SubmitOnly | host/surface proof, затем отправка | PASS, проба `M6_SUBMITONLY_PROBE_009`, UIA navigation |
| Существующий ordinary Chat с историей | Fresh без лишней навигации | PASS, проба `M6_SUBMITONLY_PROBE_010` |
| Unified Desktop Codex → ordinary Chat → Fresh → SubmitOnly | повторный переход | PASS, проба `M6_SUBMITONLY_PROBE_011`, UIA navigation |
| Ordinary Chat с непустым черновиком | очистка только после Fresh-proof | PASS, проба `M6_SUBMITONLY_PROBE_012`, `ValuePattern` после proof |
| Unified Desktop Codex → ordinary Chat → Fresh → SubmitOnly | повторный переход | PASS, проба `M6_SUBMITONLY_PROBE_013`, UIA navigation |
| Issue READY → Actions → Windows signal → Runtime | `READY` | не засчитан: single-agent остановлен до подтверждённого SubmitOnly |
| READY → originating Agent | один `POSTMAN_RESULT` | не засчитан |
| Два агента и две Issue | cross-delivery = 0 | live не выполнен |
| повтор workflow/event | `DUPLICATE_SUPPRESSED` | локальная модель PASS; live не выполнен |
| Harness выключен при READY | signal сохранён и ingest при старте | локальная модель PASS; live не выполнен |

После исправления host был обнаружен при активной поверхности Codex: PID `34728`, окно-хозяин `0x280788`, процесс `ChatGPT (Beta)`. Выполнено 5/5 живых SubmitOnly-проб: `009` Codex, `010` существующий Chat, `011` Codex, `012` непустой черновик, `013` Codex. Все возвратили `ok=true`, `submitted=true`, `userMessageConfirmed=true`, `ordinaryChatConfirmed=true`, `freshChatConfirmed=true`, `freshProofLevel=UIA_ACTION_AND_STABLE_EMPTY_STATE`, `sendAttempted=true`; в Codex-пробах `navigationMethod=UIA.ExpandCollapsePattern+MenuItem.InvokePattern`. Отдельная проба `014` безопасно остановилась до отправки с `FRESH_SURFACE_UNSTABLE` и в 5/5 не засчитывалась.

Полный почтовый M6-контур после этих проб не засчитан. Для M6 внешний Desktop/Web ChatGPT и GitHub wakeup разрешены и обязательны, но single-agent не достиг `CHAT_SUBMIT_CONFIRMED`. Поэтому последующие стадии не подменялись synthetic READY и не объявляются PASS.

## Точная остановка single-agent

Последняя попытка: `MSG_M6_SINGLE_R15` → `REQ_F6687A0BC867459CB9B53D3827DD0874` → Issue №37. Подтверждены `MESSAGE_RECEIVED`, `REQUEST_CREATED`, `REQUEST_ACCEPTED`, `ISSUE_CREATED`, `CHAT_SUBMIT_STARTED`; ожидаемая стадия — `CHAT_SUBMIT_CONFIRMED`. Фактически bridge вернул `DESKTOP_HOST_FOUND_WRONG_SURFACE`: host `ChatGPT (Beta)`, PID `34728`, HWND `0x280788` найден, но foreground был у Unity `Back To The Dawn`, PID `29032`, HWND `0x292330`; `SetForegroundWindow` и `AttachThreadInput` не сработали, `sendAttempted=false`. Следовательно, Issue READY, сигнал, DB READY, POSTMAN_RESULT и continuation по R15 отсутствуют как доказательства.

## Итог

`BLOCKED — REQ_F6687A0BC867459CB9B53D3827DD0874, Issue #37; последняя подтверждённая стадия CHAT_SUBMIT_STARTED, следующая CHAT_SUBMIT_CONFIRMED, фактическая ошибка DESKTOP_HOST_FOUND_WRONG_SURFACE из-за отказа Windows foreground-lock. Single-agent, A+B, duplicate и offline/recovery не выполнены.`

## Обязательные живые доказательства

В отчёте должны быть exact SHA merge commit, имена агентов, `REQ_*`, номера Issue, Actions run/job, факт online runner `dsh-postman-win`, состояния DB и наблюдаемые маркеры продолжения. Содержимое ответа не передаётся через видимый ответ ChatGPT и не копируется пользователем.
