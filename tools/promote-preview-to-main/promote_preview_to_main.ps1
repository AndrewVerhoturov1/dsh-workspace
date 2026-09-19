[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$PrNumber,
    [string]$RepoRoot = 'C:\Users\andre\.dsh',
    [string]$PreviewRoot = 'C:\Users\andre\.dsh-preview',
    [string]$Repository = 'AndrewVerhoturov1/dsh-workspace',
    [switch]$WhatIf,
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'promote_preview_to_main.py'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "PROMOTE_PREVIEW_SCRIPT_MISSING: $script"
}

$argsList = @(
    $script,
    '--repo-root', $RepoRoot,
    '--preview-root', $PreviewRoot,
    '--repository', $Repository,
    '--pr', $PrNumber.ToString()
)
if ($WhatIf) {
    $argsList += '--what-if'
}

& $Python '-X' 'utf8' @argsList
exit $LASTEXITCODE
