#requires -Version 7.5
$ErrorActionPreference = 'Stop'
function Get-DevspaceSettings([string]$Root) {
    $rootPath = [IO.Path]::GetFullPath($Root)
    return @{
        Root=$rootPath; Node='C:/Program Files/nodejs/node.exe'
        Runner=(Join-Path $rootPath 'server-runner.mjs')
        Cli=(Join-Path $rootPath 'node_modules/@waishnav/devspace/bin/devspace.js')
        Tailscale='C:/Program Files/Tailscale/tailscale.exe'
        LocalUrl='http://127.0.0.1:7676'; PublicUrl='https://desktop-dujmm2g.tail3bd4f2.ts.net'
        RouteHost='desktop-dujmm2g.tail3bd4f2.ts.net:443'; Port=7676
    }
}
function Read-State([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable -DateKind String }
    catch { return $null }
}
function Write-State([string]$Path, $Value) {
    $temp = "$Path.tmp"
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temp -Encoding utf8NoBOM
    Move-Item -LiteralPath $temp -Destination $Path -Force
}
function Enter-LifecycleLock($Settings) {
    try { return [IO.File]::Open((Join-Path $Settings.Root 'lifecycle.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] { return $null }
}
function Write-Diagnostic($Settings, [string]$Event, $Fields=@{}) {
    $dir = Join-Path $Settings.Root 'logs'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $file = Join-Path $dir 'watchdog.jsonl'
    if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -ge 1MB) { Move-Item -LiteralPath $file -Destination "$file.1" -Force }
    $record = @{ts=[DateTime]::UtcNow.ToString('o');event=$Event}
    foreach ($key in @('local','public','action','result','failures','attempts')) { if ($Fields.ContainsKey($key)) { $record[$key]=$Fields[$key] } }
    ($record | ConvertTo-Json -Compress) | Add-Content -LiteralPath $file -Encoding utf8
}
function Get-Listeners($Settings) { return @(Get-NetTCPConnection -LocalPort $Settings.Port -State Listen -ErrorAction SilentlyContinue) }
function Get-ServerIdentity($Settings, [int]$ProcessId, [string]$StartTime='') {
    if ($ProcessId -le 0) { return $null }
    $item = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $item -or -not $item.ExecutablePath -or -not [string]::Equals([IO.Path]::GetFullPath($item.ExecutablePath), [IO.Path]::GetFullPath($Settings.Node), [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $command = $item.CommandLine.Replace('\','/')
    $nodePattern = [regex]::Escape($Settings.Node.Replace('\','/'))
    $runnerPattern = [regex]::Escape($Settings.Runner.Replace('\','/'))
    $cliPattern = [regex]::Escape($Settings.Cli.Replace('\','/'))
    $isRunner = $command -match "(?i)^\s*(?:`"$nodePattern`"|$nodePattern)\s+(?:`"$runnerPattern`"|$runnerPattern)\s*$"
    $isLegacy = $command -match "(?i)^\s*(?:`"$nodePattern`"|$nodePattern)\s+(?:`"$cliPattern`"|$cliPattern)\s+serve\s*$"
    if (-not ($isRunner -or $isLegacy)) { return $null }
    try { $process = Get-Process -Id $ProcessId -ErrorAction Stop; $actualStart=$process.StartTime.ToUniversalTime().ToString('o') } catch { return $null }
    if ($StartTime -and $StartTime -ne $actualStart) { return $null }
    return @{pid=$ProcessId;startTime=$actualStart;executable=$Settings.Node;runner=$isRunner}
}
function Save-Runtime($Settings, $Identity, [string]$Instance='') {
    $state=@{tunnelProvider='tailscale-funnel';publicUrl=$Settings.PublicUrl;funnelTarget=$Settings.LocalUrl;startedAt=$Identity.startTime;components=@{server=$Identity}}
    if ($Instance) { $state.components.server.instance=$Instance }
    Write-State (Join-Path $Settings.Root 'runtime.json') $state
}
function Get-FunnelRoute($Settings) {
    $text = & $Settings.Tailscale funnel status --json 2>$null
    if ($LASTEXITCODE -ne 0) { return 'unknown' }
    try { $route=($text -join "`n") | ConvertFrom-Json -AsHashtable } catch { return 'unknown' }
    if (-not $route.TCP) { $route.TCP=@{} }; if (-not $route.Web) { $route.Web=@{} }; if (-not $route.AllowFunnel) { $route.AllowFunnel=@{} }
    $web443=@($route.Web.Keys | Where-Object { $_ -match ':443$' })
    $allowed443=@($route.AllowFunnel.Keys | Where-Object { $_ -match ':443$' -and $route.AllowFunnel[$_] })
    if ($route.Foreground.Count -gt 0) { return 'different' }
    if (-not $route.TCP['443'] -and $web443.Count -eq 0 -and $allowed443.Count -eq 0) { return 'absent' }
    $handlers=$route.Web[$Settings.RouteHost].Handlers
    if ($route.TCP['443'].HTTPS -eq $true -and $route.TCP['443'].Count -eq 1 -and $web443.Count -eq 1 -and $web443[0] -eq $Settings.RouteHost -and $handlers.Count -eq 1 -and $handlers['/'].Proxy -eq $Settings.LocalUrl -and $handlers['/'].Count -eq 1 -and $allowed443.Count -eq 1 -and $allowed443[0] -eq $Settings.RouteHost) { return 'active' }
    return 'different'
}
function Enable-ExpectedFunnel($Settings, [switch]$Refresh) {
    $route=Get-FunnelRoute $Settings
    if ($route -notin @('active','absent')) { throw 'Funnel configuration unknown or belongs to another route; preserved.' }
    if ($Refresh -and $route -eq 'active') {
        & $Settings.Tailscale funnel --https=443 off *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Narrow Funnel stop failed.' }
        if ((Get-FunnelRoute $Settings) -ne 'absent') { throw 'Funnel changed during repair; preserved.' }
    } elseif ($route -eq 'active') { return }
    & $Settings.Tailscale funnel --bg --https=443 $Settings.LocalUrl *> $null
    if ($LASTEXITCODE -ne 0 -or (Get-FunnelRoute $Settings) -ne 'active') { throw 'Funnel publication failed; local server preserved.' }
}
function Get-LocalHealth($Settings) {
    try { $response=Invoke-RestMethod -Uri ($Settings.LocalUrl+'/healthz') -TimeoutSec 3; return ($response.ok -eq $true -and $response.name -eq 'devspace') } catch { return $false }
}
function Start-DevspaceServer($Settings) {
    $listeners=@(Get-Listeners $Settings)
    $path=Join-Path $Settings.Root 'runtime.json'
    $state=Read-State $path
    if ($listeners.Count) {
        if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') { throw 'Unexpected listener; preserved.' }
        $identity=Get-ServerIdentity $Settings ([int]$listeners[0].OwningProcess)
        if (-not $identity) { throw 'Port belongs to another process; preserved.' }
        if (-not (Get-LocalHealth $Settings)) { throw 'Existing server is not ready; no duplicate started.' }
        $instance = if ($state.components.server.startTime -eq $identity.startTime) { $state.components.server.instance } else { '' }
        Save-Runtime $Settings $identity $instance
        return $identity
    }
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")) {
        if (Get-ServerIdentity $Settings ([int]$candidate.ProcessId)) { throw 'A server process is already starting or unhealthy; no duplicate started.' }
    }
    foreach ($file in @($Settings.Node,$Settings.Runner,$Settings.Cli)) { if (-not (Test-Path -LiteralPath $file)) { throw 'Required runtime file missing.' } }
    if (Test-Path -LiteralPath $path) { Move-Item -LiteralPath $path -Destination "$path.stale" -Force }
    New-Item -ItemType Directory -Path (Join-Path $Settings.Root 'logs') -Force | Out-Null
    foreach ($name in @('runner.stdout.log','runner.stderr.log')) {
        $log=Join-Path $Settings.Root "logs/$name"
        if (Test-Path -LiteralPath $log) { Move-Item -LiteralPath $log -Destination "$log.1" -Force }
    }
    $savedPath=$env:PATH; $savedInstance=$env:DSH_DEVSPACE_INSTANCE
    $instance=[guid]::NewGuid().ToString('N')
    try {
        $env:PATH="C:/Program Files/Git/bin;C:/Program Files/nodejs;$savedPath"
        $env:DSH_DEVSPACE_INSTANCE=$instance
        $process=Start-Process -FilePath $Settings.Node -ArgumentList ('"'+$Settings.Runner+'"') -WorkingDirectory $Settings.Root -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Settings.Root 'logs/runner.stdout.log') -RedirectStandardError (Join-Path $Settings.Root 'logs/runner.stderr.log')
    } finally { $env:PATH=$savedPath; $env:DSH_DEVSPACE_INSTANCE=$savedInstance }
    $identity=@{pid=$process.Id;startTime=$process.StartTime.ToUniversalTime().ToString('o');executable=$Settings.Node;runner=$true}
    Save-Runtime $Settings $identity $instance
    $until=[DateTime]::UtcNow.AddSeconds(30)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw 'Server exited before readiness.' }
        if (Get-LocalHealth $Settings) { Write-Diagnostic $Settings 'server_started'; return $identity }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $until)
    throw 'Server readiness timed out; identity preserved.'
}
function Stop-DevspaceServer($Settings, [switch]$Unresponsive) {
    $state=Read-State (Join-Path $Settings.Root 'runtime.json')
    $entry=$state.components.server
    if (-not $entry) { throw 'No recorded identity; no process stopped.' }
    $identity=Get-ServerIdentity $Settings ([int]$entry.pid) $entry.startTime
    if (-not $identity) { throw 'Recorded PID identity changed; no process stopped.' }
    if (@(Get-ActiveChildren $entry).Count) { throw 'Server has active child processes; preserved.' }
    if ($identity.runner -and $entry.instance) {
        Write-State (Join-Path $Settings.Root 'stop-request.json') @{pid=[int]$entry.pid;instance=$entry.instance}
        try { Wait-Process -Id ([int]$entry.pid) -Timeout 15 -ErrorAction Stop; return } catch { if (-not $Unresponsive) { throw 'Graceful drain still running; no force stop.' } }
    } elseif (-not $Unresponsive) { throw 'Legacy server requires a verified idle maintenance restart.' }
    $identity=Get-ServerIdentity $Settings ([int]$entry.pid) $entry.startTime
    if (-not $identity -or @(Get-ActiveChildren $entry).Count) { throw 'Process changed or became busy; preserved.' }
    $target=Get-Process -Id ([int]$entry.pid) -ErrorAction Stop
    if ($target.StartTime.ToUniversalTime().ToString('o') -ne $entry.startTime) { throw 'PID identity changed; preserved.' }
    Stop-Process -InputObject $target -ErrorAction Stop
    Wait-Process -Id ([int]$entry.pid) -Timeout 10 -ErrorAction SilentlyContinue
    Write-Diagnostic $Settings 'server_stopped' @{action='owned_process_only'}
}
function Get-ActiveChildren($Entry) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($Entry.pid)" | Where-Object { $_.Name -ne 'conhost.exe' -and $_.CreationDate.ToUniversalTime() -ge [DateTime]::Parse($Entry.startTime).ToUniversalTime() }
}
function Get-Probe($Settings, [string]$Mode) {
    $text=& $Settings.Node (Join-Path $Settings.Root 'probe.mjs') $Mode $Settings.LocalUrl
    if ($LASTEXITCODE -ne 0) { return @{state='unknown';healthy=$false} }
    try { return ($text -join "`n") | ConvertFrom-Json -AsHashtable } catch { return @{state='unknown';healthy=$false} }
}
