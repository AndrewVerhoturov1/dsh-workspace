[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RequestId,
      [string]$TaskBase64,
      [Parameter(Mandatory=$true)][string]$Channel,
      [AllowEmptyString()][string]$Branch,
      [ValidateSet('image_inspect','image_download')][string]$ImageAction,
      [string]$InputFilesBase64,
      [string]$InputBundleManifest,
      [switch]$ImageMode)
$ErrorActionPreference = 'Stop'
$arguments = @('--request-id', $RequestId, '--channel', $Channel)
if (-not $ImageAction -and -not $TaskBase64) { throw 'TaskBase64 is required outside image action' }
if ($TaskBase64) { $arguments += @('--task-base64', $TaskBase64) }
if ($InputFilesBase64) { $arguments += @('--input-files-base64', $InputFilesBase64) }
if ($InputBundleManifest) { $arguments += @('--input-bundle-manifest', $InputBundleManifest) }
if ($ImageMode) { $arguments += '--image-mode' }
if ($ImageAction) { $arguments += @('--image-action', $ImageAction) }
& python -X utf8 (Join-Path $PSScriptRoot 'transport.py') @arguments
exit $LASTEXITCODE
