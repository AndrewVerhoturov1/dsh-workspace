// Extracted from dsh-computer-adapter-prototype/src/adapter.js
// Only the functions relevant to Stage 8 are included.

async _operation(action, target, work, options = {}) {
  const started = Date.now();
  const deliveryMode = this.executionPolicy.backgroundOnly ? 'background' : (options.allowForeground ? 'foreground-allowed' : 'background');
  let beforeTelemetry = null, afterTelemetry = null, stateBefore = null, stateAfter = null;
  let commandSent = false, foregroundMonitor = null, foregroundEvents = [];
  try {
    if (target && this.provider._telemetry) beforeTelemetry = await this.provider._telemetry(target);
    const statefulAction = ['click','typeText','pressKey','scroll','drag'].includes(action);
    if (statefulAction && target) stateBefore = await this.provider.getState(target);
    if (target && ['click','semanticClick','typeText','pressKey','scroll','drag'].includes(action) && this.provider._startForegroundMonitor) {
      foregroundMonitor = await this.provider._startForegroundMonitor(target);
    }
    const value = await work(stateBefore);
    commandSent = true;
    // UIA semantic actions carry their own before/after property readback.
    if (statefulAction && target) stateAfter = await this.provider.getState(target);
    if (target && this.provider._telemetry) afterTelemetry = await this.provider._telemetry(target);
    if (foregroundMonitor) {
      // Keep the monitor alive through a short settle interval.
      await new Promise(resolve => setTimeout(resolve, 200));
      foregroundEvents = await foregroundMonitor.stop();
    }

    let verification = { verified: false, status: STATUS.ACTION_SENT, verificationMethod: 'not-requested' };
    if (action === 'typeText') {
      const direct = value?.result;
      verification = direct && typeof direct.textMatch === 'boolean'
        ? { verified: direct.textMatch, status: direct.textMatch ? STATUS.ACTION_VERIFIED : STATUS.ACTION_UNVERIFIED, verificationMethod: direct.deliveryPath || 'addressed-win32-readback', actual: direct.actualText }
        : verifyText(stateAfter, options.text);
    } else if (action === 'semanticClick') {
      verification = value?.verified === true || value?.result?.verified === true || value?.verification?.verified === true
        ? { verified: true, status: STATUS.ACTION_VERIFIED, verificationMethod: value.verificationMethod || value.result?.verificationMethod || 'uia-property-readback' }
        : { verified: false, status: STATUS.ACTION_UNVERIFIED, verificationMethod: value?.verificationMethod || value?.result?.verificationMethod || 'uia-property-readback', error: value?.verification?.error || value?.result?.verification?.error || 'Semantic action effect was not verified' };
    }

    const targetForegroundBefore = targetForegroundObserved(beforeTelemetry, target);
    const targetForegroundAfter = targetForegroundObserved(afterTelemetry, target);
    const route = value?.route || value?.result?.route || {};
    const targetForegroundEvents = foregroundEvents.filter(event => event.targetMatched === true);
    const targetBecameForeground = targetForegroundAfter && !targetForegroundBefore;
    const policyViolation = this.executionPolicy.backgroundOnly && (
      targetBecameForeground || targetForegroundEvents.length > 0 ||
      value?.physicalInputUsed === true || value?.foregroundActivationUsed === true ||
      route.usesGlobalInput === true
    );
    if (policyViolation) verification.status = STATUS.POLICY_VIOLATION;

    const result = makeResult({
      success: verification.status === STATUS.ACTION_VERIFIED || verification.status === STATUS.ACTION_SENT || verification.status === STATUS.BACKGROUND_SAFE,
      status: verification.status,
      action,
      deliveryMode: value?.deliveryMode || deliveryMode,
      target: target || null,
      durationMs: Date.now() - started,
      verified: verification.verified,
      verificationMethod: verification.verificationMethod,
      stateBefore,
      stateAfter,
      foregroundAttribution: targetForegroundEvents.length > 0 ? 'target' : classifyForeground(beforeTelemetry, afterTelemetry, target),
      commandSent,
      error: verification.error,
      metadata: {
        ...(value?.result || value || {}),
        semanticRoute: value?.semanticRoute || value?.result?.semanticRoute || value?.result?.action?.pattern || null,
        uiaElementGotKeyboardFocus: Boolean(
          (value?.result?.action?.after || value?.action?.after)?.hasKeyboardFocus === true &&
          (value?.result?.action?.before || value?.action?.before)?.hasKeyboardFocus !== true
        ),
        targetForegroundBefore,
        targetForegroundAfter,
        foregroundEvents,
        targetForegroundEvents: targetForegroundEvents.length,
        route,
        deliveryPath: value?.deliveryPath || value?.result?.deliveryPath || null,
        policy: value?.policy || (policyViolation ? STATUS.POLICY_VIOLATION : null)
      },
      data: value
    });
    return result;
  } catch (error) {
    if (foregroundMonitor) { try { foregroundEvents = await foregroundMonitor.stop(); } catch {} }
    if (target && this.provider._telemetry) { try { afterTelemetry = await this.provider._telemetry(target); } catch {} }
    const targetBecameForeground = targetForegroundObserved(afterTelemetry, target) && !targetForegroundObserved(beforeTelemetry, target);
    const failedStatus = this.executionPolicy.backgroundOnly && targetBecameForeground ? STATUS.POLICY_VIOLATION : classifyFailure(error, action).status;
    return {
      ...classifyFailure(error, action),
      status: failedStatus,
      target: target || null,
      deliveryMode,
      durationMs: Date.now() - started,
      commandSent,
      metadata: { foregroundEvents, targetForegroundEvents: foregroundEvents.filter(event => event.targetMatched === true).length },
      error: error.message || String(error)
    };
  }
}

// Adapter entry points used by the attempted Stage 8 runner.
async getState(target) { return this._operation('getState', target, async () => this.provider.getState(target)); }
async semanticClick(target, element, options = {}) { return this._operation('semanticClick', target, () => this.provider.semanticClick(target, element, options), options); }
async typeText(target, text, options = {}) { return this._operation('typeText', target, () => this.provider.typeText(target, text, options), { ...options, text }); }

// There is no separate adapter monitor implementation: _operation delegates to provider._startForegroundMonitor(target)
// and calls foregroundMonitor.stop() after action plus settle delay. The exact provider monitor lifecycle is in provider-excerpts.js.
