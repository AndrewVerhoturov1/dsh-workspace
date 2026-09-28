import React, { useEffect, useState } from 'react'
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

  return React.createElement('section', { 'data-ptc-lab': true },
    React.createElement('h2', null, 'PTC Lab — только лаборатория'),
    React.createElement('p', { className: 'ptc-lab-warning' }, 'Экспериментальная симуляция. Не рабочие роли; не настоящий Postman. Доступны только демонстрационные JSON-вызовы.'),
    React.createElement('label', null, 'Роль',
      React.createElement('select', { value: role, disabled: running, onChange: event => setRole(event.target.value) }, ROLE_NAMES.map(name => React.createElement('option', { key: name, value: name }, name)))),
    React.createElement('label', null, 'Программа JavaScript',
      React.createElement('textarea', { spellCheck: false, value: program, onChange: event => setProgram(event.target.value), rows: 9 })),
    React.createElement('div', { className: 'ptc-lab-actions' },
      React.createElement('button', { type: 'button', disabled: running, onClick: run }, 'Запустить'),
      React.createElement('button', { type: 'button', disabled: !running, onClick: () => controller?.abort() }, 'Прервать')),
    running && React.createElement('p', { role: 'status' }, 'QuickJS выполняет программу…'),
    outcome && React.createElement('div', { 'aria-live': 'polite' },
      React.createElement('strong', null, 'Результат выполнения (только демонстрация)'),
      outcome.result !== undefined && React.createElement('pre', null, JSON.stringify(outcome.result, null, 2)),
      !!outcome.logs?.length && React.createElement('div', null, React.createElement('strong', null, 'Журнал'), React.createElement('pre', null, JSON.stringify(outcome.logs, null, 2))),
      outcome.error && React.createElement('div', { role: 'alert' }, React.createElement('strong', null, `Ошибка · ${outcome.error.kind}`), React.createElement('pre', null, outcome.error.message))))
}
