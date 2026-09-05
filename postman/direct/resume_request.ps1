[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RequestId,
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [string]$ExpectedRepository = 'AndrewVerhoturov1/dsh-workspace',
    [string]$DirectRoot = '',
    [string]$HandoffRoot = '',
    [string]$WorktreeRoot = '',
    [string]$GhBinary = 'gh',
    [int]$TimeoutSeconds = 600,
    [string]$TestScript = '',
    [string]$TestSpec = '',
    [string[]]$TestArg,
    [string[]]$TestCommand,
    [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'resume_request.py'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "POSTMAN_RESUME_MISSING: $script" }
$argsList = @($script, '--request-id', $RequestId, '--repo-root', $RepoRoot, '--expected-repository', $ExpectedRepository, '--gh-binary', $GhBinary, '--timeout-seconds', $TimeoutSeconds.ToString())
foreach ($pair in @(@('--direct-root', $DirectRoot), @('--handoff-root', $HandoffRoot), @('--worktree-root', $WorktreeRoot))) {
    if (-not [string]::IsNullOrWhiteSpace($pair[1])) { $argsList += @($pair[0], $pair[1]) }
}
if (-not [string]::IsNullOrWhiteSpace($TestScript)) { $argsList += @('--test-script', $TestScript) }
if (-not [string]::IsNullOrWhiteSpace($TestSpec)) { $argsList += @('--test-spec', $TestSpec) }
if ($null -ne $TestArg) { foreach ($arg in $TestArg) { $argsList += @('--test-arg', $arg) } }
if ($null -ne $TestCommand -and $TestCommand.Count -gt 0) { $argsList += '--test-command'; $argsList += $TestCommand }
& $Python '-X' 'utf8' @argsList
exit $LASTEXITCODE
