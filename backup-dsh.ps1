$ErrorActionPreference = 'Stop'

$source = 'C:UsersAndrew.dsh'
$backupRoot = 'D:DSH_BACKUPSsnapshots'

try {
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        throw "Source directory does not exist: $source"
    }

    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

    $stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
    $destination = Join-Path $backupRoot $stamp

    if (Test-Path -LiteralPath $destination) {
        throw "Snapshot already exists: $destination"
    }

    New-Item -ItemType Directory -Path $destination -ErrorAction Stop | Out-Null

    & robocopy.exe $source $destination /E /COPY:DAT /R:2 /W:2 /XJ
    $robocopyExitCode = $LASTEXITCODE

    if ($robocopyExitCode -ge 8) {
        throw "Robocopy failed with exit code $robocopyExitCode"
    }

    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
