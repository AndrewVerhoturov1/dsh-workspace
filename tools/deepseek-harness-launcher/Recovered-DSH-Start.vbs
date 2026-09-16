Set shell = CreateObject("WScript.Shell")
script = "C:\Users\Andrew\.dsh\tools\deepseek-harness-launcher\Recovered-DSH-Start.ps1"
shell.Run "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, False
