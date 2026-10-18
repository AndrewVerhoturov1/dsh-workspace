import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACTS_ROOT, SKILL_ROOT } from '../scripts/capture.mjs';

function nodeCheck(configPath, component) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [path.join(SKILL_ROOT, 'scripts/check.mjs'), '--config', configPath,
        '--component', component, '--viewport', 'selftest'],
      { cwd: SKILL_ROOT, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

function nodeCompare(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [path.join(SKILL_ROOT, 'scripts/compare-ui.mjs'), '--dir', dir],
      { cwd: SKILL_ROOT, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

async function selfTest() {
  await mkdir(ARTIFACTS_ROOT, { recursive: true });
  const fixtures = path.join(SKILL_ROOT, 'fixtures');
  const reference = await readFile(path.join(fixtures, 'reference.html'), 'utf8');
  const good = await readFile(path.join(fixtures, 'target-good.html'), 'utf8');
  const bad = await readFile(path.join(fixtures, 'target-bad.html'), 'utf8');
  const routes = {
    '/reference': reference,
    '/good': good,
    '/bad': bad,
    '/pixels': good.replace('UPGRADE</button>', 'UPGRADX</button>'),
    '/dimensions': good.replace('width: 230px;', 'width: 235px;'),
    '/http-error': good,
    '/page-error': good.replace('</body>', '<script>throw new Error("fixture page error")</script></body>')
  };
  const server = createServer((req, res) => {
    const body = routes[req.url];
    res.writeHead(body && req.url !== '/http-error' ? 200 : 404,
      { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body ?? '<h1>Not found</h1>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    assert(![3080, 4173].includes(port), 'Reserved port must not be used');
    const base = 'http://127.0.0.1:' + port;
    const results = [];

    async function scenario(name, targetRoute, expectedExit, inspect, referenceRoute = '/reference') {
      const configPath = path.join(ARTIFACTS_ROOT, 'self-test-' + name + '.config.json');
      const dir = path.join(ARTIFACTS_ROOT, 'selftest', name);
      const config = {
        reference: base + referenceRoute, target: base + targetRoute,
        viewports: [{ name: 'selftest', width: 600, height: 240 }],
        components: [{ name, referenceSelector: '#upgrade', targetSelector: '#upgrade' }],
        geometryTolerancePx: 0.5, pixelChannelTolerance: 2
      };
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
      if (expectedExit === 2) {
        // A new runtime/config failure must invalidate a previous visual PASS/diff.
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'report.json'), '{"result":"PASS"}\n');
        await writeFile(path.join(dir, 'diff.png'), 'stale diff');
      }
      const result = await nodeCheck(configPath, name);
      assert.equal(result.code, expectedExit,
        name + ': expected exit ' + expectedExit + ', got ' + result.code + '\n' + result.output);
      if (inspect) {
        const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'));
        await inspect(report, dir);
      }
      if (expectedExit === 2) {
        await assert.rejects(access(path.join(dir, 'report.json')));
        await assert.rejects(access(path.join(dir, 'diff.png')));
      }
      const line = name + ': exit ' + result.code + ' OK';
      results.push(line);
      console.log(line);
    }

    await scenario('good', '/good', 0, report => {
      assert.equal(report.result, 'PASS');
      assert.equal(report.pixels.changedPixels, 0);
      assert.equal(report.pixels.changedRatio, 0);
      assert.equal(report.geometry.pass, true);
      assert.equal(report.styles.pass, true);
    });
    await scenario('bad', '/bad', 1, report => {
      assert.equal(report.result, 'BLOCK');
      assert(report.geometry.mismatches.width);
      assert(report.styles.mismatches.paddingRight);
    });
    await scenario('pixels', '/pixels', 1, report => {
      assert.equal(report.result, 'BLOCK');
      assert.equal(report.geometry.pass, true);
      assert.equal(report.styles.pass, true);
      assert.equal(report.pixels.dimensionMismatch, false);
      assert(report.pixels.changedPixels > 0);
      assert(report.pixels.boundingBox);
    });
    await scenario('dimensions', '/dimensions', 1, async (report, dir) => {
      assert.equal(report.result, 'BLOCK');
      assert.equal(report.pixels.dimensionMismatch, true);
      assert.equal(report.pixels.reason, 'dimension_mismatch');
      assert.equal(report.pixels.changedPixels, null);
      assert.equal(report.diffImage, null);
      await assert.rejects(access(path.join(dir, 'diff.png')));
    });

    await scenario('target-http', '/http-error', 2);
    await scenario('reference-http', '/good', 2, null, '/http-error');
    await scenario('target-pageerror', '/page-error', 2);
    await scenario('reference-pageerror', '/good', 2, null, '/page-error');

    // Direct comparisons must reject absent, invalid, or unsafe capture evidence,
    // and may not leave a stale PASS/diff behind after exit 2.
    const goodDir = path.join(ARTIFACTS_ROOT, 'selftest', 'good');
    const evidenceDir = path.join(ARTIFACTS_ROOT, 'selftest', 'evidence');
    await mkdir(evidenceDir, { recursive: true });
    for (const file of ['reference.png', 'target.png']) {
      await copyFile(path.join(goodDir, file), path.join(evidenceDir, file));
    }
    const originalReference = JSON.parse(await readFile(path.join(goodDir, 'reference.json'), 'utf8'));
    const originalTarget = JSON.parse(await readFile(path.join(goodDir, 'target.json'), 'utf8'));
    const evidenceCases = [
      ['missing width', r => { delete r.viewport.width; }],
      ['invalid width', (r, t) => { t.viewport.width = 0; }],
      ['missing height', (r, t) => { delete t.viewport.height; }],
      ['invalid height', r => { r.viewport.height = '240'; }],
      ['missing device scale', r => { delete r.viewport.deviceScaleFactor; }],
      ['invalid device scale', (r, t) => { t.viewport.deviceScaleFactor = 2; }],
      ['missing zoom', r => { delete r.viewport.zoomPercent; }],
      ['invalid zoom', (r, t) => { t.viewport.zoomPercent = 90; }],
      ['missing scroll', r => { delete r.scroll; }],
      ['invalid scroll', (r, t) => { t.scroll.y = 1; }],
      ['missing pageErrors', r => { delete r.pageErrors; }],
      ['invalid pageErrors', (r, t) => { t.pageErrors = null; }],
      ['reference pageErrors', r => { r.pageErrors.push('fixture reference error'); }],
      ['runtime pageErrors', (r, t) => { t.pageErrors.push('fixture runtime error'); }]
    ];
    for (const [name, modify] of evidenceCases) {
      const referenceCapture = structuredClone(originalReference);
      const targetCapture = structuredClone(originalTarget);
      modify(referenceCapture, targetCapture);
      await writeFile(path.join(evidenceDir, 'reference.json'), JSON.stringify(referenceCapture));
      await writeFile(path.join(evidenceDir, 'target.json'), JSON.stringify(targetCapture));
      await writeFile(path.join(evidenceDir, 'report.json'), '{"result":"PASS"}\n');
      await copyFile(path.join(goodDir, 'diff.png'), path.join(evidenceDir, 'diff.png'));
      const result = await nodeCompare(evidenceDir);
      assert.equal(result.code, 2, name + ': ' + result.output);
      await assert.rejects(access(path.join(evidenceDir, 'report.json')));
      await assert.rejects(access(path.join(evidenceDir, 'diff.png')));
      results.push('direct evidence ' + name + ': exit 2 OK');
      console.log(results.at(-1));
    }

    const malformed = path.join(ARTIFACTS_ROOT, 'self-test-malformed.config.json');
    await writeFile(malformed, '{ invalid JSON\n');
    const malformedResult = await nodeCheck(malformed, 'invalid');
    assert.equal(malformedResult.code, 2, malformedResult.output);
    results.push('malformed config: exit 2 OK');
    console.log(results.at(-1));

    // An unsafe name must be rejected before artifacts can be written outside the directory.
    const unsafe = path.join(ARTIFACTS_ROOT, 'self-test-unsafe.config.json');
    await writeFile(unsafe, JSON.stringify({
      reference: base + '/reference', target: base + '/good',
      viewports: [{ name: '../escape', width: 600, height: 240 }],
      components: [{ name: 'unsafe', referenceSelector: '#upgrade', targetSelector: '#upgrade' }]
    }));
    const unsafeResult = await nodeCheck(unsafe, 'unsafe');
    assert.equal(unsafeResult.code, 2, unsafeResult.output);
    results.push('unsafe path: exit 2 OK');
    console.log(results.at(-1));

    await scenario('runtime', '/does-not-exist', 2);
    await writeFile(path.join(ARTIFACTS_ROOT, 'self-test-results.txt'),
      'SELF-TEST PASS\n' + results.join('\n') + '\n');
    console.log('SELF-TEST PASS:', results.length, 'cases');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

try {
  await selfTest();
} catch (error) {
  console.error('SELF-TEST ERROR:', error.stack ?? error.message);
  process.exitCode = 2;
}
