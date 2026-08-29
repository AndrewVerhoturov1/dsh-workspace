[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][int]$HostPid,
    [Parameter(Mandatory=$true)][string]$HostHwnd,
    [Parameter(Mandatory=$true)][string]$RequestId,
    [int]$DeadlineSeconds = 1800,
    [int]$PollMilliseconds = 500,
    [int]$MaxDismissals = 3
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'chatgpt_post_submit_guard_contract.ps1'))) {
    throw 'post-submit guard contract is missing'
}
. (Join-Path $PSScriptRoot 'chatgpt_post_submit_guard_contract.ps1')

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DshPostSubmitWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
}
'@

$workHeadings = @('Продолжить в режиме Work?', 'Continue in Work mode?')
$continueHereNames = @('Продолжить чат здесь', 'Continue chat here')
$continueWorkNames = @('Продолжить в режиме Work', 'Continue in Work mode')
$targetHwnd = [IntPtr]::Zero
if ($HostHwnd -match '^0x') { $targetHwnd = [IntPtr]::new([Convert]::ToInt64($HostHwnd.Substring(2), 16)) }
else { $targetHwnd = [IntPtr]::new([Convert]::ToInt64($HostHwnd, 10)) }

function Write-GuardEvent {
    param([Parameter(Mandatory=$true)][string]$Event, [hashtable]$Data = @{})
    $record = [ordered]@{ timestamp=(Get-Date).ToUniversalTime().ToString('o'); event=$Event; requestId=$RequestId }
    foreach ($key in $Data.Keys) { $record[$key] = $Data[$key] }
    [Console]::Out.WriteLine(($record | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
}

function All-Desc($Element) {
    if (!$Element) { return @() }
    try { return @($Element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) }
    catch { return @() }
}

function Get-UiCurrent($Element) {
    try { return $Element.Current } catch { return $null }
}

function Get-WindowRectInfo([IntPtr]$Handle) {
    try {
        $process = Get-Process -Id $HostPid -ErrorAction SilentlyContinue
        if (!$process) { return $null }
        $windowRect = [DshPostSubmitWindow+RECT]::new()
        if (![DshPostSubmitWindow]::GetWindowRect($Handle, [ref]$windowRect)) { return $null }
        $monitor = [DshPostSubmitWindow]::MonitorFromWindow($Handle, 2)
        $workRect = [DshPostSubmitWindow+RECT]::new()
        $monitorInfo = [DshPostSubmitWindow+MONITORINFO]::new()
        $monitorInfo.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($monitorInfo)
        $workArea = $null
        if ($monitor -ne [IntPtr]::Zero -and [DshPostSubmitWindow]::GetMonitorInfo($monitor, [ref]$monitorInfo)) {
            $workRect = $monitorInfo.rcWork
            $workArea = [ordered]@{ left=$workRect.Left; top=$workRect.Top; right=$workRect.Right; bottom=$workRect.Bottom; width=($workRect.Right - $workRect.Left); height=($workRect.Bottom - $workRect.Top) }
        }
        $foreground = [DshPostSubmitWindow]::GetForegroundWindow()
        [uint32]$foregroundPid = 0
        if ($foreground -ne [IntPtr]::Zero) { [DshPostSubmitWindow]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid) | Out-Null }
        return [ordered]@{
            hostPid=$HostPid; hostHwnd=$HostHwnd; windowState=if([DshPostSubmitWindow]::IsIconic($Handle)){'minimized'}else{'normal'}
            windowRect=[ordered]@{ left=$windowRect.Left; top=$windowRect.Top; right=$windowRect.Right; bottom=$windowRect.Bottom; width=($windowRect.Right - $windowRect.Left); height=($windowRect.Bottom - $windowRect.Top) }
            workAreaRect=$workArea; width=($windowRect.Right - $windowRect.Left); height=($windowRect.Bottom - $windowRect.Top)
            foregroundHwnd=if($foreground -ne [IntPtr]::Zero){'0x{0:X}' -f $foreground.ToInt64()}else{$null}; foregroundPid=if($foregroundPid){[int]$foregroundPid}else{$null}
        }
    } catch { return $null }
}

function Get-ConfirmedHostRoot {
    if ($targetHwnd -eq [IntPtr]::Zero -or ![DshPostSubmitWindow]::IsWindow($targetHwnd)) { return $null }
    [uint32]$ownerPid = 0
    [DshPostSubmitWindow]::GetWindowThreadProcessId($targetHwnd, [ref]$ownerPid) | Out-Null
    if ([int]$ownerPid -ne $HostPid) { return $null }
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($targetHwnd)
        if (!$root -or [int]$root.Current.ProcessId -ne $HostPid) { return $null }
        return $root
    } catch { return $null }
}

function Get-VisibleNodes($Root) {
    return @($Root) + @(All-Desc $Root) | Where-Object {
        try { !$_.Current.IsOffscreen -and $_.Current.IsEnabled } catch { $false }
    }
}

function Get-WorkPromptState($Root) {
    if (!$Root) { return [pscustomobject]@{ Kind='HOST_NOT_CONFIRMED' } }
    $nodes = @(Get-VisibleNodes $Root)
    $heading = $nodes | Where-Object {
        try { $(Test-PostSubmitExactSemanticName ([string]$_.Current.Name) $workHeadings) } catch { $false }
    } | Select-Object -First 1
    $continue = $nodes | Where-Object {
        try { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $(Test-PostSubmitExactSemanticName ([string]$_.Current.Name) $continueHereNames) } catch { $false }
    } | Select-Object -First 1
    $work = $nodes | Where-Object {
        try { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $(Test-PostSubmitExactSemanticName ([string]$_.Current.Name) $continueWorkNames) } catch { $false }
    } | Select-Object -First 1
    if ($heading -and $continue -and $work) {
        return [pscustomobject]@{
            Kind='WORK_MODE_PROMPT'; Heading=$heading; ContinueHere=$continue; Work=$work
            HeadingName=[string]$heading.Current.Name; ContinueHereName=[string]$continue.Current.Name; WorkName=[string]$work.Current.Name
        }
    }

    # Only classify a non-root visible Window with visible buttons as unknown.
    # Other transient Chromium panes are not guessed at or dismissed.
    $unknown = $nodes | Where-Object {
        try {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and
            [int64]$_.Current.NativeWindowHandle -ne $targetHwnd.ToInt64() -and
            ![string]::IsNullOrWhiteSpace([string]$_.Current.Name) -and
            (@(All-Desc $_) | Where-Object { try { !$_.Current.IsOffscreen -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button } catch { $false } }).Count -gt 0
        } catch { $false }
    } | Select-Object -First 1
    if ($unknown) { return [pscustomobject]@{ Kind='UNKNOWN_POST_SUBMIT_MODAL'; ModalName=[string]$unknown.Current.Name } }
    return [pscustomobject]@{ Kind='NONE' }
}

function Invoke-ContinueHere($State) {
    [object]$invoke = $null
    $available = $false
    try { $available = $State.ContinueHere.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke) } catch { $available = $false }
    if (!$available) { return [pscustomobject]@{ Succeeded=$false; InvokePatternAvailable=$false; ForegroundRequired=$false; Error='Continue-here button has no InvokePattern' } }
    try {
        $invoke.Invoke()
        return [pscustomobject]@{ Succeeded=$true; InvokePatternAvailable=$true; ForegroundRequired=$false; Error=$null }
    } catch {
        return [pscustomobject]@{ Succeeded=$false; InvokePatternAvailable=$true; ForegroundRequired=$true; Error=$_.Exception.Message }
    }
}

function Get-InvokePatternAvailable($Element) {
    [object]$pattern = $null
    try { return [bool]$Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern) } catch { return $false }
}

function Activate-ExactHost {
    if (![DshPostSubmitWindow]::IsWindow($targetHwnd)) { return $false }
    if ([DshPostSubmitWindow]::IsIconic($targetHwnd)) { [DshPostSubmitWindow]::ShowWindow($targetHwnd, 9) | Out-Null }
    [DshPostSubmitWindow]::BringWindowToTop($targetHwnd) | Out-Null
    [DshPostSubmitWindow]::SetForegroundWindow($targetHwnd) | Out-Null
    return ([DshPostSubmitWindow]::GetForegroundWindow() -eq $targetHwnd)
}

Write-GuardEvent 'POST_SUBMIT_GUARD_STARTED' @{ hostPid=$HostPid; hostHwnd=$HostHwnd; deadlineSeconds=$DeadlineSeconds; maxDismissals=$MaxDismissals }
$deadline = (Get-Date).AddSeconds([Math]::Max(1, $DeadlineSeconds))
$dismissals = 0
$lastKind = 'NONE'
$finished = $false
function Finish-Guard([string]$Reason, [int]$ExitCode = 0) {
    if (!$script:finished) {
        $script:finished = $true
        Write-GuardEvent 'POST_SUBMIT_GUARD_FINISHED' @{ reason=$Reason; dismissalCount=$script:dismissals; exitCode=$ExitCode }
    }
}
while ((Get-Date) -lt $deadline) {
    $root = Get-ConfirmedHostRoot
    $state = Get-WorkPromptState $root
    if ($state.Kind -eq 'WORK_MODE_PROMPT') {
        $rect = Get-WindowRectInfo $targetHwnd
        Write-GuardEvent 'WORK_PROMPT_DETECTED' @{ hostPid=$HostPid; hostHwnd=$HostHwnd; foregroundPid=$rect.foregroundPid; foregroundHwnd=$rect.foregroundHwnd; windowRect=$rect.windowRect; workAreaRect=$rect.workAreaRect; windowWidth=$rect.width; windowHeight=$rect.height; promptHeading=$state.HeadingName; continueHereButton=$state.ContinueHereName; workButton=$state.WorkName; invokePatternAvailable=(Get-InvokePatternAvailable $state.ContinueHere); foregroundRequired=$false; dismissalCount=$dismissals }
        if ($dismissals -ge $MaxDismissals) {
            Write-GuardEvent 'WORK_PROMPT_LOOP' @{ dismissalCount=$dismissals; maxDismissals=$MaxDismissals }
            Finish-Guard 'work_prompt_loop' 3
            exit 3
        }
        $invokeResult = Invoke-ContinueHere $state
        if (!$invokeResult.Succeeded -and $invokeResult.ForegroundRequired) {
            if (!(Activate-ExactHost)) { Write-GuardEvent 'WORK_PROMPT_CONTINUE_HERE_NOT_CONFIRMED' @{ reason='exact host activation failed'; foregroundRequired=$true }; Finish-Guard 'continue_here_not_confirmed' 4; exit 4 }
            $root = Get-ConfirmedHostRoot
            $state = Get-WorkPromptState $root
            if ($state.Kind -ne 'WORK_MODE_PROMPT') { Write-GuardEvent 'WORK_PROMPT_CONTINUE_HERE_NOT_CONFIRMED' @{ reason='modal changed before invoke'; foregroundRequired=$true }; Finish-Guard 'continue_here_not_confirmed' 4; exit 4 }
            $invokeResult = Invoke-ContinueHere $state
        }
        if (!$invokeResult.Succeeded) {
            Write-GuardEvent 'WORK_PROMPT_CONTINUE_HERE_NOT_CONFIRMED' @{ reason=$invokeResult.Error; invokePatternAvailable=$invokeResult.InvokePatternAvailable; foregroundRequired=$invokeResult.ForegroundRequired }
            Finish-Guard 'continue_here_not_confirmed' 4
            exit 4
        }
        Write-GuardEvent 'WORK_PROMPT_CONTINUE_HERE_INVOKED' @{ invokePatternAvailable=$invokeResult.InvokePatternAvailable; foregroundRequired=$invokeResult.ForegroundRequired; dismissalCount=($dismissals + 1) }
        Start-Sleep -Milliseconds 250
        $clearFirst = (Get-WorkPromptState (Get-ConfirmedHostRoot)).Kind -eq 'NONE'
        Start-Sleep -Milliseconds 250
        $clearSecond = (Get-WorkPromptState (Get-ConfirmedHostRoot)).Kind -eq 'NONE'
        if ($clearFirst -and $clearSecond) {
            $dismissals++
            Write-GuardEvent 'WORK_PROMPT_DISMISS_CONFIRMED' @{ dismissalCount=$dismissals; stableReadbacks=2 }
        }
        $lastKind = 'NONE'
    } elseif ($state.Kind -eq 'UNKNOWN_POST_SUBMIT_MODAL') {
        if ($lastKind -ne $state.Kind) { Write-GuardEvent 'UNKNOWN_POST_SUBMIT_MODAL' @{ modalName=$state.ModalName; hostPid=$HostPid; hostHwnd=$HostHwnd } }
        Finish-Guard 'unknown_post_submit_modal' 5
        exit 5
    }
    $lastKind = $state.Kind
    Start-Sleep -Milliseconds ([Math]::Max(100, $PollMilliseconds))
}
Finish-Guard 'deadline' 0
exit 0
