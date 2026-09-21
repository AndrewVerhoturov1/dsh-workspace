[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(ParameterSetName = 'Run', Mandatory = $true)]
    [string]$RequestId,

    [Parameter(ParameterSetName = 'Run')]
    [AllowEmptyString()]
    [string]$Task = '',

    [Parameter(ParameterSetName = 'Run')]
    [AllowEmptyString()]
    [string]$TaskBase64 = '',

    [Parameter(ParameterSetName = 'Run')]
    [string]$ChatRequestId = '',

    [Parameter(ParameterSetName = 'Run')]
    [switch]$AutomaticContinuation,

    [Parameter(ParameterSetName = 'Smoke', Mandatory = $true)]
    [switch]$BrowserSmoke,

    [string]$Repository = 'AndrewVerhoturov1/dsh-workspace',
    [string]$Branch = 'main',
    [string]$ResultRoot = '',
    [string]$Python = 'python',
    [string[]]$AllowedPath = @(),
    [string[]]$ForbiddenPath = @()
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ResultRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:DSH_POSTMAN_RESULT_ROOT)) {
        $ResultRoot = 'D:\Downloads_dsh_auto'
    }
    else {
        $ResultRoot = $env:DSH_POSTMAN_RESULT_ROOT
    }
}
$bridge = Join-Path $PSScriptRoot 'postman_direct.py'
if (-not (Test-Path -LiteralPath $bridge -PathType Leaf)) {
    throw "Direct Postman bridge not found: $bridge"
}

$argsList = @(
    $bridge,
    '--repository', $Repository,
    '--branch', $Branch,
    '--result-root', $ResultRoot
)

if ($BrowserSmoke) {
    $argsList += '--browser-smoke'
    & $Python '-X' 'utf8' @argsList
    exit $LASTEXITCODE
}

if ([string]::IsNullOrWhiteSpace($RequestId)) {
    throw 'RequestId must not be empty.'
}

$hasTask = -not [string]::IsNullOrWhiteSpace($Task)
$hasTaskBase64 = -not [string]::IsNullOrWhiteSpace($TaskBase64)
if ($hasTask -eq $hasTaskBase64) {
    throw 'Specify exactly one of -Task or -TaskBase64.'
}

$argsList += @('--request-id', $RequestId)
$tmp = $null
try {
    if ($hasTaskBase64) {
        $argsList += @('--task-base64', $TaskBase64)
    }
    else {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("postman-task-" + [Guid]::NewGuid().ToString('N') + '.txt')
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($tmp, $Task, $utf8NoBom)
        $argsList += @('--task-file', $tmp)
    }

    if (-not [string]::IsNullOrWhiteSpace($ChatRequestId)) {
        $argsList += @('--chat-request-id', $ChatRequestId)
    }
    if ($AutomaticContinuation) {
        $argsList += '--automatic-continuation'
    }
    foreach ($path in $AllowedPath) {
        $argsList += @('--allow-path', $path)
    }
    foreach ($path in $ForbiddenPath) {
        $argsList += @('--forbid-path', $path)
    }

    & $Python '-X' 'utf8' @argsList
    exit $LASTEXITCODE
}
finally {
    if ($null -ne $tmp) {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}
