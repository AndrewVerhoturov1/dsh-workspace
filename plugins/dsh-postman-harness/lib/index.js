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
export const inject = ['agents', 'tools', 'workspaceRegistry', 'attachments', 'systemPrompt']

export const PLUGIN_NAME = 'dsh-postman-harness'

// Short standing orders; the full normative policy remains in TASK_CONTRACT.md.
export const TASK_DISCIPLINE = `TASK DISCIPLINE — mandatory

1. Perform only the current task and its acceptance criteria. Do not invent or continue into a next task.
2. Make the smallest sufficient change and preserve existing contracts.
3. Do not add abstractions, layers, wrappers, dependencies, state, retries, fallbacks, validators, infrastructure, or adjacent changes unless required by the current task or justified by a concrete material risk present now.
4. If you discover an adjacent issue that is not required for the task, report it instead of fixing it.
5. Verification must be proportional to the change. Do not repeat a successful check unless relevant inputs changed.
6. Once the acceptance criteria are satisfied and required verification passes, stop. Do not start refactoring, hardening, auditing, cleanup, or another task.

Treat expansion of the solution surface as an exception that requires justification, not as a default improvement.`

export function apply(ctx) {
  // Global section: Harness assembles it for every request, including children
  // and cold resumes. It is not appended to conversation history.
  ctx.systemPrompt.section({ name: 'dsh:task-discipline', order: 10, text: TASK_DISCIPLINE })
  const currentTurnBridge = createDirectCurrentTurnToolConfigs(ctx, { taskContexts: postmanTaskContexts })
  for (const tool of createResultWorkspaceTools(ctx)) ctx.tools.register(tool)
  ctx.tools.register(createResultPresentationTool(ctx))
  for (const tool of currentTurnBridge.tools) ctx.tools.register(defineTool(tool))
  ctx.effect(() => () => currentTurnBridge.dispose(), `${PLUGIN_NAME}.lifecycle()`)
}
