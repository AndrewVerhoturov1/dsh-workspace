Option Explicit
Dim shell, fso, root, action, scriptName, ps, command, env
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
Set env = shell.Environment("Process")

env("DSH_WORKING_DIRECTORY") = "C:\Users\andre\.dsh-preview"
env("DSH_PROFILE") = "web"
env("DSH_PORT") = "4174"
env("DSH_LAUNCHER_ROOT") = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\DeepSeekHarnessLauncher-Preview"
env("DSH_PROCESS_CONTROLLER") = root & "\dsh-process-controller.js"
env("DSH_RESTART_HELPER") = root & "\Web-Restart.vbs"
env("DSH_LAUNCHER_MUTEX") = "DeepSeekHarnessPreviewLauncher.StartStop"
env("DSH_LAUNCHER_TITLE") = "DeepSeek Harness Preview"
env("DSH_REQUIRE_PROFILE_INSTALL") = "1"

action = "start"
If WScript.Arguments.Count > 0 Then action = LCase(WScript.Arguments(0))
Select Case action
  Case "start": scriptName = "Start-DSH.ps1"
  Case "stop": scriptName = "Stop-DSH.ps1"
  Case "restart": scriptName = "Restart-DSH.ps1"
  Case Else: scriptName = "Start-DSH.ps1"
End Select

ps = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & ps & """ -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & root & "\" & scriptName & """"
shell.Run command, 0, False
