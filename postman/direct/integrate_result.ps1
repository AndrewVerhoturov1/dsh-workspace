[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ResultJson,

    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,

    [string]$ExpectedRepository = 'AndrewVerhoturov1/dsh-workspace',
    [string]$OriginRef = 'origin/main',
    [switch]$NoFetch,
    [switch]$AllowMain
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'integrate_result.py'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "POSTMAN_INTEGRATOR_MISSING: $script"
}

$python = Get-Command python -ErrorAction Stop
$arguments = @(
    $script,
    '--result-json', $ResultJson,
    '--repo-root', $RepoRoot,
    '--expected-repository', $ExpectedRepository,
    '--origin-ref', $OriginRef
)
if ($NoFetch) { $arguments += '--no-fetch' }
if ($AllowMain) { $arguments += '--allow-main' }

& $python.Source @arguments
exit $LASTEXITCODE
