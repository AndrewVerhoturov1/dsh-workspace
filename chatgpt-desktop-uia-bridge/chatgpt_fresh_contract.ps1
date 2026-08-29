function Get-FreshSurfaceSignature {
    param($Snapshot)

    $anchorNames = @($Snapshot.AnchorNames | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ } | Sort-Object)
    return @(
        [string]$Snapshot.SurfaceMode,
        [bool]$Snapshot.IsThreadContainer,
        [int]$Snapshot.MessageCount,
        ($anchorNames -join '|'),
        [bool]$Snapshot.EmptySurfaceMarker
    ) -join '::'
}

function Test-FreshProofPredicates {
    param(
        $PreviousSnapshot,
        $CurrentSnapshot,
        [bool]$NewChatInvoked,
        [int]$StableSamples,
        [int]$RequiredStableSamples = 3
    )

    $previousCount = [int]$PreviousSnapshot.MessageCount
    $currentCount = [int]$CurrentSnapshot.MessageCount
    $currentAnchors = @($CurrentSnapshot.AnchorNames | Where-Object { ![string]::IsNullOrWhiteSpace([string]$_) })
    $surfaceModeConfirmed = ([string]$CurrentSnapshot.SurfaceMode -ceq 'ChatGPT')
    $messageHistoryEmpty = ($currentCount -eq 0)
    $oldAnchorsAbsent = ($currentAnchors.Count -eq 0)
    $observableReset = ($previousCount -gt 0 -and $messageHistoryEmpty -and $oldAnchorsAbsent)
    $emptyMarkerTransition = (!$PreviousSnapshot.EmptySurfaceMarker -and $CurrentSnapshot.EmptySurfaceMarker)
    $structuralReset = ($observableReset -or $emptyMarkerTransition -or ($NewChatInvoked -and $previousCount -eq 0))
    $surfaceStable = ($StableSamples -ge [Math]::Max(2, $RequiredStableSamples))

    $reason = if (!$surfaceModeConfirmed) { 'FRESH_WRONG_CHAT_SURFACE' }
        elseif (!$messageHistoryEmpty) { 'FRESH_MESSAGE_COUNT_NONZERO' }
        elseif (!$oldAnchorsAbsent) { 'FRESH_OLD_ANCHOR_PRESENT' }
        elseif (!$NewChatInvoked) { 'FRESH_NEW_CHAT_ACTION_NOT_CONFIRMED' }
        elseif (!$structuralReset) { 'FRESH_STRUCTURAL_RESET_NOT_CONFIRMED' }
        elseif (!$surfaceStable) { 'FRESH_SURFACE_UNSTABLE' }
        else { 'CONFIRMED_NEW_CONVERSATION' }

    return [pscustomobject]@{
        Confirmed=($surfaceModeConfirmed -and $messageHistoryEmpty -and $oldAnchorsAbsent -and $NewChatInvoked -and $structuralReset -and $surfaceStable)
        SurfaceModeConfirmed=$surfaceModeConfirmed
        MessageHistoryEmpty=$messageHistoryEmpty
        OldAnchorsAbsent=$oldAnchorsAbsent
        NewChatActionConfirmed=$NewChatInvoked
        StructuralResetConfirmed=$structuralReset
        SurfaceStable=$surfaceStable
        StableSamples=$StableSamples
        RequiredStableSamples=[Math]::Max(2, $RequiredStableSamples)
        Reason=$reason
    }
}

function Test-FreshComposerSanitizationAllowed {
    param([bool]$FreshConfirmed)
    return $FreshConfirmed
}

function Test-SubmitOnlySuccessContract {
    param(
        [bool]$FreshConfirmed,
        [bool]$ComposerReady,
        [bool]$PromptInserted,
        [bool]$SendAttempted,
        [bool]$UserMessageConfirmed,
        [bool]$AssistantWaited,
        [bool]$CopyPerformed
    )

    return ($FreshConfirmed -and $ComposerReady -and $PromptInserted -and $SendAttempted -and
        $UserMessageConfirmed -and !$AssistantWaited -and !$CopyPerformed)
}
