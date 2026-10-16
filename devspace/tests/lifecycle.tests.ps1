#requires -Version 7.5
$ErrorActionPreference='Stop'
$source=Split-Path $PSScriptRoot -Parent
. (Join-Path $source 'watchdog.ps1') -LibraryOnly
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('devspace-recovery-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$settings=Get-DevspaceSettings $testRoot
$reservation=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$reservation.Start(); $settings.Port=$reservation.LocalEndpoint.Port; $reservation.Stop()
$settings.LocalUrl='http://127.0.0.1:'+$settings.Port
$settings.Cli=Join-Path $testRoot 'unused-cli.js'
Set-Content -LiteralPath $settings.Cli -Value '// test fixture' -Encoding utf8NoBOM
$fixture=@'
import http from 'node:http';
import fs from 'node:fs';
const server=http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end('{"ok":true,"name":"devspace"}')});
server.listen(PORT,'127.0.0.1');
setInterval(()=>{try{const v=JSON.parse(fs.readFileSync('stop-request.json'));if(v.pid===process.pid&&v.instance===process.env.DSH_DEVSPACE_INSTANCE)process.exit(0)}catch{}},100);
'@
$fixture.Replace('PORT',[string]$settings.Port) | Set-Content -LiteralPath $settings.Runner -Encoding utf8NoBOM
$script:checks=[Collections.Generic.List[string]]::new()
function Assert([bool]$Condition,[string]$Name) { if(-not $Condition){throw "FAIL: $Name"};$script:checks.Add($Name) }
$script:edgeState='healthy';$script:funnelRepairs=0
function Get-Probe($Settings,[string]$Mode) {
    if($Mode -eq 'public'){return @{state=$script:edgeState;dns=$true;edges=@()}}
    $ok=Get-LocalHealth $Settings
    return @{healthy=$ok;health=if($ok){200}else{0};mcp=if($ok){401}else{0};authGate=$ok;issuerOk=$ok}
}
function Enable-ExpectedFunnel($Settings,[switch]$Refresh){$script:funnelRepairs++}
$foreign=$null
try {
    Write-State (Join-Path $testRoot 'runtime.json') @{components=@{server=@{pid=$PID;executable=$settings.Node;startTime='stale'}}}
    $first=Start-DevspaceServer $settings
    Assert ([bool](Get-Process -Id $PID)) 'stale PID did not stop unrelated PowerShell'
    Assert ($first.pid -ne $PID -and (Get-LocalHealth $settings)) 'stale state recovered with real isolated server'
    $second=Start-DevspaceServer $settings
    Assert ($second.pid -eq $first.pid) 'repeated start adopted same process'
    $held=Enter-LifecycleLock $settings
    try { Assert (-not (Enter-LifecycleLock $settings)) 'exclusive lifecycle lock'; Assert ((Invoke-DevspaceWatchdog $settings).result -eq 'busy') 'concurrent watchdog skipped' } finally {$held.Dispose()}
    $script:edgeState='down'
    $old=[DateTime]::UtcNow.AddMinutes(-4).ToString('o')
    Write-State (Join-Path $testRoot 'watchdog-state.json') @{localFailures=0;publicFailures=3;localAttempts=0;funnelAttempts=0;publicFailedSince=$old}
    $out=Invoke-DevspaceWatchdog $settings
    Assert ($script:funnelRepairs -eq 1 -and $out.action -eq 'refresh_funnel') 'confirmed public outage repairs Funnel only (simulated)'
    Assert ([bool](Get-ServerIdentity $settings $first.pid $first.startTime)) 'healthy server survived public outage'
    $out=Invoke-DevspaceWatchdog $settings
    Assert ($script:funnelRepairs -eq 1 -and $out.action -eq 'funnel_backoff') 'Funnel repair has cooldown'
    $out.funnelAttempts=2;$out.nextFunnel=$null;Write-State (Join-Path $testRoot 'watchdog-state.json') $out
    Assert ((Invoke-DevspaceWatchdog $settings).action -eq 'funnel_circuit_open') 'Funnel repair budget opens circuit'
    $script:edgeState='degraded'
    Assert ((Invoke-DevspaceWatchdog $settings).action -eq 'observe') 'one working edge prevents disruptive Funnel repair'
    $script:edgeState='healthy'
    Stop-Process -Id $first.pid
    Wait-Process -Id $first.pid -Timeout 5 -ErrorAction SilentlyContinue
    $out=Invoke-DevspaceWatchdog $settings
    $recovered=Read-State (Join-Path $testRoot 'runtime.json')
    Assert ($out.lastRecovery.result -eq 'local_restored' -and $recovered.components.server.pid -ne $first.pid) 'real crash recovered by watchdog'
    $out=Invoke-DevspaceWatchdog $settings
    Assert ((Read-State (Join-Path $testRoot 'runtime.json')).components.server.pid -eq $recovered.components.server.pid) 'repeated watchdog did not duplicate server'
    $entry=$recovered.components.server.Clone();$entry.startTime='reused-PID';Write-State (Join-Path $testRoot 'runtime.json') @{components=@{server=$entry}}
    $refused=$false;try{Stop-DevspaceServer $settings -Unresponsive}catch{$refused=$true}
    Assert ($refused -and [bool](Get-Process -Id $entry.pid)) 'PID reuse/start-time mismatch refuses termination'
    Write-State (Join-Path $testRoot 'runtime.json') $recovered
    Stop-DevspaceServer $settings
    Assert (-not (Get-LocalHealth $settings)) 'graceful stop completed'
    $bad=@{localAttempts=3;localFailures=5;funnelAttempts=0}
    Assert ((Get-RecoveryDecision $bad $false $false 'unknown' ([DateTime]::UtcNow)) -eq 'local_circuit_open') 'local restart budget opens circuit'
    Set-Content -LiteralPath (Join-Path $testRoot 'watchdog-state.json') -Value '{broken'
    Assert ((Invoke-DevspaceWatchdog $settings).result -eq 'invalid_state_preserved') 'corrupt recovery budget is preserved fail closed'
    $report=@{passed=$checks.Count;checks=$checks;testRoot=$testRoot;productionNetworkChanged=$false}
    Write-State (Join-Path $testRoot 'results.json') $report
    $report | ConvertTo-Json -Depth 5
} finally {
    $record=Read-State (Join-Path $testRoot 'runtime.json')
    if($record.components.server){$owned=Get-ServerIdentity $settings ([int]$record.components.server.pid) $record.components.server.startTime;if($owned){Stop-Process -Id $owned.pid -ErrorAction SilentlyContinue}}
}
