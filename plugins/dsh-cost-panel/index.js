import { readFile } from 'node:fs/promises';
import z from 'zod';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { foldAttempts, summarize, taskTeam } from './accounting.js';
export const name = 'cost-panel';
export const inject = ['sessions', 'llm', 'connection', 'sessionProjections'];
export function apply(ctx) {
  // This revision travels through DSH's existing all-session projection feed.
  ctx.sessionProjections.register({ key: 'costPanelRevision', stateVersion: 1,
    stateSchema: z.number().int().nonnegative(), init: () => 0,
    apply: (state, event) => /^(cost-panel\/attempt|assistant\/message|llm\/retry|compaction\/(start|end))$/.test(event.type) || event.type === 'assistant/chunk' && ['usage', 'finish'].includes(event.data.chunk.type) ? state + 1 : state,
    wire: { viewSchema: z.number().int().nonnegative(), view: state => state },
  });
  ctx.on('llm/stream', (options, next) => (async function* () {
    const session = options.sessionId && ctx.sessions.get(options.sessionId);
    if (!session) { yield* next(); return; }
    const loopRequest = isAgentLoopRequest(options);
    const step = loopRequest && [...session.events].reverse().find(e => e.type === 'step/start');
    const record = { id: session.events.length, provider: options.provider, model: options.model,
      purpose: options.purpose ?? (loopRequest ? 'conversation' : 'auxiliary'), usage: null, status: 'started',
      ...step ? { turn: step.data.turn, step: step.data.step } : {},
    };
    session.append('cost-panel/attempt', record);
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') { record.usage = chunk.usage; session.append('cost-panel/attempt', record); }
        if (chunk.type === 'finish') { record.status = chunk.reason.kind; session.append('cost-panel/attempt', record); }
        yield chunk;
      }
    } finally {
      if (record.status === 'started') { record.status = 'interrupted'; session.append('cost-panel/attempt', record); }
    }
  })());
  ctx.effect(() => ctx.connection.rpc.handle('/cost-panel', async (endpoint, payload, signal) => {
    if (endpoint !== 'get' || typeof payload?.sessionId !== 'string' || payload.sessionId.length > 200) return { ok: false, error: { code: 'bad-request', message: 'Expected sessionId', details: { issues: [] } } };
    try {
      const persistence = ctx.get('sessionPersistence');
      const headers = new Map((persistence ? await persistence.list(signal) : []).map(h => [h.id, h]));
      for (const s of ctx.sessions.list()) headers.set(s.id, s.header);
      const team = taskTeam([...headers.values()], payload.sessionId);
      const catalog = JSON.parse(await readFile(new URL('./model-prices.json', import.meta.url), 'utf8'));
      const summaries = new Map();
      let incomplete = team.incomplete || !persistence;
      for (const id of new Set([...team.ids, payload.sessionId])) {
        signal.throwIfAborted();
        const live = ctx.sessions.get(id);
        if (live) summaries.set(id, summarize(foldAttempts(live.header, live.events), catalog));
        else if (persistence) {
          const stored = await persistence.inspect(id, signal);
          summaries.set(id, summarize(foldAttempts(stored.meta, stored.events), catalog));
        } else incomplete = true;
      }
      const own = summaries.get(payload.sessionId);
      if (!own) return { ok: false, error: { code: 'session-not-found', message: 'Session unavailable', details: { sessionId: payload.sessionId } } };
      let total = 0;
      for (const id of team.ids) { const s = summaries.get(id); if (!s) incomplete = true; else { total += s.total; incomplete ||= s.costUnknown; } }
      return { ok: true, value: { sessionId: payload.sessionId, own, team: { rootId: team.rootId, sessions: team.ids.length, total, costUnknown: incomplete }, checkedDate: catalog.checkedDate } };
    } catch (error) {
      if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'Request cancelled', details: {} } };
      ctx.logger.warn('cost-panel: accounting read failed', error);
      return { ok: false, error: { code: 'internal', message: 'Расходы недоступны', details: {} } };
    }
  }, { authority: 'loopback' }));
}
