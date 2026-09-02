Option Explicit
Dim shell, fso, root, action, scriptName, ps, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
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
