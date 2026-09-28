import React, { useEffect, useState } from 'react'
import './ptc-lab-panel.css'
import { PtcLabBrowserRuntime, PTC_LAB_DEFAULT_PROGRAM } from './ptc-lab-browser-runtime.js'

const ROLE_NAMES = ['leader', 'worker', 'bridge']

export function PtcLabPanel() {
  const [role, setRole] = useState('leader')
  const [program, setProgram] = useState(PTC_LAB_DEFAULT_PROGRAM)
  const [outcome, setOutcome] = useState(null)
  const [running, setRunning] = useState(false)
  const [runtime] = useState(() => new PtcLabBrowserRuntime())
  const [controller, setController] = useState(null)

  useEffect(() => () => runtime.dispose(), [runtime])

  const run = async () => {
    const nextController = new AbortController()
    setController(nextController)
    setRunning(true)
    setOutcome(null)
    try { setOutcome(await runtime.run({ role, program, signal: nextController.signal })) }
    catch (error) { setOutcome({ logs: [], error: { kind: 'exception', message: error instanceof Error ? error.message : String(error) } }) }
    finally { setController(null); setRunning(false) }
  }

  return <section data-ptc-lab>
    <h2>PTC Lab — только лаборатория</h2>
    <p className="ptc-lab-warning">Экспериментальная симуляция. Не рабочие роли; не настоящий Postman. Доступны только демонстрационные JSON-вызовы.</p>
    <label>Роль
      <select value={role} disabled={running} onChange={event => setRole(event.target.value)}>
        {ROLE_NAMES.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>
    <label>Программа JavaScript
      <textarea spellCheck={false} value={program} onChange={event => setProgram(event.target.value)} rows={9} />
    </label>
    <div className="ptc-lab-actions">
      <button type="button" disabled={running} onClick={run}>Запустить</button>
      <button type="button" disabled={!running} onClick={() => controller?.abort()}>Прервать</button>
    </div>
    {running && <p role="status">QuickJS выполняет программу…</p>}
    {outcome && <div aria-live="polite" style={{ display: 'grid', gap: 8 }}>
      <strong>Результат выполнения (только демонстрация)</strong>
      {outcome.result !== undefined && <pre>{JSON.stringify(outcome.result, null, 2)}</pre>}
      {!!outcome.logs?.length && <div><strong>Журнал</strong><pre>{JSON.stringify(outcome.logs, null, 2)}</pre></div>}
      {outcome.error && <div role="alert"><strong>Ошибка · {outcome.error.kind}</strong><pre>{outcome.error.message}</pre></div>}
    </div>}
  </section>
}
