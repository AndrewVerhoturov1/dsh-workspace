export const name = 'dsh-task-discipline'
export const inject = ['systemPrompt']

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
  ctx.systemPrompt.section({
    name: 'dsh:task-discipline',
    order: 10,
    text: TASK_DISCIPLINE,
  })
}
