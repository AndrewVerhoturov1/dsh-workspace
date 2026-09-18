$ErrorActionPreference = 'Stop'

$source = 'C:\Users\Andrew\.dsh'
$backupRoot = 'D:\DSH_BACKUPS\snapshots'
$maxBackups = 7

try {
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        throw "Source directory does not exist: $source"
    }

    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

    $stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
    $destination = Join-Path $backupRoot $stamp
    $partial = "$destination.partial"

    if (Test-Path -LiteralPath $destination) {
        throw "Completed snapshot already exists: $destination"
    }

    if (Test-Path -LiteralPath $partial) {
        throw "Partial snapshot already exists: $partial"
    }

    # Count only DSH backup directories created by this scheme.
    # Both completed snapshots and .partial snapshots count toward the limit.
    $backups = @(
        Get-ChildItem -LiteralPath $backupRoot -Directory -Force |
            Where-Object {
                $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{4}(?:\.partial)?$'
            } |
            Sort-Object Name
    )

    # Before creating a new backup, keep at most 6 existing entries.
    # The new .partial then becomes the 7th entry at most.
    $removeCount = [Math]::Max(0, $backups.Count - ($maxBackups - 1))

    if ($removeCount -gt 0) {
        foreach ($oldBackup in ($backups | Select-Object -First $removeCount)) {
            Remove-Item -LiteralPath $oldBackup.FullName -Recurse -Force -ErrorAction Stop
        }
    }

    New-Item -ItemType Directory -Path $partial -ErrorAction Stop | Out-Null

    & robocopy.exe `
        $source `
        $partial `
        /E `
        /COPY:DAT `
        /R:2 `
        /W:2 `
        /XJ `
        /NFL `
        /NDL `
        /NJH `
        /NJS `
        /NP

    $robocopyExitCode = $LASTEXITCODE

    if ($robocopyExitCode -ge 8) {
        throw "Robocopy failed with exit code $robocopyExitCode. Partial snapshot remains at: $partial"
    }

    Rename-Item `
        -LiteralPath $partial `
        -NewName (Split-Path -Path $destination -Leaf) `
        -ErrorAction Stop

    Write-Output "Backup completed: $destination"
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
