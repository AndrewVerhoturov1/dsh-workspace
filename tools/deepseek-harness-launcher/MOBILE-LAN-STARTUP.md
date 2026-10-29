# DSH Mobile LAN: one-time on-demand Windows task

The mobile UI is part of the regular DSH Web profile (web, port 4173).
The regular Start/Restart launcher checks the existing LAN listener.
A healthy listener causes no network changes. If it is missing, the
launcher asks fixed Windows task \DSH-MobileLan-Restore to run once.
If Wi-Fi or the task is unavailable, desktop Web continues while
MOBILE_LAN_NOT_READY is emitted as a warning and written to the existing
launcher log. No timer, login trigger, extra service or server is used.

## Manual installation (once, after reviewed source is deployed)

Open Windows PowerShell as Administrator yourself and run exactly:

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\Users\Andrew\.dsh\tools\deepseek-harness-launcher\Install-MobileLanTask.ps1"

This is a manual command. The normal launcher never requests elevation,
installs the task, or changes the Windows firewall.

The installer checks the exact helper SHA-256 and places a fixed helper at
C:\ProgramData\DSH-MobileLan\Restore-MobileLan.ps1, protected with
Administrators/SYSTEM-only full-control ACL and Administrators ownership.
The task runs this protected copy as SYSTEM with fixed absolute PowerShell
path, fixed arguments, fixed working directory, and no triggers. Ordinary
local Users receive task read/execute access only; they cannot modify
its action. The task never reads source files, launcher logs or caller
arguments. An existing foreign task or untrusted protected-directory
object causes STOP, not overwrite. An exact existing task/helper is a no-op.

The helper checks localhost Web, /mobile, physical Wi-Fi IP, exact saved
portproxy and scoped Public firewall rule, and iphlpsvc. Only if the
expected LAN listener is missing and no conflict exists, it performs
one delete/add for the exact existing v4tov4 row:
192.168.0.5:4173 -> 127.0.0.1:4173. It never changes firewall, VPN,
trusted hosts, other proxy rows, or launcher startup defaults.

## Tests and activation

Run mock-only tests (no network or task changes):

    pwsh -NoProfile -NonInteractive -File "C:\Users\Andrew\.dsh\tools\deepseek-harness-launcher\mobile-lan-startup.test.ps1"

These mock tests do not prove real Windows task/portproxy operation.
After separately authorized installation check localhost HTTP 200,
mobile redirect HTTP 302, LAN listener/HTTP, then Android on the two
allowed Wi-Fi addresses with Amnezia on PC and Android. A controlled
Web restart and later a separate approved Windows reboot are required
to confirm real restart/reboot behavior.
