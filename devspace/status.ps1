$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot 'runtime.json'
$tailscale = 'C:/Program Files/Tailscale/tailscale.exe'
$publicUrl = 'https://desktop-dujmm2g.tail3bd4f2.ts.net'
$routeHost = 'desktop-dujmm2g.tail3bd4f2.ts.net:443'
$serverUrl = 'http://127.0.0.1:7676'
$state = $null
if (Test-Path -LiteralPath $statePath) { try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -DateKind String } catch { Write-Output 'State: invalid runtime.json'; exit 1 } }
$entry = if ($state) { $state.components.server } else { $null }
$proc = $null; $owned = $false
if ($entry -and $entry.pid -and $entry.executable) {
  try { $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.pid)" -ErrorAction Stop } catch {}
  if ($proc -and $proc.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($proc.ExecutablePath),[IO.Path]::GetFullPath($entry.executable),[StringComparison]::OrdinalIgnoreCase)) { try { $owned = ((Get-Process -Id ([int]$entry.pid)).StartTime.ToUniversalTime().ToString('o') -eq $entry.startTime) } catch {} }
}
if (-not (Test-Path -LiteralPath $tailscale)) { throw 'Tailscale CLI unavailable; current route cannot be verified.' }
$text = & $tailscale funnel status --json
if ($LASTEXITCODE -ne 0) { throw 'Native Funnel configuration could not be verified.' }
$route = ($text -join "`n") | ConvertFrom-Json -AsHashtable
if (-not $route.TCP) { $route.TCP = @{} }; if (-not $route.Web) { $route.Web = @{} }; if (-not $route.AllowFunnel) { $route.AllowFunnel = @{} }
$web443 = @($route.Web.Keys | Where-Object { $_ -match ':443$' })
$allowed443 = @($route.AllowFunnel.Keys | Where-Object { $_ -match ':443$' -and $route.AllowFunnel[$_] })
$handlers = if ($route.Web[$routeHost]) { $route.Web[$routeHost].Handlers } else { @{} }
$funnelActive = ($route.TCP['443'].HTTPS -eq $true -and $route.AllowFunnel[$routeHost] -eq $true)
$routeMatches = ($funnelActive -and $route.Foreground.Count -eq 0 -and $route.TCP['443'].Count -eq 1 -and $web443.Count -eq 1 -and $web443[0] -eq $routeHost -and $handlers.Count -eq 1 -and $handlers['/'].Proxy -eq $serverUrl -and $handlers['/'].Count -eq 1 -and $allowed443.Count -eq 1 -and $allowed443[0] -eq $routeHost)
$listeners = @(Get-NetTCPConnection -LocalPort 7676 -State Listen -ErrorAction SilentlyContinue)
$listenerOwned = ($owned -and $listeners.Count -eq 1 -and $listeners[0].LocalAddress -eq '127.0.0.1' -and $listeners[0].OwningProcess -eq [int]$entry.pid)
$result = [pscustomobject]@{
  tunnelProvider=if($funnelActive){'tailscale-funnel'}else{$null}
  recordedTunnelProvider=if($state){$state.tunnelProvider}else{$null}
  funnelActive=$funnelActive; routeMatchesExpected=$routeMatches
  funnelOwned=($routeMatches -and $state.tunnelProvider -eq 'tailscale-funnel' -and $state.publicUrl -eq $publicUrl -and $state.funnelTarget -eq $serverUrl)
  funnelTarget=$handlers['/'].Proxy; publicUrl=if($funnelActive){$publicUrl}else{$null}
  recordedPublicUrl=if($state){$state.publicUrl}else{$null}
  startedAt=if($state){$state.startedAt}else{$null}; listenerOwned=$listenerOwned
  components=@([pscustomobject]@{name='server';running=[bool]$proc;owned=$owned;recordedPid=if($entry){[int]$entry.pid}else{$null};pid=if($owned){[int]$entry.pid}else{$null};startTime=if($entry){$entry.startTime}else{$null};executable=if($entry){$entry.executable}else{$null}})
}
$result | ConvertTo-Json -Depth 6
