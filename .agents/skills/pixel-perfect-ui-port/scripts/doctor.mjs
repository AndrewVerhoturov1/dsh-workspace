import { access, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACTS_ROOT, SKILL_ROOT } from './capture.mjs';
import { withHardwareChromium } from './browser-runtime.mjs';

async function doctor() {
  const major = Number(process.versions.node.split('.')[0]);
  console.log('Node:', process.version);
  if (major < 20) throw new Error('Node 20+ required');

  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(SKILL_ROOT, '.playwright-browsers');
  const { chromium } = await import('playwright');
  const { PNG } = await import('pngjs');
  if (typeof PNG.sync.read !== 'function') throw new Error('pngjs unavailable');
  console.log('Dependencies: playwright, pngjs OK');

  await access(chromium.executablePath());
  console.log('Chromium:', chromium.executablePath());
  await mkdir(ARTIFACTS_ROOT, { recursive: true });
  const probe = path.join(ARTIFACTS_ROOT, '.doctor-write-probe');
  try { await writeFile(probe, 'ok'); } finally { await rm(probe, { force: true }); }

  await withHardwareChromium(chromium, async browser => {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
    if (await page.evaluate(() => 6 * 7) !== 42) throw new Error('Chromium evaluation failed');
    await page.close();
  });
  console.log('DOCTOR PASS: artifacts writable; Chromium uses hardware WebGL');
}

try { await doctor(); } catch (error) {
  console.error('DOCTOR ERROR:', error.message);
  process.exitCode = 2;
}
