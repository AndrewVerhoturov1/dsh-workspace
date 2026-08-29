[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'chatgpt_desktop_surface_contract.ps1')

$passed = 0
$failed = 0
function Assert-Case([string]$Name, [bool]$Condition) {
    if ($Condition) { $script:passed++; return }
    $script:failed++
    Write-Error "FAIL $Name"
}

$hostPath = 'C:\Program Files\WindowsApps\OpenAI.CodexBeta_26.727.4816.0_x64__2p2nqsd0c76g0\app\ChatGPT (Beta).exe'
Assert-Case 'should find unified host by observed process and package identity' (Test-UnifiedDesktopHostIdentity 'ChatGPT (Beta)' $hostPath 'Chrome_WidgetWin_1')
Assert-Case 'should reject unrelated process despite matching window class' (!(Test-UnifiedDesktopHostIdentity 'chrome' 'C:\Program Files\Google\Chrome\chrome.exe' 'Chrome_WidgetWin_1'))
Assert-Case 'should classify Codex surface as non-chat' ((Get-DesktopSurfaceKind ([pscustomobject]@{ OrdinaryChatConfirmed=$false; CodexRootPresent=$true })) -ceq 'CODEX')
Assert-Case 'should not classify Codex surface as ordinary Chat' (!(Test-OrdinaryChatSurfacePredicates $false $false $false $false $false))
Assert-Case 'should require all independent ordinary Chat predicates' (Test-OrdinaryChatSurfacePredicates $true $true $true $true $true)
Assert-Case 'should reject navigation without independent Chat proof' ((Get-DesktopSurfaceRoutingDecision $true 'CODEX' $true $false) -ceq 'ORDINARY_CHAT_SURFACE_NOT_CONFIRMED')
Assert-Case 'should accept Codex to Chat only after navigation and proof' ((Get-DesktopSurfaceRoutingDecision $true 'CODEX' $true $true) -ceq 'ORDINARY_CHAT_READY')
Assert-Case 'should avoid navigation when ordinary Chat is already proven' ((Get-DesktopSurfaceRoutingDecision $true 'ORDINARY_CHAT' $false $true) -ceq 'ORDINARY_CHAT_READY')
Assert-Case 'should report missing host separately' ((Get-DesktopSurfaceRoutingDecision $false 'UNKNOWN' $false $false) -ceq 'DESKTOP_HOST_NOT_FOUND')
Assert-Case 'should report host with wrong surface instead of process absence' ((Get-DesktopSurfaceRoutingDecision $true 'UNKNOWN' $false $false) -ceq 'DESKTOP_HOST_FOUND_WRONG_SURFACE')
Assert-Case 'should keep unknown surface fail-closed' ((Get-DesktopSurfaceKind ([pscustomobject]@{ OrdinaryChatConfirmed=$false; CodexRootPresent=$false })) -ceq 'UNKNOWN')
Assert-Case 'should recognize ordinary Chat as a distinct surface' ((Get-DesktopSurfaceKind ([pscustomobject]@{ OrdinaryChatConfirmed=$true; CodexRootPresent=$false })) -ceq 'ORDINARY_CHAT')
Assert-Case 'should not touch composer before ordinary Chat proof' (!(Test-ComposerTouchAllowed $false))
Assert-Case 'should allow composer only after ordinary Chat proof' (Test-ComposerTouchAllowed $true)
Assert-Case 'should complete the synthetic Codex to Chat Fresh SubmitOnly flow' (Test-DesktopSubmitOnlyFlowContract $true 'CODEX' $true $true $true $true $true $true $false $false)
Assert-Case 'should accept a normal host geometry without a fixed monitor size' (Test-DesktopHostGeometryPredicates $false 863 582 1440 860 $true)
Assert-Case 'should reject an obviously narrow host geometry before navigation' (!(Test-DesktopHostGeometryPredicates $false 500 300 1440 860 $true))
Assert-Case 'should reject a minimized host even when its rectangle is large' (!(Test-DesktopHostGeometryPredicates $true 1440 860 1440 860 $true))
Assert-Case 'should require two stable geometry readbacks' (Test-DesktopGeometryStable ([pscustomobject]@{HostHwnd='0x1';State='normal';WindowWidth=1000;WindowHeight=700;WorkAreaWidth=1440;WorkAreaHeight=860}) ([pscustomobject]@{HostHwnd='0x1';State='normal';WindowWidth=1000;WindowHeight=700;WorkAreaWidth=1440;WorkAreaHeight=860}))
Assert-Case 'should reject changed geometry readbacks' (!(Test-DesktopGeometryStable ([pscustomobject]@{HostHwnd='0x1';State='normal';WindowWidth=1000;WindowHeight=700;WorkAreaWidth=1440;WorkAreaHeight=860}) ([pscustomobject]@{HostHwnd='0x1';State='normal';WindowWidth=500;WindowHeight=300;WorkAreaWidth=1440;WorkAreaHeight=860})))
$normalizationTarget = Get-DesktopGeometryNormalizationTarget 1440 860
Assert-Case 'should normalize narrow geometry to a working target' (Test-DesktopHostGeometryPredicates $false $normalizationTarget.Width $normalizationTarget.Height 1440 860 $true)

Write-Output "DESKTOP_SURFACE_CONTRACT_TESTS_PASS passed=$passed failed=$failed"
if ($failed) { exit 1 }
