# Pure predicates shared by the post-submit guard and its tests.

function Normalize-PostSubmitSemanticName {
    param([AllowNull()][string]$Name)

    if ($null -eq $Name) { return '' }
    # UIA providers sometimes add line breaks, non-breaking spaces or a
    # private-use keyboard glyph to an accessible name.  Remove only those
    # presentation characters; do not perform fuzzy or prefix matching.
    $normalized = $Name -replace '[\s\p{Z}]+', ' '
    $normalized = $normalized -replace '[\uE000-\uF8FF]', ''
    return $normalized.Trim()
}

function Test-PostSubmitExactSemanticName {
    param(
        [AllowNull()][string]$Actual,
        [Parameter(Mandatory=$true)][string[]]$Expected
    )

    $actualNormalized = Normalize-PostSubmitSemanticName $Actual
    foreach ($candidate in $Expected) {
        if ($actualNormalized -ceq (Normalize-PostSubmitSemanticName $candidate)) { return $true }
    }
    return $false
}

function Test-WorkModePromptContract {
    param(
        [AllowNull()][string]$Heading,
        [AllowNull()][string]$ContinueHere,
        [AllowNull()][string]$ContinueWork
    )

    return (
        (Test-PostSubmitExactSemanticName $Heading @('Продолжить в режиме Work?', 'Continue in Work mode?')) -and
        (Test-PostSubmitExactSemanticName $ContinueHere @('Продолжить чат здесь', 'Continue chat here')) -and
        (Test-PostSubmitExactSemanticName $ContinueWork @('Продолжить в режиме Work', 'Continue in Work mode'))
    )
}

function Get-PostSubmitModalClassification {
    param(
        [bool]$WorkPromptConfirmed,
        [bool]$UnknownModalConfirmed
    )

    if ($WorkPromptConfirmed) { return 'WORK_MODE_PROMPT' }
    if ($UnknownModalConfirmed) { return 'UNKNOWN_POST_SUBMIT_MODAL' }
    return 'NONE'
}
