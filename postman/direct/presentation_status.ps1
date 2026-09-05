[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PublishedJson,
    [Parameter(Mandatory = $true)][ValidateSet('PRESENTATION_PENDING', 'PRESENTED', 'UNREGISTERED')][string]$Status,
    [string]$WorkspaceId = '',
    [string]$SessionId = '',
    [Nullable[bool]]$SessionClosed,
    [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'presentation_status.py'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "POSTMAN_PRESENTATION_MISSING: $script" }
$argsList = @($script, '--published-json', $PublishedJson, '--status', $Status)
if ($WorkspaceId) { $argsList += @('--workspace-id', $WorkspaceId) }
if ($SessionId) { $argsList += @('--session-id', $SessionId) }
if ($null -ne $SessionClosed) { $argsList += $(if ($SessionClosed) { '--session-closed' } else { '--no-session-closed' }) }
& $Python '-X' 'utf8' @argsList
exit $LASTEXITCODE
