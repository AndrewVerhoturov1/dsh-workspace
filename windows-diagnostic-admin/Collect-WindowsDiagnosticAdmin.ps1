# Только чтение. Требуется PowerShell 7 и повышенные права.
[CmdletBinding()]
param([string]$OutputRoot = 'C:\Users\andre\.dsh\windows-diagnostic-admin')

$ErrorActionPreference = 'Continue'
$started = Get-Date
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$integrity = (whoami /groups 2>$null | Select-String 'S-1-16-12288') -ne $null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $OutputRoot $stamp
New-Item -ItemType Directory -Path $out -Force | Out-Null
$progressPath = Join-Path $out '00-progress.log'
$script:Succeeded = [System.Collections.Generic.List[string]]::new()
$script:FailedSteps = [System.Collections.Generic.List[string]]::new()
@{ Timestamp=$started.ToString('o'); User=[Environment]::UserName; IsAdmin=$isAdmin; HighIntegrity=$integrity; Output=$out } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out '00-run-status.json') -Encoding UTF8

function Invoke-Step {
    param([string]$Name,[string]$OutputFile,[scriptblock]$Action)
    Add-Content -LiteralPath $progressPath -Value "$(Get-Date -Format o) START $Name" -Encoding UTF8
    try { & $Action 2>&1 | Out-File -LiteralPath (Join-Path $out $OutputFile) -Encoding UTF8; $script:Succeeded.Add($Name); Add-Content -LiteralPath $progressPath -Value "$(Get-Date -Format o) DONE $Name" -Encoding UTF8 }
    catch { $script:FailedSteps.Add($Name); $_ | Out-File -LiteralPath (Join-Path $out $OutputFile) -Encoding UTF8 -Append; Add-Content -LiteralPath $progressPath -Value "$(Get-Date -Format o) FAIL ${Name}: $($_.Exception.Message)" -Encoding UTF8 }
}
function Invoke-SelfWritingStep {
    param([string]$Name,[string]$OutputFile,[scriptblock]$Action)
    Add-Content -LiteralPath $progressPath -Value "$(Get-Date -Format o) START $Name" -Encoding UTF8
    $errorFile = Join-Path $out "$OutputFile.errors.txt"
    try { & $Action 2> $errorFile | Out-Null; if ((Test-Path -LiteralPath $errorFile) -and (Get-Item -LiteralPath $errorFile).Length -eq 0) { Remove-Item -LiteralPath $errorFile -Force }; $script:Succeeded.Add($Name); Add-Content -LiteralPath $progressPath -Value "$(Get-Date -Format o) DONE $Name" -Encoding UTF8 }
    catch { $script:FailedSteps.Add($Name); $_ | Out-File -LiteralPath $errorFile -Encoding UTF8 -Append; Add-Content -LiteralPath $progressPath -Value "$(Get-Date -Format o) FAIL ${Name}: $($_.Exception.Message)" -Encoding UTF8 }
}

try {
    if (-not ($isAdmin -and $integrity)) {
        'Сеанс не имеет одновременно прав администратора и высокого уровня целостности. Запустите через UAC.' | Set-Content -LiteralPath (Join-Path $out '00-NOT-ELEVATED.txt') -Encoding UTF8
        $script:FailedSteps.Add('Проверка повышенных прав')
        return
    }
    # Первым диагностическим действием идёт потоковый вывод USN без загрузки в память.
    Invoke-Step 'USN C:' '01-usn-readjournal-C.txt' { fsutil usn readjournal C: }
    Invoke-Step 'Точки восстановления' '02-system-restore-points.txt' { Get-ComputerRestorePoint | Format-List * }
    Invoke-Step 'Теневые копии' '03-vssadmin-list-shadows.txt' { vssadmin list shadows }
    $logs=@('Microsoft-Windows-Diagnostics-Performance/Operational','Microsoft-Windows-Winlogon/Operational','Microsoft-Windows-User Profiles Service/Operational','Microsoft-Windows-AppModel-Runtime/Admin','Microsoft-Windows-AppXDeploymentServer/Operational','Microsoft-Windows-StateRepository/Operational','Microsoft-Windows-TWinUI/Operational')
    $n=10
    foreach ($log in $logs) {
        $safe=($log -replace '[^A-Za-z0-9]+','-').Trim('-'); $file='{0:D2}-events-{1}.csv' -f $n,$safe
        Invoke-SelfWritingStep "Журнал $log" $file { Get-WinEvent -LogName $log -MaxEvents 1000 -ErrorAction Stop | Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,Message | Export-Csv -LiteralPath (Join-Path $out $file) -NoTypeInformation -Encoding UTF8 }
        $n++
    }
    Invoke-Step 'Фильтры fltmc' '20-fltmc-filters.txt' { fltmc filters }
    Invoke-Step 'Экземпляры fltmc' '21-fltmc-instances.txt' { fltmc instances }
    Invoke-Step 'ACL целевых каталогов и файлов' '22-acl-targets.txt' {
        $roots=@('C:\Program Files\WindowsApps','C:\ProgramData\Microsoft\Windows\AppRepository','C:\ProgramData\Microsoft\Windows\StateRepository')
        foreach ($root in $roots) {
            if (-not (Test-Path -LiteralPath $root)) { "ОТСУТСТВУЕТ: $root"; continue }
            Get-Acl -LiteralPath $root | Format-List Path,Owner,AccessToString
            foreach ($dir in @(Get-ChildItem -LiteralPath $root -Force -Directory -ErrorAction SilentlyContinue)) { Get-Acl -LiteralPath $dir.FullName | Format-List Path,Owner,AccessToString }
            foreach ($file in @(Get-ChildItem -LiteralPath $root -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'StateRepository*.srd' -or $_.Name -like 'StateRepository*.edb' -or $_.Name -like 'StateRepository*.log' } | Select-Object -First 200)) { Get-Acl -LiteralPath $file.FullName | Format-List Path,Owner,AccessToString }
        }
    }
    Invoke-Step 'DISM CheckHealth' '30-dism-checkhealth.txt' { DISM.exe /Online /Cleanup-Image /CheckHealth }
    Invoke-Step 'DISM ScanHealth' '31-dism-scanhealth.txt' { DISM.exe /Online /Cleanup-Image /ScanHealth }
    Invoke-Step 'SFC verifyonly' '32-sfc-verifyonly.txt' { sfc.exe /verifyonly }
    Invoke-Step 'CHKDSK C: scan' '33-chkdsk-C-scan.txt' { chkdsk.exe C: /scan }
    Invoke-Step 'Счётчики надёжности накопителей' '34-storage-reliability.txt' { Get-PhysicalDisk | ForEach-Object { "=== $($_.FriendlyName) [$($_.DeviceId)] ==="; Get-StorageReliabilityCounter -PhysicalDisk $_ -ErrorAction Stop | Format-List * } }
    foreach ($user in @('andre','TeastWin10')) { $safe=$user -replace '[^A-Za-z0-9_-]','_'; Invoke-Step "AppX $user" "40-appx-$safe.txt" { Get-AppxPackage -User $user -ErrorAction Stop | Select-Object Name,PackageFullName,Status,InstallLocation,PublisherId,SignatureKind | Format-List * } }
    Invoke-SelfWritingStep 'AppX все пользователи' '41-appx-all-users-summary.csv' { Get-AppxPackage -AllUsers -ErrorAction Stop | Select-Object Name,PackageFullName,Status,InstallLocation,PublisherId,SignatureKind | Export-Csv -LiteralPath (Join-Path $out '41-appx-all-users-summary.csv') -NoTypeInformation -Encoding UTF8 }
} finally {
    $finished=Get-Date
    @{ Completed=$finished.ToString('o'); Output=$out; DurationSeconds=[math]::Round(($finished-$started).TotalSeconds,2); Succeeded=@($script:Succeeded); FailedSteps=@($script:FailedSteps); Success=($script:FailedSteps.Count -eq 0 -and $isAdmin -and $integrity) } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $out '99-final.json') -Encoding UTF8
    Add-Content -LiteralPath $progressPath -Value "$(Get-Date -Format o) FINISHED" -Encoding UTF8
}
Write-Output $out
