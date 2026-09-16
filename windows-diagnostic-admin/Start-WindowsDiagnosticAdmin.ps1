# Запускает сборщик в скрытом окне с запросом UAC. Сам файл ничего не исправляет.
[CmdletBinding()]
param([string]$OutputRoot = 'C:\Users\andre\.dsh\windows-diagnostic-admin')

New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$launch = Join-Path $OutputRoot 'last-launch.json'
try {
    $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $collector = Join-Path $PSScriptRoot 'Collect-WindowsDiagnosticAdmin.ps1'
    $p = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$collector,'-OutputRoot',$OutputRoot) -Verb RunAs -WindowStyle Hidden -PassThru
    @{ Timestamp=(Get-Date).ToString('o'); Status='Started; ожидается подтверждение UAC'; Pid=$p.Id; PowerShell=$pwsh; Collector=$collector; ExpectedOutputRoot=$OutputRoot } |
        ConvertTo-Json | Set-Content -LiteralPath $launch -Encoding UTF8
    Write-Output "PID=$($p.Id)"
    Write-Output "Ожидаемый каталог: $OutputRoot"
} catch {
    @{ Timestamp=(Get-Date).ToString('o'); Status='Failed'; Error=$_.Exception.Message; ExpectedOutputRoot=$OutputRoot } |
        ConvertTo-Json | Set-Content -LiteralPath $launch -Encoding UTF8
    throw
}
