Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-LauncherEnvValue([string]$Name, [string]$DefaultValue) {
    $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrWhiteSpace($value)) { return $DefaultValue }
    return $value
}

$script:LauncherCodeRoot = Split-Path -Parent $PSCommandPath
$script:LauncherRoot = Get-LauncherEnvValue -Name 'DSH_LAUNCHER_ROOT' -DefaultValue $script:LauncherCodeRoot
$script:LogsRoot = Join-Path $script:LauncherRoot 'logs'
$script:ControllerPath = Get-LauncherEnvValue -Name 'DSH_PROCESS_CONTROLLER' -DefaultValue (Join-Path $script:LauncherCodeRoot 'dsh-process-controller.js')
$script:WorkingDirectory = Get-LauncherEnvValue -Name 'DSH_WORKING_DIRECTORY' -DefaultValue 'C:\Users\andre\.dsh'
$script:Profile = Get-LauncherEnvValue -Name 'DSH_PROFILE' -DefaultValue 'web'
$portText = Get-LauncherEnvValue -Name 'DSH_PORT' -DefaultValue '4173'
$parsedPort = 0
if (-not [int]::TryParse($portText, [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) {
    throw "Invalid DSH_PORT: $portText"
}
$script:WebPort = $parsedPort
$script:WebUrl = "http://127.0.0.1:$($script:WebPort)/"
$script:MutexName = Get-LauncherEnvValue -Name 'DSH_LAUNCHER_MUTEX' -DefaultValue 'DeepSeekHarnessLauncher.StartStop'
$script:LauncherTitle = Get-LauncherEnvValue -Name 'DSH_LAUNCHER_TITLE' -DefaultValue 'DeepSeek Harness'
$script:RequireProfileInstall = (Get-LauncherEnvValue -Name 'DSH_REQUIRE_PROFILE_INSTALL' -DefaultValue '0') -eq '1'

New-Item -ItemType Directory -Path $script:LogsRoot -Force | Out-Null

function Resolve-ControllerRuntime {
    $node = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) { $node = Get-Command 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if (-not $node) { throw 'node.exe was not found in PATH.' }
    $nodePath = [string]$node.Source
    if ([string]::IsNullOrWhiteSpace($nodePath)) { $nodePath = [string]$node.Path }
    if (-not (Test-Path -LiteralPath $script:ControllerPath -PathType Leaf)) {
        throw "DSH controller was not found: $script:ControllerPath"
    }
    [pscustomobject]@{ NodePath = $nodePath }
}

function Assert-DshWorkspaceReady {
    if (-not (Test-Path -LiteralPath $script:WorkingDirectory -PathType Container)) {
        throw "DSH working directory was not found: $script:WorkingDirectory"
    }
    if ($script:RequireProfileInstall) {
        $profileModules = Join-Path $script:WorkingDirectory ("profiles\{0}\node_modules" -f $script:Profile)
        if (-not (Test-Path -LiteralPath $profileModules -PathType Container)) {
            $prepareScript = Join-Path $script:LauncherCodeRoot 'Prepare-DSH-Preview.ps1'
            throw "Preview dependencies are not installed. Run: & '$prepareScript'"
        }
    }
}

function Invoke-DshController([string]$Action) {
    if ($Action -in @('start', 'restart')) { Assert-DshWorkspaceReady }
    if ($Action -in @('start', 'restart')) {
        # Node fetch does not inherit the Windows proxy used by the browser.
        if ([string]::IsNullOrWhiteSpace($env:HTTPS_PROXY) -and [string]::IsNullOrWhiteSpace($env:HTTP_PROXY)) {
            $proxyKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
            $proxySettings = Get-ItemProperty -LiteralPath $proxyKey -ErrorAction SilentlyContinue
            $proxyEnabled = $proxySettings | Select-Object -ExpandProperty ProxyEnable -ErrorAction SilentlyContinue
            $proxyServer = [string]($proxySettings | Select-Object -ExpandProperty ProxyServer -ErrorAction SilentlyContinue)
            if ($proxyEnabled -eq 1 -and -not [string]::IsNullOrWhiteSpace($proxyServer)) {
                if ($proxyServer.Contains('=')) {
                    $proxyServer = [string](@($proxyServer -split ';' | Where-Object { $_ -match '^https=' } | Select-Object -First 1) -replace '^https=', '')
                }
                if (-not [string]::IsNullOrWhiteSpace($proxyServer)) {
                    if ($proxyServer -notmatch '^https?://') { $proxyServer = 'http://' + $proxyServer }
                    $env:HTTPS_PROXY = $proxyServer
                }
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($env:HTTPS_PROXY) -or -not [string]::IsNullOrWhiteSpace($env:HTTP_PROXY)) {
            if ([string]::IsNullOrWhiteSpace($env:NODE_USE_ENV_PROXY)) { $env:NODE_USE_ENV_PROXY = '1' }
            $env:NO_PROXY = ((@($env:NO_PROXY -split ',') + @('localhost', '127.0.0.1', '::1')) | Where-Object { $_ } | Select-Object -Unique) -join ','
        }
    }
    $runtime = Resolve-ControllerRuntime
    $arguments = @(
        $script:ControllerPath,
        $Action,
        '--cwd', $script:WorkingDirectory,
        '--profile', $script:Profile,
        '--port', [string]$script:WebPort,
        '--launcher-root', $script:LauncherRoot
    )
    if ($env:DSH_PRESERVE_CHILDREN -eq '1') {
        $arguments += '--preserve-children'
    }
    $output = & $runtime.NodePath @arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw (($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
    }
    if ($Action -in @('start', 'restart') -and $script:Profile -eq 'web' -and $script:WebPort -eq 4173) {
        try { Invoke-MobileLanStartup }
        catch { Write-MobileLanNotReady $_.Exception.Message }
    }
    return $output
}

# This check runs only after a successful regular Web start/restart.
# The elevated task itself validates the exact portproxy, firewall, and Wi-Fi
# conditions before changing any network setting.
function Test-MobileLanHttp([string]$Url, [int]$ExpectedStatus, [string]$ExpectedLocation = '') {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 2500
    $response = $null
    try {
        try {
            $response = $request.GetResponse()
        } catch [System.Net.WebException] {
            if ($null -eq $_.Exception.Response) { return $false }
            $response = $_.Exception.Response
        }
        if ([int]$response.StatusCode -ne $ExpectedStatus) { return $false }
        if ($ExpectedLocation -and [string]$response.Headers['Location'] -ne $ExpectedLocation) { return $false }
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $response) { $response.Dispose() }
    }
}

function Write-MobileLanNotReady([string]$Reason) {
    $message = "MOBILE_LAN_NOT_READY: $Reason"
    Write-Warning $message
    # Informational only; the SYSTEM task never reads this user-writable log.
    try {
        Add-Content -LiteralPath (Join-Path $script:LogsRoot 'dsh-controller.log') -Value ("[{0}] {1}" -f (Get-Date -Format s), $message) -ErrorAction Stop
    } catch { }
}

function Get-MobileLanListeners {
    return @(Get-NetTCPConnection -State Listen -LocalPort 4173 -ErrorAction Stop)
}

function Invoke-MobileLanScheduledTask {
    # Fixed, installed task only. No executable, task name, or arguments
    # are supplied by the caller, environment, or mutable .dsh files.
    & 'C:\Windows\System32\schtasks.exe' /Run /TN '\DSH-MobileLan-Restore' 2>&1 | Out-Null
    return $LASTEXITCODE
}

function Invoke-MobileLanStartup {
    if (-not (Test-MobileLanHttp 'http://127.0.0.1:4173/' 200) -or
        -not (Test-MobileLanHttp 'http://127.0.0.1:4173/mobile' 302 '/?mobile=1')) {
        Write-MobileLanNotReady 'LOCAL_WEB_OR_PLUGIN_UNAVAILABLE'
        return
    }

    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress '192.168.0.5' -ErrorAction SilentlyContinue)
    if ($addresses.Count -ne 1) {
        Write-MobileLanNotReady 'WIFI_192_168_0_5_UNAVAILABLE'
        return
    }
    $physical = @(Get-NetAdapter -Physical -ErrorAction Stop | Where-Object {
        $_.InterfaceIndex -eq $addresses[0].InterfaceIndex -and [string]$_.Status -eq 'Up' -and
        ($_.InterfaceDescription -match '(?i)wireless|wi-fi|802\.11' -or [string]$_.MediaType -eq 'Native 802.11')
    })
    if ($physical.Count -ne 1) {
        Write-MobileLanNotReady 'PHYSICAL_WIFI_UNAVAILABLE'
        return
    }

    $listeners = @(Get-MobileLanListeners)
    if (@($listeners | Where-Object { $_.LocalAddress -in @('0.0.0.0', '::') }).Count -gt 0) {
        Write-MobileLanNotReady 'WILDCARD_LISTENER_CONFLICT'
        return
    }
    $lan = @($listeners | Where-Object { $_.LocalAddress -eq '192.168.0.5' })
    if ($lan.Count -gt 1) {
        Write-MobileLanNotReady 'LAN_LISTENER_CONFLICT'
        return
    }
    if ($lan.Count -eq 1) {
        # Portproxy may be owned by PID 4 or by the running iphlpsvc
        # svchost. Neither a foreign listener nor a wildcard is trusted.
        $helperService = @(Get-CimInstance -ClassName Win32_Service -Filter "Name='iphlpsvc'" -ErrorAction Stop)
        if ($helperService.Count -ne 1 -or [string]$helperService[0].State -ne 'Running' -or
            [int]$helperService[0].ProcessId -le 0 -or
            $lan[0].OwningProcess -notin @(4, [int]$helperService[0].ProcessId)) {
            Write-MobileLanNotReady 'LAN_LISTENER_CONFLICT'
            return
        }
        if (-not (Test-MobileLanHttp 'http://192.168.0.5:4173/?mobile=1' 200)) {
            Write-MobileLanNotReady 'LAN_LISTENER_HTTP_UNAVAILABLE'
        }
        return # Healthy listener means no task invocation, ever.
    }

    # No elevation or mutable script execution in this process. The user
    # manually installs the pre-approved, protected SYSTEM task once.
    $taskName = 'DSH-MobileLan-Restore'
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-MobileLanNotReady 'ADMIN_TASK_NOT_INSTALLED'
        return
    }
    $before = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\' -ErrorAction Stop
    $startedAt = Get-Date
    if ((Invoke-MobileLanScheduledTask) -ne 0) {
        Write-MobileLanNotReady 'ADMIN_TASK_RUN_DENIED'
        return
    }

    # Bounded wait for ONE asynchronous task run; no repeated repair requests.
    $helperService = @(Get-CimInstance -ClassName Win32_Service -Filter "Name='iphlpsvc'" -ErrorAction Stop)
    if ($helperService.Count -ne 1 -or [string]$helperService[0].State -ne 'Running' -or
        [int]$helperService[0].ProcessId -le 0) {
        Write-MobileLanNotReady 'IPHLPSVC_UNAVAILABLE_AFTER_TASK'
        return
    }
    $allowedPids = @(4, [int]$helperService[0].ProcessId)
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        $now = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
        $info = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\' -ErrorAction Stop
        $lanNow = @(Get-MobileLanListeners | Where-Object { $_.LocalAddress -eq '192.168.0.5' -and $_.OwningProcess -in $allowedPids })
        if ($lanNow.Count -eq 1 -and (Test-MobileLanHttp 'http://192.168.0.5:4173/?mobile=1' 200)) {
            return
        }
        if ($now.State -ne 'Running' -and $info.LastRunTime -gt $before.LastRunTime -and
            [int]$info.LastTaskResult -ne 0) {
            break
        }
    }
    Write-MobileLanNotReady 'ADMIN_TASK_COMPLETED_WITHOUT_HEALTHY_LAN'
}

function Open-WebUi {
    Start-Process -FilePath $script:WebUrl | Out-Null
}

function Show-LauncherMessage([string]$Message, [string]$Title = $script:LauncherTitle) {
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        [System.Windows.Forms.MessageBox]::Show($Message, $Title, 'OK', 'Error') | Out-Null
    } catch {
        Add-Content -LiteralPath (Join-Path $script:LogsRoot 'dsh-controller.log') -Value ("[{0}] {1}" -f (Get-Date -Format s), $Message)
    }
}

function Enter-LauncherMutex {
    $mutex = New-Object System.Threading.Mutex($false, $script:MutexName)
    try {
        if (-not $mutex.WaitOne(30000)) {
            $mutex.Dispose()
            return $null
        }
        return $mutex
    } catch {
        $mutex.Dispose()
        throw
    }
}

function Exit-LauncherMutex($Mutex) {
    if ($Mutex) {
        try { $Mutex.ReleaseMutex() | Out-Null } catch { }
        $Mutex.Dispose()
    }
}
