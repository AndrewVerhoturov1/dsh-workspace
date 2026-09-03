param(
    [Parameter(Mandatory = $true)]
    [string]$PublishedJson,
    [string]$GhBinary = 'gh'
)

$ErrorActionPreference = 'Stop'
$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python -ErrorAction Stop }
$script = Join-Path $PSScriptRoot 'cleanup_published.py'
& $python.Source -X utf8 $script --published-json $PublishedJson --gh-binary $GhBinary
exit $LASTEXITCODE
