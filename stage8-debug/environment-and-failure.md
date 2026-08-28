# Environment and Stage 8 failure notes

Node version: v24.14.1
PowerShell version: 5.1.19041.6456 (Desktop)
Windows version: Windows 10 Pro 22H2, build 19045

Какой браузер использовался:
Google Chrome, process id 12404, window title `Комп юс — DeepSeek Harness - Google Chrome`, main window handle 132630.

Как именно запускался Stage 8:
Node.js запускал новый файл `tests/parallel-retest-stage8.js`. Сценарий сам запускал тестовый Notepad, отдельное WPF semantic test window, PowerShell foreground monitors и прототипный adapter. В первой версии сценарий пытался программно вернуть браузер через `SetForegroundWindow`; во второй версии был добавлен `AttachThreadInput`.

Точная команда:
`node tests/parallel-retest-stage8.js`

Последние доступные строки stdout/stderr перед первым сбоем подготовки:

```text
[stage8] select browser
[stage8] launch notepad
[stage8] find notepad child
[stage8] launch semantic target
[stage8] semantic target ready
[stage8] restore browser
Error: SetForegroundWindow failed
At line:3 char:154
+ ... ::SetForegroundWindow($h)){throw 'SetForegroundWindow failed'}; Start ...
+                                ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : OperationStopped: (SetForegroundWindow failed:String) [], RuntimeException
    + FullyQualifiedErrorId : SetForegroundWindow failed
    at ChildProcess.<anonymous> (C:\Users\andre\qwen-computer-use-evaluation\dsh-computer-adapter-prototype\tests\parallel-retest-stage8.js:19:79)
    at Object.onceWrapper (node:events:623:5)
    at ChildProcess.emit (node:events:508:28)
    at maybeClose (node:internal/child_process:1100:16)
    at ChildProcess._onexit (node:internal/child_process:1100:16)
[exit code: 1]
```

Вторая попытка после добавления `AttachThreadInput` была прервана по тайм-ауту инструмента до записи отчёта. Отдельный одиночный тест `getState` до этого прошёл: `success=true`, `status=PASS`, `verified=true`.

Ключевой участок, который вызвал зависание в попытке остановки монитора:

```js
if (!child.killed) child.kill();
await new Promise(resolve => child.once('close', resolve));
```

Это ожидание не идемпотентно: подписка ставится после `kill()`, не имеет тайм-аута и не обрабатывает уже завершившийся процесс. Следующий сценарий должен использовать ручное переключение браузера пользователем и отдельный идемпотентный shutdown.

Примечание: не запускать `SetForegroundWindow` или `AttachThreadInput` в следующем эксперименте.
