# Ремонт запуска DSH/Harness

Дата проверки: 2026-08-29.

## Root cause

- **Симптом:** `dsh --profile web --dump-config` завершался с кодом 1 с `ERR_MODULE_NOT_FOUND` для `@deepseek-ai/dsh-app-boot`.
- **Фактический CLI:** `C:\Users\andre\AppData\Roaming\npm\dsh.cmd`, пакет CLI — `C:\Users\andre\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`.
- **Версия CLI:** `@deepseek-ai/dsh@0.1.1-rc.2`.
- **Ожидаемая версия `@deepseek-ai/dsh-app-boot`:** `^0.1.1-rc.2`, фактическая версия в хранилище — `0.1.1-rc.2`.
- **Пакет существовал на диске:** да.
- **Ожидаемый путь ссылки:** `C:\Users\andre\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-app-boot`.
- **Фактическое состояние до ремонта:** ожидаемая ссылка отсутствовала. Пакет был в локальном хранилище pnpm по адресу `C:\Users\andre\AppData\Local\pnpm\store\v11\links\@deepseek-ai\dsh-app-boot\0.1.1-rc.2\8ca507c4dfa8dff8f014e6411ae961c3f88229a433587d27ff271569e17e52ea\node_modules\@deepseek-ai\dsh-app-boot`.
- **Причина:** глобальная установка DSH была неполной: в её `node_modules` отсутствовали ссылки на 58 объявленных рабочих зависимостей, хотя соответствующие точные версии находились в локальном хранилище pnpm. Это повреждение локальной установки, а не дефект репозитория.

## Repair

- Созданы только отсутствующие junction-ссылки из глобального каталога DSH на найденные точные версии в локальном хранилище pnpm: всего 58 ссылок, включая `dsh-app-boot`; существовавшие 5 ссылок не изменялись.
- Файлы репозитория, относящиеся к среде, не менялись; lock-файлы и исходники Flowglass не менялись.
- Команды установки пакетов: не использовались.
- Широкая переустановка: **нет**.
- `settings.yaml`, пользовательские диагностические файлы и несвязанные незатреканные файлы сохранены.

## Harness verification

- `dsh --profile web --dump-config`: **PASS**.
- Холодный запуск новым процессом: **PASS**.
- Flowglass загружен: **PASS**.
- `dsh-postman-harness` загружен: **PASS**.
- `agent-loop.config.agents`: `[]`, без неожиданных изменений.

## Result

Среда DSH/Harness восстановлена локально. Регенерация или публикация этой локальной установки не выполнялась; после удаления или повторной установки глобального DSH ссылки потребуется восстановить штатным установщиком.
