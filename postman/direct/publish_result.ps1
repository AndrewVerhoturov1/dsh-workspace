[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReadyJson,

    [Parameter(Mandatory = $true)]
    [string]$TestJson,

    [string]$CommitMessage = '',
    [string]$PrTitle = '',
    [string]$Python = 'python',
    [string]$GhBinary = 'gh'
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'publish_result.py'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "POSTMAN_PUBLISH_MISSING: $script"
}

$argsList = @(
    $script,
    '--ready-json', $ReadyJson,
    '--test-json', $TestJson,
    '--gh-binary', $GhBinary
)
if (-not [string]::IsNullOrWhiteSpace($CommitMessage)) {
    $argsList += @('--commit-message', $CommitMessage)
}
if (-not [string]::IsNullOrWhiteSpace($PrTitle)) {
    $argsList += @('--pr-title', $PrTitle)
}

& $Python @argsList
exit $LASTEXITCODE
