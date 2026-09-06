[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int[]]$PrNumber,
    [string]$RepoRoot = 'C:\Users\andre\.dsh',
    [string]$Repository = 'AndrewVerhoturov1/dsh-workspace',
    [switch]$WhatIf,
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'finalize_task_pr.py'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "FINALIZE_TASK_PR_SCRIPT_MISSING: $script"
}

$argsList = @(
    $script,
    '--repo-root', $RepoRoot,
    '--repository', $Repository
)
foreach ($number in $PrNumber) {
    $argsList += @('--pr', $number.ToString())
}
if ($WhatIf) {
    $argsList += '--what-if'
}

& $Python '-X' 'utf8' @argsList
exit $LASTEXITCODE
