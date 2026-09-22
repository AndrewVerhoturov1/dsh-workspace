[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RequestId,

    [AllowEmptyString()]
    [string]$Task = '',

    [AllowEmptyString()]
    [string]$TaskBase64 = '',

    [string]$ChatRequestId = '',

    [string]$Repository = 'AndrewVerhoturov1/dsh-workspace',
    [string]$Branch = 'main',
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'

$bridge = Join-Path $PSScriptRoot 'postman_ask.py'
if (-not (Test-Path -LiteralPath $bridge -PathType Leaf)) {
    throw "Direct PostmanAsk bridge not found: $bridge"
}
if ([string]::IsNullOrWhiteSpace($RequestId)) {
    throw 'RequestId must not be empty.'
}

$hasTask = -not [string]::IsNullOrWhiteSpace($Task)
$hasTaskBase64 = -not [string]::IsNullOrWhiteSpace($TaskBase64)
if ($hasTask -eq $hasTaskBase64) {
    throw 'Specify exactly one of -Task or -TaskBase64.'
}

$argsList = @(
    $bridge,
    '--repository', $Repository,
    '--branch', $Branch,
    '--request-id', $RequestId
)

$tmp = $null
try {
    if ($hasTaskBase64) {
        $argsList += @('--task-base64', $TaskBase64)
    }
    else {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("postman-ask-task-" + [Guid]::NewGuid().ToString('N') + '.txt')
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($tmp, $Task, $utf8NoBom)
        $argsList += @('--task-file', $tmp)
    }

    if (-not [string]::IsNullOrWhiteSpace($ChatRequestId)) {
        $argsList += @('--chat-request-id', $ChatRequestId)
    }

    & $Python '-X' 'utf8' @argsList
    exit $LASTEXITCODE
}
finally {
    if ($null -ne $tmp) {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}
