[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(ParameterSetName = 'Run', Mandatory = $true)]
    [string]$RequestId,

    [Parameter(ParameterSetName = 'Run', Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Task,

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
        $ResultRoot = 'D:\Downloads\_dsh\_auto'
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
    & $Python @argsList
    exit $LASTEXITCODE
}

if ([string]::IsNullOrWhiteSpace($RequestId)) {
    throw 'RequestId must not be empty.'
}
if ([string]::IsNullOrWhiteSpace($Task)) {
    throw 'Task must not be empty.'
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("postman-task-" + [Guid]::NewGuid().ToString('N') + '.txt')
try {
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($tmp, $Task, $utf8NoBom)
    $argsList += @('--request-id', $RequestId, '--task-file', $tmp)
    foreach ($path in $AllowedPath) {
        $argsList += @('--allow-path', $path)
    }
    foreach ($path in $ForbiddenPath) {
        $argsList += @('--forbid-path', $path)
    }
    & $Python @argsList
    exit $LASTEXITCODE
}
finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
