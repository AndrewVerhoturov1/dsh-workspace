// DSH usage buckets are disjoint; reasoning is a subset of output.
const buckets = { input: 'inputTokens', reasoning: 'reasoningTokens', read: 'cacheReadTokens', write: 'cacheWriteTokens', output: 'outputTokens' };
// Usage chunks and durable snapshots may omit fields that were already supplied.
export function mergeUsage(previous, next) {
  const usage = { ...previous };
  const partial = !Object.values(buckets).every(field => typeof next?.[field] === 'number');
  for (const [field, value] of Object.entries(next ?? {})) {
    if (typeof value === 'number' && next[field + 'Known'] !== false) {
      usage[field] = partial && typeof previous?.[field] === 'number' ? Math.max(previous[field], value) : value;
      delete usage[field + 'Known'];
    } else if (field.endsWith('TokensKnown') && value === false && typeof usage[field.slice(0, -5)] !== 'number') usage[field] = false;
  }
  return Object.keys(usage).length ? usage : null;
}
export function foldAttempts(header, events) {
  const attempts = new Map();
  let route = {};
  let legacyCompaction = false;
  let legacyRetry = false;
  const observedSteps = new Set();
  for (const event of events) {
    const d = event.data;
    if (event.type === 'request/header') route = d.header.config;
    if (event.seq < (header.seedLength ?? 0)) continue;
    if (event.type === 'compaction/start') legacyCompaction = true;
    if (event.type === 'cost-panel/attempt') {
      if (d.purpose === 'conversation' && d.turn != null) {
        const stepKey = 's:' + d.turn + ':' + d.step;
        observedSteps.add(stepKey);
        attempts.delete(stepKey);
      }
      const old = attempts.get('p:' + d.id);
      attempts.set('p:' + d.id, { ...old, ...d, usage: mergeUsage(old?.usage, d.usage), observed: true });
    } else if (event.type === 'assistant/chunk' || event.type === 'assistant/message') {
      const key = 's:' + d.turn + ':' + d.step;
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
  return { attempts: [...attempts.values()], incompleteHistory: legacyRetry || legacyCompaction && compactions.length < markerCount };
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
  for (const attempt of fold.attempts) {
    const usage = attempt.usage;
    const rates = ratesFor(attempt, usage, catalog);
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
  return { calls: fold.attempts.length, callsUnknown: fold.incompleteHistory, total, costKnown: ['input', 'read', 'write', 'output'].some(key => metrics[key].costKnown), costUnknown, metrics };
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
