# Mock-only tests: no real task creation, network mutation or DSH restart.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSCommandPath
$passed = 0
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "TEST_FAILED: $Message" }
}
function Pass([string]$Name) { $script:passed++; Write-Output "PASS $Name" }

foreach ($name in @('DSH-Common.ps1', 'Restore-MobileLan.ps1', 'Install-MobileLanTask.ps1')) {
    $tokens = $null
    $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $root $name), [ref]$tokens, [ref]$errors)
    Assert-True ($errors.Count -eq 0) "$name parse"
}
Pass 'PowerShell AST syntax'

function Test-PrivilegedHelper {
    . (Join-Path $root 'Restore-MobileLan.ps1')
    $script:Case = [pscustomobject]@{ Listener = 'healthy'; ProxyExact = $true; LanHttp = $true; Repairs = 0 }
    function Get-IpHelperPid { return 3808 }
    function Get-NetIPAddress {
        [pscustomobject]@{ InterfaceIndex = 14; PrefixLength = 24; AddressState = 'Preferred'; InterfaceAlias = 'Wi-Fi' }
    }
    function Get-NetAdapter {
        [pscustomobject]@{ InterfaceIndex = 14; Status = 'Up'; InterfaceDescription = 'MERCUSYS Wireless USB Adapter'; MediaType = 'Native 802.11' }
    }
    function Get-NetConnectionProfile { [pscustomobject]@{ NetworkCategory = 'Public' } }
    function Get-MobilePortproxyRows {
        if ($script:Case.ProxyExact) { return '192.168.0.5     4173        127.0.0.1       4173' }
        return '192.168.0.5     4173        127.0.0.1       4199'
    }
    function Get-NetFirewallRule {
        [pscustomobject]@{ Enabled = 'True'; Direction = 'Inbound'; Action = 'Allow'; Profile = 'Public' }
    }
    function Get-NetFirewallPortFilter {
        [pscustomobject]@{ Protocol = 'TCP'; LocalPort = '4173'; RemotePort = 'Any' }
    }
    function Get-NetFirewallAddressFilter {
        [pscustomobject]@{ LocalAddress = '192.168.0.5'; RemoteAddress = @('192.168.0.2', '192.168.0.3') }
    }
    function Get-NetFirewallInterfaceFilter { [pscustomobject]@{ InterfaceAlias = 'Wi-Fi' } }
    function Get-NetFirewallInterfaceTypeFilter { [pscustomobject]@{ InterfaceType = 'Any' } }
    function Get-NetFirewallApplicationFilter { [pscustomobject]@{ Program = 'Any' } }
    function Get-NetFirewallServiceFilter { [pscustomobject]@{ Service = 'Any' } }
    function Get-MobileLanListeners {
        $loopback = [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 9548 }
        if ($script:Case.Listener -eq 'healthy') {
            return @($loopback, [pscustomobject]@{ LocalAddress = '192.168.0.5'; OwningProcess = 3808 })
        }
        if ($script:Case.Listener -eq 'conflict') {
            return @($loopback, [pscustomobject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 9000 })
        }
        return @($loopback)
    }
    function Test-MobileLanHttp {
        param([string]$Url, [int]$ExpectedStatus, [string]$ExpectedLocation = '')
        if ($Url -like '*192.168.0.5*') { return $script:Case.LanHttp }
        return $true
    }
    function Refresh-ExactPortproxy {
        $script:Case.Repairs++
        $script:Case.Listener = 'healthy'
    }

    Assert-True ((Invoke-MobileLanRepair) -eq 'MOBILE_LAN_HEALTHY') 'healthy helper result'
    Assert-True ($script:Case.Repairs -eq 0) 'healthy should not refresh'
    Pass 'healthy: zero network mutations'

    $script:Case.Listener = 'missing'
    Assert-True ((Invoke-MobileLanRepair) -eq 'MOBILE_LAN_RESTORED') 'missing listener result'
    Assert-True ($script:Case.Repairs -eq 1) 'missing listener refresh exactly once'
    Pass 'missing listener: one targeted refresh'

    $script:Case.Listener = 'missing'
    $script:Case.ProxyExact = $false
    $failed = $false
    try { [void](Invoke-MobileLanRepair) } catch { $failed = ($_.Exception.Message -eq 'PORTPROXY_EXACT_ROW_MISMATCH') }
    Assert-True $failed 'proxy mismatch refusal'
    Assert-True ($script:Case.Repairs -eq 1) 'proxy mismatch no mutation'
    Pass 'exact proxy mismatch: refused'

    $script:Case.ProxyExact = $true
    $script:Case.Listener = 'conflict'
    $failed = $false
    try { [void](Invoke-MobileLanRepair) } catch { $failed = ($_.Exception.Message -eq 'WILDCARD_LISTENER_CONFLICT') }
    Assert-True $failed 'wildcard conflict refusal'
    Assert-True ($script:Case.Repairs -eq 1) 'wildcard conflict no mutation'
    Pass 'conflicting listener: refused'
}
Test-PrivilegedHelper

function Test-LauncherIntegration {
    $temporaryRoot = Join-Path $root 'mobile-lan-test-only'
    Assert-True (-not (Test-Path -LiteralPath $temporaryRoot)) 'test temporary root must not preexist'
    $previousRoot = $env:DSH_LAUNCHER_ROOT
    $previousProxy = $env:HTTPS_PROXY
    try {
        $env:DSH_LAUNCHER_ROOT = $temporaryRoot
        $env:HTTPS_PROXY = 'http://127.0.0.1:9'
        . (Join-Path $root 'DSH-Common.ps1')
        function Assert-DshWorkspaceReady { }
        function Resolve-ControllerRuntime { [pscustomobject]@{ NodePath = 'Mock-DshControllerRuntime' } }
        function Mock-DshControllerRuntime { $global:LASTEXITCODE = 0; 'MOCK_DSH_SUCCESS' }
        function Test-MobileLanHttp { return $true }
        function Get-NetIPAddress { [pscustomobject]@{ InterfaceIndex = 14; InterfaceAlias = 'Wi-Fi' } }
        function Get-NetAdapter { [pscustomobject]@{ InterfaceIndex = 14; Status = 'Up'; InterfaceDescription = 'Wireless USB Adapter'; MediaType = 'Native 802.11' } }
        $script:MockLanHealthy = $false
        $script:MockTaskPresent = $false
        $script:MockTaskRunResult = 0
        $script:MockTaskRunCount = 0
        $script:MockTaskReadCount = 0
        function Get-MobileLanListeners {
            $loopback = [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 9548 }
            if ($script:MockLanHealthy) {
                return @($loopback, [pscustomobject]@{ LocalAddress = '192.168.0.5'; OwningProcess = 3808 })
            }
            return @($loopback)
        }
        function Get-CimInstance { [pscustomobject]@{ State = 'Running'; ProcessId = 3808 } }
        function Get-ScheduledTask {
            $script:MockTaskReadCount++
            if ($script:MockTaskPresent) { return [pscustomobject]@{ State = 'Ready' } }
            return $null
        }
        function Get-ScheduledTaskInfo {
            [pscustomobject]@{ LastRunTime = [datetime]::MinValue; LastTaskResult = 0 }
        }
        function Invoke-MobileLanScheduledTask {
            $script:MockTaskRunCount++
            if ($script:MockTaskRunResult -eq 0) { $script:MockLanHealthy = $true }
            return $script:MockTaskRunResult
        }
        $outputStart = @(Invoke-DshController -Action 'start' -WarningAction SilentlyContinue)
        $outputRestart = @(Invoke-DshController -Action 'restart' -WarningAction SilentlyContinue)
        Assert-True ($outputStart.Count -eq 1 -and $outputStart[0] -eq 'MOCK_DSH_SUCCESS') 'start Web success'
        Assert-True ($outputRestart.Count -eq 1 -and $outputRestart[0] -eq 'MOCK_DSH_SUCCESS') 'restart Web success'
        $log = Get-Content -LiteralPath (Join-Path $temporaryRoot 'logs/dsh-controller.log') -Raw
        Assert-True (([regex]::Matches($log, 'MOBILE_LAN_NOT_READY: ADMIN_TASK_NOT_INSTALLED')).Count -eq 2) 'both invoke paths warn'
        Pass 'mock Start/Restart: Web healthy while task missing -> NOT_READY'

        # The exact on-demand task is mocked. Never run the real schtasks.exe.
        $script:MockTaskPresent = $true
        $script:MockLanHealthy = $false
        $outputStart = @(Invoke-DshController -Action 'start' -WarningAction SilentlyContinue)
        Assert-True ($outputStart.Count -eq 1 -and $outputStart[0] -eq 'MOCK_DSH_SUCCESS') 'installed task start Web success'
        Assert-True ($script:MockTaskRunCount -eq 1 -and $script:MockLanHealthy) 'start must request one successful task'
        $script:MockLanHealthy = $false
        $outputRestart = @(Invoke-DshController -Action 'restart' -WarningAction SilentlyContinue)
        Assert-True ($outputRestart.Count -eq 1 -and $outputRestart[0] -eq 'MOCK_DSH_SUCCESS') 'installed task restart Web success'
        Assert-True ($script:MockTaskRunCount -eq 2 -and $script:MockLanHealthy) 'restart must request one successful task'
        $log = Get-Content -LiteralPath (Join-Path $temporaryRoot 'logs/dsh-controller.log') -Raw
        Assert-True (-not $log.Contains('ADMIN_TASK_COMPLETED_WITHOUT_HEALTHY_LAN')) 'successful task must not report mobile NOT_READY'
        Pass 'mock Start and Restart: on-demand installed task invoked exactly once each'

        $runCount = $script:MockTaskRunCount
        $readCount = $script:MockTaskReadCount
        [void](Invoke-DshController -Action 'start' -WarningAction SilentlyContinue)
        Assert-True ($script:MockTaskRunCount -eq $runCount -and $script:MockTaskReadCount -eq $readCount) 'healthy path skips task entirely'
        Pass 'mock healthy LAN: no task invocation'

        $script:MockLanHealthy = $false
        $script:MockTaskRunResult = 5 # denied or unavailable on-demand execution
        $outputDenied = @(Invoke-DshController -Action 'restart' -WarningAction SilentlyContinue)
        Assert-True ($outputDenied.Count -eq 1 -and $outputDenied[0] -eq 'MOCK_DSH_SUCCESS') 'task denial must not break desktop'
        Assert-True ($script:MockTaskRunCount -eq ($runCount + 1)) 'task denied exactly once'
        $log = Get-Content -LiteralPath (Join-Path $temporaryRoot 'logs/dsh-controller.log') -Raw
        Assert-True ($log.Contains('MOBILE_LAN_NOT_READY: ADMIN_TASK_RUN_DENIED')) 'denied task must emit NOT_READY'
        Pass 'mock task privilege denial: desktop continues, mobile NOT_READY'
    } finally {
        $env:DSH_LAUNCHER_ROOT = $previousRoot
        $env:HTTPS_PROXY = $previousProxy
        if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
    }
}
Test-LauncherIntegration

function Test-InstallerGuards {
    # Evaluate only selected function definitions, not the installer's top-level
    # Install-MobileLanTask call. This must never register a Windows task.
    $source = Join-Path $root 'Install-MobileLanTask.ps1'
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
    $definitions = @{}
    foreach ($node in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
        $definitions[$node.Name] = $node.Extent.Text
    }

    Invoke-Expression $definitions['Assert-Administrator']
    function Test-AdministratorToken { return $false }
    $rejected = $false
    try { Assert-Administrator } catch { $rejected = ($_.Exception.Message -like 'ADMIN_REQUIRED:*') }
    Assert-True $rejected 'non-admin installer must stop without elevation'
    Pass 'non-admin token: explicit ADMIN_REQUIRED, no installation'

    Invoke-Expression $definitions['Test-SystemPrincipal']
    $SidSystem = 'S-1-5-18'
    $localizedSystemName = ([Security.Principal.SecurityIdentifier]::new($SidSystem)).Translate([Security.Principal.NTAccount]).Value
    Assert-True (Test-SystemPrincipal $localizedSystemName) 'localized SYSTEM identity must resolve to SID'
    Assert-True (-not (Test-SystemPrincipal 'S-1-5-32-545')) 'Users identity is not SYSTEM'
    Pass 'localized SYSTEM account: exact SID verified'

    Invoke-Expression $definitions['Assert-OwnTask']
    $TaskName = 'DSH-MobileLan-Restore'
    $fakeForeignTask = [pscustomobject]@{
        Definition = [pscustomobject]@{
            Actions = [pscustomobject]@{ Count = 0 }
        }
    }
    $rejected = $false
    try { Assert-OwnTask $fakeForeignTask } catch {
        $rejected = ($_.Exception.Message -like 'TASK_NAME_CONFLICT:*')
    }
    Assert-True $rejected 'foreign task with unexpected action must be rejected'
    Pass 'existing foreign task: no update/overwrite'

    Invoke-Expression $definitions['Get-ExpectedHelperBytes']
    $HelperSource = Join-Path $root 'Restore-MobileLan.ps1'
    $ExpectedHelperSha256 = (Get-FileHash -LiteralPath $HelperSource -Algorithm SHA256).Hash
    $actualBytes = [byte[]](Get-ExpectedHelperBytes)
    Assert-True ($actualBytes.Length -gt 0) 'reviewed helper bytes'
    $ExpectedHelperSha256 = '0000000000000000000000000000000000000000000000000000000000000000'
    $rejected = $false
    try { [void](Get-ExpectedHelperBytes) } catch {
        $rejected = ($_.Exception.Message -like 'HELPER_SOURCE_HASH_MISMATCH:*')
    }
    Assert-True $rejected 'modified source helper must never be installed'
    Pass 'helper source hash mismatch: fail closed'

    Invoke-Expression $definitions['New-AdminOnlySecurity']
    $SidAdministrators = 'S-1-5-32-544'
    $SidSystem = 'S-1-5-18'
    $acl = New-AdminOnlySecurity $true
    $entries = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
    Assert-True ($acl.AreAccessRulesProtected -and $entries.Count -eq 2) 'protected directory ACL'
    Assert-True ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $SidAdministrators) 'directory owner'
    Assert-True (@($entries | Where-Object { $_.IdentityReference.Value -notin @($SidSystem, $SidAdministrators) }).Count -eq 0) 'only admin/SYSTEM rights'
    Pass 'protected helper directory ACL: only SYSTEM/Administrators'
}
Test-InstallerGuards

$installer = Get-Content -LiteralPath (Join-Path $root 'Install-MobileLanTask.ps1') -Raw
$helper = Get-Content -LiteralPath (Join-Path $root 'Restore-MobileLan.ps1') -Raw
$common = Get-Content -LiteralPath (Join-Path $root 'DSH-Common.ps1') -Raw
Assert-True ($installer.Contains('O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;BU)')) 'fixed exact task DACL'
Assert-True ($installer.Contains('RegisterTaskDefinition($TaskName, $definition, 2,')) 'task create-only'
Assert-True ($installer.Contains('Get-ExpectedHelperBytes')) 'source hash validation'
Assert-True ($installer.Contains('CreateDirectory($TargetDirectory, $directoryAcl)')) 'atomic secured directory'
Assert-True ($installer.Contains('Assert-OwnTask $existing')) 'task conflict detection'
Assert-True ($installer.Contains('C:\ProgramData\DSH-MobileLan\Restore-MobileLan.ps1')) 'protected helper path'
Assert-True ($installer.Contains('::FullControl')) 'SYSTEM/admin file ACL'
Assert-True ($helper.Contains('listenaddress=192.168.0.5 listenport=4173 connectaddress=127.0.0.1 connectport=4173')) 'exact netsh target'
Assert-True (-not $helper.Contains('Set-NetFirewallRule')) 'no firewall change'
Assert-True ($common.Contains('Invoke-MobileLanStartup')) 'launcher post-success path'
$expectedHash = (Get-FileHash -LiteralPath (Join-Path $root 'Restore-MobileLan.ps1') -Algorithm SHA256).Hash
Assert-True ($installer.Contains($expectedHash)) 'helper source pinned hash'
Pass 'fixed protected task action, ACL and netsh static guard'

$start = Get-Content -LiteralPath (Join-Path $root 'Start-DSH.ps1') -Raw
$restart = Get-Content -LiteralPath (Join-Path $root 'Restart-DSH.ps1') -Raw
$webRestart = Get-Content -LiteralPath (Join-Path $root 'Web-Restart.vbs') -Raw
Assert-True ($start.Contains("Invoke-DshController -Action 'start'")) 'start wrapper'
Assert-True ($restart.Contains("Invoke-DshController -Action 'restart'")) 'restart wrapper'
Assert-True ($webRestart.Contains('Restart-DSH.ps1')) 'web restart wrapper'
Pass 'all 3 existing Start/Restart/Web-Restart wrappers'

Write-Output "TOTAL_PASS=$passed"
