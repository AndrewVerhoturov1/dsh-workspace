import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
  type SpawnOptionsWithStdioTuple,
} from 'node:child_process'
import type { Readable } from 'node:stream'

/**
 * Add the Windows-only process visibility guard without changing POSIX
 * options. The value is deliberately forced so callers cannot accidentally
 * re-enable a console window with `windowsHide: false`.
 */
export function windowsSafeSpawnOptions(
  options: SpawnOptions = {},
  platform: NodeJS.Platform = process.platform,
): SpawnOptions {
  if (platform !== 'win32') return options
  return { ...options, windowsHide: true }
}

/** Spawn a non-interactive child with the repository's Windows policy. */
export function spawnHidden(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<'ignore', 'pipe', 'pipe'>,
): ChildProcessByStdio<null, Readable, Readable>
export function spawnHidden(
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
): ChildProcess
export function spawnHidden(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(command, [...args], windowsSafeSpawnOptions(options))
}
