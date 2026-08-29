function Test-UnifiedDesktopHostIdentity {
    param(
        [string]$ProcessName,
        [string]$ExecutablePath,
        [string]$WindowClassName = ''
    )

    $nameMatch = ([string]$ProcessName -match '^ChatGPT( \(Beta\))?$')
    $pathMatch = ([string]$ExecutablePath -match '(?i)\\ChatGPT \(Beta\)\.exe$') -or
        ([string]$ExecutablePath -match '(?i)\\OpenAI\.CodexBeta_[^\\]+\\app\\ChatGPT \(Beta\)\.exe$')
    $classMatch = [string]::IsNullOrWhiteSpace($WindowClassName) -or ($WindowClassName -ceq 'Chrome_WidgetWin_1')
    return (($nameMatch -or $pathMatch) -and $classMatch)
}

function Test-OrdinaryChatSurfacePredicates {
    param(
        [bool]$ChatRootPresent,
        [bool]$ComposerStructureValid,
        [bool]$CodexRootAbsent,
        [bool]$NavigationStateConfirmed,
        [bool]$NewChatControlPresent
    )

    return ($ChatRootPresent -and $ComposerStructureValid -and $CodexRootAbsent -and
        $NavigationStateConfirmed -and $NewChatControlPresent)
}

function Get-DesktopSurfaceKind {
    param($Evidence)

    if (!$Evidence) { return 'UNKNOWN' }
    if ([bool]$Evidence.OrdinaryChatConfirmed) { return 'ORDINARY_CHAT' }
    if ([bool]$Evidence.CodexRootPresent) { return 'CODEX' }
    return 'UNKNOWN'
}

function Get-DesktopSurfaceRoutingDecision {
    param(
        [bool]$HostFound,
        [string]$CurrentSurface,
        [bool]$NavigationAttempted,
        [bool]$OrdinaryChatConfirmed
    )

    if (!$HostFound) { return 'DESKTOP_HOST_NOT_FOUND' }
    if ($CurrentSurface -ceq 'ORDINARY_CHAT' -and $OrdinaryChatConfirmed) { return 'ORDINARY_CHAT_READY' }
    if ($CurrentSurface -ceq 'CODEX' -and $NavigationAttempted -and $OrdinaryChatConfirmed) { return 'ORDINARY_CHAT_READY' }
    if ($NavigationAttempted -and !$OrdinaryChatConfirmed) { return 'ORDINARY_CHAT_SURFACE_NOT_CONFIRMED' }
    return 'DESKTOP_HOST_FOUND_WRONG_SURFACE'
}

function Test-ComposerTouchAllowed {
    param([bool]$OrdinaryChatConfirmed)
    return $OrdinaryChatConfirmed
}

function Test-DesktopSubmitOnlyFlowContract {
    param(
        [bool]$HostFound,
        [string]$InitialSurface,
        [bool]$NavigationAttempted,
        [bool]$OrdinaryChatConfirmed,
        [bool]$FreshConfirmed,
        [bool]$ComposerReady,
        [bool]$SendAttempted,
        [bool]$UserMessageConfirmed,
        [bool]$AssistantWaited,
        [bool]$CopyPerformed
    )

    $surfaceReady = (Get-DesktopSurfaceRoutingDecision $HostFound $InitialSurface $NavigationAttempted $OrdinaryChatConfirmed) -ceq 'ORDINARY_CHAT_READY'
    return ($surfaceReady -and (Test-ComposerTouchAllowed $OrdinaryChatConfirmed) -and $FreshConfirmed -and
        $ComposerReady -and $SendAttempted -and $UserMessageConfirmed -and !$AssistantWaited -and !$CopyPerformed)
}
