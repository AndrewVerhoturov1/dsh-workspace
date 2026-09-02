Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'DSH-Common.ps1')

$mutex = $null
try {
    $mutex = Enter-LauncherMutex
    if (-not $mutex) { throw 'Another launcher operation is already running. Retry in a few seconds.' }
    [void](Invoke-DshController -Action 'start')
    Open-WebUi
    exit 0
} catch {
    $message = $_.Exception.Message
    Show-LauncherMessage -Message $message
    exit 1
} finally {
    Exit-LauncherMutex -Mutex $mutex
}
