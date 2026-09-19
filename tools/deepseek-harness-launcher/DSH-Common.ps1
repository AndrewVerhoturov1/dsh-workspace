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
    $node = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command 'node' -CommandType Application -ErrorAction SilentlyContinue }
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
    return $output
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
