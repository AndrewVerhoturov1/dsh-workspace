Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$launcherDirectory = Split-Path -Parent $PSCommandPath
$statePath = Join-Path $launcherDirectory 'recovered-dsh-runtime.json'
$dshBin = 'C:\Users\Andrew\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js'

if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
$processId = [int]$state.pid
$port = [int]$state.port
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
$line = if ($null -eq $process) { '' } else { [string]$process.CommandLine }
if ($null -ne $process -and $line.Contains($dshBin) -and $line.Contains('--profile web') -and $line.Contains("--port $port")) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }
}
Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
