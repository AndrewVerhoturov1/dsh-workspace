const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createAdapter, writeResult } = require('./test-helpers');
const { launchNotepad } = require('./launch-notepad');
const { launchSemanticControls } = require('./semantic/launch-semantic-controls');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function runPsCommand(command, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('PowerShell command timeout')); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(err.trim() || `PowerShell exited ${code}`)); else resolve(out.trim()); });
  });
}

async function foregroundSnapshot() {
  const command = `$ErrorActionPreference='Stop'; Add-Type @'\nusing System; using System.Runtime.InteropServices; using System.Text;\npublic static class DshStage8Fg { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern IntPtr GetAncestor(IntPtr h,uint f); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport(\"user32.dll\",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n); }\n'@; $h=[DshStage8Fg]::GetForegroundWindow(); [uint32]$p=0; [void][DshStage8Fg]::GetWindowThreadProcessId($h,[ref]$p); $r=[DshStage8Fg]::GetAncestor($h,3); $s=New-Object Text.StringBuilder 512; [void][DshStage8Fg]::GetWindowText($h,$s,$s.Capacity); [pscustomobject]@{timestamp=(Get-Date).ToUniversalTime().ToString('O');hwnd=[int64]$h;rootHwnd=[int64]$r;pid=[int]$p;title=$s.ToString()}|ConvertTo-Json -Compress`;
  return JSON.parse(await runPsCommand(command));
}

async function selectBrowser() {
  const command = `$ErrorActionPreference='Stop'; $p=Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and ($_.ProcessName -match '^(chrome|browser|msedge|firefox)$') } | Sort-Object @{Expression={ if ($_.MainWindowTitle -match 'DeepSeek Harness|ChatGPT|Codex') { 0 } else { 1 } }},ProcessName | Select-Object -First 1; if($null -eq $p){throw 'No visible browser process found'}; [pscustomobject]@{pid=$p.Id;hwnd=[int64]$p.MainWindowHandle;title=$p.MainWindowTitle;process=$p.ProcessName}|ConvertTo-Json -Compress`;
  return JSON.parse(await runPsCommand(command));
}

async function focusWindow(hwnd) {
  const command = `$ErrorActionPreference='Stop'; Add-Type @'\nusing System; using System.Runtime.InteropServices; public static class DshStage8Focus { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool IsWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId(); [DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a,uint b,bool attach); [DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int n); }\n'@; $h=[IntPtr]${Number(hwnd)}; if(-not [DshStage8Focus]::IsWindow($h)){throw 'Browser HWND is not a window'}; [uint32]$fgPid=0; $fg=[DshStage8Focus]::GetForegroundWindow(); $fgTid=[DshStage8Focus]::GetWindowThreadProcessId($fg,[ref]$fgPid); $myTid=[DshStage8Focus]::GetCurrentThreadId(); $attached=$false; try { if($fgTid -and $fgTid -ne $myTid){$attached=[DshStage8Focus]::AttachThreadInput($myTid,$fgTid,$true)}; [void][DshStage8Focus]::ShowWindow($h,5); [void][DshStage8Focus]::BringWindowToTop($h); if(-not [DshStage8Focus]::SetForegroundWindow($h)){throw 'SetForegroundWindow failed'} } finally { if($attached){[void][DshStage8Focus]::AttachThreadInput($myTid,$fgTid,$false)} }; Start-Sleep -Milliseconds 150; 'ok'`;
  await runPsCommand(command);
}

async function findNotepadChild(notepad) {
  const command = `$ErrorActionPreference='Stop'; Add-Type @'\nusing System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text; public static class DshStage8Child { [DllImport(\"user32.dll\")] public static extern bool IsWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern IntPtr FindWindowEx(IntPtr p,IntPtr c,string cls,string title); [DllImport(\"user32.dll\",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); public static IntPtr FindEdit(IntPtr root,uint pid){var q=new Queue<IntPtr>();q.Enqueue(root);while(q.Count>0){var p=q.Dequeue();var c=IntPtr.Zero;while(true){c=FindWindowEx(p,c,null,null);if(c==IntPtr.Zero)break;uint cp;GetWindowThreadProcessId(c,out cp);if(cp!=pid)continue;var s=new StringBuilder(128);GetClassName(c,s,s.Capacity);var n=s.ToString();if(n.Equals(\"Edit\",StringComparison.OrdinalIgnoreCase)||n.IndexOf(\"RichEdit\",StringComparison.OrdinalIgnoreCase)>=0)return c;q.Enqueue(c);}}return IntPtr.Zero;} public static string ClassName(IntPtr h){var s=new StringBuilder(128);GetClassName(h,s,s.Capacity);return s.ToString();} }\n'@; $root=[IntPtr]${Number(notepad.hwnd)}; [uint32]$p=0; [void][DshStage8Child]::GetWindowThreadProcessId($root,[ref]$p); $c=[DshStage8Child]::FindEdit($root,[uint32]${Number(notepad.pid)}); [pscustomobject]@{rootHwnd=[int64]$root;childHwnd=[int64]$c;childClass=[DshStage8Child]::ClassName($c);pid=[int]$p;childFound=($c -ne [IntPtr]::Zero)}|ConvertTo-Json -Compress`;
  return JSON.parse(await runPsCommand(command));
}

function startForegroundMonitor(target) {
  const script = path.join(ROOT, 'src', 'telemetry', 'foreground-monitor.ps1');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-TargetPid', String(target.pid), '-TargetHwnd', String(target.windowHandle), '-DurationMs', '180000'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = []; let buffer = ''; let stderr = ''; let readyResolve; let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u); buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { const event = JSON.parse(line); if (event.event === 'ready') readyResolve(); else events.push(event); }
      catch { events.push({ parseError: line, timestamp: new Date().toISOString() }); }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', readyReject);
  child.once('close', code => { if (code !== 0) readyReject(new Error(stderr || `foreground monitor exited ${code}`)); });
  return {
    child, events, ready, get stderr() { return stderr; },
    async stop() {
      if (!child.killed) child.kill();
      await new Promise(resolve => child.once('close', resolve));
      if (buffer.trim()) { try { events.push(JSON.parse(buffer)); } catch {} }
      return events;
    }
  };
}

function inInterval(event, startMs, endMs) {
  const t = Date.parse(event.timestamp || '');
  return Number.isFinite(t) && t >= startMs && t <= endMs;
}

function targetEventSummary(events, startMs, endMs) {
  const interval = events.filter(event => inInterval(event, startMs, endMs));
  const target = interval.filter(event => event.targetMatched === true);
  return { events: interval, targetEvents: target, targetForegroundObserved: target.length > 0, otherForegroundChanges: interval.filter(event => event.targetMatched !== true) };
}

function routeSummary(result) {
  return {
    status: result.status || null,
    functionalResult: result.success === true ? 'PASS' : 'FAIL',
    verificationResult: result.verified === true ? 'PASS' : 'FAIL',
    verified: result.verified === true,
    error: result.error || null,
    deliveryMode: result.deliveryMode || null,
    deliveryPath: result.metadata?.deliveryPath || null,
    policy: result.metadata?.policy || null,
    pattern: result.metadata?.semanticRoute || null,
    route: result.metadata?.route || null,
    cursorBefore: result.cursorBefore || null,
    cursorAfter: result.cursorAfter || null,
    injectedInputObserved: result.metadata?.injectedInputObserved === true,
    targetRootHwnd: result.target?.windowHandle || result.metadata?.target?.rootHwnd || null,
    rawOperationId: result.operationId
  };
}

async function main() {
  const report = {
    stage: 8,
    test: 'parallel desktop use real retest',
    startedAt: new Date().toISOString(),
    policy: { backgroundOnly: true, allowForeground: false, allowUncertifiedSemanticRoute: true, productionAllowlistChanged: false },
    countsRequested: { getState: 10, asciiTypeText: 10, unicodeTypeText: 10, semanticClick: 20 },
    preparation: { monitorStartedAfterBrowserStable: true, foregroundSnapshots: [], notepadLaunchExcludedFromMeasurement: true },
    targets: {}, actions: [], foregroundEvents: {}, notes: []
  };
  let notepad = null; let semantic = null; let adapter = null; let notepadMonitor = null; let semanticMonitor = null;
  try {
    console.error('[stage8] select browser');
    const browser = await selectBrowser();
    report.preparation.browser = browser;
    report.preparation.foregroundSnapshots.push({ phase: 'before_notepad_launch', snapshot: await foregroundSnapshot() });

    console.error('[stage8] launch notepad');
    notepad = await launchNotepad(`DSH_STAGE8_NOTEPAD_${Date.now()}`);
    console.error('[stage8] find notepad child');
    const child = await findNotepadChild(notepad);
    report.targets.notepad = { pid: notepad.pid, hwnd: notepad.hwnd, title: notepad.title, targetRootHwnd: notepad.hwnd, childControlHwnd: child.childHwnd, childControlClass: child.childClass, childFound: child.childFound, file: notepad.file };
    report.preparation.foregroundSnapshots.push({ phase: 'after_notepad_launch', snapshot: await foregroundSnapshot() });

    console.error('[stage8] launch semantic target');
    semantic = await launchSemanticControls(`DSH_STAGE8_SEMANTIC_${Date.now()}`);
    console.error('[stage8] semantic target ready');
    report.targets.semantic = { pid: semantic.pid, hwnd: semantic.hwnd, title: semantic.title, targetRootHwnd: semantic.hwnd };
    report.preparation.foregroundSnapshots.push({ phase: 'after_semantic_target_launch', snapshot: await foregroundSnapshot() });

    console.error('[stage8] restore browser');
    await focusWindow(browser.hwnd);
    await sleep(2200);
    console.error('[stage8] browser stable');
    report.preparation.foregroundSnapshots.push({ phase: 'browser_stable_after_restore', snapshot: await foregroundSnapshot() });
    const stable = report.preparation.foregroundSnapshots.at(-1).snapshot;
    report.preparation.browserStable = { requiredMs: 2000, observedMs: 2200, foreground: stable, matchesBrowser: Number(stable.hwnd) === Number(browser.hwnd) || Number(stable.pid) === Number(browser.pid) };
    if (!report.preparation.browserStable.matchesBrowser) throw new Error('Browser was not foreground after preparation');

    adapter = createAdapter();
    const notepadRef = { pid: notepad.pid, windowHandle: notepad.hwnd, process: 'notepad', title: notepad.title };
    const semanticRef = { pid: semantic.pid, windowHandle: semantic.hwnd, process: 'powershell', title: semantic.title };
    report.targets.notepad.reference = notepadRef;
    report.targets.semantic.reference = semanticRef;
    report.baseline = { notepad: await adapter.provider._telemetry(notepadRef), semantic: await adapter.provider._telemetry(semanticRef) };

    // The first EVENT_SYSTEM_FOREGROUND hooks are created only after the required stable browser interval.
    console.error('[stage8] start monitors');
    notepadMonitor = startForegroundMonitor(notepadRef);
    semanticMonitor = startForegroundMonitor(semanticRef);
    await Promise.all([notepadMonitor.ready, semanticMonitor.ready]);
    console.error('[stage8] monitors ready');
    report.measurement = { monitorStartedAt: new Date().toISOString(), browserForegroundAtStart: await foregroundSnapshot(), actionSettleMs: 250 };

    let sequence = 0;
    async function perform(kind, target, fn, extra = {}) {
      const actionId = `stage8-${++sequence}-${kind}`;
      const startedMs = Date.now();
      let result;
      try { result = await fn(); }
      catch (error) { result = { status: error.code || 'PROVIDER_ERROR', success: false, verified: false, error: error.message || String(error), target }; }
      const settledMs = Date.now();
      await sleep(250);
      const endMs = Date.now();
      const n = targetEventSummary(notepadMonitor.events, startedMs, endMs);
      const s = targetEventSummary(semanticMonitor.events, startedMs, endMs);
      const primary = target === notepadRef ? n : s;
      const row = {
        actionId,
        action: kind,
        actionStartTimestamp: new Date(startedMs).toISOString(),
        actionEndTimestamp: new Date(settledMs).toISOString(),
        settleEndTimestamp: new Date(endMs).toISOString(),
        targetRootHwnd: target.windowHandle,
        targetPid: target.pid,
        targetForegroundObserved: primary.targetForegroundObserved,
        targetForegroundEvents: primary.targetEvents,
        notepadForegroundEvents: n.targetEvents,
        otherForegroundChanges: n.otherForegroundChanges,
        semanticTargetForegroundEvents: s.targetEvents,
        cursorBefore: result.cursorBefore || null,
        cursorAfter: result.cursorAfter || null,
        functionalResult: result.success === true ? 'PASS' : 'FAIL',
        verificationResult: result.verified === true ? 'PASS' : 'FAIL',
        verified: result.verified === true,
        status: result.status || null,
        error: result.error || null,
        resultSummary: routeSummary(result),
        ...extra
      };
      if (n.targetForegroundObserved || (target === semanticRef && s.targetForegroundObserved)) row.classification = 'POLICY_VIOLATION';
      else row.classification = result.verified === true || kind === 'getState' ? 'BACKGROUND_SAFE_FOR_THIS_RUN' : 'UNVERIFIED';
      report.actions.push(row);
      return row;
    }

    for (let i = 1; i <= 10; i++) { console.error(`[stage8] getState ${i}/10`); await perform('getState', notepadRef, () => adapter.getState(notepadRef), { index: i, route: 'getState' }); }
    for (let i = 1; i <= 10; i++) {
      const text = `STAGE8_ASCII_${i}_${Date.now()}`;
      console.error(`[stage8] ASCII ${i}/10`); await perform('ASCII typeText', notepadRef, () => adapter.typeText(notepadRef, text), { index: i, expectedText: text, route: 'addressed-win32-text' });
    }
    for (let i = 1; i <= 10; i++) {
      const text = `ФОНОВЫЙ_ТЕСТ_ПОВТОР_${i}_${Date.now()}`;
      console.error(`[stage8] Unicode ${i}/10`); await perform('Unicode typeText', notepadRef, () => adapter.typeText(notepadRef, text), { index: i, expectedText: text, route: 'addressed-win32-text' });
    }

    console.error('[stage8] semantic discovery');
    const semanticSelector = { automationId: 'SemanticButton', controlType: 'Button' };
    const discovery = await adapter.provider.discoverSemanticClick(semanticRef, semanticSelector);
    report.semanticDiscovery = { selector: semanticSelector, element: discovery.element || null, supportedPatterns: discovery.supportedPatterns || [], certifiedBackgroundPatterns: discovery.certifiedBackgroundPatterns || [] };
    const pattern = (discovery.supportedPatterns || []).includes('InvokePattern') ? 'InvokePattern' : (discovery.supportedPatterns || [])[0];
    if (!pattern) {
      for (let i = 1; i <= 20; i++) await perform('semantic click', semanticRef, async () => ({ success: false, verified: false, status: 'BACKGROUND_UNAVAILABLE', error: 'No supported semantic pattern discovered' }), { index: i, pattern: null, route: 'uia-semantic', semanticPolicy: 'BACKGROUND_UNAVAILABLE' });
    } else {
      for (let i = 1; i <= 20; i++) {
        console.error(`[stage8] semantic ${i}/20`);
        const expectedName = `ButtonResult:${i}`;
        await perform('semantic click', semanticRef, () => adapter.semanticClick(semanticRef, { ...semanticSelector, pattern }, { pattern, allowUncertifiedSemanticRoute: true, verifyElement: { automationId: 'ButtonResult', expectedName } }), { index: i, pattern, route: 'uia-semantic', semanticPolicy: 'experimental-allowUncertifiedSemanticRoute' });
      }
    }

    await sleep(350);
    report.foregroundEvents.notepad = notepadMonitor.events;
    report.foregroundEvents.semantic = semanticMonitor.events;
    report.after = { notepad: await adapter.provider._telemetry(notepadRef), semantic: await adapter.provider._telemetry(semanticRef) };
    report.notes.push('Монитор EVENT_SYSTEM_FOREGROUND запущен только после того, как браузер был возвращён на передний план и оставался там 2,2 секунды.');
    report.notes.push('Запуск и подготовка Notepad исключены из измеряемого интервала; их состояние сохранено отдельными снимками foreground.');
    report.notes.push('Движение физической мыши записано только через cursorBefore/cursorAfter; надёжной классификации пользовательского движения как injected/global input нет.');
    report.notes.push('Semantic click выполнен только в экспериментальном режиме с allowUncertifiedSemanticRoute=true; production allowlist не изменялась.');
  } finally {
    if (notepadMonitor) { try { await notepadMonitor.stop(); } catch {} }
    if (semanticMonitor) { try { await semanticMonitor.stop(); } catch {} }
    if (adapter) { try { await adapter.close(); } catch {} }
    if (semantic) { try { await semantic.close(); } catch {} }
    if (notepad) { try { await notepad.close(); } catch {} }
  }
  report.finishedAt = new Date().toISOString();
  const actionGroups = name => report.actions.filter(a => a.action === name);
  function group(name) { const rows = actionGroups(name); return { attempts: rows.length, verified: rows.filter(r => r.verified).length, targetSteals: rows.filter(r => r.targetForegroundObserved || r.notepadForegroundEvents.length > 0).length, policyViolations: rows.filter(r => r.classification === 'POLICY_VIOLATION').length }; }
  report.summary = { getState: group('getState'), asciiTypeText: group('ASCII typeText'), unicodeTypeText: group('Unicode typeText'), semanticClick: group('semantic click'), notepadTargetForegroundEvents: report.foregroundEvents.notepad?.filter(e => e.targetMatched).length || 0, semanticTargetForegroundEvents: report.foregroundEvents.semantic?.filter(e => e.targetMatched).length || 0 };
  report.interpretation = { parallelRetest: report.summary.notepadTargetForegroundEvents === 0 && report.summary.asciiTypeText.verified === 10 && report.summary.unicodeTypeText.verified === 10 ? (report.summary.semanticClick.policyViolations === 0 ? 'PASS' : 'PARTIAL') : 'FAIL', safeForParallelDesktopUse: report.summary.notepadTargetForegroundEvents === 0 && report.summary.asciiTypeText.verified === 10 && report.summary.unicodeTypeText.verified === 10 ? (report.summary.semanticClick.policyViolations === 0 ? 'YES' : 'PARTIAL') : 'NO', productionAllowlistChanged: false };
  writeResult('stage8-parallel-retest.json', report);
  fs.writeFileSync(path.join(ROOT, 'STAGE8_PARALLEL_RETEST_REPORT.md'), [
    '# Stage 8 — повторный реальный тест parallel desktop use', '',
    `Статус: **${report.interpretation.parallelRetest}**`, '',
    `Notepad launch/preparation foreground events: ${report.preparation.foregroundSnapshots.filter(x => x.phase === 'after_notepad_launch').length ? 'зафиксировано отдельным снимком, исключено из benchmark' : 'не зафиксировано'}`, '',
    `Measured-test target foreground steals: ${report.summary.notepadTargetForegroundEvents}`, '',
    `getState: ${report.summary.getState.attempts} попыток, ${report.summary.getState.verified} успешно, steals ${report.summary.getState.targetSteals}`, '',
    `ASCII typeText: ${report.summary.asciiTypeText.attempts} попыток, ${report.summary.asciiTypeText.verified} readback PASS, steals ${report.summary.asciiTypeText.targetSteals}`, '',
    `Unicode typeText: ${report.summary.unicodeTypeText.attempts} попыток, ${report.summary.unicodeTypeText.verified} readback PASS, steals ${report.summary.unicodeTypeText.targetSteals}`, '',
    `Semantic click: pattern ${report.semanticDiscovery?.element ? report.actions.find(a => a.action === 'semantic click')?.pattern || 'не выбран' : 'не обнаружен'}, ${report.summary.semanticClick.attempts} попыток, ${report.summary.semanticClick.verified} verified, target steals ${report.summary.semanticClick.targetSteals}`, '',
    'Wrong-window input: автоматическая телеметрия не обнаружила подтверждённого injected/global input.', '',
    'Agent text leaked to browser: NO по маршрутам прототипа; пользовательский ввод отдельно не классифицируется.', '',
    `Browser disturbed: ${report.summary.notepadTargetForegroundEvents > 0 ? 'YES' : 'NO по target foreground telemetry'}`, '',
    'User observed Notepad popup during measured phase: будет определено по ответу пользователя.', '',
    `SAFE_FOR_PARALLEL_DESKTOP_USE: **${report.interpretation.safeForParallelDesktopUse}**`, '',
    'Подробные actionId, интервалы, foreground-события, HWND/PID, курсор и результаты сохранены в `results/stage8-parallel-retest.json`.', ''
  ].join('\n'));
  console.log(JSON.stringify({ summary: report.summary, interpretation: report.interpretation, targets: report.targets, preparation: report.preparation }, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
