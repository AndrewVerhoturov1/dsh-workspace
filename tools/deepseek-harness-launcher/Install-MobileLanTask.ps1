# One-time installer; RUN MANUALLY from elevated Windows PowerShell 5.1.
# The scheduled SYSTEM task executes only a protected copy under ProgramData.
# The source tree and this installer are NEVER used as the task action.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'DSH-MobileLan-Restore'
$TargetDirectory = 'C:\ProgramData\DSH-MobileLan'
$TargetHelper = 'C:\ProgramData\DSH-MobileLan\Restore-MobileLan.ps1'
$HelperSource = Join-Path $PSScriptRoot 'Restore-MobileLan.ps1'
$ExpectedHelperSha256 = '3885B2BBAD8C81094F0F40C5D48EAB05447AB40B44EEC3B4A1570B8CDF5F7A89'
$PowerShellExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$TaskArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\ProgramData\DSH-MobileLan\Restore-MobileLan.ps1"'
$TaskWorkingDirectory = 'C:\Windows\System32'
$TaskSddl = 'O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;BU)'
$SidSystem = 'S-1-5-18'
$SidAdministrators = 'S-1-5-32-544'
$SidUsers = 'S-1-5-32-545'

function Test-AdministratorToken {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator {
    if (-not (Test-AdministratorToken)) {
        throw 'ADMIN_REQUIRED: open Windows PowerShell as Administrator, then run this installer manually. No UAC prompt was started.'
    }
}

function Get-ExpectedHelperBytes {
    $item = Get-Item -LiteralPath $HelperSource -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'HELPER_SOURCE_NOT_REGULAR_FILE'
    }
    $bytes = [IO.File]::ReadAllBytes($HelperSource)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') }
    finally { $sha.Dispose() }
    if ($actual -ne $ExpectedHelperSha256) { throw 'HELPER_SOURCE_HASH_MISMATCH: use the reviewed, matching helper' }
    return ,$bytes
}

function New-AdminOnlySecurity([bool]$ForDirectory) {
    $acl = if ($ForDirectory) {
        New-Object Security.AccessControl.DirectorySecurity
    } else {
        New-Object Security.AccessControl.FileSecurity
    }
    $acl.SetAccessRuleProtection($true, $false)
    $admin = [Security.Principal.SecurityIdentifier]::new($SidAdministrators)
    $system = [Security.Principal.SecurityIdentifier]::new($SidSystem)
    $acl.SetOwner($admin)
    foreach ($sid in @($admin, $system)) {
        $flags = if ($ForDirectory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $flags,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule)
    }
    return $acl
}

function Assert-AdminOnlyPath([string]$Path, [bool]$ForDirectory) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -ne $ForDirectory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "PROTECTED_PATH_CONFLICT: $Path"
    }
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $SidAdministrators) {
        throw "PROTECTED_ACL_CONFLICT: $Path"
    }
    $entries = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
    if ($entries.Count -ne 2) { throw "PROTECTED_ACL_CONFLICT: $Path" }
    $seen = @{}
    foreach ($entry in $entries) {
        $sid = $entry.IdentityReference.Value
        if ($sid -notin @($SidSystem, $SidAdministrators) -or
            $entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $entry.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) {
            throw "PROTECTED_ACL_CONFLICT: $Path"
        }
        $expectedInheritance = if ($ForDirectory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
        if ($entry.InheritanceFlags -ne $expectedInheritance -or
            $entry.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
            throw "PROTECTED_ACL_CONFLICT: $Path"
        }
        $seen[$sid] = $true
    }
    if (-not $seen[$SidSystem] -or -not $seen[$SidAdministrators]) {
        throw "PROTECTED_ACL_CONFLICT: $Path"
    }
}

function Test-SystemPrincipal([string]$UserId) {
    if ($UserId -eq $SidSystem) { return $true }
    try {
        $resolvedSid = ([Security.Principal.NTAccount]::new($UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
        return $resolvedSid -eq $SidSystem
    } catch {
        return $false
    }
}

function Assert-OwnTask($Task) {
    $definition = $Task.Definition
    $actions = $definition.Actions
    if ($actions.Count -ne 1 -or $actions.Item(1).Type -ne 0 -or
        [string]$actions.Item(1).Path -ne $PowerShellExe -or
        [string]$actions.Item(1).Arguments -ne $TaskArgs -or
        [string]$actions.Item(1).WorkingDirectory -ne $TaskWorkingDirectory -or
        $definition.Triggers.Count -ne 0 -or
        -not (Test-SystemPrincipal ([string]$definition.Principal.UserId)) -or
        [int]$definition.Principal.LogonType -ne 5 -or
        [int]$definition.Principal.RunLevel -ne 1 -or
        -not $definition.Settings.Enabled -or -not $definition.Settings.AllowDemandStart -or
        [int]$definition.Settings.MultipleInstances -ne 2) {
        throw 'TASK_NAME_CONFLICT: existing task does not match this fixed on-demand task'
    }

    # Task Scheduler can return expanded file-specific masks (FA/FR/FX)
    # and omit DACL_PROTECTED even for our registered SDDL. Verify every
    # returned ACE and the aggregate rights instead of comparing raw SDDL.
    $actual = [Security.AccessControl.RawSecurityDescriptor]::new($Task.GetSecurityDescriptor(7))
    if ($null -eq $actual.Owner -or $actual.Owner.Value -ne $SidAdministrators -or
        $null -eq $actual.Group -or $actual.Group.Value -ne $SidAdministrators -or
        -not ($actual.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -or
        $null -eq $actual.DiscretionaryAcl) {
        throw 'TASK_SECURITY_CONFLICT'
    }

    $rights = @{}
    foreach ($sid in @($SidSystem, $SidAdministrators, $SidUsers)) { $rights[$sid] = 0 }
    foreach ($ace in $actual.DiscretionaryAcl) {
        if ($ace -isnot [Security.AccessControl.CommonAce] -or
            $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or
            $ace.AceFlags -ne [Security.AccessControl.AceFlags]::None -or
            $ace.IsCallback -or -not $rights.ContainsKey($ace.SecurityIdentifier.Value)) {
            throw 'TASK_SECURITY_CONFLICT'
        }

        # Task ACLs use file rights: map GA/GR/GW/GX to their specific
        # equivalents before checking both the maximum and required rights.
        $mask = $ace.AccessMask -band 0x0FFFFFFF
        if ($ace.AccessMask -band 0x10000000) { $mask = $mask -bor 0x001F01FF } # GA -> FA
        if ($ace.AccessMask -band 0x20000000) { $mask = $mask -bor 0x001200A0 } # GX -> FX
        if ($ace.AccessMask -band 0x40000000) { $mask = $mask -bor 0x00120116 } # GW -> FW
        if ($ace.AccessMask -band [int]::MinValue) { $mask = $mask -bor 0x00120089 } # GR -> FR

        $sid = $ace.SecurityIdentifier.Value
        $required = if ($sid -eq $SidUsers) { 0x001200A9 } else { 0x001F01FF }
        if ($mask -eq 0 -or ($mask -band (-bnot $required)) -ne 0) {
            throw 'TASK_SECURITY_CONFLICT'
        }
        $rights[$sid] = $rights[$sid] -bor $mask
    }
    if ($rights[$SidSystem] -ne 0x001F01FF -or
        $rights[$SidAdministrators] -ne 0x001F01FF -or
        $rights[$SidUsers] -ne 0x001200A9) {
        throw 'TASK_SECURITY_CONFLICT'
    }
}

function Install-MobileLanTask {
    # No side effect before checking elevation and the reviewed helper bytes.
    Assert-Administrator
    $helperBytes = Get-ExpectedHelperBytes
    if (-not (Test-Path -LiteralPath $PowerShellExe -PathType Leaf)) { throw 'SYSTEM_POWERSHELL_MISSING' }

    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $root = $scheduler.GetFolder('\')
    $existing = $null
    try {
        $existing = $root.GetTask($TaskName)
    } catch {
        # Task Scheduler surfaces ERROR_FILE_NOT_FOUND as FileNotFoundException
        # on some PowerShell/COM versions, not necessarily COMException.
        if ($_.Exception.HResult -ne -2147024894) { throw }
    }
    if ($null -ne $existing) { Assert-OwnTask $existing }

    if (Test-Path -LiteralPath $TargetDirectory) {
        Assert-AdminOnlyPath $TargetDirectory $true
    } else {
        if ($null -ne $existing) { throw 'OWN_TASK_HELPER_DIRECTORY_MISSING' }
        $directoryAcl = New-AdminOnlySecurity $true
        [IO.Directory]::CreateDirectory($TargetDirectory, $directoryAcl) | Out-Null
        Assert-AdminOnlyPath $TargetDirectory $true
    }

    if (Test-Path -LiteralPath $TargetHelper) {
        Assert-AdminOnlyPath $TargetHelper $false
        $hash = (Get-FileHash -LiteralPath $TargetHelper -Algorithm SHA256).Hash
        if ($hash -ne $ExpectedHelperSha256) { throw 'PROTECTED_HELPER_CONTENT_CONFLICT' }
    } else {
        if ($null -ne $existing) { throw 'OWN_TASK_HELPER_FILE_MISSING' }
        [IO.File]::WriteAllBytes($TargetHelper, [byte[]]$helperBytes)
        Set-Acl -LiteralPath $TargetHelper -AclObject (New-AdminOnlySecurity $false)
        Assert-AdminOnlyPath $TargetHelper $false
    }

    # A non-owned object with this task name is never updated or replaced.
    if ($null -ne $existing) {
        Write-Output 'ALREADY_INSTALLED: exact task, helper, and protected ACL verified'
        return
    }

    $definition = $scheduler.NewTask(0)
    $definition.RegistrationInfo.Description = 'On-demand, exact DSH mobile LAN portproxy restoration. No triggers.'
    $definition.Principal.UserId = $SidSystem
    $definition.Principal.LogonType = 5 # TASK_LOGON_SERVICE_ACCOUNT
    $definition.Principal.RunLevel = 1 # TASK_RUNLEVEL_HIGHEST
    $definition.Settings.Enabled = $true
    $definition.Settings.AllowDemandStart = $true
    $definition.Settings.MultipleInstances = 2 # TASK_INSTANCES_IGNORE_NEW
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $definition.Settings.ExecutionTimeLimit = 'PT20S'
    $action = $definition.Actions.Create(0) # TASK_ACTION_EXEC
    $action.Path = $PowerShellExe
    $action.Arguments = $TaskArgs
    $action.WorkingDirectory = $TaskWorkingDirectory

    # TASK_CREATE=2 (not CREATE_OR_UPDATE), TASK_LOGON_SERVICE_ACCOUNT=5.
    # Explicit task DACL: only SYSTEM/admin full access; standard Users read+execute.
    $created = $root.RegisterTaskDefinition($TaskName, $definition, 2, $SidSystem, $null, 5, $TaskSddl)
    Assert-OwnTask $created
    Write-Output "INSTALLED: $TaskName; fixed helper: $TargetHelper; no triggers"
}

try {
    Install-MobileLanTask
} catch {
    [Console]::Error.WriteLine('MOBILE_LAN_INSTALL_STOP: ' + $_.Exception.Message)
    exit 1
}
