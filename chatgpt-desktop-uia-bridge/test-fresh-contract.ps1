[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'chatgpt_fresh_contract.ps1')

$passed = 0
$failed = 0
function Assert-Case([string]$Name, [bool]$Condition) {
    if ($Condition) { $script:passed++; return }
    $script:failed++
    Write-Error "FAIL $Name"
}

function Snapshot([string]$Mode, [int]$Messages, [string[]]$Anchors, [bool]$Marker = $false, [bool]$Thread = $true) {
    return [pscustomobject]@{
        SurfaceMode=$Mode; MessageCount=$Messages; AnchorNames=$Anchors
        EmptySurfaceMarker=$Marker; IsThreadContainer=$Thread; RuntimeId='conversation-1'
    }
}

$old = Snapshot 'ChatGPT' 1 @('Вы сказали:')
$fresh = Snapshot 'ChatGPT' 0 @() $true

$decision = Test-FreshProofPredicates $old $fresh $true 3
Assert-Case 'Fresh ordinary Chat PASS' $decision.Confirmed
Assert-Case 'Fresh reason is confirmed' ($decision.Reason -ceq 'CONFIRMED_NEW_CONVERSATION')

$decision = Test-FreshProofPredicates $old (Snapshot 'ChatGPT' 1 @('Вы сказали:')) $true 3
Assert-Case 'Old messages remain reject' (!$decision.Confirmed -and ($decision.Reason -ceq 'FRESH_MESSAGE_COUNT_NONZERO'))

$decision = Test-FreshProofPredicates $old (Snapshot 'ChatGPT' 0 @('Вы сказали:') $true) $true 3
Assert-Case 'Old anchor remains reject' (!$decision.Confirmed -and ($decision.Reason -ceq 'FRESH_OLD_ANCHOR_PRESENT'))

$decision = Test-FreshProofPredicates $old (Snapshot 'Codex' 0 @() $true) $true 3
Assert-Case 'Wrong surface reject' (!$decision.Confirmed -and ($decision.Reason -ceq 'FRESH_WRONG_CHAT_SURFACE'))

$decision = Test-FreshProofPredicates $old $fresh $true 2
Assert-Case 'Unstable reset reject' (!$decision.Confirmed -and ($decision.Reason -ceq 'FRESH_SURFACE_UNSTABLE'))

$sameSemanticsDifferentRuntime = Snapshot 'ChatGPT' 0 @() $true
$sameSemanticsDifferentRuntime.RuntimeId = 'conversation-2'
Assert-Case 'Runtime ID is diagnostic only' ((Get-FreshSurfaceSignature $fresh) -ceq (Get-FreshSurfaceSignature $sameSemanticsDifferentRuntime))

Assert-Case 'Stale composer after Fresh may be sanitized' (Test-FreshComposerSanitizationAllowed $true)
Assert-Case 'Stale composer before Fresh is never sanitized' (!(Test-FreshComposerSanitizationAllowed $false))

Assert-Case 'Composer clear failure blocks submit' (!(Test-SubmitOnlySuccessContract $true $false $true $false $false $false $true))
Assert-Case 'SubmitOnly requires confirmed user message' (!(Test-SubmitOnlySuccessContract $true $true $true $true $false $false $false))
Assert-Case 'SubmitOnly skips assistant wait and Copy' (Test-SubmitOnlySuccessContract $true $true $true $true $true $false $false)

$scriptText = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot 'chatgpt_chat.ps1')
Assert-Case 'Normal and SubmitOnly use canonical Fresh helper' (($scriptText -match 'Ensure-FreshOrdinaryChat') -and ($scriptText -match 'if \(\$SubmitOnly\)'))

Write-Output "FRESH_CONTRACT_TESTS_PASS passed=$passed failed=$failed"
if ($failed) { exit 1 }
