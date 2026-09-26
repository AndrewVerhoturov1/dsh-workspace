import { copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const wasmPath = resolve(dirname(require.resolve('@jitl/quickjs-wasmfile-release-sync/package.json')), 'dist/emscripten-module.wasm')
const common = { outDir: 'dist-client', dts: false, sourcemap: false, clean: false }
const copyWasm = {
  name: 'ptc-lab-copy-quickjs-wasm',
  async writeBundle(output) {
    await copyFile(wasmPath, resolve(output.dir ?? 'dist-client', 'emscripten-module.wasm'))
  },
}

export default [
  {
    ...common,
    entry: { client: 'lib/client.js' },
    outDir: 'dist-client',
    format: 'cjs',
    platform: 'browser',
    define: { 'import.meta.url': '""' },
    clean: true,
    deps: { alwaysBundle: ['quickjs-emscripten'], neverBundle: id => /^(react(?:\/|$)|@deepseek-ai\/dsh-client-ui-slots)$/.test(id) },
    outputOptions: {
      entryFileNames: 'client.js',
      codeSplitting: false,
      banner: `window.__ModuleLoader__.load({ id: 'dsh-postman-harness', factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
  {
    ...common,
    entry: { 'ptc-lab-browser-worker': 'lib/ptc-lab-browser-worker.mjs' },
    outDir: 'dist-client',
    format: 'esm',
    platform: 'browser',
    deps: { alwaysBundle: ['quickjs-emscripten', 'quickjs-emscripten-core'] },
    plugins: [copyWasm],
    inputOptions: { resolve: { conditionNames: ['browser', 'import', 'default'] } },
    outputOptions: { entryFileNames: 'assets/ptc-lab-browser-worker.mjs', assetFileNames: '[name][extname]', codeSplitting: false },
  },
]
