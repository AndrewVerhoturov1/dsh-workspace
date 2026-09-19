[CmdletBinding()]
param(
    [switch]$SeedLocalConfig,
    [string]$MainRoot = 'C:\Users\andre\.dsh'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Git([string]$RepoRoot, [string[]]$Arguments) {
    $output = & git -C $RepoRoot @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw (($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
    }
    return @($output | ForEach-Object { [string]$_ })
}

$previewRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$actualTop = (Invoke-Git -RepoRoot $previewRoot -Arguments @('rev-parse', '--show-toplevel'))[0].Trim()
if ([System.IO.Path]::GetFullPath($actualTop) -ne $previewRoot) {
    throw "Preview launcher must run from the repository root worktree: $previewRoot"
}

$branch = (Invoke-Git -RepoRoot $previewRoot -Arguments @('branch', '--show-current'))[0].Trim()
if ($branch -ne 'preview') {
    throw "Prepare-DSH-Preview.ps1 is allowed only in the permanent preview worktree; current branch: $branch"
}

$profileRoot = Join-Path $previewRoot 'profiles\web'
$installScript = Join-Path $profileRoot 'scripts\install-production.mjs'
if (-not (Test-Path -LiteralPath $installScript -PathType Leaf)) {
    throw "Preview production installer was not found: $installScript"
}

$pnpm = Get-Command 'pnpm.cmd' -CommandType Application -ErrorAction SilentlyContinue
if (-not $pnpm) { $pnpm = Get-Command 'pnpm' -CommandType Application -ErrorAction SilentlyContinue }
if (-not $pnpm) { throw 'pnpm was not found in PATH.' }
$pnpmPath = [string]$pnpm.Source
if ([string]::IsNullOrWhiteSpace($pnpmPath)) { $pnpmPath = [string]$pnpm.Path }

Push-Location $profileRoot
try {
    & $pnpmPath 'run' 'install:production'
    if ($LASTEXITCODE -ne 0) { throw "pnpm run install:production failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$copied = @()
$skippedExisting = @()
$missingSource = @()
if ($SeedLocalConfig) {
    if (-not (Test-Path -LiteralPath $MainRoot -PathType Container)) {
        throw "Main worktree was not found: $MainRoot"
    }
    $allowedLocalConfig = @('settings.yaml', '.credentials.yaml', 'codex-oauth.json')
    foreach ($name in $allowedLocalConfig) {
        $source = Join-Path $MainRoot $name
        $target = Join-Path $previewRoot $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            $missingSource += $name
            continue
        }
        if (Test-Path -LiteralPath $target) {
            $skippedExisting += $name
            continue
        }
        Copy-Item -LiteralPath $source -Destination $target
        $copied += $name
    }
}

$result = [ordered]@{
    ok = $true
    code = 'PREVIEW_LAUNCHER_PREPARED'
    previewRoot = $previewRoot
    branch = $branch
    dependenciesInstalled = $true
    localConfigSeedRequested = [bool]$SeedLocalConfig
    localConfigCopied = $copied
    localConfigSkippedExisting = $skippedExisting
    localConfigMissingSource = $missingSource
    destructiveGitUsed = $false
}
$result | ConvertTo-Json -Compress
