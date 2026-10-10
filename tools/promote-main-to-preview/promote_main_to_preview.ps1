[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{40}$')][string]$ApprovedMainSha,
    [Parameter(Mandatory = $true)][switch]$UserGo,
    [string]$RepoRoot = 'C:\Users\andre\.dsh',
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
if (-not $UserGo.IsPresent) {
    throw 'PROMOTE_USER_GO_REQUIRED: a separate current human GO for ApprovedMainSha is required'
}
$script = Join-Path $PSScriptRoot 'promote_main_to_preview.py'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "PROMOTE_MAIN_TO_PREVIEW_SCRIPT_MISSING: $script"
}

$argsList = @($script, '--repo-root', $RepoRoot, '--approved-main-sha', $ApprovedMainSha, '--user-go')
& $Python '-X' 'utf8' @argsList
exit $LASTEXITCODE
