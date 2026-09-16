Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = 'D:\DeepSeekHarness-Recovered'
$profileDirectory = Join-Path $root 'profiles\web'
$launcherDirectory = Split-Path -Parent $PSCommandPath
$statePath = Join-Path $launcherDirectory 'recovered-dsh-runtime.json'
$nodePath = 'C:\Program Files\nodejs\node.exe'
$dshBin = 'C:\Users\Andrew\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js'

if (-not (Test-Path -LiteralPath $profileDirectory -PathType Container)) { throw "Clean DSH profile not found: $profileDirectory" }
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw "Node.js not found: $nodePath" }
if (-not (Test-Path -LiteralPath $dshBin -PathType Leaf)) { throw "DSH binary not found: $dshBin" }

function Get-ProcessInfo([int]$ProcessId) {
    Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Test-OurDshProcess([int]$ProcessId, [int]$Port) {
    $process = Get-ProcessInfo $ProcessId
    if ($null -eq $process) { return $false }
    $line = [string]$process.CommandLine
    return $line.Contains($dshBin) -and $line.Contains('--profile web') -and $line.Contains("--port $Port")
}

function Get-Listeners([int]$Port) {
    @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $old = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $oldPid = [int]$old.pid
    $oldPort = [int]$old.port
    if ((Test-OurDshProcess $oldPid $oldPort) -and @((Get-Listeners $oldPort)).Count -gt 0) {
        Start-Process -FilePath "http://127.0.0.1:$oldPort/" | Out-Null
        exit 0
    }
    Remove-Item -LiteralPath $statePath -Force
}

$port = $null
foreach ($candidate in 4173..4199) {
    if (@((Get-Listeners $candidate)).Count -eq 0) { $port = $candidate; break }
}
if ($null -eq $port) { throw 'No free local port in range 4173-4199.' }

$logDirectory = Join-Path $root 'runtime-logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutPath = Join-Path $logDirectory "dsh-$stamp.stdout.log"
$stderrPath = Join-Path $logDirectory "dsh-$stamp.stderr.log"

$env:DSH_HOME = $root
$env:DSH_TELEMETRY_MODE = 'DISABLED'
$child = Start-Process -FilePath $nodePath -ArgumentList @(
    '--expose-internals', $dshBin, '--profile', 'web', '--host', '127.0.0.1',
    '--port', [string]$port, '--no-open'
) -WorkingDirectory $profileDirectory -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru

$ready = $false
for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
        if ([int]$response.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
}

$listeners = Get-Listeners $port
$badAddress = @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::ffff:127.0.0.1') })
if (-not $ready -or $badAddress.Count -gt 0 -or -not (Test-OurDshProcess $child.Id $port)) {
    if (Test-OurDshProcess $child.Id $port) { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue }
    throw "DSH failed the loopback startup check on 127.0.0.1:$port."
}

$state = [ordered]@{
    pid = [int]$child.Id
    port = [int]$port
    url = "http://127.0.0.1:$port/"
    root = $root
    profile = $profileDirectory
    startedAt = (Get-Date).ToString('o')
    stdout = $stdoutPath
    stderr = $stderrPath
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
Start-Process -FilePath $state.url | Out-Null
