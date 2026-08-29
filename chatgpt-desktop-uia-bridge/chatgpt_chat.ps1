[CmdletBinding()]
param(
    [ValidateSet('Quick','NewChat')][string]$Mode = 'Quick',
    [ValidateSet('Fresh','Current')][Alias('ConversationPolicy')][string]$ChatPolicy = 'Fresh',
    [Parameter(Position=0)][string]$Prompt,
    [switch]$ReturnJson,
    [int]$TimeoutSeconds = 120,
    [int]$WindowTimeoutSeconds = 20,
    [string]$LogPath,
    [switch]$VerboseLog,
    [switch]$SubmitOnly,
    [string]$RunId,
    [switch]$TestSubmitGateFailure,
    [switch]$TestForceValuePatternFailure,
    [switch]$TestForceClipboardFallbackFailure,
    [switch]$TestForceFreshConfirmationFailure,
    [switch]$TestForceFreshComposerClearFailure,
    [string]$TestSeedFreshComposerDraft
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DshKeyboard {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
    public const uint KeyUp = 0x0002;
}
'@

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DshWindowFocus {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [StructLayout(LayoutKind.Sequential)] public struct Msg { public IntPtr HWnd; public uint Message; public UIntPtr WParam; public IntPtr LParam; public uint Time; public int PtX; public int PtY; }
    [DllImport("user32.dll")] public static extern bool PeekMessage(out Msg message, IntPtr hWnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool restore);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
'@

. (Join-Path $PSScriptRoot 'chatgpt_fresh_contract.ps1')
. (Join-Path $PSScriptRoot 'chatgpt_desktop_surface_contract.ps1')

function Send-ControlShortcut([byte]$Key) {
    [DshKeyboard]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    try {
        [DshKeyboard]::keybd_event($Key, 0, 0, [UIntPtr]::Zero)
        [DshKeyboard]::keybd_event($Key, 0, [DshKeyboard]::KeyUp, [UIntPtr]::Zero)
    } finally {
        [DshKeyboard]::keybd_event(0x11, 0, [DshKeyboard]::KeyUp, [UIntPtr]::Zero)
    }
}

if ([string]::IsNullOrWhiteSpace($Prompt)) { $Prompt = [Console]::In.ReadToEnd() }
if ([string]::IsNullOrWhiteSpace($RunId)) { $RunId = [guid]::NewGuid().ToString('N').Substring(0, 8).ToUpperInvariant() }

$started = Get-Date
$modeOut = $Mode.ToLowerInvariant().Replace('newchat', 'new-chat')
$chatPolicyOut = $ChatPolicy.ToLowerInvariant()
$mutex = $null
$ws = $null
$w = $null
$baselineMessageCount = $null
$conversationRuntimeId = $null
$freshChatConfirmed = $false
$freshIdentityChanged = $false
$freshReason = $null
$freshMessageCount = $null
$freshConversationTitle = $null
$freshDiagnostic = $null
$surfaceModeBefore = $null
$surfaceModeAfter = $null
$chatModeConfirmed = $false
$hostFound = $false
$hostPid = $null
$hostHwnd = $null
$hostProcessName = $null
$hostExecutablePath = $null
$hostWindowTitle = $null
$initialSurface = 'UNKNOWN'
$navigationAttempted = $false
$navigationMethod = $null
$ordinaryChatConfirmed = $false
$composerReady = $false
$userMessageConfirmed = $false
$submitted = $false
$ordinaryChatOpenedByNavigation = $false
$freshAction = $null
$freshTransitionObserved = $false
$freshActionRuntimeId = $null
$inputMethod = $null
$inputFallbackFrom = $null
$inputAttemptCount = 0
$clipboardRestored = $false
$freshComposerInitiallyEmpty = $null
$freshComposerSanitized = $false
$freshComposerClearMethod = $null
$freshComposerClearAttempts = 0
$sendAttempted = $false
$script:HeavyDiagnosticsPerformed = $false

$script:AuthorAnchorPattern = '^(ChatGPT сказал|ChatGPT said|Assistant|Вы сказали|You said|User)\s*:'
$script:ChromeNoise = '^(ChatGPT сказал|ChatGPT said|Вы сказали|You said|Копировать|Copy|Хороший ответ|Good response|Неудачный ответ|Bad response|Продолжить в новом чате|Continue in new chat|Скопировать сообщение|Редактировать сообщение|Остановить|Stop|Прервать)$'

function Write-Log([string]$Step, [string]$Message) {
    $line = '[{0}] RunId={1} {2} {3}' -f (Get-Date -Format o), $RunId, $Step, $Message
    if ($LogPath) {
        try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
    } elseif ($VerboseLog) {
        [Console]::Error.WriteLine($line)
    }
}

function Fail([string]$Code, [string]$Message, [int]$ExitCode) {
    throw [Exception]::new("$Code|$Message|$ExitCode")
}

function Get-RuntimeId($Element) {
    if (!$Element) { return $null }
    try {
        $parts = @($Element.GetRuntimeId())
        if ($parts.Count -gt 0) { return ($parts -join '.') }
    } catch { }
    return $null
}

function Is-UiaElementAlive($Element) {
    if (!$Element) { return $false }
    try { $null = $Element.Current; return $true }
    catch [System.Windows.Automation.ElementNotAvailableException] { return $false }
    catch { return $false }
}

function All-Desc($Element) {
    if (!$Element) { return @() }
    try {
        return @($Element.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition))
    } catch { return @() }
}

function Get-ElementAncestors($Element, [int]$Max = 16) {
    $result = New-Object 'System.Collections.Generic.List[object]'
    if (!$Element) { return @() }
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $current = $Element
    for ($i = 0; $i -lt $Max -and $current; $i++) {
        try {
            [void]$result.Add($current)
            $current = $walker.GetParent($current)
        } catch { break }
    }
    return @($result.ToArray())
}

function Get-ImmediateParent($Element) {
    if (!$Element) { return $null }
    try { return ([System.Windows.Automation.TreeWalker]::RawViewWalker).GetParent($Element) }
    catch { return $null }
}

function Get-ImmediateParentRuntimeId($Element) {
    return Get-RuntimeId (Get-ImmediateParent $Element)
}

function Same-Surface($A, $B) {
    if (!$A -or !$B) { return $false }
    $aIds = @(Get-ElementAncestors $A | ForEach-Object { Get-RuntimeId $_ })
    $bIds = @(Get-ElementAncestors $B | ForEach-Object { Get-RuntimeId $_ })
    foreach ($id in $aIds) {
        if ($id -and ($bIds -contains $id)) { return $true }
    }
    return $false
}

function Get-DesktopHost {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    try { $elements = @($root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) }
    catch { return $null }
    $candidates = New-Object 'System.Collections.Generic.List[object]'
    foreach ($element in $elements) {
        try {
            $current = $element.Current
            $process = Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue
            $path = $null
            if ($process) { try { $path = $process.Path } catch { } }
            if (!$process -or !(Test-UnifiedDesktopHostIdentity ([string]$process.ProcessName) ([string]$path) ([string]$current.ClassName))) { continue }
            $score = 0
            if ([string]$current.ControlType.ProgrammaticName -ceq 'ControlType.Window') { $score += 30 }
            if ([string]$current.ClassName -ceq 'Chrome_WidgetWin_1') { $score += 10 }
            if ([string]$current.Name -match '^ChatGPT( \(Beta\))?$') { $score += 5 }
            if (!$current.IsOffscreen) { $score += 4 }
            if ($current.NativeWindowHandle -gt 0) { $score += 2 }
            [void]$candidates.Add([pscustomobject]@{
                Element=$element; Pid=[int]$current.ProcessId; Hwnd=[int64]$current.NativeWindowHandle
                ProcessName=[string]$process.ProcessName; ExecutablePath=[string]$path; WindowTitle=[string]$current.Name
                ClassName=[string]$current.ClassName; AutomationId=[string]$current.AutomationId; Score=$score
            })
        } catch { }
    }
    $selected = @($candidates | Sort-Object Score -Descending | Select-Object -First 1)
    if (!$selected) { return $null }
    $script:DesktopHostInfo = $selected[0]
    return $selected[0]
}

function Get-OrdinaryChatSurfaceEvidence($Window) {
    if (!$Window) { return [pscustomobject]@{ OrdinaryChatConfirmed=$false; ChatRootPresent=$false; ComposerStructureValid=$false; CodexRootPresent=$false; NavigationStateConfirmed=$false; NewChatControlPresent=$false } }
    $mode = Get-ChatSurfaceMode $Window
    $currentName = ''
    try { $currentName = [string]$Window.Current.Name } catch { }
    # The full Chromium document may retain the generic name "Codex" even
    # after the explicit mode control says ChatGPT. In that state the document
    # name is irrelevant; the mode control remains authoritative.
    $codexRoot = ($mode -cne 'ChatGPT' -and $currentName -ceq 'Codex')
    if (!$codexRoot -and $mode -cne 'ChatGPT') {
        foreach ($child in @(All-Desc $Window)) {
            try {
                $childCurrent = $child.Current
                if (([string]$childCurrent.Name -ceq 'Codex') -and !$childCurrent.IsOffscreen) { $codexRoot = $true; break }
            } catch { }
        }
    }
    $composer = Find-Composer $Window
    $newChat = Find-NewChatButton $Window
    $chatRoot = ($mode -ceq 'ChatGPT')
    $confirmed = Test-OrdinaryChatSurfacePredicates $chatRoot ([bool]$composer) (!$codexRoot) $chatRoot ([bool]$newChat)
    return [pscustomobject]@{
        OrdinaryChatConfirmed=[bool]$confirmed; ChatRootPresent=[bool]$chatRoot; ComposerStructureValid=[bool]$composer
        CodexRootPresent=[bool]$codexRoot; NavigationStateConfirmed=[bool]$chatRoot; NewChatControlPresent=[bool]$newChat
        Mode=$mode; Composer=$composer; NewChat=$newChat
    }
}

function Invoke-DesktopModeTarget($HostWindow, [ValidateSet('ChatGPT','Codex')][string]$TargetMode) {
    $result = [ordered]@{ Succeeded=$false; Method='UIA.ExpandCollapsePattern+MenuItem.InvokePattern'; Message=$null }
    if (!$HostWindow) { $result.Message = 'Unified Desktop host window is missing'; return [pscustomobject]$result }
    $selector = $null
    $selectorDeadline = (Get-Date).AddMilliseconds(8000)
    do {
        foreach ($element in @(All-Desc $HostWindow)) {
            try {
                $current = $element.Current
                if (($current.ControlType -eq [System.Windows.Automation.ControlType]::Button) -and
                    !$current.IsOffscreen -and ([string]$current.Name -match '^(Переключить режим, текущий режим|Switch mode, current mode):\s*(ChatGPT|Codex)$')) {
                    $selector = $element
                    break
                }
            } catch { }
        }
        if ($selector) { break }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $selectorDeadline)
    if (!$selector) {
        # Newer unified builds use a semantic Chat/Work TogglePattern.
        $toggleName = if ($TargetMode -ceq 'ChatGPT') { '^(Чат|Chat)$' } else { '^(Работа|Work)$' }
        $toggleCandidates = New-Object 'System.Collections.Generic.List[object]'
        $toggleSearch = @(All-Desc $HostWindow)
        try {
            $windowPid = [int]$HostWindow.Current.ProcessId
            $toggleSearch = @([System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition)) | Where-Object { $_.Current.ProcessId -eq $windowPid }
        } catch { }
        foreach ($element in $toggleSearch) {
            try {
                $current = $element.Current
                if (($current.ControlType -ne [System.Windows.Automation.ControlType]::Button) -or
                    $current.IsOffscreen -or ([string]$current.Name -notmatch $toggleName)) { continue }
                [object]$toggle = $null
                if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) {
                    [void]$toggleCandidates.Add([pscustomobject]@{ Element=$element; Pattern=$toggle; State=$toggle.Current.ToggleState.ToString() })
                }
            } catch { }
        }
        if ($toggleCandidates.Count -ne 1) { $result.Message = 'Mode selector was not found on the unified host'; return [pscustomobject]$result }
        if ($toggleCandidates[0].State -ne 'On') { $toggleCandidates[0].Pattern.Toggle() }
        $result.Method = 'UIA.TogglePattern.ChatWork'
        $result.Succeeded = $true
        $result.Message = "Selected $TargetMode mode toggle"
        return [pscustomobject]$result
    }
    try {
        [object]$expand = $null
        if (!$selector.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expand)) {
            $result.Message = 'Mode selector has no ExpandCollapsePattern'
            return [pscustomobject]$result
        }
        # Expand is idempotent for this selector and avoids relying on a
        # provider-specific Current-state readback.
        $expand.Expand()
        # Do not call this collection `$matches`: PowerShell reserves the
        # case-insensitive `$Matches` variable for the `-match` operator.
        # Reusing that name can replace the collection while the menu is
        # being inspected and make a unique item look ambiguous.
        $menuCandidates = New-Object 'System.Collections.Generic.List[object]'
        $menuDeadline = (Get-Date).AddMilliseconds(2000)
        do {
            $menuCandidates.Clear()
            foreach ($element in @(All-Desc $HostWindow)) {
                try {
                    $current = $element.Current
                    if (($current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem) -and
                        !$current.IsOffscreen -and ([string]$current.Name -match ('^' + [regex]::Escape($TargetMode) + '(\s|$)'))) {
                        [void]$menuCandidates.Add($element)
                    }
                } catch { }
            }
            if ($menuCandidates.Count -eq 1) { break }
            Start-Sleep -Milliseconds 150
        } while ((Get-Date) -lt $menuDeadline)
        if ($menuCandidates.Count -ne 1) { $result.Message = "Expected one $TargetMode menu item, found $($menuCandidates.Count)"; return [pscustomobject]$result }
        [object]$invoke = $null
        if (!$menuCandidates[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
            $result.Message = "$TargetMode menu item has no InvokePattern"
            return [pscustomobject]$result
        }
        $invoke.Invoke()
        $result.Succeeded = $true
        $result.Message = "Invoked $TargetMode mode menu item"
    } catch {
        $result.Message = $_.Exception.Message
    }
    return [pscustomobject]$result
}

function Get-DesktopSurface($HostInfo) {
    if (!$HostInfo) { return $null }
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    try { $elements = @($root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) }
    catch { return $null }
    $candidates = New-Object 'System.Collections.Generic.List[object]'
    foreach ($element in $elements) {
        try {
            $current = $element.Current
            if ([int]$current.ProcessId -ne [int]$HostInfo.Pid) { continue }
            $evidence = Get-OrdinaryChatSurfaceEvidence $element
            $kind = Get-DesktopSurfaceKind ([pscustomobject]@{ OrdinaryChatConfirmed=$evidence.OrdinaryChatConfirmed; CodexRootPresent=$evidence.CodexRootPresent })
            $score = if ($kind -ceq 'ORDINARY_CHAT') { 50 } elseif ($kind -ceq 'CODEX') { 40 } else { 0 }
            if (!$current.IsOffscreen) { $score += 4 }
            if ($current.NativeWindowHandle -gt 0) { $score += 2 }
            if ($score -gt 0) {
                [void]$candidates.Add([pscustomobject]@{ Element=$element; Kind=$kind; Mode=$evidence.Mode; Evidence=$evidence; Score=$score; Name=[string]$current.Name; Hwnd=[int64]$current.NativeWindowHandle })
            }
        } catch { }
    }
    $selected = @($candidates | Sort-Object Score -Descending | Select-Object -First 1)
    if (!$selected) { return $null }
    $script:DesktopSurfaceInfo = $selected[0]
    return $selected[0]
}

function Get-MainWindow {
    $desktopHost = Get-DesktopHost
    if (!$desktopHost) { return $null }
    $surface = Get-DesktopSurface $desktopHost
    if ($surface) { return $surface.Element }
    return $desktopHost.Element
}

function Wait-MainWindow {
    $deadline = (Get-Date).AddSeconds($WindowTimeoutSeconds)
    do {
        $window = Get-MainWindow
        if ($window) {
            try { $window.SetFocus() } catch { }
            return $window
        }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    if (Get-DesktopHost) { Fail 'DESKTOP_HOST_FOUND_WRONG_SURFACE' 'Unified Desktop host found but no recognized surface was exposed' 2 }
    Fail 'DESKTOP_HOST_NOT_FOUND' 'Unified ChatGPT/Codex Desktop host not found' 2
}

function Get-LiveChatGPTWindow($Preferred, [ValidateSet('Any','ChatGPT','Codex')][string]$RequiredMode = 'Any') {
    $desktopHost = Get-DesktopHost
    if (!$desktopHost) { return $null }
    $surface = Get-DesktopSurface $desktopHost
    if (!$surface) { return $null }
    if ($RequiredMode -ceq 'ChatGPT' -and $surface.Kind -cne 'ORDINARY_CHAT') { return $null }
    if ($RequiredMode -ceq 'Codex' -and $surface.Kind -cne 'CODEX') { return $null }
    return $surface.Element
}

function Get-ActiveChatGPTSurface($Fallback, [ValidateSet('Any','ChatGPT','Codex')][string]$RequiredMode = 'Any') {
    Start-Sleep -Milliseconds 250
    $live = Get-LiveChatGPTWindow $Fallback $RequiredMode
    if ($live) { return $live }
    if ($RequiredMode -eq 'Any') {
        try { if ($Fallback -and (Is-UiaElementAlive $Fallback)) { return $Fallback } } catch { }
    }
    return $null
}

function Confirm-OrdinaryChatSurface($Window, [int]$TimeoutMs = 5000) {
    $deadline = (Get-Date).AddMilliseconds([Math]::Max(1000, $TimeoutMs))
    do {
        $candidate = Get-ActiveChatGPTSurface $Window 'ChatGPT'
        if ($candidate) {
            $evidence = Get-OrdinaryChatSurfaceEvidence $candidate
            if ($evidence.OrdinaryChatConfirmed) {
                return [pscustomobject]@{ Confirmed=$true; Window=$candidate; Mode='ChatGPT'; Reason='ORDINARY_CHAT_SURFACE_CONFIRMED'; Evidence=$evidence }
            }
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    return [pscustomobject]@{ Confirmed=$false; Window=$Window; Mode=(Get-ChatSurfaceMode $Window); Reason='ORDINARY_CHAT_SURFACE_NOT_CONFIRMED'; Evidence=(Get-OrdinaryChatSurfaceEvidence $Window) }
}

function Confirm-ChatGPTMode($Window, [int]$TimeoutMs = 5000) {
    return Confirm-OrdinaryChatSurface $Window $TimeoutMs
}

function Get-ChatSurfaceMode($Window) {
    if (!$Window) { return $null }
    $candidates = New-Object 'System.Collections.Generic.List[object]'
    foreach ($element in @(All-Desc $Window)) {
        try {
            $current = $element.Current
            if (($current.ControlType -ne [System.Windows.Automation.ControlType]::Button) -or $current.IsOffscreen) { continue }
            if ([string]$current.Name -notmatch '^(Переключить режим, текущий режим|Switch mode, current mode):\s*(ChatGPT|Codex)$') { continue }
            $mode = $Matches[2]
            $score = 0
            if ($current.IsEnabled) { $score += 2 }
            $rect = $current.BoundingRectangle
            if ($rect.Width -gt 0 -and $rect.Height -gt 0) { $score += 1 }
            [void]$candidates.Add([pscustomobject]@{ Mode=$mode; Score=$score; Element=$element })
        } catch { }
    }
    $selected = @($candidates | Sort-Object Score -Descending | Select-Object -First 1)
    if ($selected) { return [string]$selected[0].Mode }

    # Newer unified Desktop builds expose the same authority as a two-state
    # Chat/Work toggle instead of the labelled mode-selector button. Use the
    # selected TogglePattern state only as a semantic mode signal; composer,
    # navigation and New Chat predicates remain independent proofs.
    $toggleModes = New-Object 'System.Collections.Generic.List[object]'
    $toggleSearch = @(All-Desc $Window)
    if ($toggleSearch.Count -eq 0) {
        try {
            $windowPid = [int]$Window.Current.ProcessId
            $toggleSearch = @([System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition)) | Where-Object { $_.Current.ProcessId -eq $windowPid }
        } catch { $toggleSearch = @() }
    }
    foreach ($element in $toggleSearch) {
        try {
            $current = $element.Current
            if (($current.ControlType -ne [System.Windows.Automation.ControlType]::Button) -or
                $current.IsOffscreen -or ([string]$current.Name -notmatch '^(Чат|Chat|Работа|Work)$')) { continue }
            [object]$toggle = $null
            if (!$element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$toggle)) { continue }
            [void]$toggleModes.Add([pscustomobject]@{ Name=[string]$current.Name; State=$toggle.Current.ToggleState.ToString(); Element=$element })
        } catch { }
    }
    $onModes = @($toggleModes | Where-Object State -eq 'On')
    if ($onModes.Count -eq 1) {
        if ($onModes[0].Name -match '^(Чат|Chat)$') { return 'ChatGPT' }
        if ($onModes[0].Name -match '^(Работа|Work)$') { return 'Codex' }
    }
    return $null
}

function Get-ElementText($Element) {
    $values = New-Object 'System.Collections.Generic.List[string]'
    foreach ($child in @(All-Desc $Element)) {
        try {
            $current = $child.Current
            if (($current.ControlType -eq [System.Windows.Automation.ControlType]::Text) -and $current.Name) {
                [void]$values.Add(([string]$current.Name).Trim())
            }
        } catch { }
    }
    return @($values.ToArray())
}

function Find-Composer($Window) {
    $best = $null
    $bestScore = -1
    foreach ($element in @(All-Desc $Window)) {
        try {
            $current = $element.Current
            if (($current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) -or
                !$current.IsEnabled -or $current.IsOffscreen) { continue }
            $score = 0
            if ($current.IsKeyboardFocusable) { $score += 2 }
            if ($current.Name -match 'Выполните|сообщ|задач|message|prompt|Ask|спрос') { $score += 5 }
            $rect = $current.BoundingRectangle
            if (($rect.Width -gt 200) -and ($rect.Height -gt 20)) { $score += 3 }
            if ($score -gt $bestScore) { $best = $element; $bestScore = $score }
        } catch { }
    }
    return $best
}

function Find-Button($Window, [string[]]$Names) {
    foreach ($element in @(All-Desc $Window)) {
        try {
            $current = $element.Current
            if (($current.ControlType -ne [System.Windows.Automation.ControlType]::Button) -or
                !$current.IsEnabled -or $current.IsOffscreen) { continue }
            foreach ($name in $Names) {
                if ([string]$current.Name -like "*$name*") { return $element }
            }
        } catch { }
    }
    return $null
}

function Find-StopButton($Window) {
    foreach ($element in @(All-Desc $Window)) {
        try {
            $current = $element.Current
            if (($current.ControlType -eq [System.Windows.Automation.ControlType]::Button) -and
                $current.IsEnabled -and ([string]$current.Name) -match '^(Остановить|Stop|Прервать)$') {
                return $element
            }
        } catch { }
    }
    return $null
}

function Get-ComposerValue($Element) {
    if (!$Element) { return '' }
    $values = New-Object 'System.Collections.Generic.List[string]'
    try {
        [object]$pattern = $null
        if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            [void]$values.Add([string]$pattern.Current.Value)
        }
    } catch { }
    try {
        [object]$pattern = $null
        if ($Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
            [void]$values.Add([string]$pattern.DocumentRange.GetText(-1))
        }
    } catch { }
    try {
        if ($Element.Current.Name) { [void]$values.Add([string]$Element.Current.Name) }
    } catch { }
    [void]$values.Add(((Get-ElementText $Element) -join "`n"))
    foreach ($value in $values) {
        if (![string]::IsNullOrWhiteSpace($value)) { return $value }
    }
    return ''
}

function Normalize-InputText([string]$Text) {
    return (([string]$Text) -replace "`r`n|`r|`n", ' ').Trim()
}

function Test-ComposerPromptValue([string]$Value, [string]$PromptText) {
    if ($null -eq $Value) { return $false }
    $left = Normalize-InputText $Value
    $right = Normalize-InputText $PromptText
    return (($left -ceq $right) -or (([string]$Value).Trim() -ceq ([string]$PromptText).Trim()))
}

function Test-ComposerIsEmpty([string]$Value) {
    $normalized = (([string]$Value) -replace "`r`n|`r|`n", ' ' -replace '\s+', ' ').Trim()
    return ([string]::IsNullOrWhiteSpace($normalized) -or
        $normalized -match '^(Сообщение ChatGPT|Message ChatGPT|Выполните любую задачу)$')
}

function Confirm-ComposerEmpty($Window, $ExpectedComposer, [int]$TimeoutMs = 3000) {
    $deadline = (Get-Date).AddMilliseconds([Math]::Max(1000, $TimeoutMs))
    $previousRuntimeId = $null
    $previousValue = $null
    $stable = 0
    $last = $null
    do {
        $candidate = Find-Composer $Window
        if ($candidate -and (Is-UiaElementAlive $candidate) -and
            (!$ExpectedComposer -or (Same-Surface $ExpectedComposer $candidate))) {
            $value = [string](Get-ComposerValue $candidate)
            $runtimeId = Get-RuntimeId $candidate
            $last = $candidate
            Write-Log 'composer-clear-readback' "runtimeId=$runtimeId valueLength=$($value.Length) valueHash=$(Get-TextHash $value) empty=$(Test-ComposerIsEmpty $value)"
            # Chromium may replace the editor node after SetValue or a key
            # event. Stability is the same empty value on the same ChatGPT
            # surface, not an unchanged Runtime ID.
            if ((Test-ComposerIsEmpty $value) -and ([string]$value -ceq [string]$previousValue)) {
                $stable++
            } elseif (Test-ComposerIsEmpty $value) {
                $stable = 1
            } else {
                $stable = 0
            }
            $previousRuntimeId = $runtimeId
            $previousValue = $value
            if ($stable -ge 2) {
                return [pscustomobject]@{ Confirmed=$true; Composer=$candidate; RuntimeId=$runtimeId; StableReadbacks=$stable; Reason='TWO_STABLE_EMPTY_READBACKS' }
            }
        } else { $stable = 0 }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $deadline)
    return [pscustomobject]@{ Confirmed=$false; Composer=$last; RuntimeId=(Get-RuntimeId $last); StableReadbacks=$stable; Reason='EMPTY_READBACK_NOT_CONFIRMED' }
}

function Clear-Composer($Window, $Element) {
    $result = [ordered]@{ Succeeded=$false; Method=$null; Attempts=0; Composer=$null; RuntimeId=$null; Error='COMPOSER_CLEAR_NOT_CONFIRMED'; Message='Composer clear was not confirmed'; StableReadbacks=0 }
    if ($TestForceFreshComposerClearFailure) {
        $result.Message = 'Test mode intentionally failed both composer clear methods'
        return [pscustomobject]$result
    }
    $target = $Element
    if (!$target -or !(Is-UiaElementAlive $target)) { $target = Find-Composer $Window }
    if (!$target) {
        $result.Error = 'COMPOSER_NOT_FOUND'
        $result.Message = 'Composer was not found before clear'
        return [pscustomobject]$result
    }
    $result.Composer = $target
    $result.RuntimeId = Get-RuntimeId $target
    $result.Attempts = 1
    try {
        [object]$pattern = $null
        if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            $pattern.SetValue('')
            $readback = Confirm-ComposerEmpty $Window $target 2500
            if ($readback.Confirmed) {
                $result.Succeeded = $true
                $result.Method = 'ValuePattern'
                $result.Composer = $readback.Composer
                $result.RuntimeId = $readback.RuntimeId
                $result.StableReadbacks = $readback.StableReadbacks
                $result.Error = $null
                $result.Message = 'ValuePattern clear confirmed by two stable UIA readbacks'
                return [pscustomobject]$result
            }
        }
    } catch { $result.Message = $_.Exception.Message }

    # Safe keyboard fallback: use only the exact, freshly acquired composer on
    # the active ChatGPT surface. No coordinates or global focus assumptions.
    $result.Attempts = 2
    try {
        $Window = Get-ActiveChatGPTSurface $Window 'ChatGPT'
        $target = Find-Composer $Window
        if (!$Window -or !$target -or !(Is-UiaElementAlive $target)) {
            $result.Error = 'COMPOSER_CLEAR_NOT_CONFIRMED'
            $result.Message = 'Composer disappeared before keyboard clear fallback'
            return [pscustomobject]$result
        }
        $result.Composer = $target
        $result.RuntimeId = Get-RuntimeId $target
        if (!(Activate-ChatGPTWindow $Window)) {
            $result.Message = 'ChatGPT window could not be activated before keyboard clear fallback'
            return [pscustomobject]$result
        }
        Start-Sleep -Milliseconds 200
        $target.SetFocus()
        Start-Sleep -Milliseconds 150
        $focused = $false
        try { $focused = [bool]$target.Current.HasKeyboardFocus } catch { }
        if (!$focused) {
            $result.Message = 'Exact composer did not report UIA keyboard focus'
            return [pscustomobject]$result
        }
        Send-ControlShortcut 0x41
        Start-Sleep -Milliseconds 100
        [DshKeyboard]::keybd_event(0x08, 0, 0, [UIntPtr]::Zero)
        [DshKeyboard]::keybd_event(0x08, 0, [DshKeyboard]::KeyUp, [UIntPtr]::Zero)
        $readback = Confirm-ComposerEmpty $Window $target 2500
        if ($readback.Confirmed) {
            $result.Succeeded = $true
            $result.Method = 'KeyboardFallback'
            $result.Composer = $readback.Composer
            $result.RuntimeId = $readback.RuntimeId
            $result.StableReadbacks = $readback.StableReadbacks
            $result.Error = $null
            $result.Message = 'Keyboard clear fallback confirmed by two stable UIA readbacks'
        }
    } catch { $result.Message = $_.Exception.Message }
    return [pscustomobject]$result
}

function Prepare-FreshComposer($Window, $Composer) {
    $result = [ordered]@{ InitiallyEmpty=$null; Sanitized=$false; ClearMethod=$null; ClearAttempts=0; ConfirmedEmpty=$false; Composer=$null; RuntimeId=$null; Error=$null; Message=$null }
    $Window = Get-ActiveChatGPTSurface $Window 'ChatGPT'
    $target = $Composer
    if (!$target -or !(Is-UiaElementAlive $target) -or !$Window -or !(Same-Surface $Window $target)) { $target = Find-Composer $Window }
    if (!$target) {
        $result.Error = 'FRESH_COMPOSER_NOT_READY'
        $result.Message = 'Fresh composer was not found after conversation confirmation'
        return [pscustomobject]$result
    }
    $value = [string](Get-ComposerValue $target)
    $result.InitiallyEmpty = [bool](Test-ComposerIsEmpty $value)
    $result.Composer = $target
    $result.RuntimeId = Get-RuntimeId $target
    Write-Log 'fresh-composer' "initiallyEmpty=$($result.InitiallyEmpty) valueLength=$($value.Length) valueHash=$(Get-TextHash $value)"
    if ($result.InitiallyEmpty) {
        $readback = Confirm-ComposerEmpty $Window $target 2500
        $result.Composer = $readback.Composer
        $result.RuntimeId = $readback.RuntimeId
        $result.ConfirmedEmpty = [bool]$readback.Confirmed
        if (!$readback.Confirmed) {
            $result.Error = 'FRESH_COMPOSER_NOT_READY'
            $result.Message = 'Fresh composer empty state was not stable across two readbacks'
            return [pscustomobject]$result
        }
        $result.Message = 'Fresh composer confirmed empty by two stable readbacks'
        return [pscustomobject]$result
    }
    $clear = Clear-Composer $Window $target
    $result.ClearMethod = $clear.Method
    $result.ClearAttempts = [int]$clear.Attempts
    $result.Composer = $clear.Composer
    $result.RuntimeId = $clear.RuntimeId
    $result.ConfirmedEmpty = [bool]$clear.Succeeded
    if (!$clear.Succeeded) {
        $result.Error = 'COMPOSER_CLEAR_NOT_CONFIRMED'
        $result.Message = $clear.Message
        return [pscustomobject]$result
    }
    $result.Sanitized = $true
    $result.Message = $clear.Message
    return [pscustomobject]$result
}

function Set-TestFreshComposerDraft($Window, [string]$Draft) {
    if ([string]::IsNullOrWhiteSpace($Draft)) { return [pscustomobject]@{ Succeeded=$true; Composer=$null; Error=$null; Message='No test draft requested' } }
    $Window = Get-ActiveChatGPTSurface $Window 'ChatGPT'
    $target = Find-Composer $Window
    if (!$target) { return [pscustomobject]@{ Succeeded=$false; Composer=$null; Error='TEST_DRAFT_SEED_FAILED'; Message='Composer not found for test draft seed' } }
    try {
        [object]$pattern = $null
        if (!$target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            return [pscustomobject]@{ Succeeded=$false; Composer=$target; Error='TEST_DRAFT_SEED_FAILED'; Message='ValuePattern unavailable for test draft seed' }
        }
        $pattern.SetValue($Draft)
        $readback = Confirm-ComposerPrompt $Window $Draft $target
        if (!$readback.Confirmed) { return [pscustomobject]@{ Succeeded=$false; Composer=$target; Error='TEST_DRAFT_SEED_FAILED'; Message='Test draft readback was not confirmed' } }
        return [pscustomobject]@{ Succeeded=$true; Composer=$readback.Composer; Error=$null; Message='Test draft seeded without Send' }
    } catch {
        return [pscustomobject]@{ Succeeded=$false; Composer=$target; Error='TEST_DRAFT_SEED_FAILED'; Message=$_.Exception.Message }
    }
}

function Invoke-ComposerClipboardFallback($Window, $Composer, [string]$Text) {
    $result = [ordered]@{ Succeeded=$false; Method='ClipboardFallback'; Attempts=1; ReadbackPolls=0; Error='CLIPBOARD_FALLBACK_FAILED'; Message='Clipboard fallback did not confirm exact readback'; RuntimeId=$null; Composer=$null; ClipboardRestored=$false }
    if ($TestForceClipboardFallbackFailure) {
        $result.Error = 'CLIPBOARD_FALLBACK_FORCED_FAILURE'
        $result.Message = 'Test mode intentionally disabled clipboard fallback'
        return [pscustomobject]$result
    }
    $oldClipboard = $null
    $oldReadable = $false
    $clipboardSet = $false
    try { $oldClipboard = Get-Clipboard -Raw -ErrorAction Stop; $oldReadable = $true } catch { }
    try {
        $target = $Composer
        if (!$target -or !(Is-UiaElementAlive $target)) { $target = Find-Composer $Window }
        if (!$target) {
            $result.Error = 'COMPOSER_NOT_FOUND'
            $result.Message = 'Composer disappeared before clipboard fallback'
            return [pscustomobject]$result
        }
        $result.Composer = $target
        $result.RuntimeId = Get-RuntimeId $target
        $clear = Clear-Composer $Window $target
        if (!$clear.Succeeded) {
            $result.Error = 'COMPOSER_CLEAR_FAILED'
            $result.Message = 'Composer could not be cleared before clipboard fallback'
            return [pscustomobject]$result
        }
        $target = Find-Composer $Window
        if (!$target -or !(Is-UiaElementAlive $target)) {
            $result.Error = 'COMPOSER_NOT_FOUND'
            $result.Message = 'Composer disappeared after clear before clipboard fallback'
            return [pscustomobject]$result
        }
        $result.Composer = $target
        $result.RuntimeId = Get-RuntimeId $target
        # Keep the activation/focus order used by the verified desktop probe:
        # activate the top-level window, focus the exact editor, then populate
        # the clipboard and paste. Re-activating after SetClipboard can detach
        # Chromium's ProseMirror text receiver.
        if (!(Activate-ChatGPTWindow $Window)) {
            $result.Message = 'ChatGPT window could not be activated before clipboard fallback'
            return [pscustomobject]$result
        }
        Start-Sleep -Milliseconds 250
        try { $target.SetFocus() } catch { }
        Start-Sleep -Milliseconds 250
        Set-Clipboard -Value $Text -ErrorAction Stop
        $clipboardSet = $true
        Start-Sleep -Milliseconds 250
        Send-ControlShortcut 0x41
        Start-Sleep -Milliseconds 100
        Send-ControlShortcut 0x56
        $deadline = (Get-Date).AddSeconds(3)
        $stable = 0
        do {
            $result.ReadbackPolls++
            Start-Sleep -Milliseconds 150
            $candidate = Find-Composer $Window
            if ($candidate -and (Is-UiaElementAlive $candidate) -and (Same-Surface $target $candidate)) {
                $value = Get-ComposerValue $candidate
                Write-Log 'clipboard-readback' "poll=$($result.ReadbackPolls) runtimeId=$(Get-RuntimeId $candidate) valueLength=$(([string]$value).Length) valueHash=$(Get-TextHash ([string]$value)) match=$(Test-ComposerPromptValue $value $Text)"
                if (Test-ComposerPromptValue $value $Text) {
                    $stable++
                    if ($stable -ge 2) {
                        $result.Composer = $candidate
                        $result.Succeeded = $true
                        $result.Error = $null
                        $result.Message = 'Clipboard paste confirmed by two stable UIA readbacks'
                        return [pscustomobject]$result
                    }
                } else { $stable = 0 }
            } else { $stable = 0 }
        } while ((Get-Date) -lt $deadline)
        $result.Error = 'CLIPBOARD_FALLBACK_READBACK_FAILED'
        return [pscustomobject]$result
    } catch {
        $result.Error = 'CLIPBOARD_FALLBACK_FAILED'
        $result.Message = $_.Exception.Message
        return [pscustomobject]$result
    } finally {
        if ($clipboardSet -and $oldReadable) {
            try {
                $currentClipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue
                if ([string]$currentClipboard -ceq [string]$Text) {
                    Set-Clipboard -Value $oldClipboard -ErrorAction SilentlyContinue
                    $result.ClipboardRestored = ([string](Get-Clipboard -Raw -ErrorAction SilentlyContinue) -ceq [string]$oldClipboard)
                }
            } catch { }
        }
    }
}

function Set-ComposerText($Window, $Composer, [string]$Text) {
    $result = [ordered]@{ Succeeded=$false; Method=$null; FallbackFrom=$null; Attempts=0; Error='INPUT_NOT_CONFIRMED'; Message='Composer input was not confirmed'; RuntimeId=$null; Composer=$null; ClipboardRestored=$false }
    $target = $Composer
    if (!$target -or !(Is-UiaElementAlive $target)) { $target = Find-Composer $Window }
    if ($target) { $result.Composer = $target; $result.RuntimeId = Get-RuntimeId $target }
    if ($target -and $TestForceValuePatternFailure) { $result.Attempts = 1; $result.Method = 'ValuePattern'; $result.Message = 'Test mode intentionally failed ValuePattern' }
    if ($target -and !$TestForceValuePatternFailure) {
        try {
            [object]$pattern = $null
            if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                $pattern.SetValue($Text)
                $result.Attempts = 1
                $result.Method = 'ValuePattern'
                Start-Sleep -Milliseconds 150
                if (Test-ComposerPromptValue (Get-ComposerValue $target) $Text) {
                    $result.Succeeded = $true
                    $result.Error = $null
                    $result.Message = 'ValuePattern write confirmed by immediate readback'
                    return [pscustomobject]$result
                }
            }
        } catch { $result.Message = $_.Exception.Message }
    }
    $fallback = Invoke-ComposerClipboardFallback $Window $target $Text
    $result.Attempts = [int]$result.Attempts + [int]$fallback.Attempts
    $result.FallbackFrom = if($fallback.Method -eq 'ClipboardFallback' -and $result.Attempts -gt 0){'ValuePattern'}else{$null}
    $result.Method = $fallback.Method
    $result.RuntimeId = $fallback.RuntimeId
    $result.Composer = $fallback.Composer
    $result.ClipboardRestored = [bool]$fallback.ClipboardRestored
    $result.Succeeded = [bool]$fallback.Succeeded
    $result.Error = $fallback.Error
    $result.Message = $fallback.Message
    return [pscustomobject]$result
}

function Get-ConversationSnapshot($Window) {
    $conversation = Find-ConversationContainer $Window
    $anchors = @(Get-AuthorAnchors $conversation)
    $anchorIds = @($anchors | ForEach-Object { [string]$_.AnchorRuntimeId } | Where-Object { $_ })
    $anchorNames = @($anchors | ForEach-Object { [string]$_.AnchorName })
    $runtimeId = Get-RuntimeId $conversation
    $isThread = $false
    try { $isThread = [string]$conversation.Current.ClassName -match 'thread-scroll-container' } catch { }
    $emptyMarker = $false
    foreach ($element in @(All-Desc $Window)) {
        try {
            $current = $element.Current
            if (($current.ControlType -eq [System.Windows.Automation.ControlType]::Text) -and
                ([string]$current.Name -match '^(Что у вас сегодня на повестке\?|О чем вы сегодня думаете\?|Можем начинать\.|С чего начнём\?|Что у вас на уме\?|What.s on your mind today\?|How can I help\?)$')) {
                $emptyMarker = $true
                break
            }
        } catch { }
    }
    return [pscustomobject]@{
        Window=$Window; Conversation=$conversation; RuntimeId=$runtimeId; WindowRuntimeId=(Get-RuntimeId $Window); WindowHandle=0; ProcessId=0
        SurfaceMode=(Get-ChatSurfaceMode $Window); IsThreadContainer=$isThread; EmptySurfaceMarker=$emptyMarker
        MessageCount=$anchors.Count; AnchorIds=$anchorIds; AnchorNames=$anchorNames
        Signature=(($runtimeId, ($anchorIds -join ','), $anchors.Count, $emptyMarker) -join '|')
    }
}

function Activate-ChatGPTWindow($Window) {
    if (!$Window) { return $false }
    # A unified Desktop session can expose a visible Codex mini-surface and a
    # separate full host window under the same PID. Keyboard navigation belongs
    # to the host, not to the mini-surface; keep surface proof independent.
    $activationTarget = $Window
    $desktopHost = Get-DesktopHost
    if ($desktopHost -and $desktopHost.Element) { $activationTarget = $desktopHost.Element }
    $handle = [IntPtr]::Zero
    try { $handle = [IntPtr]$activationTarget.Current.NativeWindowHandle } catch { }
    if ($handle -eq [IntPtr]::Zero -or ![DshWindowFocus]::IsWindow($handle)) { return $false }
    $foreground = [DshWindowFocus]::GetForegroundWindow()
    [uint32]$foregroundThread = 0
    [DshWindowFocus]::GetWindowThreadProcessId($foreground, [ref]$foregroundThread) | Out-Null
    [uint32]$targetThread = 0
    [DshWindowFocus]::GetWindowThreadProcessId($handle, [ref]$targetThread) | Out-Null
    $currentThread = [DshWindowFocus]::GetCurrentThreadId()
    # AttachThreadInput requires the caller to own a message queue. PeekMessage
    # creates/initializes it without reading or changing any user input.
    $message = New-Object DshWindowFocus+Msg
    [DshWindowFocus]::PeekMessage([ref]$message, [IntPtr]::Zero, 0, 0, 0) | Out-Null
    $attachedThreads = New-Object 'System.Collections.Generic.List[uint32[]]'
    try {
        # Foreground activation is subject to Windows' foreground-lock policy.
        # Temporarily joining both input queues gives the caller the same
        # activation path as a normal user click, then we always detach.
        foreach ($thread in @($foregroundThread, $targetThread)) {
            if ($thread -and $thread -ne $currentThread) {
                if ([DshWindowFocus]::AttachThreadInput($currentThread, $thread, $true)) {
                    [void]$attachedThreads.Add([uint32[]]@($currentThread, $thread))
                }
            }
        }
        [DshWindowFocus]::ShowWindow($handle, 9) | Out-Null
        [DshWindowFocus]::BringWindowToTop($handle) | Out-Null
        [DshWindowFocus]::SetActiveWindow($handle) | Out-Null
        [DshWindowFocus]::SetFocus($handle) | Out-Null
        $activated = $false
        $isForeground = $false
        for ($attempt = 1; $attempt -le 5; $attempt++) {
            $activated = ([DshWindowFocus]::SetForegroundWindow($handle) -or $activated)
            if (![DshWindowFocus]::GetForegroundWindow().Equals($handle)) {
                [DshWindowFocus]::SwitchToThisWindow($handle, $true)
            }
            $isForeground = [DshWindowFocus]::GetForegroundWindow().Equals($handle)
            if ($isForeground) { break }
            Start-Sleep -Milliseconds 120
        }
        Write-Log 'window-activation' "handle=$handle foregroundBefore=$foreground activated=$activated attempts=$attempt verified=$isForeground"
        return $isForeground
    } catch {
        Write-Log 'window-activation' "handle=$handle error=$($_.Exception.Message)"
        return $false
    } finally {
        foreach ($pair in @($attachedThreads)) {
            [DshWindowFocus]::AttachThreadInput($pair[0], $pair[1], $false) | Out-Null
        }
    }
}

function Find-NewChatButton($Window) {
    $candidates = New-Object 'System.Collections.Generic.List[object]'
    foreach ($element in @(All-Desc $Window)) {
        try {
            $current = $element.Current
            if (($current.ControlType -ne [System.Windows.Automation.ControlType]::Button) -or
                !$current.IsEnabled -or $current.IsOffscreen -or
                ([string]$current.Name -notmatch '^(Новый чат|New chat)$')) { continue }
            $rect = $current.BoundingRectangle
            if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
            $parent = Get-ImmediateParent $element
            $parentClass = ''
            if ($parent) { try { $parentClass = [string]$parent.Current.ClassName } catch { } }
            $score = 0
            # Prefer the global ordinary-chat command. Project quick-create
            # icons have the same visible label but are not a safe target for
            # an external request.
            if ($current.ClassName -match 'sidebar-item') { $score += 30 }
            if ($current.ClassName -notmatch 'sidebar-icon-button') { $score += 10 }
            if ($parentClass -match 'relative z-10|Navigation') { $score += 5 }
            if ($rect.Width -gt 100 -and $rect.Height -gt 15) { $score += 5 }
            [void]$candidates.Add([pscustomobject]@{ Element=$element; Score=$score; ClassName=[string]$current.ClassName; ParentClass=$parentClass; RuntimeId=(Get-RuntimeId $element) })
        } catch { }
    }
    $selected = @($candidates | Sort-Object Score -Descending)
    if ($selected.Count -eq 0) { return $null }
    $bestScore = [int]$selected[0].Score
    $best = @($selected | Where-Object Score -eq $bestScore)
    if ($best.Count -ne 1 -or $bestScore -lt 30) { return $null }
    return $best[0].Element
}

function Invoke-NewChatButton($Window) {
    $button = Find-NewChatButton $Window
    if (!$button -or !(Is-UiaElementAlive $button)) {
        return [pscustomobject]@{ Succeeded=$false; Invoked=$false; Error='FRESH_CHAT_NOT_CONFIRMED'; Subreason='FRESH_NEW_CHAT_ACTION_NOT_CONFIRMED'; Message='Global ordinary-chat New Chat button was not uniquely found'; RuntimeId=$null }
    }
    try {
        [object]$pattern = $null
        if (!$button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            return [pscustomobject]@{ Succeeded=$false; Invoked=$false; Error='FRESH_CHAT_NOT_CONFIRMED'; Subreason='FRESH_NEW_CHAT_ACTION_NOT_CONFIRMED'; Message='Global ordinary-chat New Chat button has no InvokePattern'; RuntimeId=(Get-RuntimeId $button) }
        }
        $pattern.Invoke()
        return [pscustomobject]@{ Succeeded=$true; Invoked=$true; Error=$null; Subreason='FRESH_NEW_CHAT_ACTION_CONFIRMED'; Message='Global ordinary-chat New Chat InvokePattern completed'; RuntimeId=(Get-RuntimeId $button) }
    } catch {
        return [pscustomobject]@{ Succeeded=$false; Invoked=$false; Error='FRESH_CHAT_NOT_CONFIRMED'; Subreason='FRESH_NEW_CHAT_ACTION_NOT_CONFIRMED'; Message=$_.Exception.Message; RuntimeId=(Get-RuntimeId $button) }
    }
}

function Confirm-FreshConversation($Window, $PreviousSnapshot, [int]$TimeoutMs = 8000, [bool]$NewChatInvoked = $false) {
    $deadline = (Get-Date).AddMilliseconds([Math]::Max(1000, $TimeoutMs))
    $lastSignature = $null
    $stable = 0
    $last = $null
    $requiredStableSamples = 3
    $samples = 0
    do {
        Start-Sleep -Milliseconds 200
        $candidateWindow = Get-ActiveChatGPTSurface $Window 'ChatGPT'
        if (!$candidateWindow) {
            $last = [pscustomobject]@{ Window=$Window; Snapshot=$null; StablePolls=$stable; Reason='FRESH_WRONG_CHAT_SURFACE'; Diagnostics=[ordered]@{ timestampUtc=(Get-Date).ToUniversalTime().ToString('o'); sample=$samples; surfaceMode='unknown'; messageCount=$null; anchorNames=@(); oldAnchorIntersection=$null; runtimeChanged=$false; emptySurfaceMarker=$false; stableSamples=$stable; requiredStableSamples=$requiredStableSamples; predicates=[ordered]@{ surfaceModeConfirmed=$false; messageHistoryEmpty=$false; oldAnchorsAbsent=$false; newChatActionConfirmed=$NewChatInvoked; structuralResetConfirmed=$false; surfaceStable=($stable -ge $requiredStableSamples) } } }
            Write-Log 'fresh-poll' "surface=missing reason=FRESH_WRONG_CHAT_SURFACE stable=$stable"
            continue
        }
        $Window = $candidateWindow
        $current = Get-ConversationSnapshot $Window
        $samples++
        Write-Log 'fresh-poll' "surface=$($current.SurfaceMode) marker=$($current.EmptySurfaceMarker) messages=$($current.MessageCount) anchors=$($current.AnchorNames.Count)"
        $oldAnchorIntersection = @($current.AnchorIds | Where-Object { $_ -in @($PreviousSnapshot.AnchorIds) }).Count
        $runtimeChanged = [bool]($PreviousSnapshot.RuntimeId -and $current.RuntimeId -and ($PreviousSnapshot.RuntimeId -cne $current.RuntimeId))
        # Runtime IDs are diagnostics only. Chromium may replace the entire
        # subtree on navigation, so stability uses semantic state instead.
        $signature = Get-FreshSurfaceSignature $current
        if ($signature -eq $lastSignature) { $stable++ } else { $stable = 1 }
        $lastSignature = $signature
        $decision = Test-FreshProofPredicates $PreviousSnapshot $current $NewChatInvoked $stable $requiredStableSamples
        $predicates = [ordered]@{
            surfaceModeConfirmed=[bool]$decision.SurfaceModeConfirmed
            messageHistoryEmpty=[bool]$decision.MessageHistoryEmpty
            oldAnchorsAbsent=[bool]$decision.OldAnchorsAbsent
            newChatActionConfirmed=[bool]$decision.NewChatActionConfirmed
            structuralResetConfirmed=[bool]$decision.StructuralResetConfirmed
            surfaceStable=[bool]$decision.SurfaceStable
        }
        $diagnostics = [ordered]@{
            timestampUtc=(Get-Date).ToUniversalTime().ToString('o'); sample=$samples; surfaceMode=[string]$current.SurfaceMode
            messageCount=[int]$current.MessageCount; anchorNames=@($current.AnchorNames); oldAnchorIntersection=[int]$oldAnchorIntersection
            runtimeChanged=[bool]$runtimeChanged; previousConversationRuntimeId=[string]$PreviousSnapshot.RuntimeId
            currentConversationRuntimeId=[string]$current.RuntimeId; emptySurfaceMarker=[bool]$current.EmptySurfaceMarker
            stableSamples=[int]$stable; requiredStableSamples=$requiredStableSamples; predicates=$predicates
        }
        $last = [pscustomobject]@{
            Window=$Window; Snapshot=$current; Composer=$null; StablePolls=$stable; Reason=$decision.Reason; Diagnostics=$diagnostics
        }
        if ($decision.Confirmed) {
            return [pscustomobject]@{ Confirmed=$true; Window=$Window; Snapshot=$current; Composer=$null; IdentityChanged=$runtimeChanged; TransitionObserved=$true; MarkerTransition=([bool](!$PreviousSnapshot.EmptySurfaceMarker -and $current.EmptySurfaceMarker)); ObservableReset=([bool]($PreviousSnapshot.MessageCount -gt 0 -and $current.MessageCount -eq 0)); Reason=$decision.Reason; StablePolls=$stable; Diagnostics=$diagnostics }
        }
    } while ((Get-Date) -lt $deadline)
    return [pscustomobject]@{ Confirmed=$false; Window=if($last){$last.Window}else{$Window}; Snapshot=if($last -and $last.Snapshot){$last.Snapshot}else{$null}; Composer=$null; IdentityChanged=$false; TransitionObserved=$false; MarkerTransition=$false; ObservableReset=$false; Reason=if($last){$last.Reason}else{'FRESH_TIMEOUT'}; StablePolls=if($last){$last.StablePolls}else{0}; Diagnostics=if($last){$last.Diagnostics}else{[ordered]@{ timestampUtc=(Get-Date).ToUniversalTime().ToString('o'); sample=0; reason='FRESH_TIMEOUT'; stableSamples=0; requiredStableSamples=$requiredStableSamples } } }
}

function Ensure-FreshOrdinaryChat($Window, $PreviousSnapshot, [int]$TimeoutMs = 8000, [string]$TestDraft = '') {
    $action = Invoke-NewChatButton $Window
    if (!$action.Succeeded) {
        return [pscustomobject]@{
            Confirmed=$false; Window=$Window; Snapshot=$null; Composer=$null; IdentityChanged=$false; TransitionObserved=$false
            MarkerTransition=$false; ObservableReset=$false; Reason=$action.Subreason; StablePolls=0
            Diagnostics=[ordered]@{ timestampUtc=(Get-Date).ToUniversalTime().ToString('o'); stage='new-chat-action'; action=$action.Message; actionRuntimeId=$action.RuntimeId; reason=$action.Subreason; predicates=[ordered]@{ newChatActionConfirmed=$false } }
        }
    }
    if ($TestDraft) {
        $draftResult = Set-TestFreshComposerDraft $Window $TestDraft
        if (!$draftResult.Succeeded) {
            return [pscustomobject]@{
                Confirmed=$false; Window=$Window; Snapshot=$null; Composer=$draftResult.Composer; IdentityChanged=$false; TransitionObserved=$false
                MarkerTransition=$false; ObservableReset=$false; Reason='FRESH_TEST_DRAFT_SEED_FAILED'; StablePolls=0
                Diagnostics=[ordered]@{ timestampUtc=(Get-Date).ToUniversalTime().ToString('o'); stage='test-draft-seed'; reason='FRESH_TEST_DRAFT_SEED_FAILED'; actionRuntimeId=$action.RuntimeId; message=$draftResult.Message }
            }
        }
    }
    $fresh = Confirm-FreshConversation $Window $PreviousSnapshot $TimeoutMs $action.Invoked
    $fresh | Add-Member -NotePropertyName Action -NotePropertyValue $action -Force
    return $fresh
}

function Confirm-ComposerCleared($Window, [string]$PromptText) {
    $composer = Find-Composer $Window
    if (!$composer) {
        return [pscustomobject]@{ Found=$false; Cleared=$false; Value=$null; RuntimeId=$null; Reason='COMPOSER_NOT_FOUND' }
    }
    $value = Get-ComposerValue $composer
    $norm = ([string]$value).Trim()
    $normPrompt = (([string]$PromptText) -replace "`r`n|`r|`n", ' ').Trim()
    $normValue = ($norm -replace "`r`n|`r|`n", ' ').Trim()
    $same = Test-ComposerPromptValue $value $PromptText
    $cleared = Test-ComposerIsEmpty $value
    return [pscustomobject]@{
        Found=$true; Cleared=(!$same -and $cleared); Value=$value; RuntimeId=(Get-RuntimeId $composer)
        Reason=if($same){'PROMPT_STILL_IN_COMPOSER'}elseif($cleared){'EMPTY'}else{'COMPOSER_CHANGED'}
    }
}

function Test-IsComposerDescendant($Element) {
    if (!$Element) { return $false }
    foreach ($ancestor in @(Get-ElementAncestors $Element 12)) {
        try {
            $current = $ancestor.Current
            if (($current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) -or
                ($current.ClassName -eq 'ProseMirror') -or ($current.Name -eq 'Сообщение ChatGPT')) {
                return $true
            }
        } catch { }
    }
    return $false
}

function Find-SendButtonForComposer($Window, $Composer) {
    $best = $null
    $bestScore = -1
    foreach ($element in @(All-Desc $Window)) {
        try {
            $current = $element.Current
            if (($current.ControlType -ne [System.Windows.Automation.ControlType]::Button) -or
                !$current.IsEnabled -or ($current.Name -notmatch 'Отправить|Send')) { continue }
            if (!(Same-Surface $Composer $element)) { continue }
            $rect = $current.BoundingRectangle
            $composerRect = $Composer.Current.BoundingRectangle
            # Chromium can leave IsOffscreen stale immediately after a
            # ValuePattern update. The exact same-surface relation plus a
            # positive UIA rectangle is the authority; no coordinates are
            # used and InvokePattern remains the only send action.
            if ($rect.Width -le 0 -or $rect.Height -le 0) { continue }
            $score = 0
            if ($rect.Y -ge ($composerRect.Y - 160)) { $score += 3 }
            if ($rect.X -gt $composerRect.X) { $score += 1 }
            if ($score -gt $bestScore) { $best = $element; $bestScore = $score }
        } catch { }
    }
    return $best
}

function Get-AuthorAnchors($Conversation, [switch]$IncludeDeepOffscreen) {
    $anchors = New-Object 'System.Collections.Generic.List[object]'
    foreach ($element in @(All-Desc $Conversation)) {
        try {
            $current = $element.Current
            if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Text) { continue }
            $role = $null
            if ([string]$current.Name -match '^(ChatGPT сказал|ChatGPT said|Assistant)\s*:') { $role = 'assistant' }
            elseif ([string]$current.Name -match '^(Вы сказали|You said|User)\s*:') { $role = 'user' }
            if ($role) {
                [void]$anchors.Add([pscustomobject]@{
                    AnchorElement=$element; AnchorRuntimeId=(Get-RuntimeId $element); Role=$role
                    AnchorName=[string]$current.Name; YTop=[double]$current.BoundingRectangle.Y
                })
            }
        } catch { }
    }
    $filtered = if ($IncludeDeepOffscreen) {
        @($anchors.ToArray())
    } else {
        @($anchors | Where-Object { $_.YTop -gt -10000 })
    }
    return @($filtered | Sort-Object YTop)
}

function Find-ConversationContainer($Window) {
    $all = @(All-Desc $Window)
    foreach ($element in $all) {
        try { if ($element.Current.ClassName -match 'thread-scroll-container') { return $element } }
        catch { }
    }
    $best = $Window
    $bestScore = 0
    foreach ($element in $all) {
        try {
            $current = $element.Current
            if ($current.ControlType.ProgrammaticName -notmatch 'Pane|Group|Document|List|Custom|ListItem') { continue }
            $text = @(Get-ElementText $element)
            $score = ([int](@($text | Where-Object { $_ -match 'ChatGPT сказал|ChatGPT said|Вы сказали|You said' }).Count) * 10)
            $score += [Math]::Min($text.Count, 20)
            $rect = $current.BoundingRectangle
            if (($rect.Width -gt 300) -and ($rect.Height -gt 200)) { $score += 5 }
            if ($score -gt $bestScore) { $best = $element; $bestScore = $score }
        } catch { }
    }
    return $best
}

function Find-MessageContainer($Conversation, $Anchor) {
    if (!$Anchor -or !$Anchor.AnchorElement) { return $null }
    foreach ($ancestor in @(Get-ElementAncestors $Anchor.AnchorElement 12)) {
        try {
            $current = $ancestor.Current
            if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Window) { continue }
            if ($current.ClassName -match 'thread-scroll-container') { continue }
            $marks = @((All-Desc $ancestor) | Where-Object {
                try { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and ([string]$_.Current.Name) -match $script:AuthorAnchorPattern }
                catch { $false }
            })
            if (($marks.Count -eq 1) -and ($current.BoundingRectangle.Width -gt 80)) { return $ancestor }
        } catch { }
    }
    return $null
}

function Resolve-AssistantTextRange($Conversation, $Anchor, [double]$NextUserY = 0, [double]$ComposerY = 0) {
    if (!$Anchor) { return $null }
    $top = [double]$Anchor.YTop
    $ends = New-Object 'System.Collections.Generic.List[object]'
    if ($NextUserY -gt $top) { [void]$ends.Add([pscustomobject]@{ Y=$NextUserY; Reason='next-user-anchor' }) }
    if ($ComposerY -gt $top) { [void]$ends.Add([pscustomobject]@{ Y=$ComposerY; Reason='composer-top' }) }
    $end = @($ends | Where-Object { $_.Y -gt $top } | Sort-Object Y | Select-Object -First 1)
    if (!$end) {
        # flex-col-reverse can place the composer above an off-screen last assistant.
        # The structural node scan still stops at the next author anchor; this large
        # limit is only the final-message bound, never a global Copy query.
        return [pscustomobject]@{ StartY=$top; EndY=1e9; StartRuntimeId=$Anchor.AnchorRuntimeId; EndRuntimeId=$null; BoundaryReason='last-assistant-open-end' }
    }
    return [pscustomobject]@{ StartY=$top; EndY=[double]$end.Y; StartRuntimeId=$Anchor.AnchorRuntimeId; EndRuntimeId=$null; BoundaryReason=$end.Reason }
}

function Resolve-MessageBoundary($Conversation, $Anchor, [double]$BottomHint = 0) {
    if (!$Anchor) { return $null }
    $anchors = @(Get-AuthorAnchors $Conversation)
    $top = [double]$Anchor.YTop
    $next = @($anchors | Where-Object { $_.YTop -gt $top } | Sort-Object YTop | Select-Object -First 1)
    $bottom = if ($BottomHint -gt $top) { $BottomHint } elseif ($next) { [double]$next.YTop } else { 0 }
    $container = Find-MessageContainer $Conversation $Anchor
    $range = $null
    if ($Anchor.Role -eq 'assistant') {
        $composerY = 0
        try { $composerY = [double](Find-Composer $Conversation).Current.BoundingRectangle.Y } catch { }
        $nextY = if ($next) { [double]$next.YTop } else { 0 }
        $range = Resolve-AssistantTextRange $Conversation $Anchor $nextY $composerY
        if ($range.EndY -gt $top) { $bottom = $range.EndY }
    }
    return [pscustomobject]@{
        Role=$Anchor.Role; AuthorAnchorElement=$Anchor.AnchorElement; AnchorElement=$Anchor.AnchorElement
        ContainerElement=$container; BodyContainerElement=$null; AnchorRuntimeId=$Anchor.AnchorRuntimeId
        AuthorRuntimeId=$Anchor.AnchorRuntimeId; ContainerRuntimeId=if($container){Get-RuntimeId $container}else{$null}
        BodyRuntimeId=$null; BoundaryMode=if($container){'Container'}elseif($range){'AssistantRange'}else{'VerticalRange'}
        Top=$top; Bottom=$bottom; AssistantRange=$range; Conversation=$Conversation; YTop=$top; YBottom=$bottom
        AnchorName=$Anchor.AnchorName
    }
}

function Find-ExactSubmittedUserMessage($Window, [string]$PromptText, $Composer, $BaselineIds, $BaselineCount, $BaselineTextIds) {
    $conversation = Find-ConversationContainer $Window
    $nodes = @(All-Desc $conversation)
    $hits = New-Object 'System.Collections.Generic.List[object]'
    $promptNorm = (([string]$PromptText) -replace "`r`n|`r|`n", ' ').Trim()
    $promptCompact = [regex]::Replace($promptNorm, '\s+', ' ').Trim()

    # Chromium may expose a long submitted prompt as several adjacent Text
    # nodes (for example, a Markdown paragraph followed by separate contract
    # paragraphs). Compare the complete bounded user-message body as well as a
    # single node; never broaden the search beyond the authenticated user
    # message boundary.
    # A long Chromium message may be represented below the normal viewport
    # cutoff even though its text nodes remain in the current conversation
    # container. This path is still bounded by the authenticated author
    # anchor, the next author anchor, and baseline identity checks.
    $userAnchors = @(Get-AuthorAnchors $conversation -IncludeDeepOffscreen | Where-Object { $_.Role -eq 'user' } | Sort-Object YTop)
    foreach ($userAnchor in $userAnchors) {
        try {
            if ($userAnchor.AnchorRuntimeId -and $BaselineIds -and $BaselineIds.Contains($userAnchor.AnchorRuntimeId)) { continue }
            $boundary = Resolve-MessageBoundary $conversation $userAnchor
            $nextAnchor = @(
                Get-AuthorAnchors $conversation -IncludeDeepOffscreen |
                    Where-Object { $_.YTop -gt $userAnchor.YTop } |
                    Sort-Object YTop |
                    Select-Object -First 1
            )
            $nextAnchorY = if ($nextAnchor) { [double]$nextAnchor[0].YTop } else { [double]::PositiveInfinity }
            $parts = New-Object 'System.Collections.Generic.List[string]'
            $matchingNodes = New-Object 'System.Collections.Generic.List[object]'
            foreach ($element in $nodes) {
                $current = $element.Current
                if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Text) { continue }
                if (Test-IsComposerDescendant $element) { continue }
                $rect = $current.BoundingRectangle
                if ($rect.Y -le $userAnchor.YTop) { continue }
                # The resolved container bottom may be stale while a scrolled
                # Chromium message has a very large negative Y. Bound the
                # assembled text by the next authenticated author anchor.
                if ($rect.Y -ge $nextAnchorY) { continue }
                $rawValue = ([string]$current.Name) -replace "`r`n|`r|`n", ' '
                $value = $rawValue.Trim()
                if (!$value -or ($value -match $script:ChromeNoise) -or ($value -match $script:AuthorAnchorPattern) -or ($value -match '^\d{1,2}:\d{2}$')) { continue }
                # Preserve UIA boundary whitespace for an exact comparison;
                # also keep a compact comparison for Chromium splits that
                # discard the blank-line separator between adjacent nodes.
                [void]$parts.Add($rawValue)
                [void]$matchingNodes.Add($element)
            }
            $assembled = (($parts.ToArray()) -join '').Trim()
            $assembledCompact = [regex]::Replace($assembled, '\s+', ' ').Trim()
            if (($assembled -ne $promptNorm) -and ($assembledCompact -ne $promptCompact)) { continue }
            $textNode = if ($matchingNodes.Count -gt 0) { $matchingNodes[0] } else { $null }
            $textRuntimeId = if ($textNode) { Get-RuntimeId $textNode } else { $null }
            if ($textRuntimeId -and $BaselineTextIds -and $BaselineTextIds.Contains($textRuntimeId)) { continue }
            [void]$hits.Add([pscustomobject]@{
                TextNode=$textNode; User=$userAnchor; Boundary=$boundary
            })
        } catch { }
    }
    if ($hits.Count -gt 0) { return $hits[$hits.Count - 1] }

    # Retain the original single-node check for short prompts and for UIA
    # implementations that expose the whole body as one Text element.
    foreach ($element in $nodes) {
        try {
            $current = $element.Current
            $nameNorm = (([string]$current.Name) -replace "`r`n|`r|`n", ' ').Trim()
            if (($current.ControlType -ne [System.Windows.Automation.ControlType]::Text) -or ($nameNorm -ne $promptNorm)) { continue }
            if (Test-IsComposerDescendant $element) { continue }
            $rect = $current.BoundingRectangle
            $userAnchor = $null
            foreach ($candidate in $nodes) {
                try {
                    $candidateCurrent = $candidate.Current
                    if (($candidateCurrent.ControlType -eq [System.Windows.Automation.ControlType]::Text) -and
                        ([string]$candidateCurrent.Name -match '^(Вы сказали|You said|User)\s*:')) {
                        $candidateRect = $candidateCurrent.BoundingRectangle
                        if (($candidateRect.Y -le $rect.Y) -and (!$userAnchor -or ($candidateRect.Y -gt $userAnchor.YTop))) {
                            $userAnchor = [pscustomobject]@{
                                AnchorElement=$candidate; AnchorRuntimeId=(Get-RuntimeId $candidate); Role='user'
                                AnchorName=[string]$candidateCurrent.Name; YTop=[double]$candidateRect.Y
                            }
                        }
                    }
                } catch { }
            }
            if (!$userAnchor) { continue }
            if ($userAnchor.AnchorRuntimeId -and $BaselineIds -and $BaselineIds.Contains($userAnchor.AnchorRuntimeId)) { continue }
            $textRuntimeId = Get-RuntimeId $element
            if ($textRuntimeId -and $BaselineTextIds -and $BaselineTextIds.Contains($textRuntimeId)) { continue }
            [void]$hits.Add([pscustomobject]@{
                TextNode=$element; User=$userAnchor; Boundary=(Resolve-MessageBoundary $conversation $userAnchor)
            })
        } catch { }
    }
    if ($hits.Count -eq 0) { return $null }
    return $hits[$hits.Count - 1]
}

function Confirm-SubmittedPrompt($Window, [string]$PromptText, [string]$Run, $Composer, $BaselineIds, $BaselineCount, $BaselineTextIds, $Deadline) {
    $last = $null
    do {
        Start-Sleep -Milliseconds 250
        $Window = Get-ActiveChatGPTSurface $Window
        $clear = Confirm-ComposerCleared $Window $PromptText
        if (!$clear.Found) {
            $last = [pscustomobject]@{ Confirmed=$false; ComposerCleared=$false; ExactUserMessageFound=$false; UserMessage=$null; Reason='COMPOSER_NOT_FOUND'; ComposerRuntimeIdAfter=$null; ComposerValue=$null }
            continue
        }
        if (!$clear.Cleared) {
            $last = [pscustomobject]@{ Confirmed=$false; ComposerCleared=$false; ExactUserMessageFound=$false; UserMessage=$null; Reason='PROMPT_STILL_IN_COMPOSER'; ComposerRuntimeIdAfter=$clear.RuntimeId; ComposerValue=$clear.Value }
            continue
        }
        $hit = Find-ExactSubmittedUserMessage $Window $PromptText $Composer $BaselineIds $BaselineCount $BaselineTextIds
        if ($hit -and $hit.User) {
            return [pscustomobject]@{ Confirmed=$true; ComposerCleared=$true; ExactUserMessageFound=$true; UserMessage=$hit.Boundary; Reason='CONFIRMED'; ComposerRuntimeIdAfter=$clear.RuntimeId; ComposerValue=$clear.Value }
        }
        $last = [pscustomobject]@{ Confirmed=$false; ComposerCleared=$true; ExactUserMessageFound=$false; UserMessage=$null; Reason='USER_MESSAGE_NOT_CONFIRMED'; ComposerRuntimeIdAfter=$clear.RuntimeId; ComposerValue=$clear.Value }
    } while ((Get-Date) -lt $Deadline)
    if ($last) { return $last }
    return [pscustomobject]@{ Confirmed=$false; ComposerCleared=$false; ExactUserMessageFound=$false; UserMessage=$null; Reason='SUBMIT_NOT_CONFIRMED' }
}

function Refresh-AssistantBinding($Assistant) {
    if (!$Assistant -or !$Assistant.Window -or !$Assistant.SubmittedPrompt) { return $null }
    $conversation = Find-ConversationContainer $Assistant.Window
    $nodes = @(All-Desc $conversation)
    $promptNorm = (([string]$Assistant.SubmittedPrompt) -replace "`r`n|`r|`n", ' ').Trim()
    $promptNodes = New-Object 'System.Collections.Generic.List[object]'
    foreach ($element in $nodes) {
        try {
            $current = $element.Current
            $nameNorm = (([string]$current.Name) -replace "`r`n|`r|`n", ' ').Trim()
            if (($current.ControlType -eq [System.Windows.Automation.ControlType]::Text) -and
                ($nameNorm -eq $promptNorm) -and !(Test-IsComposerDescendant $element)) {
                [void]$promptNodes.Add($element)
            }
        } catch { }
    }
    if ($promptNodes.Count -eq 0) { return $null }
    $promptNode = $promptNodes[$promptNodes.Count - 1]
    try { $promptY = [double]$promptNode.Current.BoundingRectangle.Y } catch { return $null }
    $anchors = @(Get-AuthorAnchors $conversation)
    $userAnchor = @($anchors | Where-Object { ($_.Role -eq 'user') -and ($_.YTop -le $promptY) } | Sort-Object YTop | Select-Object -Last 1)
    if (!$userAnchor) { return $null }
    $nextUser = @($anchors | Where-Object { ($_.Role -eq 'user') -and ($_.YTop -gt $userAnchor[0].YTop) } | Sort-Object YTop | Select-Object -First 1)
    $assistantLimit = if ($nextUser) { [double]$nextUser[0].YTop } else { 1e9 }
    $assistantAnchor = @($anchors | Where-Object {
        ($_.Role -eq 'assistant') -and ($_.YTop -gt $userAnchor[0].YTop) -and ($_.YTop -lt $assistantLimit)
    } | Sort-Object YTop | Select-Object -First 1)
    if (!$assistantAnchor) { return $null }
    $bound = Resolve-MessageBoundary $conversation $assistantAnchor $assistantLimit
    if (!$bound) { return $null }
    $bound | Add-Member -NotePropertyName Window -NotePropertyValue $Assistant.Window -Force
    $bound | Add-Member -NotePropertyName SubmittedPrompt -NotePropertyValue $Assistant.SubmittedPrompt -Force
    $bound | Add-Member -NotePropertyName UserRuntimeId -NotePropertyValue $userAnchor[0].AnchorRuntimeId -Force
    return $bound
}

function Get-MessageContainers($Conversation) {
    $result = New-Object 'System.Collections.Generic.List[object]'
    foreach ($anchor in @(Get-AuthorAnchors $Conversation)) {
        $message = Resolve-MessageBoundary $Conversation $anchor
        if ($message) { [void]$result.Add($message) }
    }
    return @($result.ToArray())
}

function Get-MessageText($Message) {
    $texts = New-Object 'System.Collections.Generic.List[string]'
    $range = $Message.AssistantRange
    foreach ($element in @(All-Desc $Message.Conversation)) {
        try {
            $current = $element.Current
            if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Text) { continue }
            $value = ([string]$current.Name).Trim()
            $y = [double]$current.BoundingRectangle.Y
            $include = $true
            $reason = 'inside-boundary'
            if (Test-IsComposerDescendant $element) {
                $include = $false; $reason = 'composer-descendant'
            } elseif (($Message.Role -eq 'assistant') -and $range -and
                (($range.EndY -le $range.StartY) -or ($y -lt $range.StartY) -or ($y -ge $range.EndY))) {
                $include = $false
                $reason = if ($y -le $range.StartY) { 'before-body-range' } else { 'after-body-range' }
            } elseif (($Message.Role -ne 'assistant') -and
                (($y -lt $Message.Top) -or (($Message.Bottom -gt $Message.Top) -and ($y -ge $Message.Bottom)))) {
                $include = $false; $reason = 'outside-boundary'
            } elseif (!$value -or ($value -match $script:ChromeNoise) -or ($value -match '^\d{1,2}:\d{2}$') -or ($value -eq $Message.AnchorName)) {
                $include = $false; $reason = 'known-non-body-text'
            }
            # Detailed per-node extraction is diagnostic-only. The normal path
            # keeps the bounded stream trace but does not repeatedly serialize
            # the entire UIA subtree on every polling iteration.
            if ($VerboseLog) {
                $trace = [ordered]@{ RuntimeId=(Get-RuntimeId $element); Name=$value; Y=$y; Included=$include; Reason=$reason }
                $tracePath = Join-Path $PSScriptRoot ('diagnostics\assistant_extract_' + $RunId + '.jsonl')
                New-Item -ItemType Directory -Path (Split-Path -Parent $tracePath) -Force | Out-Null
                ($trace | ConvertTo-Json -Compress) | Add-Content -LiteralPath $tracePath -Encoding UTF8
            }
            if ($include) { [void]$texts.Add($value) }
        } catch { }
    }
    return (($texts -join "`n").Trim())
}

function Get-ScopedAssistantNodes($Assistant) {
    if (!$Assistant -or !$Assistant.Conversation -or !$Assistant.AnchorRuntimeId) { return @() }
    $source = $Assistant.Conversation
    if (($Assistant.BoundaryMode -eq 'Container') -and $Assistant.ContainerElement) { $source = $Assistant.ContainerElement }
    $nodes = @(All-Desc $source)
    $start = -1
    for ($i = 0; $i -lt $nodes.Count; $i++) {
        try { if ((Get-RuntimeId $nodes[$i]) -eq $Assistant.AnchorRuntimeId) { $start = $i; break } }
        catch { }
    }
    if (($start -lt 0) -and ($source -ne $Assistant.Conversation)) {
        $source = $Assistant.Conversation
        $nodes = @(All-Desc $source)
        for ($i = 0; $i -lt $nodes.Count; $i++) {
            try { if ((Get-RuntimeId $nodes[$i]) -eq $Assistant.AnchorRuntimeId) { $start = $i; break } }
            catch { }
        }
    }
    if ($start -lt 0) { return @() }
    $end = $nodes.Count
    for ($i = $start + 1; $i -lt $nodes.Count; $i++) {
        try {
            $current = $nodes[$i].Current
            if (($current.ControlType -eq [System.Windows.Automation.ControlType]::Text) -and
                ([string]$current.Name -match $script:AuthorAnchorPattern)) {
                $end = $i; break
            }
        } catch { }
    }
    if ($end -le $start) { return @() }
    return @($nodes[$start..($end - 1)])
}

function Get-AssistantBodyMarkers($Assistant) {
    $markers = New-Object 'System.Collections.Generic.List[string]'
    foreach ($element in @(Get-ScopedAssistantNodes $Assistant)) {
        try {
            $current = $element.Current
            if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Text) { continue }
            $value = ([string]$current.Name).Trim()
            if (!$value -or ($value -match $script:ChromeNoise) -or ($value -match '^\d{1,2}:\d{2}$') -or (Test-IsComposerDescendant $element)) { continue }
            if ($value -match $script:AuthorAnchorPattern) { continue }
            [void]$markers.Add($value)
        } catch { }
    }
    return @($markers.ToArray())
}

function Test-IsDescendantOf($Element, $Ancestor) {
    if (!$Element -or !$Ancestor) { return $false }
    $target = Get-RuntimeId $Ancestor
    if (!$target) { return $false }
    foreach ($parent in @(Get-ElementAncestors $Element)) {
        if ((Get-RuntimeId $parent) -eq $target) { return $true }
    }
    return $false
}

function Get-SupportedPatternNames($Element) {
    $patterns = [ordered]@{
        Invoke=[System.Windows.Automation.InvokePattern]
        ScrollItem=[System.Windows.Automation.ScrollItemPattern]
        Value=[System.Windows.Automation.ValuePattern]
        Text=[System.Windows.Automation.TextPattern]
        Toggle=[System.Windows.Automation.TogglePattern]
        Scroll=[System.Windows.Automation.ScrollPattern]
    }
    $result = New-Object 'System.Collections.Generic.List[string]'
    foreach ($name in $patterns.Keys) {
        try {
            [object]$pattern = $null
            if ($Element.TryGetCurrentPattern($patterns[$name]::Pattern, [ref]$pattern)) { [void]$result.Add($name) }
        } catch { }
    }
    return @($result.ToArray())
}

function Find-CopyButtonForAssistant($Assistant) {
    $notFound = [pscustomobject]@{
        Found=$false; Error='COPY_BUTTON_NOT_FOUND'; Message='No uniquely paired enabled Copy button'; Element=$null
        RuntimeId=$null; ParentRuntimeId=$null; ControlType='ControlType.Button'; Name=$null; AutomationId=$null
        ClassName=$null; BoundingRectangle=$null; IsEnabled=$false; IsOffscreen=$false; SupportedPatterns=@()
        RelationMode=$null; Y=0; CandidateCount=0; CopyPresent=$false; CopyEnabled=$false
    }
    if (!$Assistant -or !$Assistant.AnchorRuntimeId) {
        $notFound.Error = 'COPY_ASSISTANT_PAIRING_ERROR'
        $notFound.Message = 'Assistant boundary has no author anchor'
        return $notFound
    }
    $nodes = @(Get-ScopedAssistantNodes $Assistant)
    $candidates = New-Object 'System.Collections.Generic.List[object]'
    foreach ($element in $nodes) {
        try {
            $current = $element.Current
            $name = ([string]$current.Name).Trim()
            if (($current.ControlType -ne [System.Windows.Automation.ControlType]::Button) -or
                ($name -notmatch '^(Копировать|Copy)$')) { continue }
            $rect = $current.BoundingRectangle
            if (($rect.Width -le 0) -or ($rect.Height -le 0) -or [double]::IsNaN($rect.Y) -or [double]::IsInfinity($rect.Y)) { continue }
            $parentId = Get-ImmediateParentRuntimeId $element
            $anchorParentId = Get-ImmediateParentRuntimeId $Assistant.AnchorElement
            # The current Chromium tree has a common relative shrink-0 parent for
            # every message.  That parent is not a message container, so sharing it
            # is deliberately not treated as proof of pairing.  The safe relation
            # is the bounded author-anchor-to-next-author range below.
            $relation = 'VerticalRange'
            if ($Assistant.ContainerElement -and (Test-IsDescendantOf $element $Assistant.ContainerElement)) {
                $relation = 'ContainerDescendant'
            }
            [void]$candidates.Add([pscustomobject]@{
                Element=$element; RuntimeId=(Get-RuntimeId $element); ParentRuntimeId=$parentId
                ControlType=$current.ControlType.ProgrammaticName; Name=$name; AutomationId=[string]$current.AutomationId
                ClassName=[string]$current.ClassName; BoundingRectangle=[string]$rect; IsEnabled=[bool]$current.IsEnabled
                IsOffscreen=[bool]$current.IsOffscreen; SupportedPatterns=@(Get-SupportedPatternNames $element)
                RelationMode=$relation; Y=[double]$rect.Y
            })
        } catch { }
    }
    if ($candidates.Count -eq 0) {
        $notFound.CandidateCount = 0
        $notFound.CopyPresent = $false
        $notFound.CopyEnabled = $false
        return $notFound
    }
    if ($candidates.Count -ne 1) {
        $notFound.Error = 'COPY_BUTTON_AMBIGUOUS'
        $notFound.Message = "Found $($candidates.Count) Copy buttons in the assistant bound"
        $notFound.CandidateCount = $candidates.Count
        $notFound.CopyPresent = $true
        $notFound.CopyEnabled = [bool](@($candidates | Where-Object { $_.IsEnabled }).Count -gt 0)
        return $notFound
    }
    $selected = $candidates[0]
    if (!$selected.IsEnabled) {
        $notFound.Message = 'The paired Copy button is present but disabled'
        $notFound.CandidateCount = 1
        $notFound.CopyPresent = $true
        return $notFound
    }
    $selected | Add-Member -NotePropertyName Found -NotePropertyValue $true
    $selected | Add-Member -NotePropertyName Error -NotePropertyValue $null
    $selected | Add-Member -NotePropertyName Message -NotePropertyValue 'Unique enabled Copy button paired to assistant'
    $selected | Add-Member -NotePropertyName CandidateCount -NotePropertyValue 1
    $selected | Add-Member -NotePropertyName CopyPresent -NotePropertyValue $true
    $selected | Add-Member -NotePropertyName CopyEnabled -NotePropertyValue $true
    return $selected
}

function Normalize-CopiedText([string]$Text) {
    if ($null -eq $Text) { return $null }
    return (($Text -replace "`r`n", "`n") -replace "`r", "`n").TrimEnd("`n")
}

function Get-TextHash([string]$Text) {
    if ($null -eq $Text) { return $null }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
}

function Write-CopyTrace([string]$TraceRunId, $Row, [switch]$Detailed) {
    if (!$Detailed -and !$script:HeavyDiagnosticsPerformed -and !$VerboseLog) {
        # Detailed probe rows are diagnostic-only; the normal path writes one
        # compact final record via Write-CopyTraceFinal.
        return
    }
    try {
        $directory = Join-Path $PSScriptRoot 'diagnostics'
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        $path = Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $TraceRunId + '.jsonl')
        ($Row | ConvertTo-Json -Compress -Depth 12) | Add-Content -LiteralPath $path -Encoding UTF8
    } catch { Write-Log 'copy-trace' "failed=$($_.Exception.Message)" }
}

function Write-CopyTraceFinal([string]$TraceRunId, $Row) {
    try {
        $path = Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $TraceRunId + '.jsonl')
        $compact = [ordered]@{
            Confirmed=$true; CopyRuntimeId=$Row.CopyRuntimeId; AssistantRuntimeId=$Row.AssistantRuntimeId
            RelationMode=$Row.RelationMode; CandidateCount=$Row.CandidateCount
            ClipboardChanged=$Row.ClipboardChanged; CopiedLength=$Row.CopiedLength; CopiedHash=$Row.CopiedHash
            Error=$null; Message='Copy confirmed'
        }
        Set-Content -LiteralPath $path -Value ($compact | ConvertTo-Json -Compress) -Encoding UTF8
    } catch { Write-Log 'copy-trace' "final failed=$($_.Exception.Message)" }
}

function Invoke-ScrollItemIntoView($Element) {
    if (!$Element) { return $false }
    try {
        [object]$pattern = $null
        if (!$Element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$pattern)) { return $false }
        $pattern.ScrollIntoView()
        return $true
    } catch { return $false }
}

function Invoke-ButtonStrict($Element) {
    $runtimeId = Get-RuntimeId $Element
    if (!$Element) {
        return [pscustomobject]@{ Succeeded=$false; Error='COPY_INVOKE_FAILED'; Message='Copy element is missing'; RuntimeId=$null }
    }
    try {
        [object]$pattern = $null
        if (!$Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            return [pscustomobject]@{ Succeeded=$false; Error='COPY_INVOKE_FAILED'; Message='InvokePattern is unavailable'; RuntimeId=$runtimeId }
        }
        try {
            $pattern.Invoke()
            return [pscustomobject]@{ Succeeded=$true; Error=$null; Message='InvokePattern.Invoke completed'; RuntimeId=$runtimeId }
        } catch [System.Windows.Automation.ElementNotAvailableException] {
            return [pscustomobject]@{ Succeeded=$false; Error='COPY_INVOKE_FAILED'; Message='Copy element became stale during Invoke'; RuntimeId=$runtimeId }
        } catch {
            return [pscustomobject]@{ Succeeded=$false; Error='COPY_INVOKE_FAILED'; Message=$_.Exception.Message; RuntimeId=$runtimeId }
        }
    } catch {
        return [pscustomobject]@{ Succeeded=$false; Error='COPY_INVOKE_FAILED'; Message=$_.Exception.Message; RuntimeId=$runtimeId }
    }
}

function Wait-CopyButtonForAssistant($Assistant, [int]$TimeoutMs = 5000, [int]$PollMs = 200) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $deadline = (Get-Date).AddMilliseconds([Math]::Max(0, $TimeoutMs))
    $currentAssistant = $Assistant
    $last = $null
    $polls = 0
    do {
        $polls++
        $last = Find-CopyButtonForAssistant $currentAssistant
        if ($last.Found) {
            $watch.Stop()
            return [pscustomobject]@{ Found=$true; Candidate=$last; Assistant=$currentAssistant; Error=$null; Message='Copy button appeared in the assistant bound'; Polls=$polls; DurationMs=$watch.ElapsedMilliseconds }
        }
        # Multiple Copy controls are a real ambiguity and must stop immediately.
        if ($last.Error -eq 'COPY_BUTTON_AMBIGUOUS') {
            $watch.Stop()
            return [pscustomobject]@{ Found=$false; Candidate=$last; Assistant=$currentAssistant; Error=$last.Error; Message=$last.Message; Polls=$polls; DurationMs=$watch.ElapsedMilliseconds }
        }
        # During delayed action-row mounting Chromium can replace the anchor and
        # temporarily make the old scoped query empty. Rebind by the exact prompt
        # while waiting; do not widen the search to a global Copy button.
        try {
            $rebound = Refresh-AssistantBinding $currentAssistant
            if ($rebound) { $currentAssistant = $rebound }
        } catch { }
        if ((Get-Date) -ge $deadline) { break }
        Start-Sleep -Milliseconds ([Math]::Max(100, $PollMs))
    } while ((Get-Date) -lt $deadline)
    $watch.Stop()
    $error = if ($last -and $last.Error) { $last.Error } else { 'COPY_BUTTON_NOT_FOUND' }
    $message = if ($last -and $last.Message) { $last.Message } else { 'Copy button did not appear before the wait deadline' }
    return [pscustomobject]@{ Found=$false; Candidate=$last; Assistant=$currentAssistant; Error=$error; Message=$message; Polls=$polls; DurationMs=$watch.ElapsedMilliseconds }
}

function Copy-AssistantResponse($Assistant, [string]$CopyRunId, [int]$TimeoutMs = 4000) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $sentinel = 'DSH_CLIPBOARD_SENTINEL_' + $CopyRunId + '_' + ([guid]::NewGuid().ToString('N').ToUpperInvariant())
    $old = $null
    $oldReadable = $false
    $sentinelSet = $false
    $copied = $null
    $clipboardChanged = $false
    $probe = $null
    $trace = [ordered]@{
        timestamp=(Get-Date).ToString('o'); UserRuntimeId=if($Assistant.PSObject.Properties['UserRuntimeId']){[string]$Assistant.UserRuntimeId}else{$null}
        AssistantRuntimeId=$Assistant.AnchorRuntimeId; CopyRuntimeId=$null; CopyParentRuntimeId=$null; CopyName=$null
        CopyAutomationId=$null; CopyClassName=$null; CopyBoundingRectangle=$null; CopyIsEnabled=$false; CopyIsOffscreen=$false
        CopySupportedPatterns=@(); CopyY=$null; RelationMode=$null; CandidateCount=0; InvokeAttempted=$false
        ClipboardSentinel=$sentinel; ClipboardChanged=$false; CopiedLength=0; CopiedHash=$null
        ScrollIntoViewAttempted=$false; ScrollIntoViewSucceeded=$false
        StopPresent=if($Assistant.PSObject.Properties['StopPresent']){[bool]$Assistant.StopPresent}else{$false}; CopyEnabled=$false
        Error=$null; Message=$null
    }
    try { $old = Get-Clipboard -Raw -ErrorAction Stop; $oldReadable = $true } catch { }

    $initialMarkers = @(Get-AssistantBodyMarkers $Assistant)
    # The response text can stabilize before the action row is mounted.  Wait
    # for that row instead of treating the first missing Copy as a failure.
    $wait = Wait-CopyButtonForAssistant $Assistant 5000 200
    if ($wait.Found -and $wait.Assistant) { $Assistant = $wait.Assistant }
    $probe = $wait.Candidate
    $trace.AssistantRuntimeId = $Assistant.AnchorRuntimeId
    $trace.CopyRuntimeId = if($probe){$probe.RuntimeId}else{$null}
    $trace.CopyParentRuntimeId = if($probe){$probe.ParentRuntimeId}else{$null}
    $trace.CopyName = if($probe){$probe.Name}else{$null}
    $trace.CopyAutomationId = if($probe){$probe.AutomationId}else{$null}
    $trace.CopyClassName = if($probe){$probe.ClassName}else{$null}
    $trace.CopyBoundingRectangle = if($probe){$probe.BoundingRectangle}else{$null}
    $trace.CopyIsEnabled = if($probe){$probe.IsEnabled}else{$false}
    $trace.CopyIsOffscreen = if($probe){$probe.IsOffscreen}else{$false}
    $trace.CopySupportedPatterns = if($probe){@($probe.SupportedPatterns)}else{@()}
    $trace.CopyY = if($probe){$probe.Y}else{$null}
    $trace.RelationMode = if($probe){$probe.RelationMode}else{$null}
    $trace.CandidateCount = if($probe){$probe.CandidateCount}else{0}
    $trace.CopyEnabled = if($probe){$probe.CopyEnabled}else{$false}
    if (!$probe.Found) {
        $trace.Error = $probe.Error
        $trace.Message = $probe.Message
        Write-CopyTrace $CopyRunId ([pscustomobject]$trace)
        return [pscustomobject]@{ Confirmed=$false; Text=$null; Error=$probe.Error; Message=$probe.Message; CopyRuntimeId=$probe.RuntimeId; DurationMs=0; LegacyText=$null; TracePath=(Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $CopyRunId + '.jsonl')) }
    }

    try {
        Set-Clipboard -Value $sentinel -ErrorAction Stop
        $sentinelSet = $true
    } catch {
        $trace.Error = 'COPY_NOT_CONFIRMED'; $trace.Message = 'Could not set clipboard sentinel'
        Write-CopyTrace $CopyRunId ([pscustomobject]$trace)
        return [pscustomobject]@{ Confirmed=$false; Text=$null; Error='COPY_NOT_CONFIRMED'; Message='Could not set clipboard sentinel'; CopyRuntimeId=$probe.RuntimeId; DurationMs=0; LegacyText=$null; TracePath=(Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $CopyRunId + '.jsonl')) }
    }

    try {
        # Setting the sentinel can trigger another Chromium accessibility-tree
        # rebuild. Wait for the same bounded assistant scope to expose Copy again;
        # never widen this query to all buttons in the conversation.
        $freshWait = Wait-CopyButtonForAssistant $Assistant 2000 150
        if ($freshWait.Found -and $freshWait.Assistant) { $Assistant = $freshWait.Assistant }
        $fresh = $freshWait.Candidate
        if (!$freshWait.Found) {
            $error = if($freshWait.Error){$freshWait.Error}else{'COPY_ASSISTANT_PAIRING_ERROR'}
            $message = if($freshWait.Message){$freshWait.Message}else{'Copy pairing changed before Invoke'}
            $trace.Error = $error; $trace.Message = $message
            Write-CopyTrace $CopyRunId ([pscustomobject]$trace)
            return [pscustomobject]@{ Confirmed=$false; Text=$null; Error=$error; Message=$message; CopyRuntimeId=if($probe){$probe.RuntimeId}else{$null}; DurationMs=0; LegacyText=$null; TracePath=(Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $CopyRunId + '.jsonl')) }
        }
        $trace.CopyRuntimeId = $fresh.RuntimeId
        $trace.CopyParentRuntimeId = $fresh.ParentRuntimeId
        $trace.CopyName = $fresh.Name
        $trace.CopyAutomationId = $fresh.AutomationId
        $trace.CopyClassName = $fresh.ClassName
        $trace.CopyBoundingRectangle = $fresh.BoundingRectangle
        $trace.CopyIsEnabled = $fresh.IsEnabled
        $trace.CopyIsOffscreen = $fresh.IsOffscreen
        $trace.CopySupportedPatterns = @($fresh.SupportedPatterns)
        $trace.CopyY = $fresh.Y
        $trace.RelationMode = $fresh.RelationMode
        $trace.CopyEnabled = $fresh.CopyEnabled
        if ($fresh.IsOffscreen) {
            $trace.ScrollIntoViewAttempted = $true
            $trace.ScrollIntoViewSucceeded = Invoke-ScrollItemIntoView $fresh.Element
            Write-CopyTrace $CopyRunId ([pscustomobject]$trace)
            Start-Sleep -Milliseconds 250
            $w = Get-ActiveChatGPTSurface $Assistant.Window
            $rebound = Refresh-AssistantBinding $Assistant
            if ($rebound) { $Assistant = $rebound }
            $visible = Find-CopyButtonForAssistant $Assistant
            if (!$visible.Found) {
                $trace.Error = if($visible.Error){$visible.Error}else{'COPY_BUTTON_NOT_FOUND'}
                $trace.Message = 'Bound Copy remained unavailable after ScrollItemPattern'
                Write-CopyTrace $CopyRunId ([pscustomobject]$trace)
                return [pscustomobject]@{ Confirmed=$false; Text=$null; Error=$trace.Error; Message=$trace.Message; CopyRuntimeId=$fresh.RuntimeId; DurationMs=0; LegacyText=$null; TracePath=(Join-Path $PSScriptRoot ('diagnostics\\copy_trace_' + $CopyRunId + '.jsonl')) }
            }
            $fresh = $visible
            $trace.CopyRuntimeId = $fresh.RuntimeId
            $trace.CopyBoundingRectangle = $fresh.BoundingRectangle
            $trace.CopyIsOffscreen = $fresh.IsOffscreen
            $trace.CopySupportedPatterns = @($fresh.SupportedPatterns)
            $trace.CopyY = $fresh.Y
            $trace.CopyEnabled = $fresh.CopyEnabled
        }
        $trace.InvokeAttempted = $true
        Write-CopyTrace $CopyRunId ([pscustomobject]$trace)

        $invoke = Invoke-ButtonStrict $fresh.Element
        if (!$invoke.Succeeded) {
            $trace.Error = $invoke.Error; $trace.Message = $invoke.Message
            Write-CopyTrace $CopyRunId ([pscustomobject]$trace)
            return [pscustomobject]@{ Confirmed=$false; Text=$null; Error='COPY_INVOKE_FAILED'; Message=$invoke.Message; CopyRuntimeId=$fresh.RuntimeId; DurationMs=0; LegacyText=$null; TracePath=(Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $CopyRunId + '.jsonl')) }
        }

        $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
        do {
            Start-Sleep -Milliseconds 150
            try { $value = Get-Clipboard -Raw -ErrorAction Stop } catch { $value = $null }
            if (($null -ne $value) -and ([string]$value -ne $sentinel)) {
                $clipboardChanged = $true
                $copied = Normalize-CopiedText ([string]$value)
                break
            }
        } while ((Get-Date) -lt $deadline)
        $watch.Stop()
        $trace.ClipboardChanged = $clipboardChanged
        $trace.CopiedLength = if($null -ne $copied){$copied.Length}else{0}
        $trace.CopiedHash = Get-TextHash $copied
        $trace.Message = 'Clipboard polling completed'
        Write-CopyTrace $CopyRunId ([pscustomobject]$trace)
        if (!$clipboardChanged) {
            return [pscustomobject]@{ Confirmed=$false; Text=$null; Error='COPY_NOT_CONFIRMED'; Message='Clipboard sentinel was not replaced after Invoke'; CopyRuntimeId=$fresh.RuntimeId; DurationMs=$watch.ElapsedMilliseconds; LegacyText=$null; TracePath=(Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $CopyRunId + '.jsonl')) }
        }
        if ([string]::IsNullOrWhiteSpace($copied)) {
            return [pscustomobject]@{ Confirmed=$false; Text=$null; Error='COPY_EMPTY'; Message='Copy produced empty clipboard text'; CopyRuntimeId=$fresh.RuntimeId; DurationMs=$watch.ElapsedMilliseconds; LegacyText=$null; TracePath=(Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $CopyRunId + '.jsonl')) }
        }

        $refreshedAssistant = Refresh-AssistantBinding $Assistant
        if ($refreshedAssistant) {
            $Assistant = $refreshedAssistant
            $trace.AssistantRuntimeId = $Assistant.AnchorRuntimeId
            $trace.UserRuntimeId = if($Assistant.PSObject.Properties['UserRuntimeId']){[string]$Assistant.UserRuntimeId}else{$trace.UserRuntimeId}
        }
        $markers = @(Get-AssistantBodyMarkers $Assistant)
        $belongs = $false
        foreach ($marker in $markers) {
            if ($marker -and $copied.Contains($marker)) { $belongs = $true; break }
        }
        if (!$belongs) {
            $legacy = ($markers -join "`n")
            return [pscustomobject]@{ Confirmed=$false; Text=$null; Error='COPY_ASSISTANT_PAIRING_ERROR'; Message='Clipboard text has no marker from the paired assistant body'; CopyRuntimeId=$fresh.RuntimeId; DurationMs=$watch.ElapsedMilliseconds; LegacyText=$legacy; TracePath=(Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $CopyRunId + '.jsonl')) }
        }
        if ($Assistant.PSObject.Properties['SubmittedPrompt'] -and $Assistant.SubmittedPrompt -and $copied.Contains([string]$Assistant.SubmittedPrompt)) {
            return [pscustomobject]@{ Confirmed=$false; Text=$null; Error='COPY_ASSISTANT_PAIRING_ERROR'; Message='Clipboard text contains the submitted prompt'; CopyRuntimeId=$fresh.RuntimeId; DurationMs=$watch.ElapsedMilliseconds; LegacyText=($markers -join "`n"); TracePath=(Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $CopyRunId + '.jsonl')) }
        }
        $after = Find-CopyButtonForAssistant $Assistant
        if (!$after.Found -and ($after.Error -eq 'COPY_BUTTON_AMBIGUOUS')) {
            return [pscustomobject]@{ Confirmed=$false; Text=$null; Error='COPY_BUTTON_AMBIGUOUS'; Message='Copy pairing became ambiguous after Invoke'; CopyRuntimeId=$fresh.RuntimeId; DurationMs=$watch.ElapsedMilliseconds; LegacyText=($markers -join "`n"); TracePath=(Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $CopyRunId + '.jsonl')) }
        }
        # A rerender can temporarily remove the control from RawView.  The Copy
        # transaction itself is proven by sentinel replacement; never fall back
        # to a global button or to the old clipboard value.  Keep the originally
        # paired runtime id in the result when post-check is only NOT_FOUND.
        $resultCopyId = if($after.Found){$after.RuntimeId}else{$fresh.RuntimeId}
        $trace.CopyRuntimeId = $resultCopyId
        $trace.AssistantRuntimeId = $Assistant.AnchorRuntimeId
        $trace.RelationMode = $fresh.RelationMode
        $trace.CandidateCount = $fresh.CandidateCount
        $trace.ClipboardChanged = $true
        $trace.CopiedLength = $copied.Length
        $trace.CopiedHash = Get-TextHash $copied
        Write-CopyTraceFinal $CopyRunId ([pscustomobject]$trace)
        return [pscustomobject]@{ Confirmed=$true; Text=$copied; Error=$null; Message='Copied text confirmed by sentinel and assistant marker'; CopyRuntimeId=$resultCopyId; DurationMs=$watch.ElapsedMilliseconds; LegacyText=($markers -join "`n"); TracePath=(Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $CopyRunId + '.jsonl')) }
    } finally {
        if ($sentinelSet) {
            try {
                $currentClipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue
                if (([string]$currentClipboard -eq $sentinel) -or (($null -ne $copied) -and ([string]$currentClipboard -eq $copied))) {
                    if ($oldReadable) { Set-Clipboard -Value $old -ErrorAction SilentlyContinue }
                }
            } catch { }
        }
    }
}

function Confirm-ComposerPrompt($Window, [string]$PromptText, $ExpectedComposer) {
    $deadline = (Get-Date).AddSeconds(4)
    $previousRuntimeId = $null
    $previousValue = $null
    $stable = 0
    $last = $null
    do {
        $candidate = Find-Composer $Window
        if ($candidate -and (Is-UiaElementAlive $candidate) -and
            (!$ExpectedComposer -or (Same-Surface $ExpectedComposer $candidate))) {
            $value = Get-ComposerValue $candidate
            $runtimeId = Get-RuntimeId $candidate
            $last = $candidate
            if ((Test-ComposerPromptValue $value $PromptText) -and
                $runtimeId -and ($runtimeId -ceq $previousRuntimeId) -and ([string]$value -ceq [string]$previousValue)) {
                $stable++
            } elseif (Test-ComposerPromptValue $value $PromptText) {
                $stable = 1
            } else {
                $stable = 0
            }
            $previousRuntimeId = $runtimeId
            $previousValue = [string]$value
            if ($stable -ge 2) {
                return [pscustomobject]@{ Confirmed=$true; Composer=$candidate; RuntimeId=$runtimeId; Reason='TWO_STABLE_READBACKS' }
            }
        } else { $stable = 0 }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $deadline)
    return [pscustomobject]@{ Confirmed=$false; Composer=$last; RuntimeId=(Get-RuntimeId $last); Reason='COMPOSER_CHANGED_OR_READBACK_FAILED' }
}

function Invoke-Button($Element) {
    $result = Invoke-ButtonStrict $Element
    return [bool]$result.Succeeded
}

function Save-MessageParentChain($Conversation, [string]$DiagnosticRunId) {
    try {
        $rows = New-Object 'System.Collections.Generic.List[object]'
        $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
        foreach ($anchor in @(Get-AuthorAnchors $Conversation)) {
            $chain = New-Object 'System.Collections.Generic.List[object]'
            $currentElement = $anchor.AnchorElement
            for ($depth = 0; $depth -lt 12 -and $currentElement; $depth++) {
                try {
                    $current = $currentElement.Current
                    $descendants = @(All-Desc $currentElement)
                    [void]$chain.Add([pscustomobject]@{
                        Depth=$depth; RuntimeId=(Get-RuntimeId $currentElement); ParentRuntimeId=(Get-ImmediateParentRuntimeId $currentElement)
                        ControlType=$current.ControlType.ProgrammaticName; ClassName=$current.ClassName; AutomationId=$current.AutomationId
                        Name=$current.Name; BoundingRectangle=[string]$current.BoundingRectangle
                        DescendantTextCount=@($descendants | Where-Object { try { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text } catch { $false } }).Count
                        DescendantButtonCount=@($descendants | Where-Object { try { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } catch { $false } }).Count
                    })
                    $currentElement = $walker.GetParent($currentElement)
                } catch { break }
            }
            [void]$rows.Add([pscustomobject]@{ Role=$anchor.Role; AnchorRuntimeId=$anchor.AnchorRuntimeId; AnchorName=$anchor.AnchorName; YTop=$anchor.YTop; Ancestors=@($chain.ToArray()) })
        }
        $path = Join-Path $PSScriptRoot ('diagnostics\message_parent_chain_' + $DiagnosticRunId + '.json')
        New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
        $rows.ToArray() | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $path -Encoding UTF8
    } catch { Write-Log 'diagnostic' "parent-chain failed=$($_.Exception.Message)" }
}

function Save-FailureDump($Window, [string]$Code) {
    $script:HeavyDiagnosticsPerformed = $true
    try {
        $directory = Join-Path $PSScriptRoot 'logs'
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        $targetPid = 0
        try { $targetPid = [int]$Window.Current.ProcessId } catch { }
        & (Join-Path $PSScriptRoot 'chatgpt_uia_dump.ps1') `
            -TargetPid $targetPid `
            -Path (Join-Path $directory ('failure_' + $RunId + '_uia.txt')) `
            -JsonPath (Join-Path $directory ('failure_' + $RunId + '_uia.json')) | Out-Null
        $diagnosticConversation = if ($Window) { Find-ConversationContainer $Window } else { $null }
        if ($diagnosticConversation) { Save-MessageParentChain $diagnosticConversation ('failure_' + $RunId) }
        if ($freshDiagnostic) {
            $freshDiagnostic | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $directory ('failure_' + $RunId + '_fresh.json')) -Encoding UTF8
        }
        $composer = if ($Window) { Find-Composer $Window } else { $null }
        $composerValue = if ($composer) { Get-ComposerValue $composer } else { '' }
        $promptPresent = if ([string]::IsNullOrEmpty($Prompt)) { $false } else { ([string]$composerValue).Contains([string]$Prompt) }
        $notes = @(
            "RunId: $RunId",
            "FailureStage: $Code",
            "TargetPid: $targetPid",
            "ActiveSurface: ChatGPT/Codex",
            "ComposerRuntimeId: $(Get-RuntimeId $composer)",
            "ComposerContainsPrompt: $promptPresent",
            "ComposerValueLength: $(([string]$composerValue).Length)",
            'VisualInspection: required via Computer Use',
            'Private screenshot: not saved',
            'UIA/visual discrepancy: inspect the accompanying dump before retry',
            "FreshReason: $freshReason",
            "FreshDiagnosticPath: $(if($freshDiagnostic){Join-Path $directory ('failure_' + $RunId + '_fresh.json')}else{$null})"
        ) | Out-String
        Set-Content -LiteralPath (Join-Path $directory ('failure_' + $RunId + '_computer_use_notes.md')) -Value $notes -Encoding UTF8
    } catch { Write-Log 'diagnostic' "dump failed=$($_.Exception.Message)" }
}

try {
    if ($TimeoutSeconds -lt 5) { Fail 'INVALID_ARGUMENT' 'TimeoutSeconds must be at least 5' 1 }
    $logDirectory = if ($LogPath) { Split-Path -Parent $LogPath } else { $null }
    if ($logDirectory) { New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null }
    Write-Log 'start' "mode=$modeOut promptLength=$($Prompt.Length)"

    $mutex = New-Object System.Threading.Mutex($false, 'Global\LunaChatGPTDesktopBridge')
    if (!$mutex.WaitOne(10000)) { Fail 'BUSY' 'Another bridge invocation is controlling Desktop' 1 }

    $w = Wait-MainWindow
    $hostInfo = Get-DesktopHost
    $hostFound = [bool]$hostInfo
    if ($hostInfo) {
        $hostPid = [int]$hostInfo.Pid
        $hostHwnd = if ($hostInfo.Hwnd) { '0x{0:X}' -f [int64]$hostInfo.Hwnd } else { $null }
        $hostProcessName = [string]$hostInfo.ProcessName
        $hostExecutablePath = [string]$hostInfo.ExecutablePath
        $hostWindowTitle = [string]$hostInfo.WindowTitle
    }
    $surfaceInfo = if ($hostInfo) { Get-DesktopSurface $hostInfo } else { $null }
    $initialSurface = if ($surfaceInfo) { [string]$surfaceInfo.Kind } else { 'UNKNOWN' }
    $ordinaryChatConfirmed = ($initialSurface -ceq 'ORDINARY_CHAT')
    $ws = New-Object -ComObject WScript.Shell
    if (!(Activate-ChatGPTWindow $w)) { Fail 'DESKTOP_HOST_FOUND_WRONG_SURFACE' 'Unified Desktop host could not be activated' 3 }
    $surfaceModeBefore = if ($initialSurface -ceq 'ORDINARY_CHAT') { 'ChatGPT' } elseif ($initialSurface -ceq 'CODEX') { 'Codex' } else { Get-ChatSurfaceMode $w }
    Write-Log 'surface-before' "pid=$($w.Current.ProcessId) mode=$surfaceModeBefore"

    # Quick is a ChatGPT surface, not merely a shortcut. Always select ChatGPT
    # first, then wait for UIA confirmation before opening the Quick overlay.
    if ($surfaceModeBefore -ne 'ChatGPT') {
        $navigationAttempted = $true
        $navigationMethod = 'UIA.ExpandCollapsePattern+MenuItem.InvokePattern'
        if (!(Activate-ChatGPTWindow $w)) { Fail 'ORDINARY_CHAT_NAVIGATION_FAILED' 'Unified Desktop surface could not be activated before navigation' 3 }
        $navigation = Invoke-DesktopModeTarget (Get-DesktopHost).Element 'ChatGPT'
        Write-Log 'surface-navigation' "method=$($navigation.Method) succeeded=$($navigation.Succeeded) message=$($navigation.Message)"
        if (!$navigation.Succeeded) {
            # The semantic route is authoritative. This shortcut is only an
            # action fallback; the following proof remains mandatory.
            $navigationMethod = $navigationMethod + ';Alt+1'
            if (!(Activate-ChatGPTWindow $w)) { Fail 'ORDINARY_CHAT_NAVIGATION_FAILED' 'Unified Desktop surface could not be activated before shortcut fallback' 3 }
            $ws.SendKeys('%1')
        }
        $modeConfirmation = Confirm-ChatGPTMode $w 5000
        if (!$modeConfirmation.Confirmed -and $initialSurface -ceq 'CODEX') {
            $navigationMethod = $navigationMethod + ';Ctrl+Alt+O'
            if (!(Activate-ChatGPTWindow $w)) { Fail 'ORDINARY_CHAT_NAVIGATION_FAILED' 'Codex surface could not be activated before ordinary Chat fallback' 3 }
            $ws.SendKeys('^%o')
            $ordinaryChatOpenedByNavigation = $true
            $modeConfirmation = Confirm-ChatGPTMode $w 5000
        }
        if (!$modeConfirmation.Confirmed) { Fail 'ORDINARY_CHAT_SURFACE_NOT_CONFIRMED' $modeConfirmation.Reason 3 }
        $w = $modeConfirmation.Window
        $chatModeConfirmed = $true
        $ordinaryChatConfirmed = $true
    } else {
        $modeConfirmation = Confirm-ChatGPTMode $w 3000
        if (!$modeConfirmation.Confirmed) { Fail 'ORDINARY_CHAT_SURFACE_NOT_CONFIRMED' $modeConfirmation.Reason 3 }
        $w = $modeConfirmation.Window
        $chatModeConfirmed = $true
        $ordinaryChatConfirmed = $true
    }
    if ($Mode -eq 'Quick') {
        if (!(Activate-ChatGPTWindow $w)) { Fail 'ORDINARY_CHAT_NAVIGATION_FAILED' 'Ordinary Chat surface could not be activated before Quick Chat' 3 }
        $ws.SendKeys('^%n')
    } else {
        if (!(Activate-ChatGPTWindow $w)) { Fail 'ORDINARY_CHAT_NAVIGATION_FAILED' 'Ordinary Chat surface could not be activated before New Chat' 3 }
        if (!$ordinaryChatOpenedByNavigation) { $ws.SendKeys('^%o') }
    }
    $afterModeConfirmation = Confirm-ChatGPTMode $w 5000
    if (!$afterModeConfirmation.Confirmed) { Fail 'ORDINARY_CHAT_SURFACE_NOT_CONFIRMED' $afterModeConfirmation.Reason 3 }
    $w = $afterModeConfirmation.Window
    $surfaceModeAfter = $afterModeConfirmation.Mode
    $ordinaryChatConfirmed = $true
    Write-Log 'surface' "pid=$($w.Current.ProcessId) windowRuntimeId=$(Get-RuntimeId $w) mode=$surfaceModeAfter chatModeConfirmed=$chatModeConfirmed"

    $composerDeadline = (Get-Date).AddSeconds([Math]::Min($TimeoutSeconds, 30))
    $composer = $null
    do {
        $composer = Find-Composer $w
        if ($composer) { break }
        Start-Sleep -Milliseconds 250
        $w = Get-ActiveChatGPTSurface $w
    } while ((Get-Date) -lt $composerDeadline)
    if (!$composer) { Fail 'COMPOSER_NOT_FOUND' 'Visible enabled composer not found' 3 }
    Write-Log 'composer' "runtimeId=$(Get-RuntimeId $composer)"

    if ([string]::IsNullOrWhiteSpace($Prompt)) { Fail 'INVALID_ARGUMENT' 'Prompt must not be empty' 1 }
    $beforeSnapshot = Get-ConversationSnapshot $w
    $baselineMessageCount = [int]$beforeSnapshot.MessageCount
    $conversationRuntimeId = $beforeSnapshot.RuntimeId
    Write-Log 'baseline' "messageCount=$baselineMessageCount conversationRuntimeId=$conversationRuntimeId"

    if ($ChatPolicy -eq 'Fresh') {
        if ($TestForceFreshConfirmationFailure) {
            $freshReason = 'FRESH_TEST_FORCED_FAILURE'
            $freshDiagnostic = [ordered]@{ timestampUtc=(Get-Date).ToUniversalTime().ToString('o'); stage='fresh-proof'; reason=$freshReason; predicates=[ordered]@{ newChatActionConfirmed=$true; freshConfirmed=$false } }
            Fail 'FRESH_CHAT_NOT_CONFIRMED' $freshReason 3
        }
        $fresh = Ensure-FreshOrdinaryChat $w $beforeSnapshot 8000 $TestSeedFreshComposerDraft
        $w = $fresh.Window
        $freshAction = if ($fresh.Action) { 'NewChat.InvokePattern' } else { $null }
        $freshActionRuntimeId = if ($fresh.Action) { $fresh.Action.RuntimeId } else { $null }
        Write-Log 'fresh-action' "method=InvokePattern runtimeId=$freshActionRuntimeId"
        $freshConversationTitle = $null
        $freshChatConfirmed = [bool]$fresh.Confirmed
        $freshIdentityChanged = [bool]$fresh.IdentityChanged
        $freshTransitionObserved = [bool]$fresh.TransitionObserved
        $freshReason = [string]$fresh.Reason
        $freshDiagnostic = $fresh.Diagnostics
        if (!$freshChatConfirmed) { Fail 'FRESH_CHAT_NOT_CONFIRMED' $freshReason 3 }
        $conversationRuntimeId = $fresh.Snapshot.RuntimeId
        $freshMessageCount = [int]$fresh.Snapshot.MessageCount
        $conversation = $fresh.Snapshot.Conversation
        $composer = $fresh.Composer
        Write-Log 'fresh-confirm' "confirmed=$freshChatConfirmed identityChanged=$freshIdentityChanged messageCount=$($fresh.Snapshot.MessageCount) reason=$freshReason"
    } else {
        $conversation = $beforeSnapshot.Conversation
    }

    # Fresh proof is complete before any non-empty composer is touched. Only
    # now may Fresh sanitize a retained draft, then insert the real prompt.
    $w = Get-ActiveChatGPTSurface $w
    if (!$composer -or !(Is-UiaElementAlive $composer)) { $composer = Find-Composer $w }
    if (!$composer) { Fail 'COMPOSER_NOT_FOUND' 'Visible enabled composer not found' 3 }
    Write-Log 'composer-refresh' "runtimeId=$(Get-RuntimeId $composer)"
    if ($ChatPolicy -eq 'Fresh') {
        $freshComposer = Prepare-FreshComposer $w $composer
        $freshComposerInitiallyEmpty = $freshComposer.InitiallyEmpty
        $freshComposerSanitized = [bool]$freshComposer.Sanitized
        $freshComposerClearMethod = $freshComposer.ClearMethod
        $freshComposerClearAttempts = [int]$freshComposer.ClearAttempts
        if ($freshComposer.Composer) { $composer = $freshComposer.Composer }
        if (!$freshComposer.ConfirmedEmpty) {
            $code = if ($freshComposer.Error) { $freshComposer.Error } else { 'FRESH_COMPOSER_NOT_READY' }
            Fail $code $freshComposer.Message 1
        }
        Write-Log 'fresh-composer-ready' "initiallyEmpty=$freshComposerInitiallyEmpty sanitized=$freshComposerSanitized clearMethod=$freshComposerClearMethod clearAttempts=$freshComposerClearAttempts"
        $composerReady = $true
    }
    $inputResult = Set-ComposerText $w $composer $Prompt
    $inputAttemptCount = [int]$inputResult.Attempts
    $inputMethod = [string]$inputResult.Method
    $inputFallbackFrom = if($inputResult.PSObject.Properties['FallbackFrom']){[string]$inputResult.FallbackFrom}else{$null}
    $clipboardRestored = [bool]$inputResult.ClipboardRestored
    if ($inputResult.Composer) { $composer = $inputResult.Composer }
    if (!$inputResult.Succeeded) { Fail 'INPUT_NOT_CONFIRMED' $inputResult.Message 1 }
    $composerValue = Get-ComposerValue $composer
    Write-Log 'prompt-readback' "valueLength=$(([string]$composerValue).Length) valueHash=$(Get-TextHash ([string]$composerValue)) normalizedMatch=$(Test-ComposerPromptValue $composerValue $Prompt) method=$inputMethod attempts=$inputAttemptCount"
    $promptConfirmation = Confirm-ComposerPrompt $w $Prompt $composer
    if (!$promptConfirmation.Confirmed) {
        Fail 'INPUT_NOT_CONFIRMED' 'Composer did not contain the exact prompt after two stable readbacks' 1
    }
    $composer = $promptConfirmation.Composer
    Write-Log 'prompt-inserted' "runtimeId=$(Get-RuntimeId $composer) promptLength=$($Prompt.Length) method=$inputMethod attempts=$inputAttemptCount"

    $beforeMessages = @()
    $beforeIds = New-Object 'System.Collections.Generic.HashSet[string]'
    $beforeTextIds = New-Object 'System.Collections.Generic.HashSet[string]'
    if ($ChatPolicy -eq 'Current') {
        $beforeMessages = @(Get-MessageContainers $conversation)
        foreach ($message in $beforeMessages) {
            if ($message.AnchorRuntimeId) { [void]$beforeIds.Add($message.AnchorRuntimeId) }
            foreach ($element in @(All-Desc $message.Conversation)) {
                $runtimeId = Get-RuntimeId $element
                if ($runtimeId) { [void]$beforeTextIds.Add($runtimeId) }
            }
        }
    }

    # This explicit test-only branch does not submit and therefore cannot reach assistant lookup.
    if ($TestSubmitGateFailure) {
        Write-Log 'submit-skipped-test' 'intentional non-submit; assistant lookup and Copy are forbidden'
        Fail 'SUBMIT_NOT_CONFIRMED' 'Test mode intentionally did not invoke Send' 6
    }

    try { $composer.SetFocus() } catch { }
    $send = Find-SendButtonForComposer $w $composer
    if (!$send) { Fail 'SUBMIT_FAILED' 'Send button for composer surface was not found' 4 }
    Write-Log 'send-validation' "runtimeId=$(Get-RuntimeId $send) sameSurface=$(Same-Surface $composer $send)"
    $sendAttempted = $true
    if (!(Invoke-Button $send)) { Fail 'SUBMIT_FAILED' 'Validated Send button Invoke failed' 4 }
    Write-Log 'submit-attempted' 'method=Invoke'
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

    $submitted = Confirm-SubmittedPrompt $w $Prompt $RunId $composer $beforeIds $beforeMessages.Count $beforeTextIds $deadline
    Write-Log 'submit-confirm' "confirmed=$($submitted.Confirmed) composerCleared=$($submitted.ComposerCleared) exactUser=$($submitted.ExactUserMessageFound) reason=$($submitted.Reason)"
    if (!$submitted.Confirmed) { Fail 'SUBMIT_NOT_CONFIRMED' $submitted.Reason 6 }
    $user = $submitted.UserMessage
    if (!$user) { Fail 'USER_MESSAGE_NOT_CONFIRMED' 'Confirmed submit had no user boundary' 6 }
    $userMessageConfirmed = $true
    Write-Log 'user' "anchorRuntimeId=$($user.AnchorRuntimeId) boundaryMode=$($user.BoundaryMode) top=$($user.Top) bottom=$($user.Bottom)"

    if ($SubmitOnly) {
        # M6 deliberately stops after the existing submit gate. The remote
        # result authority is GitHub Issue body, never this chat response.
        $submitted = $true
        $output = [ordered]@{
            ok=$true; submitted=$true; userMessageConfirmed=$true; runId=$RunId; mode=$modeOut; chatPolicy=$chatPolicyOut; response=$null
            conversationId=$null; deeplink=$null; extraction=$null; copyRuntimeId=$null; copyTracePath=$null
            hostFound=$hostFound; hostPid=$hostPid; hostHwnd=$hostHwnd; hostProcessName=$hostProcessName; hostExecutablePath=$hostExecutablePath; hostWindowTitle=$hostWindowTitle
            initialSurface=$initialSurface; navigationAttempted=$navigationAttempted; navigationMethod=$navigationMethod; ordinaryChatConfirmed=$ordinaryChatConfirmed; composerReady=$composerReady
            baselineMessageCount=$baselineMessageCount; conversationRuntimeId=$conversationRuntimeId
            surfaceModeBefore=$surfaceModeBefore; surfaceModeAfter=$surfaceModeAfter; chatModeConfirmed=$chatModeConfirmed
            freshAction=$freshAction; freshActionRuntimeId=$freshActionRuntimeId; freshTransitionObserved=$freshTransitionObserved; freshProofLevel=if($freshChatConfirmed){'UIA_ACTION_AND_STABLE_EMPTY_STATE'}else{$null}
            freshChatConfirmed=$freshChatConfirmed; freshIdentityChanged=$freshIdentityChanged; freshReason=$freshReason; freshMessageCount=$freshMessageCount
            freshComposerInitiallyEmpty=$freshComposerInitiallyEmpty; freshComposerSanitized=$freshComposerSanitized; freshComposerClearMethod=$freshComposerClearMethod; freshComposerClearAttempts=$freshComposerClearAttempts
            inputMethod=$inputMethod; inputFallbackFrom=$inputFallbackFrom; inputAttemptCount=$inputAttemptCount; clipboardRestored=$clipboardRestored; sendAttempted=$sendAttempted; heavyDiagnostics=$script:HeavyDiagnosticsPerformed
            durationMs=[int]((Get-Date)-$started).TotalMilliseconds; error=$null
        }
        Write-Log 'submit-only-complete' 'confirmed user message; remote result remains GitHub Issue authority'
        if ($ReturnJson) { $output | ConvertTo-Json -Compress -Depth 8 } else { [Console]::Out.WriteLine('POSTMAN_SIGNAL_SUBMITTED') }
        exit 0
    }

    $assistant = $null
    do {
        Start-Sleep -Milliseconds 200
        $w = Get-ActiveChatGPTSurface $w
        $currentConversation = Find-ConversationContainer $w
        $anchors = @(Get-AuthorAnchors $currentConversation)
        $nextUser = @($anchors | Where-Object { ($_.Role -eq 'user') -and ($_.YTop -gt $user.Top) } | Sort-Object YTop | Select-Object -First 1)
        $assistantLimit = if ($nextUser) { [double]$nextUser[0].YTop } else { 1e9 }
        $assistantAnchor = @($anchors | Where-Object {
            ($_.Role -eq 'assistant') -and ($_.YTop -gt $user.Top) -and ($_.YTop -lt $assistantLimit)
        } | Sort-Object YTop | Select-Object -First 1)
        if ($assistantAnchor) {
            $assistant = Resolve-MessageBoundary $currentConversation $assistantAnchor $assistantLimit
            if ($assistant) {
                $assistant | Add-Member -NotePropertyName Window -NotePropertyValue $w -Force
                $assistant | Add-Member -NotePropertyName SubmittedPrompt -NotePropertyValue $Prompt -Force
                break
            }
        }
    } while ((Get-Date) -lt $deadline)
    if (!$assistant) { Fail 'RESPONSE_NOT_FOUND' 'Assistant boundary paired to user was not found' 6 }
    Write-Log 'assistant' "anchorRuntimeId=$($assistant.AnchorRuntimeId) containerRuntimeId=$($assistant.ContainerRuntimeId) boundaryMode=$($assistant.BoundaryMode) top=$($assistant.Top) bottom=$($assistant.Bottom) generationStart=$(Get-Date -Format o)"

    $lastLegacy = ''
    $lastChange = Get-Date
    $legacyAnswer = ''
    $completed = $false
    $streamTrace = Join-Path $PSScriptRoot ('diagnostics\stream_trace_' + $RunId + '.jsonl')
    New-Item -ItemType Directory -Path (Split-Path -Parent $streamTrace) -Force | Out-Null
    do {
        Start-Sleep -Milliseconds 250
        $w = Get-ActiveChatGPTSurface $w
        $currentConversation = Find-ConversationContainer $w
        $anchors = @(Get-AuthorAnchors $currentConversation)
        $nextUserNow = @($anchors | Where-Object { ($_.Role -eq 'user') -and ($_.YTop -gt $user.Top) } | Sort-Object YTop | Select-Object -First 1)
        $assistantLimitNow = if ($nextUserNow) { [double]$nextUserNow[0].YTop } else { 1e9 }
        $currentAnchor = @($anchors | Where-Object {
            ($_.Role -eq 'assistant') -and ($_.YTop -gt $user.Top) -and ($_.YTop -lt $assistantLimitNow)
        } | Sort-Object YTop | Select-Object -First 1)
        if ($currentAnchor) {
            $freshAssistant = Resolve-MessageBoundary $currentConversation $currentAnchor $assistantLimitNow
            if ($freshAssistant) {
                $assistant = $freshAssistant
                $assistant | Add-Member -NotePropertyName Window -NotePropertyValue $w -Force
                $assistant | Add-Member -NotePropertyName SubmittedPrompt -NotePropertyValue $Prompt -Force
            }
        }
        $legacyAnswer = Get-MessageText $assistant
        if ($legacyAnswer -ne $lastLegacy) { $lastLegacy = $legacyAnswer; $lastChange = Get-Date }
        $stop = Find-StopButton $w
        $copyInfo = Find-CopyButtonForAssistant $assistant
        $streamRow = [ordered]@{
            timestamp=(Get-Date).ToString('o'); UserRuntimeId=$user.AnchorRuntimeId; AssistantRuntimeId=$assistant.AnchorRuntimeId
            StopPresent=[bool]$stop; CopyPresent=[bool]$copyInfo.CopyPresent; AssistantTextLength=$legacyAnswer.Length
            CopyEnabled=[bool]$copyInfo.CopyEnabled; CopyRuntimeId=$copyInfo.RuntimeId; CopyRelationMode=$copyInfo.RelationMode
            CopyCandidateCount=$copyInfo.CandidateCount
        }
        ($streamRow | ConvertTo-Json -Compress) | Add-Content -LiteralPath $streamTrace -Encoding UTF8
        $stableMs = ((Get-Date) - $lastChange).TotalMilliseconds
        # Copy may be mounted by the virtualized Chromium view after the text
        # has become stable.  Its absence in this 250 ms sample is not failure.
        # Completion is established by stable text + Stop absent; Copy is waited
        # for in a bounded assistant scope immediately afterwards.
        if ($legacyAnswer -and ($stableMs -ge 2200) -and !$stop) {
            $completed = $true
            break
        }
    } while ((Get-Date) -lt $deadline)

    if (!$completed) { Fail 'GENERATION_TIMEOUT' 'Generation did not complete before timeout' 5 }
    if (!$legacyAnswer) { Fail 'RESPONSE_NOT_FOUND' 'New assistant response has no readable text' 6 }
    $copyWait = Wait-CopyButtonForAssistant $assistant 5000 200
    Write-Log 'copy-wait' "found=$($copyWait.Found) error=$($copyWait.Error) polls=$($copyWait.Polls) durationMs=$($copyWait.DurationMs)"
    if (!$copyWait.Found) { Fail $copyWait.Error $copyWait.Message 6 }
    if ($legacyAnswer -eq $Prompt -or $legacyAnswer.Contains($Prompt)) {
        Write-Log 'boundary-reject' 'assistant text contains submitted prompt'
        Fail 'MESSAGE_BOUNDARY_ERROR' 'Assistant boundary contains the submitted user prompt' 6
    }
    $assistant | Add-Member -NotePropertyName UserRuntimeId -NotePropertyValue $user.AnchorRuntimeId -Force
    $assistant | Add-Member -NotePropertyName StopPresent -NotePropertyValue $false -Force
    Write-Log 'complete' "runtimeId=$($assistant.AnchorRuntimeId) responseLength=$($legacyAnswer.Length) legacyHash=$(Get-TextHash $legacyAnswer)"

    $copyResult = Copy-AssistantResponse $assistant $RunId
    Write-Log 'copy' "confirmed=$($copyResult.Confirmed) error=$($copyResult.Error) copyRuntimeId=$($copyResult.CopyRuntimeId) copiedLength=$(if($copyResult.Text){$copyResult.Text.Length}else{0}) legacyLength=$($legacyAnswer.Length)"
    if (!$copyResult.Confirmed) { Fail $copyResult.Error $copyResult.Message 6 }
    $answer = $copyResult.Text
    if ([string]::IsNullOrWhiteSpace($answer)) { Fail 'COPY_EMPTY' 'Confirmed copy returned empty text' 6 }
    if ($answer.Contains($Prompt)) { Fail 'COPY_ASSISTANT_PAIRING_ERROR' 'Copied text contains submitted prompt' 6 }

    $submitted = $true

    $deep = $null
    $conversationId = $null
    if ($Mode -eq 'NewChat') {
        try {
            $oldDeep = Get-Clipboard -Raw -ErrorAction SilentlyContinue
            $ws.SendKeys('^%l')
            $deeplinkDeadline = (Get-Date).AddSeconds(3)
            do {
                Start-Sleep -Milliseconds 150
                $deep = Get-Clipboard -Raw -ErrorAction SilentlyContinue
            } while ((Get-Date) -lt $deeplinkDeadline -and (!$deep -or ($deep -eq $oldDeep)))
            $match = [regex]::Match($deep, '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
            if ($match.Success) { $conversationId = $match.Value }
        } catch { }
    }

    $output = [ordered]@{
        ok=$true; runId=$RunId; mode=$modeOut; chatPolicy=$chatPolicyOut; response=$answer; conversationId=$conversationId; deeplink=$deep
        extraction='copy'; copyRuntimeId=$copyResult.CopyRuntimeId; copyTracePath=$copyResult.TracePath
        submitted=$submitted; userMessageConfirmed=$userMessageConfirmed; hostFound=$hostFound; hostPid=$hostPid; hostHwnd=$hostHwnd; hostProcessName=$hostProcessName; hostExecutablePath=$hostExecutablePath; hostWindowTitle=$hostWindowTitle
        initialSurface=$initialSurface; navigationAttempted=$navigationAttempted; navigationMethod=$navigationMethod; ordinaryChatConfirmed=$ordinaryChatConfirmed; composerReady=$composerReady
        baselineMessageCount=$baselineMessageCount; conversationRuntimeId=$conversationRuntimeId
        surfaceModeBefore=$surfaceModeBefore; surfaceModeAfter=$surfaceModeAfter; chatModeConfirmed=$chatModeConfirmed
        freshAction=$freshAction; freshActionRuntimeId=$freshActionRuntimeId; freshTransitionObserved=$freshTransitionObserved; freshProofLevel=if($freshChatConfirmed){'UIA_ACTION_AND_STABLE_EMPTY_STATE'}else{$null}
        freshChatConfirmed=$freshChatConfirmed; freshIdentityChanged=$freshIdentityChanged; freshReason=$freshReason; freshDiagnostic=$freshDiagnostic; freshMessageCount=$freshMessageCount
        freshComposerInitiallyEmpty=$freshComposerInitiallyEmpty; freshComposerSanitized=$freshComposerSanitized; freshComposerClearMethod=$freshComposerClearMethod; freshComposerClearAttempts=$freshComposerClearAttempts
        inputMethod=$inputMethod; inputFallbackFrom=$inputFallbackFrom; inputAttemptCount=$inputAttemptCount; clipboardRestored=$clipboardRestored; sendAttempted=$sendAttempted; heavyDiagnostics=$script:HeavyDiagnosticsPerformed
        legacyLength=$legacyAnswer.Length; legacyHash=(Get-TextHash $legacyAnswer); copiedLength=$answer.Length; copiedHash=(Get-TextHash $answer)
        durationMs=[int]((Get-Date)-$started).TotalMilliseconds; error=$null
    }
    if ($ReturnJson) { $output | ConvertTo-Json -Compress -Depth 8 } else { [Console]::Out.WriteLine($answer) }
    exit 0
}
catch {
    $parts = $_.Exception.Message -split '\|', 3
    $code = if ($parts.Count -gt 0) { $parts[0] } else { 'ERROR' }
    $message = if ($parts.Count -gt 1) { $parts[1] } else { $_.Exception.Message }
    $exitCode = if ($parts.Count -gt 2) { [int]$parts[2] } else { 1 }
    Write-Log 'error' "$code $message"
    try { if ($w) { Save-FailureDump $w $code } } catch { }
    $output = [ordered]@{
        ok=$false; runId=$RunId; mode=$modeOut; chatPolicy=$chatPolicyOut; response=$null; conversationId=$null; deeplink=$null
        extraction=$null; copyRuntimeId=$null; copyTracePath=(Join-Path $PSScriptRoot ('diagnostics\copy_trace_' + $RunId + '.jsonl'))
        submitted=$submitted; userMessageConfirmed=$userMessageConfirmed; hostFound=$hostFound; hostPid=$hostPid; hostHwnd=$hostHwnd; hostProcessName=$hostProcessName; hostExecutablePath=$hostExecutablePath; hostWindowTitle=$hostWindowTitle
        initialSurface=$initialSurface; navigationAttempted=$navigationAttempted; navigationMethod=$navigationMethod; ordinaryChatConfirmed=$ordinaryChatConfirmed; composerReady=$composerReady
        baselineMessageCount=$baselineMessageCount; conversationRuntimeId=$conversationRuntimeId
        surfaceModeBefore=$surfaceModeBefore; surfaceModeAfter=$surfaceModeAfter; chatModeConfirmed=$chatModeConfirmed
        freshAction=$freshAction; freshActionRuntimeId=$freshActionRuntimeId; freshTransitionObserved=$freshTransitionObserved; freshProofLevel=if($freshChatConfirmed){'UIA_ACTION_AND_STABLE_EMPTY_STATE'}else{$null}
        freshChatConfirmed=$freshChatConfirmed; freshIdentityChanged=$freshIdentityChanged; freshReason=$freshReason; freshDiagnostic=$freshDiagnostic; freshMessageCount=$freshMessageCount
        freshComposerInitiallyEmpty=$freshComposerInitiallyEmpty; freshComposerSanitized=$freshComposerSanitized; freshComposerClearMethod=$freshComposerClearMethod; freshComposerClearAttempts=$freshComposerClearAttempts
        inputMethod=$inputMethod; inputFallbackFrom=$inputFallbackFrom; inputAttemptCount=$inputAttemptCount; clipboardRestored=$clipboardRestored; sendAttempted=$sendAttempted; heavyDiagnostics=$script:HeavyDiagnosticsPerformed
        durationMs=[int]((Get-Date)-$started).TotalMilliseconds; failureStage=$code; failureReason=$message; error=[ordered]@{ code=$code; message=$message }
    }
    if ($ReturnJson) { $output | ConvertTo-Json -Compress -Depth 8 } else { [Console]::Error.WriteLine($message) }
    exit $exitCode
}
finally {
    if ($mutex) { try { $mutex.ReleaseMutex(); $mutex.Dispose() } catch { } }
}
