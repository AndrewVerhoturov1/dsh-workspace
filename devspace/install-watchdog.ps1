#requires -Version 7.5
param([string]$Root=$PSScriptRoot, [switch]$Elevated, [string]$OwnerSid)
$ErrorActionPreference='Stop'
$taskName='DSH DevSpace Supervisor'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$admin=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$pwsh=(Get-Process -Id $PID).Path
if (-not $admin) {
    if ($Elevated) { throw 'Administrator approval was not granted.' }
    $process=Start-Process -FilePath $pwsh -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList ('-NoProfile -NonInteractive -File "'+$PSCommandPath+'" -Root "'+$Root+'" -OwnerSid "'+$identity.User.Value+'" -Elevated')
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw 'Elevated installation failed or was cancelled.' }
    return
}
$resultPath=Join-Path $Root 'installation.json'
try {
    if ($OwnerSid -and $identity.User.Value -ne $OwnerSid) { throw 'Elevation changed the Windows user; no task installed.' }
    $user=$identity.Name
    $existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing -and ($existing.Description -ne 'DSH DevSpace: user-owned loopback server and public Funnel checks.' -or $existing.Principal.UserId -notin @($user,$identity.User.Value))) { throw 'Existing task has different ownership; preserved.' }
    $action=New-ScheduledTaskAction -Execute $pwsh -Argument ('-NoProfile -NonInteractive -File "'+(Join-Path $Root 'watchdog.ps1')+'" -Monitor') -WorkingDirectory $Root
    $startup=New-ScheduledTaskTrigger -AtStartup
    $logon=New-ScheduledTaskTrigger -AtLogOn -User $user
    $minute=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $null=Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($startup,$logon,$minute) -Principal $principal -Settings $settings -Description 'DSH DevSpace: user-owned loopback server and public Funnel checks.' -Force
    & 'C:/Program Files/Tailscale/tailscale.exe' set --unattended=true *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Tailscale unattended setting failed; no network reset attempted.' }
    Start-ScheduledTask -TaskName $taskName
    @{installedAt=[DateTime]::UtcNow.ToString('o');task=$taskName;user=$user;logon='S4U';runLevel='Limited';unattendedCommandSucceeded=$true} | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding utf8NoBOM
} catch {
    @{installedAt=[DateTime]::UtcNow.ToString('o');result='failed';error=$_.Exception.GetType().Name} | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding utf8NoBOM
    exit 1
}
