[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ResultJsonText,

    [string]$RepoRoot = 'C:\Users\andre\.dsh',
    [string]$Python = 'python',
    [string]$ExpectedRepository = 'AndrewVerhoturov1/dsh-workspace',
    [string]$GhBinary = 'gh'
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'prepare_result.py'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "POSTMAN_PREPARE_MISSING: $script"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("postman-result-" + [Guid]::NewGuid().ToString('N') + '.json')
try {
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($tmp, $ResultJsonText, $utf8NoBom)
    & $Python $script `
        '--result-json' $tmp `
        '--repo-root' $RepoRoot `
        '--expected-repository' $ExpectedRepository `
        '--gh-binary' $GhBinary
    exit $LASTEXITCODE
}
finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
