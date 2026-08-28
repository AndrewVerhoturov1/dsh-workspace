// Extracted from dsh-computer-use-evaluation/dsh-computer-adapter-prototype/src/provider.js
// Only target validation, monitor lifecycle, getState, semantic click, and strict text routes.

async _telemetry(target) {
  const t = normaliseTarget(target);
  if (!t.pid) return { foreground: null, cursor: null, target: null };
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', this.telemetryScript, '-TargetPid', String(t.pid)], { windowsHide: true, stdio:['ignore','pipe','pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new QwenTransportError('Telemetry timeout','TIMEOUT')); }, 5000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new QwenTransportError(err || `Telemetry exited ${code}`));
      try { resolve(JSON.parse(out.trim())); }
      catch (e) { reject(new QwenTransportError(`Invalid telemetry: ${e.message}`)); }
    });
  });
}

async _validate(target) {
  const result = await validateTarget(target, this.telemetryScript);
  const remembered = normaliseTarget(result.target);
  if (remembered.pid) {
    const key = String(remembered.pid);
    const previous = this.targets.get(key);
    if (previous?.windowHandle && remembered.windowHandle && Number(previous.windowHandle) !== Number(remembered.windowHandle)) {
      throw new QwenTransportError('Target window handle changed', 'TARGET_STALE');
    }
    this.targets.set(key, remembered);
  }
  return result.target;
}

async _requireWin32Target(target) {
  const checked = await this._validate(target);
  if (!checked.pid || !checked.windowHandle) {
    throw new QwenTransportError('Addressed background path requires pid and stable windowHandle', 'BACKGROUND_UNAVAILABLE');
  }
  return checked;
}

async getState(target) {
  const { result } = await this._call('get_app_state', {}, target);
  return snapshotFrom(result);
}

async _runPowerShell(script, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new QwenTransportError('Background helper timeout', 'TIMEOUT')); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.on('error', error => { clearTimeout(timer); reject(new QwenTransportError(`Background helper error: ${error.message}`, 'PROVIDER_ERROR')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new QwenTransportError(err.trim() || `Background helper exited ${code}`, 'BACKGROUND_UNAVAILABLE'));
      try { resolve(JSON.parse(Buffer.from(out.trim(), 'base64').toString('utf8'))); }
      catch (error) { reject(new QwenTransportError(`Invalid background helper result: ${error.message}`, 'PROVIDER_ERROR')); }
    });
  });
}

async _startForegroundMonitor(target) {
  if (!this.policy.monitorForeground || !this.policy.backgroundOnly) return null;
  const checked = await this._requireWin32Target(target);
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.foregroundMonitorScript,
    '-TargetPid', String(checked.pid), '-TargetHwnd', String(checked.windowHandle), '-DurationMs', '120000'
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const events = []; let buffer = ''; let stderr = ''; let readyResolve; let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u); buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.event === 'ready') readyResolve(); else events.push(event);
      } catch { events.push({ parseError: line }); }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', error => readyReject(new QwenTransportError(`Foreground monitor error: ${error.message}`, 'BACKGROUND_UNAVAILABLE')));
  child.once('close', code => {
    if (code !== 0) readyReject(new QwenTransportError(stderr || `Foreground monitor exited ${code}`, 'BACKGROUND_UNAVAILABLE'));
  });
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => setTimeout(() => reject(new QwenTransportError('Foreground monitor startup timeout', 'BACKGROUND_UNAVAILABLE')), 5000))
    ]);
  } catch (error) {
    try { child.kill(); } catch {}
    throw error;
  }
  return {
    child,
    events,
    startedAt: Date.now(),
    get stderr() { return stderr; },
    // Problematic lifecycle from the current prototype:
    stop: async () => {
      if (!child.killed) child.kill();
      await new Promise(resolve => child.once('close', resolve));
      if (buffer.trim()) { try { events.push(JSON.parse(buffer)); } catch {} }
      return events;
    }
  };
}

async _semanticHelper(action, target, element, options = {}) {
  const checked = await this._requireWin32Target(target);
  const selector = this._semanticSelector(element);
  if (!selector.automationId && !selector.name && !selector.className && !selector.runtimeId && !(selector.elementIndex > 0)) {
    throw new QwenTransportError('UIA semantic action requires an addressed element selector', 'BACKGROUND_UNAVAILABLE');
  }
  const args = ['-Action', action, '-TargetPid', String(checked.pid), '-TargetHwnd', String(checked.windowHandle)];
  for (const [key, value] of Object.entries({ AutomationId: selector.automationId, Name: selector.name, ControlType: selector.controlType, ClassName: selector.className, RuntimeId: selector.runtimeId, ElementIndex: selector.elementIndex, Pattern: selector.pattern || options.pattern })) {
    if (value !== undefined && value !== null && value !== '' && !(key === 'ElementIndex' && !(Number(value) > 0))) args.push(`-${key}`, String(value));
  }
  const payload = await this._runPowerShell(this.semanticClickScript, args);
  if (!payload.ok || payload.physicalInputUsed || payload.foregroundActivationUsed || payload.route?.usesForeground || payload.route?.usesGlobalInput) {
    throw new QwenTransportError(`UIA semantic route did not prove background safety: ${JSON.stringify(payload)}`, 'BACKGROUND_UNAVAILABLE');
  }
  if (action === 'click' && payload.verified !== true) {
    throw new QwenTransportError(`UIA semantic action effect was not verified: ${JSON.stringify(payload.verification || {})}`, 'BACKGROUND_UNAVAILABLE');
  }
  return {
    result: payload,
    target: checked,
    deliveryMode: 'background-safe-uia-semantic',
    deliveryPath: `uia-semantic:${payload.semanticRoute || payload.action?.pattern || 'discovery'}`,
    policy: 'BACKGROUND_SAFE',
    physicalInputUsed: false,
    foregroundActivationUsed: false,
    cursorMovedByBackend: false,
    route: payload.route,
    semanticRoute: payload.semanticRoute,
    supportedPatterns: payload.supportedPatterns,
    verified: payload.verified,
    verification: payload.verification,
    verificationMethod: payload.verificationMethod
  };
}

async discoverSemanticClick(target, element, options = {}) {
  const payload = await this._semanticHelper('discover', target, element, options);
  const descriptor = payload.result.element || {};
  const certifiedBackgroundPatterns = (payload.result.supportedPatterns || []).filter(pattern => Boolean(certificationFor({ provider: 'qwen', backend: 'uia', framework: descriptor.frameworkId, controlType: descriptor.controlType, className: descriptor.className, pattern })));
  return { ...payload.result, target: payload.target, certifiedBackgroundPatterns, deliveryPath: 'uia-semantic:discovery' };
}

async semanticClick(target, element, options = {}) {
  if (this.policy.backgroundOnly && options.allowUncertifiedSemanticRoute !== true) {
    const discovery = await this.discoverSemanticClick(target, element, options);
    const selected = selectCertifiedPattern({ ...(discovery.element || {}), supportedPatterns: discovery.supportedPatterns || [] }, { pattern: options.pattern, provider: 'qwen', backend: 'uia' });
    if (!selected) {
      const supported = discovery.supportedPatterns || [];
      throw new QwenTransportError(`No certified background UIA route for ${discovery.element?.frameworkId || 'unknown'} ${discovery.element?.className || discovery.element?.controlType || 'unknown'} (${supported.join(', ') || 'none'})`, 'BACKGROUND_UNAVAILABLE');
    }
    options = { ...options, pattern: selected.pattern };
  }
  return this._semanticHelper('click', target, element, options);
}

async typeText(target, text, options = {}) {
  if (typeof text !== 'string' || !text.length) throw new QwenTransportError('Text is required', 'INVALID_ARGUMENT');
  if (this.policy.backgroundOnly) {
    if (options.mode === 'clipboard' || options.allowSharedClipboard === true || this.policy.allowSharedClipboard === true) {
      if (options.allowSharedClipboard !== true && this.policy.allowSharedClipboard !== true) {
        throw new QwenTransportError('Clipboard route is disabled in strict backgroundOnly mode', 'BACKGROUND_UNAVAILABLE');
      }
      return this._clipboardType(target, text);
    }
    // Both ASCII and Unicode use this addressed Win32 route by default.
    return this._backgroundText(target, text);
  }
  const mode = options.mode || (containsUnicode(text) ? 'clipboard' : 'qwen');
  if (mode === 'clipboard') return this._clipboardType(target, text);
  if (options.forceEscapedJson !== false) return this._qwenEscapedType(target, text);
  return this._call('type_text', { text }, target);
}

async _backgroundText(target, text) {
  const checked = await this._requireWin32Target(target);
  const file = path.join(os.tmpdir(), `dsh-cu-${process.pid}-${Date.now()}-text.txt`);
  fs.writeFileSync(file, text, 'utf8'); this.tempFiles.add(file);
  try {
    const payload = await this._runPowerShell(this.backgroundTextScript, ['-TargetPid', String(checked.pid), '-TargetHwnd', String(checked.windowHandle), '-TextPath', file]);
    if (!payload.ok || !payload.textMatch || payload.physicalInputUsed || payload.foregroundActivationUsed || payload.route?.usesGlobalInput || payload.route?.usesForeground) {
      throw new QwenTransportError(`Direct Win32 text path did not prove background safety: ${JSON.stringify(payload)}`, 'BACKGROUND_UNAVAILABLE');
    }
    return { result: payload, target: checked, deliveryMode: 'background-safe-addressed-em-replacesel', deliveryPath: payload.deliveryPath, policy: 'BACKGROUND_SAFE', physicalInputUsed: false, foregroundActivationUsed: false, cursorMovedByBackend: false, route: payload.route };
  } finally {
    try { fs.unlinkSync(file); } catch {}
    this.tempFiles.delete(file);
  }
}
