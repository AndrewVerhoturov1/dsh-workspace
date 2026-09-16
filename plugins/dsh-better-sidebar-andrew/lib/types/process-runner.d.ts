import { type ChildProcess, type ChildProcessByStdio, type SpawnOptions, type SpawnOptionsWithStdioTuple } from 'node:child_process';
import type { Readable } from 'node:stream';
/**
 * Add the Windows-only process visibility guard without changing POSIX
 * options. The value is deliberately forced so callers cannot accidentally
 * re-enable a console window with `windowsHide: false`.
 */
export declare function windowsSafeSpawnOptions(options?: SpawnOptions, platform?: NodeJS.Platform): SpawnOptions;
/** Spawn a non-interactive child with the repository's Windows policy. */
export declare function spawnHidden(command: string, args: readonly string[], options: SpawnOptionsWithStdioTuple<'ignore', 'pipe', 'pipe'>): ChildProcessByStdio<null, Readable, Readable>;
export declare function spawnHidden(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
