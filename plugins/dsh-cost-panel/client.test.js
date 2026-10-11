import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const svgPaths = {
  calls: '<path d="M2 3.5h12v8H8l-3.5 2v-2H2zM5 6.5h6"/><path d="m9 1.5-1.5 3H10l-1 2.5"/>',
  cost: '<path d="M8 1.5v13M11 4.2C10.4 3.4 9.4 3 8 3 6.3 3 5 3.8 5 5s1 1.7 3 2.2 3 1.2 3 2.6-1.3 2.3-3 2.3c-1.3 0-2.5-.5-3.2-1.4"/>',
  team: '<circle cx="6" cy="5" r="2.3"/><circle cx="11.5" cy="6" r="1.7"/><path d="M1.8 13c.4-2.4 1.8-3.7 4.2-3.7s3.9 1.3 4.2 3.7m-.1-3.3c2.2-.3 3.6.9 4 3.3"/>',
  input: '<path d="M8 2v8m-3-3 3 3 3-3M2.5 11v2.5h11V11"/>',
  reasoning: '<path d="M6 12.5h4m-3.5 2h3m-4.1-4.6a5 5 0 1 1 5.2 0c-.7.5-.9 1-1 1.6H6.4c-.1-.6-.3-1.1-1-1.6Z"/><path d="M8 2v1m-4 .7.7.7m6.6 0 .7-.7"/>',
  cache: '<ellipse cx="8" cy="3.5" rx="5.5" ry="2"/><path d="M2.5 3.5v4c0 1.1 2.5 2 5.5 2m5.5-6v4c0 1.1-2.5 2-5.5 2m-5.5-2v4c0 1.1 2.5 2 5.5 2m5.5-6v4c0 1.1-2.5 2-5.5 2"/>',
  output: '<path d="M2 8h11m-4-4 4 4-4 4"/><path d="M2 3v10"/>',
};

// A deliberately small DOM/React fixture: enough to invoke the native client
// component and effects; it does not emulate browser layout or claim GUI acceptance.
function fixture({ sessionId = 'child', result, pending = [] } = {}) {
  const hooks = [];
  let hook = 0;
  let render;
  let tree;
  let effectCleanups = [];
  const effects = [];
  const calls = [];
  const listeners = new Map();
  const listListeners = new Set();
  const styles = [];
  const head = { append(node) { styles.push(node); }, remove(node) { const i = styles.indexOf(node); if (i >= 0) styles.splice(i, 1); } };
  const document = { head, createElement: tag => ({ tag, textContent: '', remove() { head.remove(this); } }) };
  const winListeners = new Map();
  const window = { innerWidth: 1200, addEventListener(name, fn) { winListeners.set(name, fn); }, removeEventListener(name) { winListeners.delete(name); } };
  const useState = initial => {
    const i = hook++;
    if (!(i in hooks)) hooks[i] = initial;
    return [hooks[i], value => { const next = typeof value === 'function' ? value(hooks[i]) : value; if (next !== hooks[i]) { hooks[i] = next; if (render) render(); } }];
  };
  const useRef = initial => { const i = hook++; return hooks[i] ??= { current: initial }; };
  const useEffect = (fn, deps) => {
    const i = hook++;
    const prior = hooks[i];
    const changed = !prior || deps.some((value, n) => value !== prior.deps[n]);
    if (changed) {
      hooks[i] = { deps };
      effects.push(() => {
        prior?.cleanup?.();
        const cleanup = fn();
        hooks[i].cleanup = cleanup;
        effectCleanups[i] = cleanup;
      });
    }
  };
  const React = { createElement(type, props, ...children) { return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }; }, useState, useEffect, useRef };
  const module = { load({ factory }) {
    const exported = factory(name => { assert.equal(name, 'react'); return React; });
    const ctx = {
      get(name) { assert.ok(['connection', 'sessions'].includes(name)); return name === 'connection' ? connection : sessions; },
      on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
      slots: { inject(name, fn) { assert.equal(name, 'conversation.composer.dock'); register = fn; }, register: registerSlot },
    };
    exported.apply(ctx);
    return exported;
  } };
  let registered;
  const registerSlot = (options, component) => { registered = { options, component }; };
  let register;
  const sessions = { list: { subscribe(fn) { listListeners.add(fn); return () => listListeners.delete(fn); } } };
  const connection = { rpc: { call(channel, method, payload, signal) {
    const record = { channel, method, payload, signal, resolve: null, reject: null };
    calls.push(record);
    return new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
  } } };
  const context = vm.createContext({ window: { __ModuleLoader__: module }, document, AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: 'client.js' });
  register();
  assert.ok(registered);
  render = () => {
    hook = 0;
    const useProjection = key => assert.equal(key, 'costPanelRevision');
    tree = registered.component({ sessionId, useProjection });
    for (const effect of effects.splice(0)) effect();
  };
  render();
  const setRpcResult = value => { result = value; };
  const settle = async (callIndex, value = result) => { calls[callIndex].resolve({ ok: true, value }); await Promise.resolve(); await Promise.resolve(); };
  const listChanged = () => { for (const listener of [...listListeners]) listener(); };
  const switchSession = id => { sessionId = id; render(); };
  const fail = async (index, reject = false) => {
    if (reject) calls[index].reject(new Error('offline'));
    else calls[index].resolve({ ok: false, error: { code: 'unavailable' } });
    await Promise.resolve(); await Promise.resolve();
  };
  const walk = (node, predicate, found = []) => {
    if (node == null || typeof node === 'boolean') return found;
    if (Array.isArray(node)) { for (const child of node) walk(child, predicate, found); return found; }
    if (typeof node === 'object' && node.type) {
      if (predicate(node)) found.push(node);
      walk(node.props?.children, predicate, found);
    }
    return found;
  };
  const metricNodes = () => walk(tree, node => node.props?.['data-metric']);
  const metrics = () => Object.fromEntries(metricNodes().map(node => [node.props['data-metric'], node]));
  const text = node => {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(text).join('');
    return text(node.props?.children);
  };
  const tooltip = () => walk(tree, node => node.props?.role === 'tooltip')[0];
  const panel = () => walk(tree, node => node.props?.className === 'dsh-cost-panel')[0];
  const dispose = () => { for (const cleanup of [...effectCleanups].reverse()) cleanup?.(); listeners.get('dispose')?.(); };
  return { calls, listeners, listListeners, styles, winListeners, setRpcResult, settle, listChanged, switchSession, fail, metrics, metricNodes, text, tooltip, panel, dispose, get tree() { return tree; }, get registered() { return registered; }, get registerSlot() { return registerSlot; } };
}

const sample = (id = 'child', overrides = {}) => ({
  sessionId: id,
  own: { calls: 2, callsUnknown: false, costUnknown: false, costKnown: true, total: 0.0042, metrics: {
    input: { count: 1200, countUnknown: false, countKnown: true, cost: 0.001, costUnknown: false, costKnown: true, share: 25 },
    reasoning: { count: 300, countUnknown: false, countKnown: true, cost: 0.0005, costUnknown: false, costKnown: true, share: 12.5 },
    read: { count: 2000, countUnknown: false, countKnown: true, cost: 0.0002, costUnknown: false, costKnown: true, share: 5 },
    write: { count: 500, countUnknown: false, countKnown: true, cost: 0.0005, costUnknown: false, costKnown: true, share: 12.5 },
    output: { count: 400, countUnknown: false, countKnown: true, cost: 0.002, costUnknown: false, costKnown: true, share: 50 },
  } }, team: { costUnknown: false, costKnown: true, total: 0.009 }, ...overrides,
});

test('native registration preserves existing composer dock ordering/statistics', () => {
  const f = fixture();
  assert.equal(f.registered.options.name, 'conversation.composer.dock');
  assert.equal(f.registered.options.id, 'cost-panel');
  assert.equal(f.registered.options.order, -10);
  assert.equal(typeof f.registered.component, 'function');
  f.dispose();
});

test('RPC targets the actual current session and renders real supplied values and approved SVGs', async () => {
  const f = fixture({ sessionId: 'live-child-42', result: sample('live-child-42') });
  assert.equal(f.calls[0].channel, '/cost-panel');
  assert.equal(f.calls[0].method, 'get');
  assert.equal(f.calls[0].payload.sessionId, 'live-child-42');
  await f.settle(0);
  const m = f.metrics();
  assert.deepEqual(Object.keys(m), ['calls', 'cost', 'team', 'input', 'reasoning', 'cache', 'output']);
  assert.deepEqual(Object.fromEntries(Object.entries(m).map(([key, n]) => [key, n.props['aria-label'].split(':')[0]])), {
    calls: 'Вызовы модели', cost: 'Стоимость агента', team: 'Стоимость команды', input: 'Вход без кэша', reasoning: 'Размышления', cache: 'Кэш', output: 'Исходящие',
  });
  assert.equal(m.calls.props.children[1].props.children, '2');
  assert.equal(m.cost.props.children[1].props.children, '$0.0042');
  assert.equal(m.team.props.children[1].props.children, '$0.0090');
  assert.equal(m.reasoning.props.children[1].props.children, '300');
  assert.equal(m.cache.props.children[1].props.children, '2.5k');
  assert.equal(m.output.props.children[1].props.children, '400');
  const innerSvg = key => m[key].props.children[0].props.dangerouslySetInnerHTML.__html;
  assert.deepEqual(Object.fromEntries(Object.keys(svgPaths).map(key => [key, innerSvg(key)])), svgPaths);
  assert.equal(f.styles.length, 1);
  assert.match(f.styles[0].textContent, /\.dsh-cost-panel\{/);
  assert.doesNotMatch(f.styles[0].textContent, /(^|})\s*(body|button|svg)\s*\{/);
  f.dispose();
});

test('positive sub-threshold cost is visible while a true zero stays exact', async () => {
  const low = fixture({ result: sample('child', { own: { ...sample().own, total: 0.0000007 }, team: { costUnknown: false, total: 0 } }) });
  await low.settle(0);
  assert.equal(low.metrics().cost.props.children[1].props.children, '<$0.0001');
  assert.equal(low.metrics().team.props.children[1].props.children, '$0.00');
  low.dispose();
});

test('unknown values differ from reported zero; reasoning share is explanatory and cache rows split', async () => {
  const f = fixture({ result: sample('child', { own: { ...sample().own, metrics: {
    ...sample().own.metrics,
    reasoning: { count: 0, countUnknown: false, countKnown: true, cost: 0, costUnknown: false, costKnown: true, share: null },
    read: { count: 0, countUnknown: false, countKnown: true, cost: 0, costUnknown: false, costKnown: true, share: null },
    write: { count: 0, countUnknown: false, countKnown: true, cost: 0, costUnknown: false, costKnown: true, share: null },
    output: { count: 10, countUnknown: false, countKnown: true, cost: 0, costUnknown: false, costKnown: true, share: 100 },
  } } }) });
  await f.settle(0);
  assert.equal(f.metrics().reasoning.props.children[1].props.children, '0');
  assert.equal(f.metrics().cache.props.children[1].props.children, '0');
  assert.equal(f.metrics().output.props.children[1].props.children, '10');
  f.metrics().reasoning.props.onFocus({ currentTarget: { getBoundingClientRect() { return { left: 1, top: 2, width: 3, height: 4 }; } } });
  const tip = f.tooltip();
  assert.equal(tip.props.hidden, false);
  const tipText = f.text(tip);
  assert.doesNotMatch(tipText, /Доля стоимости агента|—/);
  assert.match(tipText, /Входят в исходящие/);
  assert.doesNotMatch(tipText, /Общий расход|Итого/);
  f.metrics().cache.props.onFocus({ currentTarget: { getBoundingClientRect() { return { left: 1, top: 2, width: 3, height: 4 }; } } });
  assert.match(f.text(f.tooltip()), /Кэш · чтение/);
  assert.match(f.text(f.tooltip()), /Кэш · запись/);
  assert.match(tip.props.className, /dsh-cost-tip/);
  f.dispose();
  const unknown = fixture({ result: sample('child', { own: { ...sample().own, callsUnknown: true, costUnknown: true, metrics: {
    ...sample().own.metrics, input: { count: 0, countUnknown: true, costUnknown: true }, reasoning: { count: 0, countUnknown: true, costUnknown: true }, read: { count: 0, countUnknown: true, costUnknown: true }, write: { count: 0, countUnknown: true, costUnknown: true }, output: { count: 0, countUnknown: true, costUnknown: true },
  } } }) });
  await unknown.settle(0);
  assert.equal(unknown.metrics().calls.props.children[1].props.children, '2');
  assert.equal(unknown.metrics().cost.props.children[1].props.children, '$0.0042');
  assert.equal(unknown.metrics().reasoning.props.children[1].props.children, '0');
  assert.equal(unknown.metrics().cache.props.children[1].props.children, '0');
  unknown.dispose();
});

test('tooltip is hidden by default and focus/hover exposes exactly one tooltip', async () => {
  const f = fixture({ result: sample() });
  await f.settle(0);
  const m = f.metrics();
  assert.equal(f.tooltip().props.hidden, true);
  const anchor = { getBoundingClientRect() { return { left: 10, top: 100, width: 40, height: 20 }; } };
  m.cost.props.onMouseEnter({ currentTarget: anchor });
  assert.equal(f.tooltip().props.hidden, false);
  m.team.props.onFocus({ currentTarget: anchor });
  assert.equal(f.tooltip().props.hidden, false);
  assert.equal(f.tree.props.children[3].props.children.length, 3);
  m.team.props.onBlur();
  assert.equal(f.tooltip().props.hidden, false);
  m.cost.props.onMouseLeave();
  assert.equal(f.tooltip().props.hidden, true);
  m.input.props.onFocus({ currentTarget: anchor });
  m.cost.props.onMouseEnter({ currentTarget: anchor });
  m.cost.props.onMouseLeave();
  assert.equal(f.tooltip().props.hidden, false);
  assert.match(f.text(f.tooltip()), /Вход без кэша/);
  m.input.props.onBlur();
  assert.equal(f.tooltip().props.hidden, true);
  f.dispose();
});

test('list snapshots trigger current-child refetch including absent descendant publication; unary requests coalesce', async () => {
  const f = fixture({ sessionId: 'actual-child', result: sample('actual-child') });
  assert.equal(f.calls.length, 1);
  f.listChanged(); // manager publishes even when child is absent from ordinary list items
  f.listChanged();
  assert.equal(f.calls.length, 1);
  await f.settle(0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].payload.sessionId, 'actual-child');
  f.listChanged();
  assert.equal(f.calls.length, 2);
  await f.settle(1);
  assert.equal(f.calls.length, 3);
  f.dispose();
});

test('dispose removes subscriptions/style and aborts in-flight unary request without polling', async () => {
  const f = fixture({ sessionId: 'child', result: sample() });
  const signal = f.calls[0].signal;
  assert.equal(signal.aborted, false);
  assert.equal(f.listListeners.size, 1);
  assert.equal(f.winListeners.size, 0);
  f.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(f.listListeners.size, 0);
  assert.equal(f.listeners.has('connection/reset'), false);
  assert.equal(f.styles.length, 0);
});
const displayed = f => Object.fromEntries(Object.entries(f.metrics()).map(([key, node]) => [key, node.props.children[1].props.children]));
const focus = (f, key) => f.metrics()[key].props.onFocus({ currentTarget: { getBoundingClientRect: () => ({ left: 1, top: 100, width: 20, height: 20 }) } });

test('first session without usage displays zeros and compact no-data tooltip, never dashes', async () => {
  const f = fixture({ sessionId: 'empty' });
  assert.deepEqual(displayed(f), { calls: '0', cost: '$0.00', team: '$0.00', input: '0', reasoning: '0', cache: '0', output: '0' });
  for (const key of Object.keys(f.metrics())) {
    focus(f, key);
    assert.match(f.text(f.tooltip()), /данные ещё не получены/);
    assert.doesNotMatch(f.text(f.tooltip()), /—|неизвестн/);
  }
  await f.settle(0, { sessionId: 'empty', own: { calls: 0, total: 0, costKnown: false, metrics: {} }, team: { total: 0, costKnown: false } });
  focus(f, 'input');
  assert.match(f.text(f.tooltip()), /данные ещё не получены/);
  f.dispose();
});

test('RPC errors, missing fields and partial lower snapshots retain known numbers per session', async () => {
  const f = fixture({ result: sample() });
  await f.settle(0);
  const before = displayed(f);
  f.listChanged();
  await f.fail(1);
  assert.deepEqual(displayed(f), before);
  focus(f, 'cost');
  assert.match(f.text(f.tooltip()), /неполные данные.*оценка по API/);
  f.listChanged();
  await f.fail(2, true);
  assert.deepEqual(displayed(f), before);
  f.listChanged();
  await f.settle(3, { sessionId: 'child', own: { calls: 1, callsUnknown: true, total: 0.001, costKnown: true, costUnknown: true, metrics: {
    input: { count: 500, countKnown: true, countUnknown: true, cost: 0.0001, costKnown: true, costUnknown: true },
    read: { count: 0, countKnown: false, countUnknown: true, cost: 0, costKnown: false, costUnknown: true },
  } }, team: { total: 0.003, costKnown: true, costUnknown: true } });
  assert.deepEqual(displayed(f), before);
  focus(f, 'reasoning');
  assert.match(f.text(f.tooltip()), /неполные данные/);
  f.listChanged();
  await f.settle(4, sample('child', { own: { ...sample().own, calls: 3, total: 0.005 } }));
  assert.equal(displayed(f).calls, '3');
  assert.equal(displayed(f).cost, '$0.0050');
  focus(f, 'cost');
  assert.doesNotMatch(f.text(f.tooltip()), /неполные/);
  f.dispose();
});

test('switching sessions, returning and late replies never transfer another session values', async () => {
  const f = fixture({ sessionId: 'a', result: sample('a') });
  await f.settle(0);
  const a = displayed(f);
  f.listChanged(); // old-session request remains in flight
  f.switchSession('b');
  assert.equal(f.calls[1].signal.aborted, true);
  assert.equal(f.calls[2].payload.sessionId, 'b');
  assert.equal(displayed(f).calls, '0');
  assert.equal(displayed(f).team, '$0.00');
  await f.settle(1, sample('a', { own: { ...sample().own, calls: 999 } }));
  assert.equal(displayed(f).calls, '0');
  await f.settle(2, sample('b', { own: { ...sample().own, calls: 7, total: 0.1 }, team: { total: 0.2, costKnown: true } }));
  assert.equal(displayed(f).calls, '7');
  f.switchSession('a');
  assert.deepEqual(displayed(f), a);
  await f.settle(3, sample('b')); // unexpected session RPC must not replace a
  assert.deepEqual(displayed(f), a);
  f.dispose();
});

test('known partial costs and cache counts stay visible, unknown shares are omitted', async () => {
  const f = fixture({ result: sample('child', { own: { ...sample().own, costUnknown: true, total: 0.001, metrics: {
    ...sample().own.metrics,
    read: { count: 30, countKnown: true, countUnknown: false, cost: 0.00001, costKnown: true, costUnknown: false },
    write: { count: 0, countKnown: false, countUnknown: true, cost: 0, costKnown: false, costUnknown: true },
  } }, team: { total: 0.002, costKnown: true, costUnknown: true } }) });
  await f.settle(0);
  assert.equal(displayed(f).cost, '$0.0010');
  assert.equal(displayed(f).team, '$0.0020');
  assert.equal(displayed(f).cache, '30');
  focus(f, 'team');
  assert.match(f.text(f.tooltip()), /неполные данные.*оценка по API/);
  focus(f, 'cache');
  assert.match(f.text(f.tooltip()), /данные ещё не получены/);
  assert.doesNotMatch(f.text(f.tooltip()), /—/);
  f.dispose();
});

test('received counts with unknown rates differ from no data; partial tiers and missing reasoning are explained', async () => {
  const unknown = fixture({ result: sample('child', { own: { ...sample().own, total: 0, costKnown: false, costUnknown: true, rateUnknown: true } }) });
  await unknown.settle(0);
  focus(unknown, 'cost');
  assert.match(unknown.text(unknown.tooltip()), /тариф неизвестен/);
  assert.doesNotMatch(unknown.text(unknown.tooltip()), /данные ещё не получены/);
  unknown.dispose();
  const partial = fixture({ result: sample('child', { own: { ...sample().own, total: 0.00679628, costUnknown: true, tierUnknown: true, metrics: { ...sample().own.metrics, reasoning: { count: 0, countKnown: false, countUnknown: true } } }, team: { total: 0.00679628, costKnown: true, costUnknown: true, tierUnknown: true } }) });
  await partial.settle(0);
  assert.equal(displayed(partial).cost, '$0.0068');
  assert.equal(displayed(partial).team, '$0.0068');
  focus(partial, 'cost');
  assert.match(partial.text(partial.tooltip()), /неполные данные.*нижняя оценка: порог тарифа неизвестен.*оценка по API/);
  focus(partial, 'team');
  assert.match(partial.text(partial.tooltip()), /порог тарифа неизвестен/);
  focus(partial, 'reasoning');
  assert.match(partial.text(partial.tooltip()), /Отдельный счётчик не получен или не сохранён/);
  assert.equal(displayed(partial).reasoning, '0');
  partial.dispose();
});

test('returning to a stale session keeps its numbers and incompleteness until fresh data arrives', async () => {
  const f = fixture({ result: sample() });
  await f.settle(0);
  const before = displayed(f);
  f.listChanged();
  await f.fail(1);
  f.switchSession('other');
  assert.equal(displayed(f).calls, '0');
  f.switchSession('child');
  assert.deepEqual(displayed(f), before);
  focus(f, 'cost');
  assert.match(f.text(f.tooltip()), /неполные данные/);
  await f.settle(3, sample());
  assert.doesNotMatch(f.text(f.tooltip()), /неполные данные/);
  f.dispose();
});
