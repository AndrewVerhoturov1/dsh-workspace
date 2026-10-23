POSTMAN_REQUEST_ID: REQ_20261023T203838Z_1361
Режим: WRITE_ISOLATED. Область для чтения: C:\PROJECTS\Real-tactic-wargame-babylon-soldier-sandbox\sandbox\babylon-soldier
Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:a9aedfcd-ee49-4b56-8b83-a7eec6c4ac53'. Если адрес недоступен, сообщи CAPABILITY_UNAVAILABLE обычным текстом; Этот адрес связывает выполнение с заданием. Назначенная область записи: C:\PROJECTS\Real-tactic-wargame-babylon-soldier-sandbox\sandbox\babylon-soldier.
Leader разрешил Computer Use для этого поручения.
DevSpace Bash не является песочницей. Не выходи за scope; не читай секреты/runtime credentials, binding и служебные файлы, не меняй права, не создавай AI-агентов, не устанавливай и не перезапускай Host/DevSpace. GitHub writes/commit/push/PR/merge запрещены здесь; отдельный местный маршрут требует разрешения.
## Инструкции Host
instructions_sha256: 80b4f481067e8beb2aaad08470b597cf91572c82d7d883cbe02e47086931570c
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/cfd6832017d265adb536f8500f76044905cc775a/postman/devspace/SKILL.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/cfd6832017d265adb536f8500f76044905cc775a/AGENTS.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/cfd6832017d265adb536f8500f76044905cc775a/REPO_POLICY.md
- https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/cfd6832017d265adb536f8500f76044905cc775a/docs/workflow/TASK_CONTRACT.md
Bell — отдельное узкое разрешение через настоящий DevSpace Bash (не читать скрипт/JSON):
pwsh -NoProfile -NonInteractive -File 'C:\Users\Andrew\AppData\Local\DSH\Postman\devspace\a9aedfcd-ee49-4b56-8b83-a7eec6c4ac53\signal.ps1' <done|need-decision|blocked> [-Message 'причина'] [-Report 'report.md']
## Поручение Leader
Заверши текущую интеграцию персонажа в браузере, безIK. Оба зависимыхзаданияDONE: тыудалилremovePlanarClipTravel послефактическогоподтверждениястиранияZвертикали; другойисполнительпереключилclipManifest.RIFLE_ASSETна/assets/local/m1-garand.glb. Прочти tools/blender/weapon/WEAPON-IMPORT.md при необходимости:реальнаяM1Garand1.105m,rootrightGrip0,+Zствол,+Yверх,leftGrip(0,.013367,.416617),muzzle(0,.076232,.821142);GLB162956B SHA E5F1FBF7E6F8B096E1E5F32F6411AC2CF5E7764CF6F1E4CAE94EE97DFEF490AD. Soldier14groups39837760B SHA EEA017798E7CFA49CA52C30DE5D5DE4E4B2BFC07C71ACDBDE3C9988CEC4E0E69. Теперьразрешёнnpmrunbuildиrefreshсуществующегоhttp://127.0.0.1:5181/,сервернеперезапускать. VUDAтолькоутебя,общийсеанссвободен. Главнаяпроверкапользователя: ходьба/бегбезвыворачивания/заплетанияног, несколькопоследовательныхреальныхфаз крупносбоку/спереди,немеряйкачествопозытолькокадрами/коленями. ИсточникиIKполностьюудалены,нельзяеёвосстанавливатьилидобавлятьпроцедурнуюправкупоз. Проверь новые6clips: crouch_walk/prone_idle/prone_crawl/stand_to_crouch/crouch_to_prone/prone_to_crouch,полныйstand↔crouch↔prone,смешиваниеколеноidle↔низкийшаг;фиксируйчто hipsвысотатеперьменяетсяистопы/тело неостаютсянапрежнейвысоте. ПроверьновуюM1направление/масштаб/праваякисть/muzzleвstand/crouch/prone;леваярукабезIKможетнеточнодержать — честноограничение,не возвращатьsolver. ДопустиматольконеобходимаякалибровкаRIGHT_HAND_WEAPON_MOUNTориентации/translationдляреальноймодели, не коверкатьasset. РеальныеUIвыстрелыстоя/присев/лёжа(нетскачкавстояприprone/crouch),возвраткidle,пауза/reset,краткийdeath/resetsmokeеслименяетсяжизненныйцикл. Не повторяйcore12tests/редактор/сцену:ихвходынеменялись. МинимальноисправляйобнаруженныедефектытольковCharacterView/clipManifest/mainbridgeприобоснованнойнеобходимости;неimporter/GLB/core/scene/ui/deps/Git. УстаревшийhardcodedweaponlogможноисправитьвтомжеCharacterView. Временнуюдиагностикуснятьпередфинальнымbuild/refresh. ОбновиCHARACTER-INTEGRATION.mdсновымкраткимитогом,точнымиUIнаблюдениями/снимками/ограничениями,безложногоPASS. Не делайновыйframework/костыли/аудитпроизводительности. Готово:рабочаясборкаM1+14анимацийбезIK,проверенызатронутыесценарии,остаточныедефектыназваны. Послеэтогобудетотдельныйнезависимыйкритик. Остановисьпослерезультата.
## Обязательный формат итогового ответа
После bell напиши итоговый ответ строго между следующими точными маркерами этого задания.
Если bell недоступен или поручение требует только текст, эти маркеры всё равно обязательны.
Каждый маркер — отдельная строка без кавычек, Markdown, пробелов или замены REQ.
Между ними — непустой итог, ограничения и результаты проверок; вне маркеров ничего не пиши.
<<<POSTMAN_RESULT_BEGIN:REQ_20261023T203838Z_1361>>>
<итог работы либо BLOCKED/NEED_DECISION с причиной>
<<<POSTMAN_RESULT_END:REQ_20261023T203838Z_1361>>>
Маркеры нужны скрипту получения ответа; они не заменяют bell и не доказывают PASS.
