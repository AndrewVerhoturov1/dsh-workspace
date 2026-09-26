[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$ProfileJunction,
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$OriginalTarget,
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$TaskPlugin,
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$HostFile,
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$HostBackup,
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$PatchedHostSha256,
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$OriginalHostSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$module = Join-Path $PSScriptRoot 'switch-ptc-lab-junction.psm1'
Import-Module -Name $module -Force
Invoke-LabRollback -Configuration @{
  ProfileJunction=$ProfileJunction; OriginalTarget=$OriginalTarget; TaskPlugin=$TaskPlugin
  HostFile=$HostFile; HostBackup=$HostBackup
  PatchedHostSha256=$PatchedHostSha256; OriginalHostSha256=$OriginalHostSha256
}
