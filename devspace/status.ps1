#requires -Version 7.5
param([string]$Root=$PSScriptRoot)
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
$settings=Get-DevspaceSettings $Root
$state=Read-State (Join-Path $Root 'runtime.json')
$entry=$state.components.server
$identity=if($entry){Get-ServerIdentity $settings ([int]$entry.pid) $entry.startTime}else{$null}
$task=Get-ScheduledTask -TaskName 'DSH DevSpace Supervisor' -ErrorAction SilentlyContinue
$info=if($task){Get-ScheduledTaskInfo -TaskName $task.TaskName -ErrorAction SilentlyContinue}else{$null}
$lastAuthorized=$null
$log=Join-Path $Root 'logs/requests.jsonl'
if (Test-Path -LiteralPath $log) {
    $lastAuthorized=Get-Content -LiteralPath $log -Tail 500 | ForEach-Object { try { $event=$_ | ConvertFrom-Json; if($event.event -eq 'tool_call' -and $event.success -eq $true){$event | Select-Object ts,tool} } catch {} } | Select-Object -Last 1
}
[ordered]@{
    checkedAt=[DateTime]::UtcNow.ToString('o')
    publicUrl=$settings.PublicUrl+'/mcp'
    server=@{owned=[bool]$identity;pid=if($identity){$identity.pid}else{$null};runner=if($identity){$identity.runner}else{$false}}
    local=(Get-Probe $settings 'local')
    public=(Get-Probe $settings 'public')
    nativeRoute=(Get-FunnelRoute $settings)
    watchdog=@{paused=(Test-Path -LiteralPath (Join-Path $Root 'watchdog-paused'));taskState=[string]$task.State;lastTaskResult=$info.LastTaskResult;lastRun=$info.LastRunTime;principal=$task.Principal.UserId;logon=[string]$task.Principal.LogonType}
    recovery=(Read-State (Join-Path $Root 'watchdog-state.json'))
    installation=(Read-State (Join-Path $Root 'installation.json'))
    oauthAccountTokens='Not read by health checks; confirmed only by an authenticated client request.'
    lastAuthorizedToolCall=$lastAuthorized
} | ConvertTo-Json -Depth 14
