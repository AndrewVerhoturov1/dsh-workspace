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

function Get-DesktopGeometryThresholds {
    param(
        [int]$WorkAreaWidth,
        [int]$WorkAreaHeight
    )

    if ($WorkAreaWidth -le 0 -or $WorkAreaHeight -le 0) {
        return [pscustomobject]@{ SafeMinWidth=0; SafeMinHeight=0 }
    }
    # The threshold scales with the usable desktop. The absolute floors only
    # prevent an obviously mini layout on ordinary Windows desktops; no
    # monitor resolution is treated as an invariant.
    $safeMinWidth = [int][Math]::Min($WorkAreaWidth, [Math]::Max(720, [Math]::Ceiling($WorkAreaWidth * 0.55)))
    $safeMinHeight = [int][Math]::Min($WorkAreaHeight, [Math]::Max(480, [Math]::Ceiling($WorkAreaHeight * 0.55)))
    return [pscustomobject]@{ SafeMinWidth=$safeMinWidth; SafeMinHeight=$safeMinHeight }
}

function Test-DesktopHostGeometryPredicates {
    param(
        [bool]$IsMinimized,
        [int]$WindowWidth,
        [int]$WindowHeight,
        [int]$WorkAreaWidth,
        [int]$WorkAreaHeight,
        [bool]$WindowVisibleOnWorkArea
    )

    $thresholds = Get-DesktopGeometryThresholds $WorkAreaWidth $WorkAreaHeight
    return (!$IsMinimized -and $WindowVisibleOnWorkArea -and
        $WindowWidth -ge $thresholds.SafeMinWidth -and
        $WindowHeight -ge $thresholds.SafeMinHeight)
}

function Get-DesktopGeometryNormalizationTarget {
    param(
        [int]$WorkAreaWidth,
        [int]$WorkAreaHeight
    )

    $thresholds = Get-DesktopGeometryThresholds $WorkAreaWidth $WorkAreaHeight
    if ($thresholds.SafeMinWidth -le 0 -or $thresholds.SafeMinHeight -le 0) { return $null }
    return [pscustomobject]@{
        Width=[int][Math]::Min($WorkAreaWidth, [Math]::Max($thresholds.SafeMinWidth, [Math]::Ceiling($WorkAreaWidth * 0.80)))
        Height=[int][Math]::Min($WorkAreaHeight, [Math]::Max($thresholds.SafeMinHeight, [Math]::Ceiling($WorkAreaHeight * 0.80)))
    }
}

function Test-DesktopGeometryStable {
    param($Before, $After)

    if (!$Before -or !$After) { return $false }
    return ([string]$Before.HostHwnd -eq [string]$After.HostHwnd -and
        [string]$Before.State -eq [string]$After.State -and
        [int]$Before.WindowWidth -eq [int]$After.WindowWidth -and
        [int]$Before.WindowHeight -eq [int]$After.WindowHeight -and
        [int]$Before.WorkAreaWidth -eq [int]$After.WorkAreaWidth -and
        [int]$Before.WorkAreaHeight -eq [int]$After.WorkAreaHeight)
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
