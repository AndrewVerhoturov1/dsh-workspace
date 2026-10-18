# Windows setup. All installed files stay inside this skill folder.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $root '.playwright-browsers'
$env:npm_config_cache = Join-Path $root '.npm-cache'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required' }
$nodeMajor = [int](& node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 20) { throw 'Node.js 20+ is required' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required' }

Push-Location $root
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    node (Join-Path $root 'node_modules/playwright/cli.js') install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Playwright Chromium install failed' }
    node (Join-Path $root 'scripts/doctor.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Doctor failed' }
    node (Join-Path $root 'tests/self-test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Self-test failed' }
} finally {
    Pop-Location
}
