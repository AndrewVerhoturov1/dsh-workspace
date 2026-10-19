# Pixel Perfect UI Port v1 — локальный измеритель

Измеряет одну и ту же видимую область reference и target в Chromium. Сравнивает position/size, фиксированный набор computed styles и PNG по прямым RGBA-каналам. Не вносит изменений в игру и не исправляет CSS автоматически. В исходном web profile предусмотрен VUDA с местным скрытым Chromium (`VUDA_BROWSER_PROVIDER=local`), но без активации и реального испытания его работоспособность в активном Host не подтверждена. Playwright MCP, VUDA и измеритель используют отдельные сеансы; входы и состояние страниц автоматически не переносятся.

## Установка в проекте (Windows)

Нужны Node.js 20+ и PowerShell 7. Из корня репозитория:

```powershell
pwsh -NoProfile -NonInteractive -File .\.agents\skills\pixel-perfect-ui-port\setup.ps1
```

Сценарий ставит только зависимости `node_modules`, npm cache `.npm-cache` и Playwright Chromium `.playwright-browsers` внутри папки skill, затем запускает doctor и self-test. Настройки DSH, игра, ветки Git и постоянные профили не изменяются. Итоговые артефакты находятся в `artifacts/` и исключены из Git.

Для явных отдельных проверок из каталога навыка:

```powershell
node scripts/doctor.mjs
node tests/self-test.mjs
```

Self-test запускает временный локальный HTTP-сервер на случайном свободном порту, но никогда не использует 3080/4173 или `file://`. Сервер закрывается в `finally`. Результаты: `artifacts/self-test-results.txt` и `artifacts/selftest/<component>/`.

## Проверка собственного интерфейса

1. Поднимите reference и target локальными HTTP-серверами и получите устойчивые selectors.
2. Создайте `pixel-perfect.config.json` на основе `example.config.json`. URL — только HTTP(S), имя компонента/viewport — буквы, цифры, `_` или `-`, без `..` или путей.
3. В каталоге навыка запустите:

```powershell
node scripts/check.mjs --config pixel-perfect.config.json --component upgrade-button --viewport desktop
```

Без `--component`/`--viewport` проверяются все пары конфигурации. Каждый результат: `artifacts/<viewport>/<component>/reference.json`, `reference.png`, `target.json`, `target.png`, `report.json`; `diff.png` присутствует только при равных размерах PNG. `report.json` содержит точные поля расхождений и статистику pixel diff.

Коды выхода: `0` = PASS, `1` = visual BLOCK, `2` = ошибочная конфигурация, отсутствие selector/браузера, runtime issue. Числа конфигурации ограничены: geometryTolerancePx `0..0.5`, pixelChannelTolerance целое `0..2`. Сравнение не делает resize/masking и не повышает пороги.

Для раздельного измерения и повторного сравнения (пути вывода должны находиться внутри каталога `artifacts` этого навыка):

```powershell
node scripts/capture.mjs --url http://127.0.0.1:5180/reference --selector '#upgrade-button' --name desktop --width 1440 --height 900 --out ./artifacts/desktop/upgrade-button --label reference
node scripts/capture.mjs --url http://127.0.0.1:5181/game --selector '.upgrade-button' --name desktop --width 1440 --height 900 --out ./artifacts/desktop/upgrade-button --label target
node scripts/compare-ui.mjs --dir ./artifacts/desktop/upgrade-button --component upgrade-button --viewport desktop
```

Захват начинается с прокрутки `0,0` и требует полностью видимый компонент внутри viewport. Для overflow/shadows выберите внешний контейнер как selector; PNG самого элемента может обрезать эффекты вне `getBoundingClientRect`. Умеет измерять default state: подготовку hover/modal/selected и настоящую функциональную проверку делайте отдельно. Runtime `pageErrors` ведут к exit 2; `consoleErrors` сохраняются для сверки с исходным baseline, без утверждения об их новизне.

## Исходная интеграция VUDA (без активации)

В `profiles/web/cordis.patch.yml` добавлен отдельный `mcp-vuda`: `stdio`, `npx -y visual-ui-debug-agent-mcp@1.1.0`, `failOnStartupError: false`. Профиль явно задаёт `VUDA_BROWSER_PROVIDER=local`; в коде этой версии местный Chromium запускается с `headless: true`. Существующий `mcp-playwright` использует свой скрытый Chromium. Рабочий каталог VUDA указывает на `DSH_HOME` (по умолчанию `$HOME/.dsh` в Windows через `USERPROFILE`), **не** на каталог игры. `DOTENV_CONFIG_PATH` указывает на существующий исходный файл `<DSH_HOME>/.agents/skills/pixel-perfect-ui-port/references/vuda-empty.config`; ручная глобальная копия навыка для этого пути не требуется. В файле только комментарии, секретов нет. Это не удаляет унаследованные переменные среды. Для версии 1.1.0 ранее сообщалась ошибка импорта `dotenv/config`; наличие нужной зависимости и действительный запуск VUDA здесь не доказаны. Missing/forbidden инструменты требуют STOP для маршрутизации; VUDA не отменяет ролевые разрешения и функциональную приёмку через канонический Playwright.

## Копия user-global (только явное решение владельца)

Provider DSH обнаруживает project `.agents/skills` и пользовательские `<DSH_HOME>/skills` (обычно `$HOME/.dsh/skills`). **Ничего не устанавливается в активный DSH_HOME этой задачей**. Если владелец захочет глобальную установку, после интеграции изменений в постоянный репозиторий (НЕ из временного task worktree), из его корня отдельно выполните в PowerShell:

```powershell
$source = (Resolve-Path '.\.agents\skills\pixel-perfect-ui-port').Path
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$dest = Join-Path $dshHome 'skills\pixel-perfect-ui-port'
if (Test-Path -LiteralPath $dest) { throw "Existing install: $dest — do not overwrite" }
New-Item -ItemType Directory -Path $dest | Out-Null
foreach ($item in @('SKILL.md','README.md','example.config.json','package.json','package-lock.json','setup.ps1','.gitignore','scripts','fixtures','tests','references')) {
    Copy-Item -LiteralPath (Join-Path $source $item) -Destination (Join-Path $dest $item) -Recurse
}
pwsh -NoProfile -NonInteractive -File (Join-Path $dest 'setup.ps1')
```

Это независимая **копия**, не ссылка на временный каталог. `DSH_HOME` поддержан непосредственно командой; список копирования намеренно исключает `node_modules`, `.npm-cache`, `.playwright-browsers`, `artifacts`. Файл `references/vuda-empty.config` попадает в копию вместе с `references/`; web profile читает исходный файл из `<DSH_HOME>/.agents/skills/pixel-perfect-ui-port/references/`. Не перезаписывать чужую установку. Обнаружение навыка вне проекта следует проверить через существующий filesystem provider, если он доступен; действительный VUDA MCP — после отдельной активации профиля. Реальный trial на игре **PENDING**.

См. `SKILL.md`, `references/rules.md`, `references/vuda.md`.
