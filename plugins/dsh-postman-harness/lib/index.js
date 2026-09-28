import { defineTool } from '@deepseek-ai/dsh-tools'
import { createResultWorkspaceTools } from './result-workspace.js'
import { createResultPresentationTool } from './result-presentation.js'
import { createDirectCurrentTurnToolConfigs } from './direct-current-turn.js'
import { postmanTaskContexts } from './postman-task-context.js'

export { attachTaskUrl, createAndPublishTask, createTaskPackage, renderIntentTaskFile } from './task-creation-bridge.js'
export { WebWorkerBridge, markWebResultReady } from './web-worker-bridge.js'
export { createResultWorkspaceTools } from './result-workspace.js'
export { clearResultPresentation, createResultPresentationTool, presentResult } from './result-presentation.js'
export { CurrentUserTurnStore, DirectPostmanJobManager, createDirectCurrentTurnToolConfigs, parsePostmanUserTurn } from './direct-current-turn.js'

export const name = 'dsh-postman-harness'
export const inject = ['agents', 'tools', 'workspaceRegistry']

export const PLUGIN_NAME = 'dsh-postman-harness'

export function apply(ctx) {
  const currentTurnBridge = createDirectCurrentTurnToolConfigs(ctx, { taskContexts: postmanTaskContexts })
  for (const tool of createResultWorkspaceTools(ctx)) ctx.tools.register(tool)
  ctx.tools.register(createResultPresentationTool(ctx))
  for (const tool of currentTurnBridge.tools) ctx.tools.register(defineTool(tool))
  ctx.effect(() => () => currentTurnBridge.dispose(), `${PLUGIN_NAME}.lifecycle()`)
}
