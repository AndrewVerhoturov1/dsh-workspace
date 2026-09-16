# ASCII only. Performs the explicitly approved Windows component repair.
[CmdletBinding()]
param([string]$OutputRoot='C:\Users\andre\.dsh\windows-diagnostic-admin\repair')
$ErrorActionPreference='Continue';$started=Get-Date
$isAdmin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$high=(whoami /groups 2>$null|Select-String 'S-1-16-12288') -ne $null
$out=Join-Path (Join-Path $OutputRoot 'runs') (Get-Date -Format 'yyyyMMdd-HHmmss');New-Item -ItemType Directory -Path $out -Force|Out-Null
$progress=Join-Path $out '00-progress.log';$script:ok=@();$script:bad=@();$script:skipped=@();$script:codes=@{};$script:RebootRequired=$false
function NativeStep([string]$Name,[string]$File,[scriptblock]$Action,[int[]]$SuccessCodes=@(0)){Add-Content $progress "$(Get-Date -Format o) START $Name"; $path=Join-Path $out $File;try{&$Action 2>&1|Out-File $path -Encoding UTF8;$code=$LASTEXITCODE;$script:codes[$Name]=$code;Add-Content $path "`r`nLASTEXITCODE=$code";if($SuccessCodes -notcontains $code){throw "Command failed with exit code $code"};$script:ok+=$Name;Add-Content $progress "$(Get-Date -Format o) DONE $Name"}catch{$script:bad+=$Name;$_|Out-File $path -Encoding UTF8 -Append;Add-Content $progress "$(Get-Date -Format o) FAIL ${Name}: $($_.Exception.Message)"}}
function ReadStep([string]$Name,[string]$File,[scriptblock]$Action){Add-Content $progress "$(Get-Date -Format o) START $Name";try{&$Action 2>&1|Out-File (Join-Path $out $File) -Encoding UTF8;$script:ok+=$Name;Add-Content $progress "$(Get-Date -Format o) DONE $Name"}catch{$script:bad+=$Name;$_|Out-File (Join-Path $out $File) -Encoding UTF8 -Append;Add-Content $progress "$(Get-Date -Format o) FAIL ${Name}: $($_.Exception.Message)"}}
try{
 if(-not($isAdmin -and $high)){ 'Administrator and high integrity are required.'|Set-Content (Join-Path $out '00-NOT-ELEVATED.txt') -Encoding UTF8;$script:bad+='Privilege check';return }
 NativeStep 'DISM RestoreHealth' '01-dism-restorehealth.txt' {DISM.exe /Online /Cleanup-Image /RestoreHealth} @(0,3010)
 if($script:codes['DISM RestoreHealth'] -eq 3010){$script:RebootRequired=$true;$script:skipped+='SFC scannow';'Skipped until a manual reboot because DISM returned 3010 (reboot required).'|Set-Content (Join-Path $out '02-sfc-scannow.txt') -Encoding UTF8}
 elseif($script:codes['DISM RestoreHealth'] -eq 0){NativeStep 'SFC scannow' '02-sfc-scannow.txt' {sfc.exe /scannow}}
 else{$script:skipped+='SFC scannow';'Skipped because DISM RestoreHealth did not return a successful code.'|Set-Content (Join-Path $out '02-sfc-scannow.txt') -Encoding UTF8}
 ReadStep 'sc query swprv' '10-sc-query-swprv.txt' {sc.exe query swprv}
 ReadStep 'sc qc swprv' '11-sc-qc-swprv.txt' {sc.exe qc swprv}
 ReadStep 'Registry swprv key' '12-reg-query-swprv.txt' {reg.exe query 'HKLM\SYSTEM\CurrentControlSet\Services\swprv' /s}
 NativeStep 'VSS providers' '13-vssadmin-providers.txt' {vssadmin list providers}
 NativeStep 'VSS writers' '14-vssadmin-writers.txt' {vssadmin list writers}
 NativeStep 'VSS shadowstorage' '15-vssadmin-shadowstorage.txt' {vssadmin list shadowstorage}
 NativeStep 'CHKDSK C scan' '16-chkdsk-C-scan.txt' {chkdsk.exe C: /scan}
 ReadStep 'Service state' '17-services.txt' {Get-Service -Name VSS,swprv,AppXSvc,StateRepository,ClipSVC -ErrorAction SilentlyContinue|Select Name,Status,StartType|Format-List *}
 ReadStep 'Reboot pending checks' '18-reboot-pending.txt' {Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending' -ErrorAction SilentlyContinue|Format-List *;Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired' -ErrorAction SilentlyContinue|Format-List *}
}finally{$end=Get-Date;$pending=(($null -ne (Get-Item 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending' -ErrorAction SilentlyContinue))-or($null -ne (Get-Item 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired' -ErrorAction SilentlyContinue)));$script:RebootRequired=$script:RebootRequired -or $pending;$needs=($script:RebootRequired -or ($script:codes['DISM RestoreHealth'] -eq 3010));@{Completed=$end.ToString('o');Output=$out;DurationSeconds=[math]::Round(($end-$started).TotalSeconds,2);Succeeded=$script:ok;SkippedSteps=$script:skipped;FailedSteps=$script:bad;ExitCodes=$script:codes;RebootRequired=$script:RebootRequired;CompletedNeedsReboot=$needs;Success=($script:bad.Count -eq 0 -and $isAdmin -and $high)}|ConvertTo-Json -Depth 5|Set-Content (Join-Path $out '99-final.json') -Encoding UTF8;Add-Content $progress "$(Get-Date -Format o) FINISHED"}
Write-Output $out
