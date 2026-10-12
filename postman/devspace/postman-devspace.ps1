[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RequestId,
      [Parameter(Mandatory=$true)][string]$TaskBase64,
      [Parameter(Mandatory=$true)][string]$Channel,
      [Parameter(Mandatory=$true)][string]$Branch)
$ErrorActionPreference = 'Stop'
& python -X utf8 (Join-Path $PSScriptRoot 'transport.py') --request-id $RequestId --task-base64 $TaskBase64 --channel $Channel
exit $LASTEXITCODE
