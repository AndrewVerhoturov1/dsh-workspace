[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RequestId,
      [Parameter(Mandatory=$true)][string]$TaskBase64,
      [Parameter(Mandatory=$true)][string]$Channel,
      [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Branch,
      [string]$InputFilesBase64,
      [string]$InputBundleManifest)
$ErrorActionPreference = 'Stop'
$arguments = @('--request-id', $RequestId, '--task-base64', $TaskBase64, '--channel', $Channel)
if ($InputFilesBase64) { $arguments += @('--input-files-base64', $InputFilesBase64) }
if ($InputBundleManifest) { $arguments += @('--input-bundle-manifest', $InputBundleManifest) }
& python -X utf8 (Join-Path $PSScriptRoot 'transport.py') @arguments
exit $LASTEXITCODE
