/**
 * The `/codex` human command provides browser `login`, `logout`, and `status`.
 * Registered only when the composition mounts the commands service (the
 * shipped base bundle does).
 *
 * The command plane renders one result only after its handler completes, so it
 * cannot conduct device login: the user must see the code while authentication
 * is still pending. Device login therefore returns immediate CLI guidance;
 * the CLI bin prints provider progress as it arrives.
 *
 * @module dsh-codex-oauth/command
 */

import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { FileCredentialStore } from './store.js'
import { CODEX_PROVIDER_ID, login, logout, status } from './auth.js'

/**
 * Build the `/codex` command definition.
 * @param store - the credential store the command operates on.
 * @returns the command definition.
 */
export function codexCommand(store: FileCredentialStore): CommandDefinition {
  return {
    name: 'codex',
    description: 'Manage OpenAI Codex (ChatGPT Plus/Pro) OAuth login',
    input: { hint: 'login | logout | status' },
    recordInput: false,
    handler: async ({ rawInput, signal }): Promise<CommandResult> => {
      const [verb, ...rest] = rawInput.trim().split(/\s+/u).filter(part => part.length > 0)
      try {
        switch (verb) {
          case 'login':
          case undefined: {
            if (rest[0] === 'device') {
              return {
                kind: 'error',
                text: 'Device login needs live terminal output; run `dsh-codex-oauth login --method device`.',
              }
            }
            if (rest.length > 0) {
              return { kind: 'error', text: `Unknown /codex login option "${rest.join(' ')}"; use /codex login.` }
            }
            const lines: string[] = []
            await login({
              store,
              method: 'browser',
              openBrowser: true,
              ...signal === undefined ? {} : { signal },
              reporter: { line: (text: string) => lines.push(text) },
            })
            return { kind: 'success', text: lines.join('\n') }
          }
          case 'logout': {
            await logout(store)
            return { kind: 'success', text: 'Codex logged out.' }
          }
          case 'status': {
            return { kind: 'success', text: (await status(store)).join('\n') }
          }
          default:
            return {
              kind: 'error',
              text: `Unknown /codex subcommand "${verb}"; use login, logout, or status.`,
            }
        }
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error)
        return { kind: 'error', text: `Codex ${verb ?? 'login'} failed: ${detail}` }
      }
    },
  }
}

export { CODEX_PROVIDER_ID }
