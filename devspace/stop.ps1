#requires -Version 7.5
param([string]$Root=$PSScriptRoot)
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
$settings=Get-DevspaceSettings $Root
$lock=Enter-LifecycleLock $settings
if (-not $lock) { throw 'Lifecycle operation already running.' }
try {
    Set-Content -LiteralPath (Join-Path $Root 'watchdog-paused') -Value 'Paused by stop.ps1; start.ps1 resumes.' -Encoding utf8
    Stop-DevspaceServer $settings
    if ((Get-FunnelRoute $settings) -eq 'active') { & $settings.Tailscale funnel --https=443 off; if ($LASTEXITCODE -ne 0) { throw 'Funnel stop failed.' } }
    Write-Output 'DevSpace stopped; watchdog paused. Configuration and OAuth preserved.'
} finally { $lock.Dispose() }
