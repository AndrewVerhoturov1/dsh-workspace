Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:LauncherRoot = Split-Path -Parent $PSCommandPath
$script:LogsRoot = Join-Path $script:LauncherRoot 'logs'
$script:ControllerPath = Join-Path $script:LauncherRoot 'dsh-process-controller.js'
$script:WorkingDirectory = 'C:\Users\andre\.dsh'
$script:WebPort = 4173
$script:WebUrl = "http://127.0.0.1:$($script:WebPort)/"
$script:MutexName = 'DeepSeekHarnessLauncher.StartStop'

New-Item -ItemType Directory -Path $script:LogsRoot -Force | Out-Null

function Resolve-ControllerRuntime {
    $node = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue
    if (-not $node) { $node = Get-Command 'node' -CommandType Application -ErrorAction SilentlyContinue }
    if (-not $node) { throw 'node.exe was not found in PATH.' }
    $nodePath = [string]$node.Source
    if ([string]::IsNullOrWhiteSpace($nodePath)) { $nodePath = [string]$node.Path }
    if (-not (Test-Path -LiteralPath $script:ControllerPath)) {
        throw "DSH controller was not found: $script:ControllerPath"
    }
    [pscustomobject]@{ NodePath = $nodePath }
}

function Invoke-DshController([string]$Action) {
    $runtime = Resolve-ControllerRuntime
    $arguments = @(
        $script:ControllerPath,
        $Action,
        '--cwd', $script:WorkingDirectory,
        '--profile', 'web',
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

function Show-LauncherMessage([string]$Message, [string]$Title = 'DeepSeek Harness') {
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
