# Read-only. Compatible with Windows PowerShell 5.1.
[CmdletBinding()]
param([string]$OutputRoot = 'C:\Users\andre\.dsh\windows-diagnostic-admin')
$ErrorActionPreference='Continue'; $started=Get-Date
$isAdmin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$high=(whoami /groups 2>$null | Select-String 'S-1-16-12288') -ne $null
$out=Join-Path (Join-Path $OutputRoot 'followup') (Get-Date -Format 'yyyyMMdd-HHmmss'); New-Item -ItemType Directory -Path $out -Force | Out-Null
$progress=Join-Path $out '00-progress.log'; $script:ok=@(); $script:bad=@()
function Step([string]$Name,[string]$File,[scriptblock]$Action){Add-Content $progress "$(Get-Date -Format o) START $Name";try{&$Action 2>&1|Out-File (Join-Path $out $File) -Encoding UTF8;$script:ok+=$Name;Add-Content $progress "$(Get-Date -Format o) DONE $Name"}catch{$script:bad+=$Name;$_|Out-File (Join-Path $out $File) -Encoding UTF8 -Append;Add-Content $progress "$(Get-Date -Format o) FAIL ${Name}: $($_.Exception.Message)"}}
function NativeStep([string]$Name,[string]$File,[scriptblock]$Action){
 Add-Content $progress "$(Get-Date -Format o) START $Name"
 $path=Join-Path $out $File
 try {
  &$Action 2>&1|Out-File $path -Encoding UTF8
  $code=$LASTEXITCODE
  Add-Content $path "`r`nLASTEXITCODE=$code"
  if($code -ne 0){throw "Command failed with exit code $code"}
  $script:ok+=$Name;Add-Content $progress "$(Get-Date -Format o) DONE $Name"
 } catch {
  $script:bad+=$Name;$_|Out-File $path -Encoding UTF8 -Append
  Add-Content $progress "$(Get-Date -Format o) FAIL ${Name}: $($_.Exception.Message)"
 }
}
try {
 if(-not($isAdmin -and $high)){ 'Administrator and high integrity are required.'|Set-Content (Join-Path $out '00-NOT-ELEVATED.txt') -Encoding UTF8;$script:bad+='Privilege check';return }
 Step 'SystemRestore CIM' '01-systemrestore-cim.txt' {try{Get-CimInstance -Namespace root\default -ClassName SystemRestore -ErrorAction Stop|Format-List *}catch{Get-WmiObject -Namespace root\default -Class SystemRestore -ErrorAction Stop|Format-List *}}
 foreach($u in @('andre','TeastWin10')){ $f=$u+'.txt';Step "AppX $u" "02-appx-$f" {Get-AppxPackage -User $u -ErrorAction Stop|Select Name,PackageFullName,PackageFamilyName,Version,InstallLocation,Status,IsFramework,SignatureKind,NonRemovable|Format-List *}}
 Step 'AppX all users' '03-appx-all-users.txt' {Get-AppxPackage -AllUsers -ErrorAction Stop|Select Name,PackageFullName,PackageFamilyName,Version,InstallLocation,Status,IsFramework,SignatureKind,NonRemovable|Format-List *}
 Step 'Target AppX packages' '04-appx-targets.txt' {$names='immersivecontrolpanel|StartMenuExperienceHost|ShellExperienceHost|Windows.Search|SecurityHealth|WindowsTerminal|Codex';Get-AppxPackage -AllUsers|Where-Object{$_.Name -match $names}|Select Name,PackageFullName,PackageFamilyName,Version,InstallLocation,Status,IsFramework,SignatureKind,NonRemovable|Format-List *}
 Step 'Service state' '05-services.txt' {Get-Service -Name VSS,swprv,AppXSvc,StateRepository,ClipSVC -ErrorAction SilentlyContinue|Select Name,DisplayName,Status,StartType,CanStop,CanShutdown|Format-List *}
 NativeStep 'VSS writers' '06-vssadmin-writers.txt' {vssadmin list writers}
 NativeStep 'VSS providers' '07-vssadmin-providers.txt' {vssadmin list providers}
 NativeStep 'VSS shadowstorage' '08-vssadmin-shadowstorage.txt' {vssadmin list shadowstorage}
 NativeStep 'Dirty state C:' '09-fsutil-dirty-C.txt' {fsutil dirty query C:}
 Step 'Volume C:' '10-volume-C.txt' {Get-Volume -DriveLetter C|Format-List *}
 NativeStep 'Mount points' '11-mountvol.txt' {mountvol}
 Step 'System/Application events' '12-events-system-application.txt' {foreach($l in 'System','Application'){try{Get-WinEvent -LogName $l -MaxEvents 2000 -ErrorAction Stop|Where-Object{$_.ProviderName -match 'Chkdsk|VSS|VolSnap'}|Select-Object -First 100 TimeCreated,Id,LevelDisplayName,ProviderName,Message|Format-List *}catch{"ERROR ${l}: $($_.Exception.Message)"}}}
}finally{$end=Get-Date;@{Completed=$end.ToString('o');Output=$out;DurationSeconds=[math]::Round(($end-$started).TotalSeconds,2);Succeeded=$script:ok;FailedSteps=$script:bad;Success=($script:bad.Count -eq 0 -and $isAdmin -and $high)}|ConvertTo-Json -Depth 4|Set-Content (Join-Path $out '99-final.json') -Encoding UTF8;Add-Content $progress "$(Get-Date -Format o) FINISHED"}
Write-Output $out
