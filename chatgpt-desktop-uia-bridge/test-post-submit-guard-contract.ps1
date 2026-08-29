$ErrorActionPreference = 'Stop'
$contract = Join-Path $PSScriptRoot 'chatgpt_post_submit_guard_contract.ps1'
. $contract

$passed = 0
$failed = 0
function Assert-True([bool]$Condition, [string]$Name) {
    if ($Condition) { $script:passed++ } else { $script:failed++; Write-Output "FAIL $Name" }
}

Assert-True ((Normalize-PostSubmitSemanticName (" Продолжить`nчат здесь " + [char]0xE001)) -ceq 'Продолжить чат здесь') 'normalizes presentation whitespace and glyph'
Assert-True ((Test-PostSubmitExactSemanticName 'Продолжить чат здесь  ' @('Продолжить чат здесь')) -eq $true) 'matches exact normalized continue-here name'
Assert-True ((Test-PostSubmitExactSemanticName 'Продолжить в режиме Work' @('Продолжить чат здесь')) -eq $false) 'does not confuse Work action with continue-here'
Assert-True ((Test-PostSubmitExactSemanticName 'Продолжить чат здесь дополнительно' @('Продолжить чат здесь')) -eq $false) 'does not accept a fuzzy suffix'
Assert-True ((Test-WorkModePromptContract 'Продолжить в режиме Work?' 'Продолжить чат здесь' 'Продолжить в режиме Work') -eq $true) 'confirms complete Russian modal contract'
Assert-True ((Test-WorkModePromptContract 'Продолжить в режиме Work?' 'Продолжить чат здесь' $null) -eq $false) 'requires both buttons'
Assert-True ((Get-PostSubmitModalClassification $true $true) -ceq 'WORK_MODE_PROMPT') 'known modal wins over unknown classification'
Assert-True ((Get-PostSubmitModalClassification $false $true) -ceq 'UNKNOWN_POST_SUBMIT_MODAL') 'unknown modal is fail-closed'
Assert-True ((Get-PostSubmitModalClassification $false $false) -ceq 'NONE') 'absence of modal is neutral'

if ($failed -ne 0) { throw "POST_SUBMIT_GUARD_CONTRACT_TESTS_FAIL passed=$passed failed=$failed" }
Write-Output "POST_SUBMIT_GUARD_CONTRACT_TESTS_PASS passed=$passed failed=$failed"
