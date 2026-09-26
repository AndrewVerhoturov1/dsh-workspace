import assert from 'node:assert/strict'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(resolve(pluginRoot, 'package.json'), 'utf8'))
assert.equal(packageJson.exports?.['./client'], './dist-client/client.js', 'Host clientPath must resolve to built bundle')
const clientPath = resolve(pluginRoot, packageJson.exports['./client'])
const clientRoot = dirname(clientPath)
assert.equal(clientRoot, resolve(pluginRoot, 'dist-client'), 'Host static asset root must be dist-client')
const [client, worker, wasm] = await Promise.all([
  readFile(clientPath, 'utf8'),
  readFile(resolve(clientRoot, 'assets/ptc-lab-browser-worker.mjs'), 'utf8'),
  readFile(resolve(clientRoot, 'emscripten-module.wasm')),
])
assert.match(worker, /typeof self === "undefined"\s*\?\s*src_default\s*:\s*newVariant\(src_default, \{ wasmLocation: new URL\(["']\/plugins\/dsh-postman-harness\/emscripten-module\.wasm["'], self\.location\.origin\)\.href \}\)/)
assert.equal((client.match(/window\.__ModuleLoader__\.load\s*\(/g) ?? []).length, 1, 'client must register exactly once')
assert.doesNotMatch(client, /require\(["']\.\.?\//, 'client must not contain unresolved local require')
assert.doesNotMatch(client, /require\(["']url["']\)|__filename|pathToFileURL/, 'client must not contain Node URL shims')
assert.match(client, /require\(["']react["']\)/, 'React must resolve from the loader module table')
assert.match(client, /new URL\(["']\/plugins\/dsh-postman-harness\/assets\/ptc-lab-browser-worker\.mjs["'], window\.location\.origin\)/, 'worker URL must use confirmed DSH plugin route')
assert.ok(wasm.byteLength > 100_000, `unexpected WASM size: ${wasm.byteLength}`)

const allowedAssets = [
  'assets/ptc-lab-browser-worker.mjs',
  'emscripten-module.wasm',
]
const canonicalRoot = await realpath(clientRoot)
for (const relative of allowedAssets) {
  const candidate = resolve(clientRoot, relative)
  const canonical = await realpath(candidate)
  assert.equal(canonical, candidate, `asset must not be symlinked: ${relative}`)
  assert.ok(canonical.startsWith(`${canonicalRoot}${sep}`), `asset escaped Host client root: ${relative}`)
}
const files = await readdir(clientRoot, { recursive: true })
const jsFiles = files.filter(file => /\.(?:js|mjs)$/.test(file))
const normalizedJsFiles = jsFiles.map(file => file.replaceAll('\\', '/'))
const assetSet = new Set(allowedAssets)
const jsAssetSet = new Set(normalizedJsFiles)
assert.deepEqual([...normalizedJsFiles].sort(), ['assets/ptc-lab-browser-worker.mjs', 'client.js'].sort(), 'built browser entrypoints must be the client and standalone worker')
for (const file of jsFiles) {
  const source = await readFile(resolve(clientRoot, file), 'utf8')
  const imports = [
    ...source.matchAll(/(?:^|\n)\s*import\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
  ]
  for (const imported of imports) {
    const specifier = imported[1]
    assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `bare/absolute browser import in ${file}: ${specifier}`)
    const resolved = resolve(dirname(resolve(clientRoot, file)), specifier)
    assert.ok(resolved.startsWith(`${canonicalRoot}${sep}`), `browser import escapes Host root: ${file} -> ${specifier}`)
    const relative = resolved.slice(canonicalRoot.length + 1).replaceAll('\\', '/')
    assert.ok(assetSet.has(relative), `browser import is not Host-allowlisted: ${file} -> ${specifier}`)
    assert.ok(jsAssetSet.has(relative), `browser import target is not a built JS asset: ${relative}`)
  }
  assert.doesNotMatch(source, /(?:from|import\()\s*["']node:/, `Node builtin import in ${file}`)
}
const base = 'http://127.0.0.1:4173'
const workerURL = new URL('/plugins/dsh-postman-harness/assets/ptc-lab-browser-worker.mjs', base)
const wasmURL = new URL('/plugins/dsh-postman-harness/emscripten-module.wasm', base)
console.log(`Host clientPath: ${clientPath}`)
console.log(`Host static asset root: ${clientRoot}`)
console.log(`Verified ${workerURL.href}`)
console.log(`Verified ${wasmURL.href} (${wasm.byteLength} bytes)`)
console.log(`Verified ${allowedAssets.length} exact assets; no node: imports in ${jsFiles.length} browser JS assets`)
