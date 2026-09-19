# Preview Harness Launcher

Постоянный preview worktree запускается отдельно от main:

```text
main    C:\Users\andre\.dsh          http://127.0.0.1:4173/
preview C:\Users\andre\.dsh-preview  http://127.0.0.1:4174/
```

## Первый запуск

После merge этого изменения в `preview` и обновления `C:\Users\andre\.dsh-preview` один раз установить зависимости:

```powershell
& 'C:\Users\andre\.dsh-preview\tools\deepseek-harness-launcher\Prepare-DSH-Preview.ps1'
```

Локальные `settings.yaml`, `.credentials.yaml` и `codex-oauth.json` не копируются автоматически. Если пользователь явно хочет сделать одноразовую локальную копию существующей конфигурации main, используется:

```powershell
& 'C:\Users\andre\.dsh-preview\tools\deepseek-harness-launcher\Prepare-DSH-Preview.ps1' -SeedLocalConfig
```

Копирование fail-safe: существующие файлы preview не перезаписываются. `sessions/`, `storages/`, `attachments/`, журналы и другие runtime/user-data не копируются.

## Запуск

Двойной клик:

```text
start-dsh-preview.bat
```

Остановка и перезапуск:

```text
stop-dsh-preview.bat
restart-dsh-preview.bat
```

Preview launcher использует те же проверенные `Start-DSH.ps1` / `Stop-DSH.ps1` / `Restart-DSH.ps1`, но через отдельные process environment overrides:

```text
DSH_WORKING_DIRECTORY=C:\Users\andre\.dsh-preview
DSH_PROFILE=web
DSH_PORT=4174
DSH_LAUNCHER_ROOT=%LOCALAPPDATA%\DeepSeekHarnessLauncher-Preview
DSH_PROCESS_CONTROLLER=<preview>\tools\deepseek-harness-launcher\dsh-process-controller.js
DSH_RESTART_HELPER=<preview>\tools\deepseek-harness-launcher\Web-Restart.vbs
DSH_LAUNCHER_MUTEX=DeepSeekHarnessPreviewLauncher.StartStop
DSH_REQUIRE_PROFILE_INSTALL=1
```

Main defaults не меняются: `.dsh` и порт `4173` остаются обычным production launcher.

## Встроенная кнопка Restart

Контроллер передаёт запущенному DSH точные `cwd/profile/port/launcher-root/controller` через environment. Поэтому `dsh-restart-web` в preview наследует preview identity и вызывает `Web-Restart.vbs` именно из preview launcher root.

Это не позволяет preview-кнопке Restart случайно обратиться к main launcher.

## Изоляция

Main и preview имеют разные:

- рабочие папки;
- порты;
- mutex;
- launcher state (`dsh-runtime.json`, `dsh.pid`, logs): preview хранит его отдельно в `%LOCALAPPDATA%\DeepSeekHarnessLauncher-Preview`;
- runtime/user directories относительно разных repository roots.

Запрещено автоматически связывать или синхронизировать `sessions/`, `storages/`, `attachments/` и другие пользовательские runtime-данные между main и preview.
