param(
    [Parameter(Mandatory = $true)]
    [string]$PublishedJson,
    [Alias('ConfirmDiscard')]
    [switch]$Discard,
    [string]$Reason = 'explicit operator discard of a closed unmerged PR',
    [string]$GhBinary = 'gh'
)

$ErrorActionPreference = 'Stop'
$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command python -ErrorAction Stop }
$script = Join-Path $PSScriptRoot 'abandon_result.py'
$args = @($script, '--published-json', $PublishedJson, '--reason', $Reason, '--gh-binary', $GhBinary)
if ($Discard) { $args += '--discard' }
& $python.Source -X utf8 @args
exit $LASTEXITCODE
