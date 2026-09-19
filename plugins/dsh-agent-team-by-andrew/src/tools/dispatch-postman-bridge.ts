import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentTeamService } from '../index.ts'

/** Explicit repeatable parent -> Postman Bridge dispatch. This path intentionally does not consume the one-team-per-message claim. */
export function createDispatchPostmanBridgeTool(service: Pick<AgentTeamService, 'dispatchPostmanBridgeFromTool'>) {
  return defineTool({
    name: 'dispatch_postman_bridge',
    description: 'Send an exact task through the configured Postman Bridge child to Direct Postman. Repeat serially when the external ChatGPT must revise its result; pass chatRequestId to continue an existing ChatGPT conversation.',
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'Exact task/intention to send through Postman. Preserve the user request; do not turn it into a new implementation design.',
      },
      bridgeAgent: {
        type: 'string',
        description: 'Optional durable agent id or exact agent name. Omit when exactly one member is marked Postman Bridge.',
      },
      chatRequestId: {
        type: 'string',
        description: 'Optional prior canonical REQ used only to continue that exact ChatGPT conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          requestId: { type: 'string', required: true },
          state: { type: 'string', required: true },
          code: { type: 'string', required: true },
          resultZip: { type: 'string' },
          resultHandoffPath: { type: 'string' },
          conversationUrl: { type: 'string' },
          conversationId: { type: 'string' },
          continuedFromRequestId: { type: 'string' },
          errorCode: { type: 'string' },
          error: { type: 'string' },
          bridgeAgentId: { type: 'string', required: true },
          bridgeAgentName: { type: 'string', required: true },
          childId: { type: 'string' },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reasoningEffort: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('dispatch_postman_bridge requires a calling agent')
      return service.dispatchPostmanBridgeFromTool({
        task: args.task,
        ...(args.bridgeAgent === undefined ? {} : { bridgeAgent: args.bridgeAgent }),
        ...(args.chatRequestId === undefined ? {} : { chatRequestId: args.chatRequestId }),
      }, exec.agent, exec.signal)
    },
  })
}
