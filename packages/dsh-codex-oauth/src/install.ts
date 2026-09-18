/**
 * One-command installer support.
 *
 * `dsh-codex-oauth install` removes the two friction points of the manual
 * flow: it writes the one-time pnpm build approvals for pi-ai's transitive
 * build scripts (both unused by the Codex route) into the profile's
 * `pnpm-workspace.yaml`, then shells out to `dsh plugin add` with the same
 * package spec.
 *
 * pnpm 11 reads these approvals from an `allowBuilds` map; pnpm 10 read the
 * equivalent `onlyBuiltDependencies` list, so the installer writes both for
 * the two required packages. Unrelated map entries retain their exact values:
 * an explicit denial must never become permission to run a lifecycle script.
 * The edit also repairs pnpm's placeholder values for the required packages.
 *
 * @module dsh-codex-oauth/install
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml'

/** The one-time approvals pnpm 11.22+ demands for pi-ai's transitive deps. */
export const ALLOW_BUILDS: Readonly<Record<string, true>> = Object.freeze({
  '@google/genai': true,
  protobufjs: true,
})

/** The default target profile of the product CLI. */
export const DEFAULT_PROFILE = 'web'

/**
 * The package spec the installer hands to `dsh plugin add`. Pinned per
 * release instead of `latest/download` so a previously fetched URL can never
 * serve a stale CDN copy of the installer itself.
 */
export const INSTALL_SPEC = 'https://github.com/birat-chapagain/dsh-codex-oauth/releases/download/v0.1.6/dsh-codex-oauth.tgz'

/** One planned or performed installer action, for display and dry runs. */
export interface InstallStep {
  /** What this step does or did. */
  readonly text: string
  /** Whether the step modified anything. */
  readonly changed: boolean
}

/**
 * What dsh's own `initProfile` writes for a fresh profile; reproduced here
 * because `dsh plugin add` skips its template once the file exists.
 */
const PROFILE_WORKSPACE_TEMPLATE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** Scalar string items of a YAML sequence node. */
function stringItems(node: unknown): string[] {
  if (!isSeq(node)) return []
  const items: string[] = []
  for (const item of node.items) {
    if (isScalar(item) && typeof item.value === 'string') items.push(item.value)
  }
  return items
}

/**
 * The package names one `allowBuilds` node currently approves. A sequence
 * approves every string item. A map approves only entries whose value is the
 * boolean `true`; false and placeholder values remain denials. Returns
 * undefined for an unusable node so the caller fails without rewriting it.
 * @param allow - the `allowBuilds` node, or undefined when absent.
 * @returns the approved names, or undefined for an unusable node.
 */
function approvedNames(allow: unknown): string[] | undefined {
  if (allow === null || allow === undefined) return []
  if (isSeq(allow)) return stringItems(allow)
  if (!isMap(allow)) return undefined
  const names: string[] = []
  for (const pair of allow.items) {
    if (isScalar(pair.key)
      && typeof pair.key.value === 'string'
      && isScalar(pair.value)
      && pair.value.value === true) {
      names.push(pair.key.value)
    }
  }
  return names
}

/** One trailing newline, whatever the source had. */
function normalized(text: string): string {
  return text.replace(/\n*$/u, '\n')
}

/**
 * Ensure the profile's `pnpm-workspace.yaml` approves every
 * {@link ALLOW_BUILDS} package. Creates the file with dsh's profile template
 * when missing, otherwise preserves every unrelated key, value, and comment.
 * Required entries become `true`; a legacy list becomes a map; and
 * `onlyBuiltDependencies` receives the required and already-approved names.
 * @param workspaceFile - absolute path to the profile's pnpm-workspace.yaml.
 * @returns the step describing what happened.
 */
export async function ensureAllowBuilds(workspaceFile: string): Promise<InstallStep> {
  let text: string
  try {
    text = await readFile(workspaceFile, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    text = PROFILE_WORKSPACE_TEMPLATE
  }
  if (text.trim() === '') text = PROFILE_WORKSPACE_TEMPLATE
  const doc: Document.Parsed = parseDocument(text)
  if (doc.errors.length > 0) {
    throw new Error(`cannot parse ${workspaceFile}: ${doc.errors[0]!.message} — fix or remove the file, then re-run`)
  }
  if (!isMap(doc.contents)) {
    throw new Error(`${workspaceFile} is not a YAML mapping — remove it so the installer can write a fresh one`)
  }

  const wanted = Object.keys(ALLOW_BUILDS)
  const allow = doc.get('allowBuilds', true)
  const names = approvedNames(allow)
  if (names === undefined) {
    throw new Error(`allowBuilds in ${workspaceFile} is not a map or list of package names — remove it and re-run`)
  }
  const approved = new Set<string>(wanted)
  for (const name of names) approved.add(name)
  for (const name of stringItems(doc.get('onlyBuiltDependencies', true))) approved.add(name)

  const placeholder = isMap(allow) && wanted.some((name) => {
    const entry = allow.get(name, true)
    return entry !== undefined && !(isScalar(entry) && entry.value === true)
  })
  const before = normalized(String(doc))
  const sorted = [...approved].sort()
  if (isMap(allow)) {
    for (const name of wanted) doc.setIn(['allowBuilds', name], true)
  } else {
    doc.set('allowBuilds', doc.createNode(Object.fromEntries(sorted.map(name => [name, true]))))
  }
  doc.set('onlyBuiltDependencies', doc.createNode(sorted))
  const after = normalized(String(doc))
  if (after === before) {
    return { text: `build approvals already present in ${workspaceFile}`, changed: false }
  }
  await mkdir(dirname(workspaceFile), { recursive: true })
  await writeFileAtomic(workspaceFile, after, { mode: 0o644 })
  return {
    text: placeholder
      ? `corrected build approval values in ${workspaceFile}`
      : `wrote build approvals (${wanted.join(', ')}) to ${workspaceFile}`,
    changed: true,
  }
}

/**
 * The profile workspace file for one Harness home and profile name.
 * @param home - resolved Harness home directory.
 * @param profile - profile name.
 * @returns the pnpm-workspace.yaml path dsh manages for that profile.
 */
export function profileWorkspaceFile(home: string, profile: string): string {
  return join(home, 'profiles', profile, 'pnpm-workspace.yaml')
}

/**
 * Whether a Codex credential already exists for the target home, so the
 * installer can skip the login reminder.
 * @param home - resolved Harness home directory.
 * @returns true when `$home/codex-oauth.json` exists.
 */
export async function hasExistingLogin(home: string): Promise<boolean> {
  try {
    await readFile(join(home, 'codex-oauth.json'), 'utf8')
    return true
  } catch {
    return false
  }
}
