param(
    [Parameter(Mandatory = $true)][string]$PublishedJson,
    [string]$GhBinary = 'gh'
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python -ErrorAction Stop }
& $python.Source -X utf8 (Join-Path $scriptDir 'cleanup_published.py') --published-json $PublishedJson --gh-binary $GhBinary
exit $LASTEXITCODE
