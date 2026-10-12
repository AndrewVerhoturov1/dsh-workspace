$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$statePath = Join-Path $root 'runtime.json'
$logDir = Join-Path $root 'logs'
$node = 'C:/Program Files/nodejs/node.exe'
$bashDir = 'C:/Program Files/Git/bin'
$cli = Join-Path $root 'node_modules/@waishnav/devspace/bin/devspace.js'
$serverUrl = 'http://127.0.0.1:7676'
$publicUrl = 'https://desktop-dujmm2g.tail3bd4f2.ts.net'
$routeHost = 'desktop-dujmm2g.tail3bd4f2.ts.net:443'
$tailscale = 'C:/Program Files/Tailscale/tailscale.exe'
foreach ($file in @($node,$cli,$tailscale)) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing executable: $file" } }
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
function Get-FunnelRoute {
  $text = & $tailscale funnel status --json
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect native Funnel configuration; preserving it.' }
  $route = ($text -join "`n") | ConvertFrom-Json -AsHashtable
  if (-not $route.TCP) { $route.TCP = @{} }; if (-not $route.Web) { $route.Web = @{} }; if (-not $route.AllowFunnel) { $route.AllowFunnel = @{} }
  $web443 = @($route.Web.Keys | Where-Object { $_ -match ':443$' })
  $allowed443 = @($route.AllowFunnel.Keys | Where-Object { $_ -match ':443$' -and $route.AllowFunnel[$_] })
  if ($route.Foreground.Count -gt 0) { throw 'Foreground native routes exist; refusing to change route ownership.' }
  if (-not $route.TCP['443'] -and $web443.Count -eq 0 -and $allowed443.Count -eq 0) { return 'absent' }
  $handlers = if ($route.Web[$routeHost]) { $route.Web[$routeHost].Handlers } else { @{} }
  if ($route.TCP['443'].HTTPS -eq $true -and $route.TCP['443'].Count -eq 1 -and $web443.Count -eq 1 -and $web443[0] -eq $routeHost -and $handlers.Count -eq 1 -and $handlers['/'].Proxy -eq $serverUrl -and $handlers['/'].Count -eq 1 -and $allowed443.Count -eq 1 -and $allowed443[0] -eq $routeHost) { return 'active' }
  throw 'Native HTTPS 443 configuration differs from the approved sole root proxy; preserving it.'
}
$existing = $null
if (Test-Path -LiteralPath $statePath) { try { $existing = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -DateKind String } catch { throw 'runtime.json is invalid; no existing process will be stopped.' } }
if ($existing) {
  $entry = $existing.components.server; $proc = $null; $owned = $false
  if ($entry -and $entry.pid -and $entry.executable) { try { $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.pid)" -ErrorAction Stop } catch {} }
  if ($proc -and $proc.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($proc.ExecutablePath),[IO.Path]::GetFullPath($entry.executable),[StringComparison]::OrdinalIgnoreCase)) { try { $owned = ((Get-Process -Id ([int]$entry.pid)).StartTime.ToUniversalTime().ToString('o') -eq $entry.startTime) } catch {} }
  $listeners = @(Get-NetTCPConnection -LocalPort 7676 -State Listen -ErrorAction SilentlyContinue)
  if ($owned -and $listeners.Count -eq 1 -and $listeners[0].LocalAddress -eq '127.0.0.1' -and $listeners[0].OwningProcess -eq [int]$entry.pid -and $existing.tunnelProvider -eq 'tailscale-funnel' -and $existing.publicUrl -eq $publicUrl -and $existing.funnelTarget -eq $serverUrl -and (Get-FunnelRoute) -eq 'active') { Write-Output "Already running: $publicUrl"; exit 0 }
  throw 'Partial, stale or different runtime state exists; preserving processes and native routes.'
}
if (Get-NetTCPConnection -LocalPort 7676 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 7676 already in use; no existing process will be stopped.' }
$routeState = Get-FunnelRoute
$moduleUrl = ([uri](Join-Path $root 'node_modules/@waishnav/devspace/dist/user-config.js')).AbsoluteUri | ConvertTo-Json -Compress
$configScript = @"
import { loadDevspaceFiles, setDevspaceConfigValues } from $moduleUrl;
const { config } = loadDevspaceFiles();
if (config.server.host !== '127.0.0.1' || config.server.port !== 7676) throw new Error('Expected loopback host/port; config preserved.');
const hosts = config.server.allowedHosts ?? [];
const edits = [];
if (config.server.publicBaseUrl !== '$publicUrl') edits.push({path:['server','publicBaseUrl'],value:'$publicUrl'});
if (!hosts.includes('desktop-dujmm2g.tail3bd4f2.ts.net')) edits.push({path:['server','allowedHosts'],value:[...hosts,'desktop-dujmm2g.tail3bd4f2.ts.net']});
if (edits.length) setDevspaceConfigValues(edits);
"@
& $node --input-type=module -e $configScript
if ($LASTEXITCODE -ne 0) { throw 'DevSpace public origin/allowedHosts preparation failed; no server started.' }
if ($routeState -eq 'absent') {
  & $tailscale funnel --bg --https=443 $serverUrl
  if ($LASTEXITCODE -ne 0) { throw 'Native Funnel start failed; no server started.' }
}
if ((Get-FunnelRoute) -ne 'active') { throw 'Expected native Funnel route is not active; no server started.' }
$serverOut = Join-Path $logDir 'server.stdout.log'; $serverErr = Join-Path $logDir 'server.stderr.log'
$server = $null
$components = [ordered]@{}
function Save-State {
  if ($components.Count -gt 0) {
    $state = [pscustomobject]@{ tunnelProvider='tailscale-funnel'; publicUrl=$publicUrl; funnelTarget=$serverUrl; startedAt=$components.server.startTime; components=[pscustomobject]$components }
    $tmp = "$statePath.tmp"; $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tmp -Encoding utf8; Move-Item -LiteralPath $tmp -Destination $statePath -Force
  }
}
function Quote-Argument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '(\\*)"','$1$1\"' -replace '(\\+)$','$1$1') + '"'
}
try {
  $env:PATH = "$bashDir;C:/Program Files/nodejs;$env:PATH"
  $server = Start-Process -FilePath $node -ArgumentList ((@($cli,'serve') | ForEach-Object { Quote-Argument $_ }) -join ' ') -PassThru -WindowStyle Hidden -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr
  $components.server = [pscustomobject]@{ pid=$server.Id; startTime=$server.StartTime.ToUniversalTime().ToString('o'); executable=$node }
  Save-State
  $until = [DateTime]::UtcNow.AddSeconds(30)
  $ready = $false
  while ([DateTime]::UtcNow -lt $until) {
    if ($server.HasExited) { throw 'DevSpace server exited before readiness; inspect logs/server.*.log privately.' }
    try { $response = Invoke-RestMethod -Uri ($serverUrl+'/healthz') -TimeoutSec 2; if ($response.ok -eq $true -and $response.name -eq 'devspace') { $ready=$true; break } } catch {}
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw 'DevSpace server did not respond on loopback within 30 seconds; runtime preserved.' }
  Write-Output "DevSpace ready: $publicUrl"
} catch { Save-State; throw }
