import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'src/client/editor.html'), 'utf8');
const css = readFileSync(resolve(root, 'src/client/editor.css'), 'utf8');
const editor = readFileSync(resolve(root, 'src/client/editor.js'), 'utf8');
if (!editor.includes('function mountEditor(root, bridge)') || !editor.includes('return () =>'))
  throw Error('Expected production editor entry/cleanup is missing');
const runtime = String.raw`
const React = require('react');
const CHANNEL = '/nodes-agent-by-andrew';
function apply(ctx) {
  const connection = ctx.get('connection');
  const sessions = ctx.get('sessions');
  const call = async (endpoint, data = {}, signal) => {
    const response = await connection.rpc.call(CHANNEL, endpoint, { sessionId: sessions.list.getSnapshot().current, ...data }, signal);
    if (!response?.ok) throw Error((response?.error?.code || 'NODES_AGENT_ERROR') +
      ': ' + (response?.error?.message || 'Unavailable'));
    return response.value;
  };
  const startTeam = async (teamId, sessionId) => {
    const summary = sessions.list.getSnapshot().byId[sessionId];
    if (summary?.blank === true) {
      const response = await connection.api.agentPresets.select({ sessionId, agentPreset: 'postman-leader-ptc-nodes' });
      if (!response.result.ok) throw Error(response.result.error.message);
      sessions.noteAgentPreset(sessionId, response.result.value.agentPreset);
    } else if (summary?.agentPreset !== 'postman-leader-ptc-nodes') {
      throw Error('A blank new Chat is required to select the Nodes preset');
    }
    return call('runs/start', { teamId, sessionId });
  };
  const bridge = {
    call, startTeam,
    sessionId: () => sessions.list.getSnapshot().current,
    openChat(binding) {
      if (!binding?.sessionId) throw Error('AgentNode has no DSH Session');
      if (binding.parentSessionId) {
        if (typeof sessions.openSubagent !== 'function') throw Error('Native subagent navigation is unavailable');
        sessions.openSubagent({ parentSessionId: binding.parentSessionId,
          childSessionId: binding.sessionId });
      } else {
        if (typeof sessions.open !== 'function') throw Error('Native session navigation is unavailable');
        sessions.open(binding.sessionId);
      }
    }
  };
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.nodesAgentByAndrew = 'true';
    style.textContent = EDITOR_CSS;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'nodes-agent: style');
  let editorWindow = null;
  function openEditorWindow() {
    if (editorWindow && !editorWindow.closed) {
      editorWindow.focus();
      return;
    }
    const popup = window.open('', 'nodes-agent-by-andrew-editor', 'popup,width=1480,height=920');
    if (!popup) throw Error('Allow pop-up windows to open the NodesAgent editor');
    try {
      const doc = popup.document;
      doc.open();
      doc.write('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>NodesAgent_by_Andrew</title>' +
        '<style>html,body{width:100%;height:100%;margin:0;background:#0b0e14}' +
        EDITOR_CSS + '</style></head><body><div class="nodes-agent-root" id="nodesAgentWindowRoot">' +
        EDITOR_HTML + '</div></body></html>');
      doc.close();
      const dispose = mountEditor(doc.getElementById('nodesAgentWindowRoot'), bridge);
      editorWindow = popup;
      popup.addEventListener('pagehide', () => {
        dispose?.();
        if (editorWindow === popup) editorWindow = null;
      }, { once: true });
      popup.focus();
    } catch (error) {
      popup.close();
      throw error;
    }
  }
  function TeamChoice({ session }) {
    const sessionId = session?.id || bridge.sessionId();
    const [list, setList] = React.useState([]);
    const [selection, setSelection] = React.useState('');
    const [visible, setVisible] = React.useState(false);
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState('');
    React.useEffect(() => {
      let active = true;
      call('teams/list').then(rows => {
        if (!active) return;
        setList(rows);
        setSelection(current => rows.some(row => row.id === current) ? current : rows[0]?.id || '');
      }).catch(e => { if (active) setError(String(e.message || e)); });
      return () => { active = false; };
    }, [visible]);
    const ru = navigator.language.toLowerCase().startsWith('ru');
    const create = async () => {
      if (!selection || !sessionId || pending) return;
      setPending(true); setError('');
      try {
        await startTeam(selection, sessionId);
        setVisible(false);
      } catch (e) { setError(String(e.message || e)); }
      finally { setPending(false); }
    };
    return React.createElement('div', { className: 'nodes-team-choice' },
      React.createElement('button', { type: 'button', onClick: () => setVisible(!visible),
        'aria-expanded': visible }, ru ? 'Команда агентов' : 'Use Agent Team'),
      visible && React.createElement('div', { className: 'nodes-team-choice-panel' },
        React.createElement('label', null, ru ? 'Сохранённая команда' : 'Saved team',
          React.createElement('select', { value: selection, onChange: e => setSelection(e.target.value) },
            ...list.map(row => React.createElement('option', { key: row.id, value: row.id }, row.name)))),
        React.createElement('button', { type: 'button', disabled: pending || !selection || !sessionId, onClick: create },
          pending ? '…' : (ru ? 'Запустить' : 'Start')),
        React.createElement('button', { type:'button', onClick: () => {
          try { openEditorWindow(); } catch (e) { setError(String(e.message || e)); }
        } }, ru ? 'Редактор команды' : 'Edit team'),
        error && React.createElement('small', { role: 'alert' }, error)));
  }
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'nodes-agent-use-team', order: 81,
    inject: () => ({})
  }, TeamChoice));
}
module.exports = { apply, inject: ['slots', 'sessions', 'connection'], CHANNEL };
`;
const source = 'window.__ModuleLoader__.load({\n id: "dsh-nodes-agent-by-andrew",\n factory: (require) => {\n const module = { exports: {} };\n' +
  ' const EDITOR_HTML = ' + JSON.stringify(html) + ';\n' +
  ' const EDITOR_CSS = ' + JSON.stringify(css) + ';\n' +
  editor + '\n' + runtime + '\n return module.exports;\n }\n});\n';
mkdirSync(resolve(root,'lib'), { recursive: true });
writeFileSync(resolve(root, 'lib/client.js'), source);
console.log('Built NodesAgent client:', source.length, 'UTF-8 bytes:', Buffer.byteLength(source));
