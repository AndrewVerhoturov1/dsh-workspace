#requires -Version 7.5
param([string]$Root=$PSScriptRoot, [switch]$Monitor, [switch]$LibraryOnly)
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
function Get-RecoveryDecision($State, [bool]$LocalHealthy, [bool]$ListenerPresent, [string]$PublicState, [DateTime]$Now) {
    if (-not $LocalHealthy) {
        if ($State.localAttempts -ge 3) { return 'local_circuit_open' }
        if ($State.nextLocal -and $Now -lt [DateTime]::Parse($State.nextLocal).ToUniversalTime()) { return 'local_backoff' }
        if (-not $ListenerPresent) { return 'start_server' }
        if ($State.localFailures -ge 2) { return 'restart_server' }
        return 'confirm_local_failure'
    }
    if ($PublicState -eq 'down' -and $State.publicFailures -ge 3 -and $State.publicFailedSince -and ($Now-[DateTime]::Parse($State.publicFailedSince).ToUniversalTime()).TotalSeconds -ge 180) {
        if ($State.funnelAttempts -ge 2) { return 'funnel_circuit_open' }
        if ($State.nextFunnel -and $Now -lt [DateTime]::Parse($State.nextFunnel).ToUniversalTime()) { return 'funnel_backoff' }
        return 'refresh_funnel'
    }
    return 'observe'
}
function Invoke-DevspaceWatchdog($Settings) {
    $lock=Enter-LifecycleLock $Settings
    if (-not $lock) { return @{result='busy'} }
    try {
        if (Test-Path -LiteralPath (Join-Path $Settings.Root 'watchdog-paused')) { return @{result='paused'} }
        $statePath=Join-Path $Settings.Root 'watchdog-state.json'
        $state=Read-State $statePath
        if (-not $state) {
            if (Test-Path -LiteralPath $statePath) { Write-Diagnostic $Settings 'invalid_watchdog_state'; return @{result='invalid_state_preserved'} }
            $state=@{localFailures=0;publicFailures=0;localAttempts=0;funnelAttempts=0}
        }
        $now=[DateTime]::UtcNow
        $local=Get-Probe $Settings 'local'
        $health=($local.health -eq 200)
        $external=Get-Probe $Settings 'public'
        $state.localFailures=if($health){0}else{[int]$state.localFailures+1}
        if ($external.state -eq 'down') {
            $state.publicFailures=[int]$state.publicFailures+1
            if (-not $state.publicFailedSince) { $state.publicFailedSince=$now.ToString('o') }
        } else { $state.publicFailures=0; $state.publicFailedSince=$null }
        if ($health -and $local.healthy -and $external.state -eq 'healthy') {
            if (-not $state.healthySince) { $state.healthySince=$now.ToString('o') }
            if (($now-[DateTime]::Parse($state.healthySince).ToUniversalTime()).TotalMinutes -ge 10) {
                $state.localAttempts=0; $state.funnelAttempts=0; $state.nextLocal=$null; $state.nextFunnel=$null
            }
        } else {
            $state.healthySince=$null
            $state.lastFault=if(-not $health){'local_server'}elseif(-not $local.healthy){'oauth_gate_or_metadata'}else{'funnel_'+$external.state}
            $state.lastFaultAt=$now.ToString('o')
        }
        $record=Read-State (Join-Path $Settings.Root 'runtime.json')
        $entry=$record.components.server
        $owned=if($entry){Get-ServerIdentity $Settings ([int]$entry.pid) $entry.startTime}else{$null}
        $decision=Get-RecoveryDecision $state $health ((@(Get-Listeners $Settings).Count -gt 0) -or [bool]$owned) $external.state $now
        if ($health -and -not $local.healthy -and $decision -eq 'refresh_funnel') { $decision='oauth_requires_owner' }
        $state.checkedAt=$now.ToString('o'); $state.local=$local; $state.public=$external; $state.action=$decision
        if ($decision -in @('start_server','restart_server','refresh_funnel')) {
            if ($decision -eq 'refresh_funnel') {
                $state.funnelAttempts=[int]$state.funnelAttempts+1
                $state.nextFunnel=$now.AddMinutes(15).ToString('o')
            } else {
                $state.localAttempts=[int]$state.localAttempts+1
                $state.nextLocal=$now.AddSeconds(@(60,300,1800)[$state.localAttempts-1]).ToString('o')
            }
            # Persist before changing anything, so supervisor crashes cannot erase the budget.
            $state.lastRecovery=@{at=$now.ToString('o');action=$decision;result='started'}
            Write-State $statePath $state
            Write-Diagnostic $Settings 'recovery_started' @{action=$decision}
            try {
                if ($decision -eq 'refresh_funnel') { Enable-ExpectedFunnel $Settings -Refresh }
                else {
                    if ($decision -eq 'restart_server') { Stop-DevspaceServer $Settings -Unresponsive }
                    $null=Start-DevspaceServer $Settings
                }
                $state.local=Get-Probe $Settings 'local'
                $state.public=Get-Probe $Settings 'public'
                $state.lastRecovery.result=if($decision -eq 'refresh_funnel'){$state.public.state}elseif($state.local.healthy){'local_restored'}else{'local_not_restored'}
            } catch { $state.lastRecovery.result='failed_or_busy_preserved' }
            Write-Diagnostic $Settings 'recovery_finished' @{action=$decision;result=$state.lastRecovery.result}
        }
        Write-State $statePath $state
        Write-Diagnostic $Settings 'check' @{local=[bool]$state.local.healthy;public=$state.public.state;action=$decision}
        return $state
    } finally { $lock.Dispose() }
}
if (-not $LibraryOnly) {
    $settings=Get-DevspaceSettings $Root
    do {
        try { $result=Invoke-DevspaceWatchdog $settings; if (-not $Monitor) { $result | ConvertTo-Json -Depth 12 } }
        catch { if (-not $Monitor) { throw }; Write-Diagnostic $settings 'supervisor_check_failed' }
        if ($Monitor) { Start-Sleep -Seconds 60 }
    } while ($Monitor)
}
