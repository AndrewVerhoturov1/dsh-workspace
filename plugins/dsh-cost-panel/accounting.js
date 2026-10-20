// DSH usage buckets are disjoint; reasoning is a subset of output.
const buckets = { input: 'inputTokens', reasoning: 'reasoningTokens', read: 'cacheReadTokens', write: 'cacheWriteTokens', output: 'outputTokens' };
// Usage chunks and durable snapshots may omit fields that were already supplied.
export function mergeUsage(previous, next) {
  const usage = { ...previous };
  const partial = !Object.values(buckets).every(field => typeof next?.[field] === 'number');
  for (const [field, value] of Object.entries(next ?? {})) {
    if (typeof value === 'number' && next[field + 'Known'] !== false) {
      usage[field] = partial && typeof previous?.[field] === 'number' ? Math.max(previous[field], value) : value;
      // An SDK-normalized zero is not proof of a provider-reported zero.
      if (field === 'cacheWriteTokens' && (next.cacheWriteTokensKnown === true || previous?.cacheWriteTokensKnown === true))
        usage.cacheWriteTokensKnown = true;
      else delete usage[field + 'Known'];
    } else if (field.endsWith('TokensKnown') && value === false && typeof usage[field.slice(0, -5)] !== 'number') usage[field] = false;
  }
  return Object.keys(usage).length ? usage : null;
}
function correlateNativeStreams(events, seedLength) {
  // The observer appends immediately before yielding each native chunk.
  // Sequence adjacency, chunk kind, and the active step prove stream identity;
  // matching token numbers by themselves never do.
  const evidence = new Map(), seenNative = new Set();
  let activeStep = null;
  for (let i = 0; i < events.length; i++) {
    const native = events[i], observer = events[i - 1];
    if (native.seq < seedLength) continue;
    if (native.type === 'step/start') activeStep = 's:' + native.data.turn + ':' + native.data.step;
    if (native.type === 'step/end' || native.type === 'turn/end') activeStep = null;
    if (native.type !== 'assistant/chunk') continue;
    const data = native.data, chunk = data?.chunk;
    const key = 's:' + data?.turn + ':' + data?.step;
    if (observer?.type === 'cost-panel/attempt' && observer.seq >= seedLength &&
        native.seq === observer.seq + 1 && data?.turn != null && data?.step != null) {
      const d = observer.data;
      if (d?.id != null && ['auxiliary', 'conversation'].includes(d.purpose)) {
        const id = 'p:' + d.id;
        const proof = evidence.get(id) ?? { key, turn: data.turn, step: data.step, start: false, usage: false, finish: false, conflict: false };
        if (proof.key !== key) proof.conflict = true;
        if (!seenNative.has(key) && activeStep === key && d.status === 'started' && d.usage == null &&
            chunk?.type !== 'usage' && chunk?.type !== 'finish') proof.start = true;
        if (chunk?.type === 'usage' && chunk.usage && d.usage &&
            Object.entries(chunk.usage).some(([, value]) => typeof value === 'number') &&
            Object.entries(chunk.usage).every(([field, value]) =>
              typeof value !== 'number' || typeof d.usage[field] === 'number' && d.usage[field] >= value))
          proof.usage = true;
        if (chunk?.type === 'finish' && chunk.reason?.kind === d.status) proof.finish = true;
        evidence.set(id, proof);
      }
    }
    seenNative.add(key);
  }
  const linked = new Map(), uncertain = new Set();
  for (const [id, proof] of evidence) {
    if (!proof.conflict && (proof.start || proof.usage || proof.finish)) linked.set(id, proof);
    else uncertain.add(proof.key);
  }
  return { linked, uncertain };
}

export function foldAttempts(header, events) {
  const attempts = new Map();
  let route = {};
  let legacyCompaction = false;
  let legacyRetry = false;
  const observedSteps = new Set(), nativeFallbackSteps = new Set();
  const { linked, uncertain } = correlateNativeStreams(events, header.seedLength ?? 0);
  let activeStep = null;
  for (const event of events) {
    const d = event.data;
    if (event.type === 'request/header') route = d.header.config;
    if (event.seq < (header.seedLength ?? 0)) continue;
    if (event.type === 'step/start') activeStep = 's:' + d.turn + ':' + d.step;
    if (event.type === 'step/end' || event.type === 'turn/end') activeStep = null;
    if (event.type === 'compaction/start') legacyCompaction = true;
    if (event.type === 'cost-panel/attempt') {
      const id = 'p:' + d.id;
      const proof = d.turn == null || d.step == null ? linked.get(id) : null;
      const observed = proof ? { ...d, purpose: 'conversation', turn: proof.turn, step: proof.step } : d;
      if (d.purpose === 'auxiliary' && d.turn == null && !proof && activeStep) uncertain.add(activeStep);
      if (observed.purpose === 'conversation' && observed.turn != null && observed.step != null) {
        const stepKey = 's:' + observed.turn + ':' + observed.step;
        observedSteps.add(stepKey);
        attempts.delete(stepKey);
      }
      const old = attempts.get(id);
      attempts.set(id, { ...old, ...observed, usage: mergeUsage(old?.usage, d.usage), observed: true });
    } else if (event.type === 'assistant/chunk' || event.type === 'assistant/message') {
      const key = 's:' + d.turn + ':' + d.step;
      nativeFallbackSteps.add(key);
      const old = attempts.get(key);
      if (observedSteps.has(key)) continue; // the observer's full snapshots own these calls
      const record = old ?? { ...route, purpose: 'conversation', usage: null, status: 'unknown' };
      if (event.type === 'assistant/message') {
        const source = d.message.source;
        if (source.kind === 'model') Object.assign(record, { provider: source.provider, model: source.model });
        record.usage = mergeUsage(record.usage, d.usage);
        record.status = d.interrupted ? 'aborted' : 'finished';
      } else {
        if (d.chunk.type === 'usage') record.usage = mergeUsage(record.usage, d.chunk.usage);
        if (d.chunk.type === 'finish') record.status = d.chunk.reason.kind;
      }
      attempts.set(key, record);
    } else if (event.type === 'llm/retry') {
      const key = 's:' + d.turn + ':' + d.step;
      // Native retries share turn/step; their usage snapshots cannot be assigned per attempt.
      if (!observedSteps.has(key)) legacyRetry = true;
      if (!observedSteps.has(key) && !attempts.has(key)) attempts.set(key, { ...route, provider: d.provider, purpose: 'conversation', usage: null, status: 'error' });
    }
  }
  // Old compaction calls have no durable token usage; never turn that gap into zero.
  const compactions = [...attempts.values()].filter(a => a.purpose === 'compaction');
  const markerCount = events.filter(e => e.seq >= (header.seedLength ?? 0) && e.type === 'compaction/start').length;
  const ambiguous = [...uncertain].some(key => nativeFallbackSteps.has(key) && !observedSteps.has(key));
  return { attempts: [...attempts.values()], duplicateUncertain: ambiguous, incompleteHistory: legacyRetry || ambiguous || legacyCompaction && compactions.length < markerCount };
}
function ratesFor(attempt, usage, catalog) {
  const provider = attempt.provider === 'codex' ? 'openai' : attempt.provider; // API-equivalent estimate, not subscription billing
  const item = catalog.models.find(m => m.publicId === attempt.model && m.provider === provider);
  if (!item || !usage) return null;
  // The catalog is Standard only; do not silently price another processing tier.
  if (attempt.serviceTier != null && !['default', 'standard'].includes(attempt.serviceTier)) return null;
  const processingUnknown = attempt.serviceTier == null;
  const tiers = item.pricesUSDper1M;
  if (tiers.standard) return { ...tiers.standard, processingUnknown };
  const thresholdKey = Object.keys(tiers).find(k => k.startsWith('promptInputLTE'));
  const threshold = Number(thresholdKey?.slice('promptInputLTE'.length));
  const promptKnown = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every(k => typeof usage[k] === 'number' && usage[k + 'Known'] !== false);
  const prompt = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce((sum, key) => sum + (typeof usage[key] === 'number' && usage[key + 'Known'] !== false ? usage[key] : 0), 0);
  if (!promptKnown && prompt <= threshold) {
    // Missing nonnegative buckets cannot prove the lower tier; a known subtotal
    // above the threshold already proves the higher tier for the whole request.
    const low = tiers['promptInputLTE' + threshold];
    const high = tiers['promptInputGT' + threshold];
    if (!low || !high) return null;
    return { ...Object.fromEntries(Object.keys(low).filter(k => typeof low[k] === 'number' && typeof high[k] === 'number').map(k => [k, Math.min(low[k], high[k])])), tierUnknown: true, processingUnknown };
  }
  const rates = tiers[(prompt > threshold ? 'promptInputGT' : 'promptInputLTE') + threshold];
  return rates ? { ...rates, processingUnknown } : null;
}
export function summarize(fold, catalog) {
  const metrics = Object.fromEntries(Object.keys(buckets).map(k => [k, { count: 0, countKnown: false, countUnknown: false, cost: 0, costKnown: false, costUnknown: false }]));
  let total = 0;
  let costUnknown = fold.incompleteHistory;
  const writeScenario = { tokens: 0, tokensKnown: false, tokensUnknown: !!fold.incompleteHistory,
    extra: 0, extraKnown: false, extraUnknown: !!fold.incompleteHistory, rateMissing: false };
  for (const attempt of fold.attempts) {
    const usage = attempt.usage;
    const rates = ratesFor(attempt, usage, catalog);
    // Codex hypothesis uses the catalog's fixed Standard row, not the baseline long-context tier.
    const scenarioRates = attempt.provider === 'codex' && rates
      ? catalog.models.find(m => m.provider === 'openai' && m.publicId === attempt.model)?.pricesUSDper1M?.promptInputLTE272000
      : rates;
    if (!rates || !scenarioRates) writeScenario.rateMissing = true; // unknown model or unsupported tier
    const writeCount = usage?.cacheWriteTokens;
    // Positive actual writes are already charged; zero needs explicit provenance.
    const provenWrite = typeof writeCount === 'number' && usage.cacheWriteTokensKnown !== false &&
      (writeCount > 0 || usage.cacheWriteTokensKnown === true);
    if (provenWrite) { writeScenario.tokensKnown = true; writeScenario.extraKnown = true; }
    else if (typeof usage?.inputTokens !== 'number' || usage.inputTokensKnown === false) {
      writeScenario.tokensUnknown = true;
      writeScenario.extraUnknown = true;
    } else {
      // inputTokens is already the disjoint, non-cache-read input bucket.
      const count = usage.inputTokens;
      writeScenario.tokens += count;
      writeScenario.tokensKnown = true;
      if (typeof usage.cacheReadTokens !== 'number' || usage.cacheReadTokensKnown === false) writeScenario.tokensUnknown = true;
      if (count === 0) writeScenario.extraKnown = true;
      else if (typeof scenarioRates?.inputUncached === 'number' && typeof scenarioRates?.cacheWrite === 'number') {
        // Replace the input category: never add the whole write fee to baseline.
        writeScenario.extra += count * (scenarioRates.cacheWrite - scenarioRates.inputUncached) / catalog.unitTokens;
        writeScenario.extraKnown = true;
        if (scenarioRates.tierUnknown || rates?.processingUnknown) writeScenario.extraUnknown = true;
      } else { writeScenario.extraUnknown = true; writeScenario.rateMissing = true; }
    }
    const prices = { input: rates?.inputUncached, reasoning: rates?.output, read: rates?.cacheRead, write: rates?.cacheWrite, output: rates?.output };
    for (const [key, field] of Object.entries(buckets)) {
      const m = metrics[key];
      const count = usage?.[field];
      if (typeof count !== 'number' || usage?.[field + 'Known'] === false) { m.countUnknown = true; m.costUnknown = true; continue; }
      m.count += count;
      m.countKnown = true;
      let amount;
      if (count === 0) amount = 0;
      else if (key === 'write' && prices.write == null && rates?.cacheWrite5m != null) {
        // Only price actual TTL buckets. DSH's normalized aggregate does not imply 5m.
        const short = usage.cacheWrite5mTokens;
        const long = usage.cacheWrite1hTokens;
        if (typeof short === 'number' && typeof long === 'number' && short + long === count) amount = (short * rates.cacheWrite5m + long * rates.cacheWrite1h) / catalog.unitTokens;
      } else if (typeof prices[key] === 'number') amount = count * prices[key] / catalog.unitTokens;
      if (amount == null) m.costUnknown = true;
      else { m.cost += amount; m.costKnown = true; if (count > 0 && (rates?.tierUnknown || rates?.processingUnknown)) m.costUnknown = true; }
    }
  }
  for (const key of ['input', 'read', 'write', 'output']) { total += metrics[key].cost; costUnknown ||= metrics[key].costUnknown; }
  if (fold.incompleteHistory) for (const m of Object.values(metrics)) { m.countUnknown = true; m.costUnknown = true; }
  for (const m of Object.values(metrics)) m.share = !costUnknown && !m.costUnknown && total > 0 ? m.cost / total * 100 : null;
  const costKnown = ['input', 'read', 'write', 'output'].some(key => metrics[key].costKnown);
  writeScenario.total = total + writeScenario.extra;
  writeScenario.costKnown = costKnown && writeScenario.extraKnown && !writeScenario.rateMissing;
  writeScenario.costUnknown = !!(costUnknown || writeScenario.extraUnknown || writeScenario.rateMissing);
  return { calls: fold.attempts.length, callsUnknown: fold.incompleteHistory, duplicateUncertain: !!fold.duplicateUncertain, total, costKnown, costUnknown, metrics, writeScenario };
}
export function taskTeam(headers, currentId) {
  const byId = new Map(headers.map(h => [h.id, h]));
  let root = byId.get(currentId);
  if (!root) return { rootId: currentId, ids: [currentId], incomplete: true };
  const seen = new Set();
  let incomplete = false;
  while (root.origin === 'subagent' && root.parentSession) {
    if (seen.has(root.id)) { incomplete = true; break; }
    seen.add(root.id);
    const parent = byId.get(root.parentSession);
    if (!parent) { incomplete = true; break; }
    root = parent;
  }
  const ids = new Set([root.id]);
  const pending = [root.id];
  for (let i = 0; i < pending.length; i++) {
    for (const h of byId.values()) if (h.origin === 'subagent' && h.parentSession === pending[i] && !ids.has(h.id)) { ids.add(h.id); pending.push(h.id); }
  }
  return { rootId: root.id, ids: [...ids], incomplete };
}
