[CmdletBinding(DefaultParameterSetName = 'Text')]
param(
    [Parameter(ParameterSetName = 'Text', Mandatory = $true)]
    [string]$ResultJsonText,

    [Parameter(ParameterSetName = 'Resume', Mandatory = $true)]
    [string]$RequestId,

    [string]$RepoRoot = 'C:\Users\andre\.dsh',
    [string]$Python = 'python',
    [string]$ExpectedRepository = 'AndrewVerhoturov1/dsh-workspace',
    [string]$GhBinary = 'gh',
    [string]$DirectRoot = ''
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'prepare_result.py'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "POSTMAN_PREPARE_MISSING: $script"
}

$argsList = @(
    $script,
    '--repo-root', $RepoRoot,
    '--expected-repository', $ExpectedRepository,
    '--gh-binary', $GhBinary
)
if (-not [string]::IsNullOrWhiteSpace($DirectRoot)) {
    $argsList += @('--direct-root', $DirectRoot)
}

$tmp = $null
try {
    if ($PSCmdlet.ParameterSetName -eq 'Resume') {
        $argsList += @('--request-id', $RequestId)
    }
    else {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("postman-result-" + [Guid]::NewGuid().ToString('N') + '.json')
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($tmp, $ResultJsonText, $utf8NoBom)
        $argsList += @('--result-json', $tmp)
    }
    & $Python '-X' 'utf8' @argsList
    exit $LASTEXITCODE
}
finally {
    if ($null -ne $tmp) {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}
