// Native DSH module-loader entry: React is supplied by the existing Web shell.
window.__ModuleLoader__.load({ id: 'dsh-cost-panel', factory: require => {
  const React = require('react');
  const { createElement: h, useState, useEffect, useRef } = React;
  const exact = n => n.toLocaleString('ru-RU');
  const compact = n => n < 1000 ? String(n) : (n < 1000000 ? (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k' : (n / 1000000).toFixed(1) + 'm');
  const money = n => n > 0 && n < 0.0001 ? '<$0.0001' : '$' + (n === 0 ? '0.00' : n >= 1 ? n.toFixed(2) : n.toFixed(4));
  const paths = {
    calls: '<path d="M2 3.5h12v8H8l-3.5 2v-2H2zM5 6.5h6"/><path d="m9 1.5-1.5 3H10l-1 2.5"/>',
    cost: '<path d="M8 1.5v13M11 4.2C10.4 3.4 9.4 3 8 3 6.3 3 5 3.8 5 5s1 1.7 3 2.2 3 1.2 3 2.6-1.3 2.3-3 2.3c-1.3 0-2.5-.5-3.2-1.4"/>',
    team: '<circle cx="6" cy="5" r="2.3"/><circle cx="11.5" cy="6" r="1.7"/><path d="M1.8 13c.4-2.4 1.8-3.7 4.2-3.7s3.9 1.3 4.2 3.7m-.1-3.3c2.2-.3 3.6.9 4 3.3"/>',
    input: '<path d="M8 2v8m-3-3 3 3 3-3M2.5 11v2.5h11V11"/>',
    reasoning: '<path d="M6 12.5h4m-3.5 2h3m-4.1-4.6a5 5 0 1 1 5.2 0c-.7.5-.9 1-1 1.6H6.4c-.1-.6-.3-1.1-1-1.6Z"/><path d="M8 2v1m-4 .7.7.7m6.6 0 .7-.7"/>',
    cache: '<ellipse cx="8" cy="3.5" rx="5.5" ry="2"/><path d="M2.5 3.5v4c0 1.1 2.5 2 5.5 2m5.5-6v4c0 1.1-2.5 2-5.5 2m-5.5-2v4c0 1.1 2.5 2 5.5 2m5.5-6v4c0 1.1-2.5 2-5.5 2"/>',
    output: '<path d="M2 8h11m-4-4 4 4-4 4"/><path d="M2 3v10"/>',
  };
  const css = '.dsh-cost-panel{display:flex;align-items:center;flex-wrap:wrap;min-height:40px;padding:3px 2px;margin:1px 0 2px;gap:0;color:#c8c9cc;font:12px/1.4 Inter,"Segoe UI",sans-serif;max-width:100%;box-sizing:border-box}.dsh-cost-group{display:flex;align-items:center;gap:2px;max-width:100%;flex-wrap:wrap}.dsh-cost-group+.dsh-cost-group{border-left:1px solid #4b4c50;margin-left:8px;padding-left:8px}.dsh-cost-metric{position:relative;display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:4px 6px;border-radius:6px;color:#c8c9cc;white-space:nowrap;outline:none;cursor:help}.dsh-cost-metric svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.55;stroke-linecap:round;stroke-linejoin:round;color:#aeb1b8;flex:none}.dsh-cost-value{font-variant-numeric:tabular-nums;font-size:12px}.dsh-cost-metric:hover,.dsh-cost-metric:focus-visible{background:#3a3b3f;color:#fff}.dsh-cost-metric:focus-visible{box-shadow:0 0 0 2px #75a9ff}.dsh-cost-metric.cost{background:#3c414b;color:#e7e9ee}.dsh-cost-metric.cost svg{color:#b6cbf2}.dsh-cost-metric.team{background:#353d49}.dsh-cost-tip{position:fixed;z-index:10000;display:grid;gap:3px;width:max-content;max-width:calc(100vw - 24px);box-sizing:border-box;padding:9px 11px;border:1px solid #45464a;border-radius:7px;background:#17181a;color:#e6e7e9;font-size:12px;line-height:1.45;white-space:normal;pointer-events:none;box-shadow:0 5px 18px #0008}.dsh-cost-tip[hidden]{display:none}.dsh-cost-tip>span{display:flex;justify-content:space-between;gap:12px}.dsh-cost-tip strong{font-size:12px;color:#fff}.dsh-cost-tip b{font-variant-numeric:tabular-nums;font-family:ui-monospace,Consolas,monospace;color:#f2f3f5}@media(max-width:600px){.dsh-cost-group+.dsh-cost-group{margin-left:4px;padding-left:5px}.dsh-cost-metric{gap:4px;padding:4px 5px}.dsh-cost-metric svg{width:13px;height:13px}.dsh-cost-value{font-size:11.5px}}@media(max-width:390px){.dsh-cost-group+.dsh-cost-group{margin-left:2px;padding-left:4px}.dsh-cost-metric{padding:4px 3px;gap:3px}}';
  function apply(ctx) {
    const connection = ctx.get('connection');
    const sessions = ctx.get('sessions');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    ctx.on('dispose', () => style.remove());
    function Panel({ sessionId, useProjection }) {
      useProjection('costPanelRevision');
      const [data, setData] = useState(null);
      const [hovered, setHovered] = useState(null);
      const [focused, setFocused] = useState(null);
      const activeInfo = hovered ?? focused;
      const active = activeInfo?.key;
      const tip = useRef(null);
      useEffect(() => {
        let stopped = false;
        let request;
        let pending = false;
        const load = () => {
          if (stopped) return;
          if (request) { pending = true; return; }
          request = new AbortController();
          const signal = request.signal;
          connection.rpc.call('/cost-panel', 'get', { sessionId }, signal).then(result => {
            if (!stopped) setData(result.ok ? result.value : null);
          }, () => { if (!stopped) setData(null); }).finally(() => {
            request = null;
            if (pending && !stopped) { pending = false; load(); }
          });
        };
        setData(null);
        load();
        const off = sessions.list.subscribe(load); // native all-session projection/lifecycle updates
        const reset = ctx.on('connection/reset', load);
        return () => { stopped = true; request?.abort(); off(); reset(); };
      }, [sessionId]);
      useEffect(() => {
        if (!activeInfo || !tip.current) return;
        const place = () => {
          const a = activeInfo.node.getBoundingClientRect();
          const t = tip.current.getBoundingClientRect();
          tip.current.style.left = Math.max(12, Math.min(a.left + a.width / 2 - t.width / 2, window.innerWidth - t.width - 12)) + 'px';
          tip.current.style.top = Math.max(8, a.top - t.height - 8) + 'px';
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
      }, [activeInfo, data]);
      const own = data?.sessionId === sessionId ? data.own : null;
      const totalText = s => !s || s.costUnknown ? '—' : money(s.total);
      const countText = m => !m || m.countUnknown ? '—' : compact(m.count);
      const costText = m => !m || m.costUnknown ? 'неизвестна' : money(m.cost);
      const shareText = m => m?.share == null ? '—' : m.share.toFixed(2).replace(/\.00$/, '') + '%';
      const rows = (name, m) => [h('strong', { key: name }, name), h('span', { key: name + '-n' }, 'Токены', h('b', null, !m || m.countUnknown ? 'неизвестны' : exact(m.count))), h('span', { key: name + '-c' }, 'Стоимость', h('b', null, costText(m))), h('span', { key: name + '-s' }, 'Доля стоимости агента', h('b', null, shareText(m)))];
      const m = own?.metrics;
      const cacheKnown = m && !m.read.countUnknown && !m.write.countUnknown;
      const names = { calls: 'Вызовы модели', cost: 'Стоимость агента', team: 'Стоимость команды', input: 'Вход без кэша', reasoning: 'Размышления', cache: 'Кэш', output: 'Исходящие' };
      const values = { calls: !own || own.callsUnknown ? '—' : String(own.calls), cost: totalText(own), team: totalText(data?.team), input: countText(m?.input), reasoning: countText(m?.reasoning), cache: cacheKnown ? compact(m.read.count + m.write.count) : '—', output: countText(m?.output) };
      const details = { calls: [h('strong', { key: 'h' }, names.calls), h('b', { key: 'v' }, !own || own.callsUnknown ? 'неизвестно' : exact(own.calls))], cost: [h('strong', { key: 'h' }, names.cost), h('b', { key: 'v' }, !own || own.costUnknown ? 'неизвестна' : money(own.total))], team: [h('strong', { key: 'h' }, names.team), h('b', { key: 'v' }, !data || data.team.costUnknown ? 'неизвестна' : money(data.team.total))], input: rows(names.input, m?.input), reasoning: rows(names.reasoning, m?.reasoning), output: rows(names.output, m?.output), cache: [...rows('Кэш · чтение', m?.read), ...rows('Кэш · запись', m?.write)] };
      const metric = key => h('span', { key, className: 'dsh-cost-metric' + (['cost', 'team'].includes(key) ? ' cost' : '') + (key === 'team' ? ' team' : ''), tabIndex: 0,
        'data-metric': key, 'aria-label': names[key] + ': ' + values[key], 'aria-describedby': active === key ? 'dsh-cost-tooltip-' + sessionId : undefined,
        onMouseEnter: e => setHovered({ key, node: e.currentTarget }), onMouseLeave: () => setHovered(null), onFocus: e => setFocused({ key, node: e.currentTarget }), onBlur: () => setFocused(null),
      }, h('svg', { 'aria-hidden': true, viewBox: '0 0 16 16', dangerouslySetInnerHTML: { __html: paths[key] } }), h('span', { className: 'dsh-cost-value' }, values[key]));
      return h('div', { className: 'dsh-cost-panel', role: 'group', 'aria-label': 'Расходы агента и команды. Оценка по ценам API, не счёт за подписку; — означает неизвестные данные. Рассуждения входят в исходящие.' },
        h('div', { className: 'dsh-cost-group' }, metric('calls')),
        h('div', { className: 'dsh-cost-group' }, metric('cost'), metric('team')),
        h('div', { className: 'dsh-cost-group' }, metric('input'), metric('reasoning'), metric('cache'), metric('output')),
        h('div', { ref: tip, id: 'dsh-cost-tooltip-' + sessionId, className: 'dsh-cost-tip', role: 'tooltip', hidden: !active }, active ? details[active] : null));
    }
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'cost-panel', order: -10 }, Panel));
  }
  return { inject: ['slots', 'sessions', 'connection'], apply };
}});
