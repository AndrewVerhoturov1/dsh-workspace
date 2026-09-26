import React from 'react'
import { PtcLabPanel } from './ptc-lab-panel.js'

const inject = ['slots']

export function apply(ctx) {
  ctx.effect(() => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'postman-ptc-lab',
    inject: () => ({}),
  }, ({ wide }) => wide ? React.createElement(PtcLabPanel) : null), 'postman-harness: isolated PTC lab')
}

export { inject }

