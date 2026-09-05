[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReadyJson,

    [string[]]$TestCommand,

    [string]$TestScript,

    [string[]]$TestScriptArgs,

    [int]$TimeoutSeconds = 600,
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'test_result.py'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "POSTMAN_TEST_GATE_MISSING: $script"
}
if ([string]::IsNullOrWhiteSpace($TestScript) -and (-not $TestCommand -or $TestCommand.Count -eq 0)) {
    throw 'POSTMAN_TEST_GATE_ARGUMENT_MISSING: provide -TestScript or -TestCommand'
}
if (-not [string]::IsNullOrWhiteSpace($TestScript) -and $TestCommand -and $TestCommand.Count -gt 0) {
    throw 'POSTMAN_TEST_GATE_ARGUMENT_AMBIGUOUS: provide -TestScript or -TestCommand, not both'
}

# Pass each argument as a separate process argument: no shell parsing or quoting.
$argsList = @(
    $script,
    '--ready-json', $ReadyJson,
    '--timeout-seconds', $TimeoutSeconds.ToString()
)
if (-not [string]::IsNullOrWhiteSpace($TestScript)) {
    $argsList += '--test-script'
    $argsList += $TestScript
    foreach ($item in @($TestScriptArgs)) {
        $argsList += '--test-arg'
        $argsList += $item
    }
} else {
    $argsList += '--'
    $argsList += $TestCommand
}

& $Python '-X' 'utf8' @argsList
exit $LASTEXITCODE
