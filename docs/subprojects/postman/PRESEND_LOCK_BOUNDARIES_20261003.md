# Проверка границ browser-presend.lock после PR #328 — 2026-10-03

## Решение

Общий cross-process lock оставлен только у submit_fresh_prompt: prepare fresh / → upload → fill → один Send → полное sent/attachment proof → безопасный cleanup. Для submit_existing_prompt, Image packaging, reminder и system continuation/recovery на существующем /c/... глобальный lock больше не берётся. Общий декоратор ownership/cleanup и все send guards остаются. FIFO/scheduler, новые retries и увеличение 180 секунд не добавлены.

Причина — воспроизведённое ожидание reminder 55,359 с с истечением operation_deadline, а не предположение о гонке. Разные existing-чаты экспериментально не конфликтовали. Это не обещание отсутствия конфликтов двух Pages одного и того же разговора: существующий Direct lock_chat и последовательный control внутри Worker не меняются.

## Среда и метод

- База: exact origin/preview 43ccb533d3048b1e2aae16fea398da1a980adcea после merge #328/#329. Отдельный task worktree postman-presend-boundaries-20261003; постоянные main/preview и активная установка не редактировались.
- Существующий Chrome/CDP http://127.0.0.1:9222, Context FE8E9A7F7EC2194D6B6D40CCBAE89CA5. Каждый процесс создаёт собственную Page; браузер/context не закрывались. Только доказанно собственные остановленные targets закрыты адресно.
- Без субагентов. Python-процессы — тестовые исполнители production helpers, не LLM. Полные Image controls вызывают настоящий DirectPostman.run(image_mode=True) с native input manifest и уникальным REQ/PNG.
- Внешние fixtures живут в %LOCALAPPDATA%/DSH/Postman/presend-boundaries-20261003, не в Git. JSONL фиксирует UTC + monotonic, PID/Page/Context, lock wait/enter/exit, fill/upload/Send counts, proof и composer. Источники: live_lock_child.py, run_controls.py, matrix_controls.py, pair_state_probe.py, evidence-summary.json.
- Долгое удержание контролируемое: fixture после production insert/readback собственного exact prompt задерживает Page на 55 с (195 с для timeout), оставаясь внутри настоящего OS lock. Upload, prompt, click и sent proof настоящие; ни phase, ни deadline не подменены. Это стресс-тест границы, а не измерение обычной задержки сервиса.
- A–E выполнены до production-правки: только в тестовом процессе lock заменён nullcontext; production файлы в этих экспериментах исходные. Other ownership/send/attachment guards не отключались.
- Reminder slots ускорены до 8/16 с, observer budget до 30/35 с; Worker scheduling, monotonic, control_intent, inspect_answer_phase и operation_deadline штатные. В production минуты не менялись. Обычный chat намеренно решает задачу без ZIP: его терминал observer timeout ожидаем и не выдаётся за успешный durable Postman.

## 1. Reminder при занятом десятки секунд lock

### Исходный широкий lock: batch 20261003T103534Z

Normal REQ ..._9400, PID21100; полный Image ..._9401, PID19116. Image initial действительно внутри lock, exact own PNG + prompt готовы; fixture hold 10:36:05.865–10:37:00.874 UTC, lock в целом 72,644 с. Initial Image PROVEN_SENT 10:37:10.008 с exact user turn, empty composer и правильным input attachment.

| Событие reminder slot 1 | UTC / факт |
|---|---|
| Плановая граница | elapsed 8000 мс, около 10:36:13.894 |
| Worker обнаружил due | 10:36:14.109 (elapsed8215 мс) |
| Начало submit/ожидания lock | 10:36:14.502; реальная фаза WORKING, generationActive=true |
| Получил lock | 10:37:09.860 |
| Ожидание | 55,359 с |
| operation_deadline | monotonic232432.995, около 10:36:35.893 UTC; истёк за 33,97 с до lock admission |
| Итог reminder | 10:37:10.377: REMINDER_PHASE_PENDING / PROVEN_NOT_SENT, reason control_deadline |
| Send reminder | не было; всего один click/fill от initial, новых upload/fill/click0 |
| Composer | пустой; чужой текст не очищался |
| Slots | оба остались PENDING, не ложно SENT/SKIPPED; slot1 фактически потерян на deadline |
| Worker | POSTMAN_TRANSPORT_FAILED по bounded observer deadline |

За время ожидания напоминание стало недопустимым по deadline, хотя исходно WORKING был доказан. Guard правильно отказал позднему Send, но широкий lock израсходовал весь оставшийся бюджет. Причина первичного generation CDP зависания полного Image позже не установлена; это не доказательство lock race, и тот Image не повторялся.

### После минимального уточнения: batch 20261003T105323Z

Normal ..._9400 PID42476, Image ..._9401 PID6776. Image hold55с 10:53:44.006–10:54:39.017, fresh lock до 10:54:49.621. Reminder реальный due slot1:

- scheduled elapsed8000; due увиден10:53:52.282 (elapsed8234).
- submit10:53:52.695, phase WORKING. lock_wait/lock_enter у reminder отсутствуют, ожидание fresh lock0.
- click10:53:54.768, PROVEN_SENT10:53:57.162: 4,467с после входа в helper, 5,114с после плановой границы до полного proof.
- operation_deadline ещё не истёк (бюджет35с); composer пустой, ровно новый exact turn, slot1=SENT (finishedElapsedMs13223).
- slot2 наступил16с; после первого reminder UI не доказал допустимую WORKING фазу, slot остался PENDING. Это phase guard, не lock ожидание. Normal bounded observer затем истёк, поскольку тест не просил ZIP.

Таким образом, исправлен именно доказанный failure mode: independent reminder не теряет остаток deadline из-за fresh Image.

## 2. Без lock: матрица A–E

| Вариант / UTC batch | Результат |
|---|---|
| A: fresh + fresh, 104322Z | Первый держал exact prompt18с. Второй / после hydration получил тот же prompt hash, COMPOSER_NOT_EMPTY/PROVEN_NOT_SENT, upload/fill/click0. Attachment не перенёсся (count0). Первый PROVEN_SENT с правильным PNG. Общий home draft доказан. |
| B: fresh + existing, 104400Z | 2/2 PROVEN_SENT, у каждого exact prompt + свой PNG, composerEmpty=true; existing проходит пока fresh держит18с. COMPOSER_NOT_EMPTY нет. |
| B reverse: existing + fresh, 104447Z | 2/2 PROVEN_SENT с правильными PNG. Existing exact draft18с не загрязняет новый /. |
| C: existing + existing в разных /c/, 104518Z | 2/2 PROVEN_SENT, attachments привязаны правильно. Третий read-only / + reload остался пустым. Другой existing мог показать только собственный параллельно вставленный prompt, не prompt первой Page. |
| D: fresh + reminder в другом /c/, 104547Z | Fresh держит prompt/PNG25с; реально WORKING reminder PROVEN_SENT, exact turn и empty composer; fresh тоже PROVEN_SENT. |
| E: две reminders в разных /c/, 104815Z | Обе реальные фазы WORKING; параллельные helpers, 2/2 PROVEN_SENT, own turn/composer proof, новых attachments нет. |

Первый E 104641Z был неполным: у одной Page ASSISTANT_NOT_STARTED/UNKNOWN, helper не вызван; его нельзя считать доказательством пары. Повтор выполнен только ради недостающего покрытия: readiness дожидалась настоящего WORKING, не подменяла фазу. Initial setup этих reminders ещё использовал исходный lock и ждал136,875/155,513с из-за concurrent queue; сами две reminders bypassed lock и завершились за2,66/2,84с.

Отдельный existing-draft probe state-20261003T104251Z: synthetic exact owned draft76chars на existing0, ожидание5с. Existing1 и / оставались пустыми; после reload обеих страниц всё ещё пусты. Only own unsent draft очищен при неизменных URL/count и нулевом Send; после reload existing0 пустой. Доказательства ограничены проверенной текущей UI: universal guarantee для будущих версий ChatGPT не заявляется. Не исследовались private/user Pages и raw origin storage не публикуется.

## 3. Четыре fresh и несколько ожидающих

### Исходный lock: queue 104709Z

4 fresh с уникальными PNG + later existing/packaging-style helper. Первый hold35с, следующие hold5с. Два admitted initial Send завершились UNKNOWN после click: early read-only image rebind показал0 user turns, attachment proof не восстановился за текущий бюджет. Сам исходный click не повторялся и UNKNOWN не очищался.

- Fresh0 держал lock117,326с; fresh1 получил его после109,049с и держал ещё85,686с.
- Fresh2, fresh3 и later existing истекли по180,013 /180,023 /180,044с.
- Каждый timeout waiter: about:blank, composer empty, upload0/fill0/click0, без resend.
- Это доказательство head-of-line задержки и исчерпания180с при медленном proof, не доказательство starvation или ошибки attachment ownership. Поведение remote UI и rebind отдельно не ремонтировалось.

### После уточнения: четыре настоящих PostmanImage 105323Z

Все четыре начальных helpers PROVEN_SENT: exactUserTurn=true, composerEmpty=true, sentAttachmentConfirmed=true с PNG именно своего REQ. Никаких COMPOSER_NOT_EMPTY и пересечения inputs. Получили fresh lock:

| Image | REQ suffix | Wait с | Initial proof UTC |
|---|---|---:|---|
| red | 9401 | 0,001 | 10:54:49.772 |
| green | 9402 | 143,107 | 10:56:26.492 |
| blue | 9403 | 160,298 | 10:56:50.913 |
| orange | 9404 | 62,992 | 10:56:08.518 |

Порядок ожидания green→blue→orange, admission orange→green→blue: текущая polling OS блокировка НЕ FIFO. Все получили lock внутри180с; starvation в конечной проверке не наблюдался, но гарантию его невозможности дать нельзя. При бесконечном притоке конкурентов или очень долгом holder fairness не гарантирована. Новая очередь не вводилась.

Packaging red10:55:40.129 PROVEN_SENT пока orange всё ещё держал fresh lock. Orange packaging10:56:23.068 тоже PROVEN_SENT пока green держал fresh lock. Green packaging10:57:17.677 PROVEN_SENT; каждому initial соответствовал ровно один packaging click. Это успешная параллельность независимых existing Sends, не обгон очереди за тем же lock.

Не выдаётся за 4/4 IMAGE_RESULT_DURABLE: red получил IMAGE_RESULT_DURABLE10:56:33.243; orange download rejected DOWNLOAD_PROOF_CHANGED / p5_identity_changed на preclick reproof, clickAttempted=false; green позже получил busy cdp-download.lock; blue target перестал отвечать CDP в generation, controlled job остановлен и закрыт только его target. Все эти этапы после PROVEN_SENT/fresh lock release; точная причина DOM/CDP сбоя не доказана. Download lock и observer не менялись; попыток resend нет. Полного успешного4/4 generation/download данный прогон не доказал.

## 4. Timeout180с

Исходный timeout103119Z: holder195с после real exact fill + own attachment. Waiter получил ResourceBusyError через180,021с — исключение выходило до decorator body. about:blank, composer empty, uploads/fills/clicks0, никаких retries; holder затем PROVEN_SENT.

После правки живой timeout105717Z: waiter PID18536 ждал180,038с, вернул BROWSER_PRESEND_LOCK_TIMEOUT/PROVEN_NOT_SENT11:03:13.148 UTC; about:blank, empty composer, uploads/fills/clicks0, exitCodes[0,0]. Holder PID15172 завершил PROVEN_SENT11:03:37.949. Результат timeout admission структурирован: BROWSER_PRESEND_LOCK_TIMEOUT, PROVEN_NOT_SENT, recoverable=false, transitions=[], composerUntouched=true, sendAttempted=false. Lock берётся до любых Page/DOM/diagnostic/upload/fill; exception details не раскрывают private filesystem path. Timeout не даёт разрешения повторить REQ. Порог180с неизменён.

180с достаточно для четырёх initial Sends в финальном stress batch (максимум160,298с), но недостаточно как гарантия успешного completion при любых задержках: baseline queue это опровергает. Поэтому не обещаем стабильный4/4 durable и не маскируем overload увеличением timeout. Для independent reminder/existing глобальный порог больше не применим.

## 5. Сохранённые гарантии и проверки

- Общий _presend_transaction остаётся на fresh/existing/reminder/system-continuation; изменено только решение о global lock admission.
- UNKNOWN никогда не очищается/не повторяется; attempted marker, exact ownership/user-count/URL, foreign draft refusal, attachment cleanup membership и full sent attachment proof не менялись.
- Generation/observer/download после initial proof остаются параллельными. lock_chat, CDP lock, reminder click5000мс, control intent/anchor/deadline guards не менялись.
- test_presend*.py:18/18 PASS (5 новых scope/timeout tests +13 existing transaction/attachment tests).
- process_lock tests:8/8 PASS.
- Финальный Web suite:463 tests OK, skipped1; явно исключён известный неизменённый baseline test_web_worker_result_recovery.WebWorkerResultRecoveryTests.test_additional_processing_enters_active_system_flow (FakePage lacks locator). Не заявляется полный suite без исключения.
- git diff --check; intentional file staging; diagnostics/manifests/state/credentials не коммитятся.

## 6. Семь ответов

1. Один глобальный lock для всех Send не нужен: его вред для reminder доказан.
2. Оставить для explicit fresh / фазы; независимые existing /c/ работают с прежними строгими guards.
3. Исходный lock может израсходовать reminder deadline; поздний Send guard отказал правильно. После уточнения reminder проходит во время55с holder.
4. Четыре initial Image Send получили lock и правильные attachments; waits до160,298с. Не все четыре завершили download, что честно отделено от Send.
5. Starvation не доказан; overtaking доказан; FIFO/fairness гарантий нет.
6.180с не универсальная гарантия: перегрузка может истечь. Timeout остаётся terminal PROVEN_NOT_SENT без DOM mutations/retries.
7. #328 уже слит; необходим новый минимальный follow-up PR, без scheduler/очереди и без изменений unrelated download/observer.
