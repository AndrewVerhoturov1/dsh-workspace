# Запускает последующий сборщик встроенным Windows PowerShell 5.1 через один запрос UAC.
[CmdletBinding()]
param([string]$OutputRoot='C:\Users\andre\.dsh\windows-diagnostic-admin')
New-Item -ItemType Directory -Path $OutputRoot -Force|Out-Null
$launch=Join-Path $OutputRoot 'last-followup-launch.json'
try{$ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';if(-not(Test-Path -LiteralPath $ps)){throw "Не найден $ps"};$collector=Join-Path $PSScriptRoot 'Collect-WindowsDiagnosticFollowup.ps1';$p=Start-Process -FilePath $ps -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$collector,'-OutputRoot',$OutputRoot) -Verb RunAs -WindowStyle Hidden -PassThru;@{Timestamp=(Get-Date).ToString('o');Status='Started; ожидается подтверждение UAC';Pid=$p.Id;PowerShell=$ps;Collector=$collector;ExpectedOutputRoot=(Join-Path $OutputRoot 'followup')}|ConvertTo-Json|Set-Content $launch -Encoding UTF8;Write-Output "PID=$($p.Id)";Write-Output "Ожидаемый каталог: $(Join-Path $OutputRoot 'followup')"}catch{@{Timestamp=(Get-Date).ToString('o');Status='Failed';Error=$_.Exception.Message}|ConvertTo-Json|Set-Content $launch -Encoding UTF8;throw}
