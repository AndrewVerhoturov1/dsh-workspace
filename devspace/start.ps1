#requires -Version 7.5
param([string]$Root=$PSScriptRoot)
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
$settings=Get-DevspaceSettings $Root
$lock=Enter-LifecycleLock $settings
if (-not $lock) { Write-Output 'Lifecycle operation already running.'; exit 0 }
try {
    $identity=Start-DevspaceServer $settings
    Remove-Item -LiteralPath (Join-Path $Root 'watchdog-paused') -Force -ErrorAction SilentlyContinue
    Enable-ExpectedFunnel $settings
    Write-Output "DevSpace PID $($identity.pid): $($settings.PublicUrl)/mcp"
} finally { $lock.Dispose() }
