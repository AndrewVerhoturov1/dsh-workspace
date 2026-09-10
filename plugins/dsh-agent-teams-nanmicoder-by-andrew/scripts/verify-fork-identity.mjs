#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const EXPECTED_NAME = 'dsh-agent-teams-nanmicoder-by-andrew'
const EXPECTED_VERSION = '0.1.10-andrew.1'
const EXPECTED_STATE_DIR = '.agent-teams-nanmicoder-by-andrew'
const UPSTREAM_NAME = '@nanmicoder/dsh-agent-teams'

let failures = 0

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
    return
  }

  failures += 1
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const hostSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
const toolsSource = await readFile(new URL('../src/tools.ts', import.meta.url), 'utf8')
const membersSource = await readFile(new URL('../src/members.ts', import.meta.url), 'utf8')
const clientBundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

const patchId = patch.match(/^\s*- id:\s*([^\s#]+)$/m)?.[1]
const patchName = patch.match(/^\s*name:\s*['"]([^'"]+)['"]$/m)?.[1]
const patchStateDir = patch.match(/^\s*stateDir:\s*([^\s#]+)$/m)?.[1]
const registeredClientId = clientBundle.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]*)"/)?.[1]

check('package has the custom machine identity', packageJson.name === EXPECTED_NAME, packageJson.name)
check('package has the Andrew fork version', packageJson.version === EXPECTED_VERSION, packageJson.version)
check('package is private', packageJson.private === true, JSON.stringify(packageJson.private))
check('package dependencies do not resolve the upstream npm package', ![
  packageJson.dependencies,
  packageJson.devDependencies,
  packageJson.optionalDependencies,
  packageJson.peerDependencies,
].some((dependencies) => dependencies?.[UPSTREAM_NAME] !== undefined))
check('bundle row id has the custom identity', patchId === EXPECTED_NAME, patchId)
check('bundle package name has the custom identity', patchName === EXPECTED_NAME, patchName)
check('bundle uses the isolated state directory', patchStateDir === EXPECTED_STATE_DIR, patchStateDir)
check('host plugin exports the custom identity', hostSource.includes(`export const name = '${EXPECTED_NAME}'`))
check('captain message owner uses the custom identity', toolsSource.includes(`plugin: '${EXPECTED_NAME}'`))
check('member message owner uses the custom identity', membersSource.includes(`plugin: '${EXPECTED_NAME}'`))
check('client bundle registers under the custom identity', registeredClientId === EXPECTED_NAME, registeredClientId)
check('client bundle does not register under the upstream package', registeredClientId !== UPSTREAM_NAME, registeredClientId)

if (failures > 0) {
  console.error(`\n${failures} fork identity check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nFork identity verification passed')
}
