import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { artifactPath, parseOptions, STYLE_PROPERTIES, validViewport } from './capture.mjs';

function approvedTolerances(geometryTolerancePx, pixelChannelTolerance) {
  if (typeof geometryTolerancePx !== 'number' || !Number.isFinite(geometryTolerancePx) ||
      geometryTolerancePx < 0 || geometryTolerancePx > 0.5) {
    throw new Error('geometryTolerancePx must be between 0 and 0.5 CSS px');
  }
  if (!Number.isInteger(pixelChannelTolerance) || pixelChannelTolerance < 0 || pixelChannelTolerance > 2) {
    throw new Error('pixelChannelTolerance must be an integer from 0 to 2');
  }
}

function normalized(value) {
  return String(value).trim().replace(/\s+/g, ' ');
}

function compareGeometry(reference, target, tolerance) {
  const mismatches = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const a = reference.rect?.[key];
    const b = target.rect?.[key];
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Invalid capture rect: ' + key);
    const delta = b - a;
    if (Math.abs(delta) > tolerance) mismatches[key] = { reference: a, target: b, delta };
  }
  return { pass: Object.keys(mismatches).length === 0, tolerancePx: tolerance, mismatches };
}

function compareStyles(reference, target) {
  const mismatches = {};
  for (const key of STYLE_PROPERTIES) {
    if (!Object.hasOwn(reference.styles ?? {}, key) || !Object.hasOwn(target.styles ?? {}, key)) {
      throw new Error('Missing approved computed style: ' + key);
    }
    const a = normalized(reference.styles[key]);
    const b = normalized(target.styles[key]);
    if (a !== b) mismatches[key] = { reference: a, target: b };
  }
  return { pass: Object.keys(mismatches).length === 0, mismatches };
}

function comparePixels(reference, target, tolerance) {
  const dimensions = {
    reference: { width: reference.width, height: reference.height },
    target: { width: target.width, height: target.height }
  };
  if (reference.width !== target.width || reference.height !== target.height) {
    return {
      metrics: { pass: false, reason: 'dimension_mismatch', dimensionMismatch: true,
        dimensions, changedPixels: null, totalPixels: null, changedRatio: null,
        maxChannelDelta: null, boundingBox: null },
      diff: null
    };
  }
  const { width, height } = reference;
  const diff = new PNG({ width, height });
  let changedPixels = 0, maxChannelDelta = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      let changed = false;
      for (let channel = 0; channel < 4; channel++) {
        const delta = Math.abs(reference.data[index + channel] - target.data[index + channel]);
        maxChannelDelta = Math.max(maxChannelDelta, delta);
        if (delta > tolerance) changed = true;
      }
      if (changed) {
        changedPixels++;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        diff.data.set([255, 0, 64, 255], index);
      } else {
        diff.data.set(reference.data.subarray(index, index + 4), index);
      }
    }
  }
  const totalPixels = width * height;
  return {
    metrics: {
      pass: changedPixels === 0,
      reason: changedPixels === 0 ? null : 'changed_pixels',
      dimensionMismatch: false, dimensions,
      changedPixels, totalPixels, changedRatio: changedPixels / totalPixels,
      maxChannelDelta,
      boundingBox: changedPixels === 0 ? null : {
        x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1
      }
    },
    diff
  };
}

export async function comparePair({
  dir, component, viewport, geometryTolerancePx = 0.5, pixelChannelTolerance = 2
}) {
  const out = artifactPath(dir);
  // An invalid direct comparison must invalidate any previous PASS and diff.
  await Promise.all(['report.json', 'diff.png'].map(file =>
    rm(path.join(out, file), { force: true })));
  approvedTolerances(geometryTolerancePx, pixelChannelTolerance);
  const [reference, target, referenceImage, targetImage] = await Promise.all([
    readFile(path.join(out, 'reference.json'), 'utf8').then(JSON.parse),
    readFile(path.join(out, 'target.json'), 'utf8').then(JSON.parse),
    readFile(path.join(out, 'reference.png')).then(PNG.sync.read),
    readFile(path.join(out, 'target.png')).then(PNG.sync.read)
  ]);
  for (const [side, capture] of [['reference', reference], ['target', target]]) {
    try { validViewport(capture?.viewport); }
    catch (error) { throw new Error('Invalid ' + side + ' viewport: ' + error.message); }
    if (capture.viewport.deviceScaleFactor !== 1 || capture.viewport.zoomPercent !== 100 ||
        capture.scroll?.x !== 0 || capture.scroll?.y !== 0) {
      throw new Error('Invalid ' + side + ' device scale/zoom/scroll evidence');
    }
    if (!Array.isArray(capture.pageErrors)) {
      throw new Error('Missing ' + side + ' pageErrors evidence');
    }
    if (capture.pageErrors.length) {
      throw new Error(side + ' runtime page error: ' + capture.pageErrors.join(' | '));
    }
  }
  if (reference.viewport.width !== target.viewport.width ||
      reference.viewport.height !== target.viewport.height) {
    throw new Error('Capture viewport dimensions differ');
  }

  const geometry = compareGeometry(reference, target, geometryTolerancePx);
  const styles = compareStyles(reference, target);
  const { metrics: pixels, diff } = comparePixels(referenceImage, targetImage, pixelChannelTolerance);
  if (diff) {
    await writeFile(path.join(out, 'diff.png'), PNG.sync.write(diff));
  } else {
    // Prevent a stale diff from an earlier comparison being mistaken for this run.
    await rm(path.join(out, 'diff.png'), { force: true });
  }
  const report = {
    component: component ?? null, viewport: viewport ?? reference.viewport?.name ?? null,
    result: geometry.pass && styles.pass && pixels.pass ? 'PASS' : 'BLOCK',
    geometry, styles, pixels,
    captures: { reference: 'reference.json', target: 'target.json' },
    diffImage: diff ? 'diff.png' : null
  };
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('COMPONENT:', report.component ?? '(direct comparison)');
  console.log('VIEWPORT:', report.viewport ?? '(unknown)');
  console.log('RESULT:', report.result);
  console.log('geometry:', geometry.pass ? 'PASS' : 'BLOCK', JSON.stringify(geometry.mismatches));
  console.log('styles:', styles.pass ? 'PASS' : 'BLOCK', JSON.stringify(styles.mismatches));
  console.log('pixels:', pixels.pass ? 'PASS' : 'BLOCK',
    pixels.dimensionMismatch ? 'image dimension mismatch' :
      'changedPixels=' + pixels.changedPixels + ', changedRatio=' + pixels.changedRatio);
  console.log('report:', path.join(out, 'report.json'));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseOptions(process.argv.slice(2),
      ['dir', 'component', 'viewport', 'geometry-tolerance', 'pixel-tolerance']);
    const report = await comparePair({
      dir: o.dir, component: o.component, viewport: o.viewport,
      geometryTolerancePx: o['geometry-tolerance'] === undefined ? 0.5 : Number(o['geometry-tolerance']),
      pixelChannelTolerance: o['pixel-tolerance'] === undefined ? 2 : Number(o['pixel-tolerance'])
    });
    process.exitCode = report.result === 'PASS' ? 0 : 1;
  } catch (error) {
    console.error('COMPARE ERROR:', error.message);
    process.exitCode = 2;
  }
}
