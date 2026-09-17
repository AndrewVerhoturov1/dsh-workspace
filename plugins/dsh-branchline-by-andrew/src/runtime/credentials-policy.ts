import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const HOME_FILES = ['settings.yaml', '.credentials.yaml', 'cordis.patch.yml'] as const
const PRESET_DIRS = ['.agent-presets', 'agent-presets'] as const

const SAFE_ENVIRONMENT_NAMES = [
  'ALL_PROXY', 'APPDATA', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'HTTP_PROXY', 'HTTPS_PROXY',
  'LANG', 'LC_ALL', 'LOCALAPPDATA', 'NODE_USE_SYSTEM_CA', 'NO_PROXY', 'PATH', 'PATHEXT', 'PROGRAMDATA',
  'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
] as const

// Explicit compatibility exception for the audited current Web profile: its GitHub MCP
// header reads process.env.GITHUB_TOKEN. The value is inherited only by the isolated
// child process and is never written to runtime.json or diagnostics.
const EXPLICIT_CREDENTIAL_ENVIRONMENT_NAMES = ['GITHUB_TOKEN'] as const

/** Copy only configuration/auth snapshots that are intentionally private to the test runtime. */
export function snapshotHomeConfiguration(primaryHome: string, runtimeHome: string): void {
  mkdirSync(runtimeHome, { recursive: true })
  for (const filename of HOME_FILES) {
    const source = join(primaryHome, filename)
    if (existsSync(source)) copyFileSync(source, join(runtimeHome, filename))
  }
  for (const dirname of PRESET_DIRS) {
    const source = join(primaryHome, dirname)
    if (existsSync(source)) cpSync(source, join(runtimeHome, basename(source)), { recursive: true })
  }
}

/** Build a deliberately small launch environment. Credential-like variables are not inherited implicitly. */
export function isolatedLaunchEnvironment(runtimeHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of [...SAFE_ENVIRONMENT_NAMES, ...EXPLICIT_CREDENTIAL_ENVIRONMENT_NAMES]) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  environment.DSH_HOME = runtimeHome
  return environment
}

/** Names only: useful for diagnostics without leaking secret values. */
export function blockedSensitiveEnvironmentNames(): readonly string[] {
  const allowed = new Set<string>(EXPLICIT_CREDENTIAL_ENVIRONMENT_NAMES)
  return Object.keys(process.env)
    .filter(name => /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/iu.test(name) && !allowed.has(name))
    .sort()
}
