$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot 'runtime.json'
$tailscale = 'C:/Program Files/Tailscale/tailscale.exe'
$publicUrl = 'https://desktop-dujmm2g.tail3bd4f2.ts.net'
$routeHost = 'desktop-dujmm2g.tail3bd4f2.ts.net:443'
$serverUrl = 'http://127.0.0.1:7676'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'No runtime state; no process or native route changed.'; exit 0 }
try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -DateKind String } catch { throw 'runtime.json is invalid; refusing to stop any process or route.' }
if ($state.tunnelProvider -ne 'tailscale-funnel' -or $state.publicUrl -ne $publicUrl -or $state.funnelTarget -ne $serverUrl) { throw 'Runtime does not record the approved native route; preserving processes and routes.' }
$entry = $state.components.server
if (-not $entry -or -not $entry.pid -or -not $entry.executable) { throw 'No recorded DevSpace server; refusing route changes.' }
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.pid)" -ErrorAction Stop
$serverProcess = Get-Process -Id ([int]$entry.pid) -ErrorAction Stop
if (-not $proc.ExecutablePath -or -not [string]::Equals([IO.Path]::GetFullPath($proc.ExecutablePath),[IO.Path]::GetFullPath($entry.executable),[StringComparison]::OrdinalIgnoreCase) -or $serverProcess.StartTime.ToUniversalTime().ToString('o') -ne $entry.startTime) { throw 'Server executable/start time no longer matches; preserving everything.' }
$listeners = @(Get-NetTCPConnection -LocalPort 7676 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1' -or $listeners[0].OwningProcess -ne [int]$entry.pid) { throw 'Loopback listener does not match the recorded server; preserving everything.' }
$text = & $tailscale funnel status --json
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect native Funnel route; preserving server and state.' }
$route = ($text -join "`n") | ConvertFrom-Json -AsHashtable
if (-not $route.TCP) { $route.TCP = @{} }; if (-not $route.Web) { $route.Web = @{} }; if (-not $route.AllowFunnel) { $route.AllowFunnel = @{} }
$web443 = @($route.Web.Keys | Where-Object { $_ -match ':443$' })
$allowed443 = @($route.AllowFunnel.Keys | Where-Object { $_ -match ':443$' -and $route.AllowFunnel[$_] })
$handlers = if ($route.Web[$routeHost]) { $route.Web[$routeHost].Handlers } else { @{} }
if ($route.Foreground.Count -gt 0 -or $route.TCP['443'].HTTPS -ne $true -or $route.TCP['443'].Count -ne 1 -or $web443.Count -ne 1 -or $web443[0] -ne $routeHost -or $handlers.Count -ne 1 -or $handlers['/'].Proxy -ne $serverUrl -or $handlers['/'].Count -ne 1 -or $allowed443.Count -ne 1 -or $allowed443[0] -ne $routeHost) { throw 'Native HTTPS 443 route differs from the sole recorded root proxy; preserving server and state.' }
& $tailscale funnel --https=443 off
if ($LASTEXITCODE -ne 0) { throw 'Narrow native Funnel stop failed; preserving server and runtime.' }
$text = & $tailscale funnel status --json
if ($LASTEXITCODE -ne 0) { throw 'Funnel stop cannot be confirmed; server and runtime preserved.' }
$after = ($text -join "`n") | ConvertFrom-Json -AsHashtable
if (-not $after.TCP) { $after.TCP = @{} }; if (-not $after.Web) { $after.Web = @{} }; if (-not $after.AllowFunnel) { $after.AllowFunnel = @{} }
if ($after.TCP['443'] -or @($after.Web.Keys | Where-Object { $_ -match ':443$' }).Count -gt 0 -or @($after.AllowFunnel.Keys | Where-Object { $_ -match ':443$' -and $after.AllowFunnel[$_] }).Count -gt 0) { throw 'Native HTTPS 443 still configured; server and runtime preserved.' }
$serverProcess.Refresh()
if ($serverProcess.HasExited -or $serverProcess.StartTime.ToUniversalTime().ToString('o') -ne $entry.startTime) { throw 'Recorded process changed during route stop; runtime preserved.' }
Stop-Process -InputObject $serverProcess -ErrorAction Stop
$serverProcess.Refresh()
if (-not $serverProcess.HasExited) { Wait-Process -InputObject $serverProcess -Timeout 10 -ErrorAction Stop }
if (Get-Process -Id ([int]$entry.pid) -ErrorAction SilentlyContinue) { throw 'Recorded PID still present; runtime preserved.' }
Remove-Item -LiteralPath $statePath -Force
Write-Output 'DevSpace and recorded native Funnel root proxy stopped; runtime removed, config and auth preserved.'
