[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReadyJson,

    [Parameter(Mandatory = $true)]
    [string[]]$TestCommand,

    [int]$TimeoutSeconds = 600,
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'test_result.py'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "POSTMAN_TEST_GATE_MISSING: $script"
}

$argsList = @(
    $script,
    '--ready-json', $ReadyJson,
    '--timeout-seconds', $TimeoutSeconds.ToString(),
    '--'
)
$argsList += $TestCommand

& $Python @argsList
exit $LASTEXITCODE
