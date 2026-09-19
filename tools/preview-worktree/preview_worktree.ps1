[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('bootstrap', 'setup', 'update', 'status')]
    [string]$Action,
    [string]$RepoRoot = 'C:\Users\andre\.dsh',
    [string]$PreviewRoot = 'C:\Users\andre\.dsh-preview',
    [string]$Repository = 'AndrewVerhoturov1/dsh-workspace',
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'preview_worktree.py'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "PREVIEW_WORKTREE_SCRIPT_MISSING: $script"
}

& $Python '-X' 'utf8' $script $Action `
    '--repo-root' $RepoRoot `
    '--preview-root' $PreviewRoot `
    '--repository' $Repository
exit $LASTEXITCODE
