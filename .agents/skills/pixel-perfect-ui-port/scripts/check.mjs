import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACTS_ROOT, capture, parseOptions, validUrl, validViewport
} from './capture.mjs';
import { comparePair } from './compare-ui.mjs';

function safeName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error('Unsafe component/viewport name: ' + String(name));
  }
  return name;
}

function validatedConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Config must be an object');
  const reference = validUrl(config.reference);
  const target = validUrl(config.target);
  if (!Array.isArray(config.viewports) || !config.viewports.length ||
      !Array.isArray(config.components) || !config.components.length) {
    throw new Error('viewports and components must be nonempty arrays');
  }
  const viewports = config.viewports.map(validViewport);
  const components = config.components.map(component => {
    if (!component || typeof component !== 'object') throw new Error('Invalid component');
    safeName(component.name);
    for (const key of ['referenceSelector', 'targetSelector']) {
      if (typeof component[key] !== 'string' || !component[key].trim()) {
        throw new Error('Missing component selector: ' + key);
      }
    }
    return component;
  });
  for (const entries of [viewports, components]) {
    if (new Set(entries.map(x => x.name)).size !== entries.length) {
      throw new Error('Duplicate component/viewport name');
    }
  }
  const geometryTolerancePx = config.geometryTolerancePx ?? 0.5;
  const pixelChannelTolerance = config.pixelChannelTolerance ?? 2;
  if (!Number.isFinite(geometryTolerancePx) || geometryTolerancePx < 0 ||
      geometryTolerancePx > 0.5 || !Number.isInteger(pixelChannelTolerance) ||
      pixelChannelTolerance < 0 || pixelChannelTolerance > 2) {
    throw new Error('Tolerances must be geometry 0..0.5 and integer pixel channel 0..2');
  }
  return { reference, target, viewports, components, geometryTolerancePx, pixelChannelTolerance };
}

export async function runCheck(configPath, componentFilter, viewportFilter) {
  const config = validatedConfig(JSON.parse(await readFile(path.resolve(configPath), 'utf8')));
  if (componentFilter && !config.components.some(c => c.name === componentFilter)) {
    throw new Error('Unknown --component: ' + componentFilter);
  }
  if (viewportFilter && !config.viewports.some(v => v.name === viewportFilter)) {
    throw new Error('Unknown --viewport: ' + viewportFilter);
  }
  let blocked = false;
  for (const viewport of config.viewports.filter(v => !viewportFilter || v.name === viewportFilter)) {
    for (const component of config.components.filter(c => !componentFilter || c.name === componentFilter)) {
      const dir = path.join(ARTIFACTS_ROOT, viewport.name, component.name);
      // An earlier PASS or capture must never survive an incomplete fresh run.
      await Promise.all([
        'reference.json', 'reference.png', 'target.json', 'target.png', 'report.json', 'diff.png'
      ].map(file =>
        rm(path.join(dir, file), { force: true })));
      const reference = await capture({ url: config.reference, selector: component.referenceSelector,
        viewport, outDir: dir, label: 'reference' });
      const target = await capture({ url: config.target, selector: component.targetSelector,
        viewport, outDir: dir, label: 'target' });
      for (const [side, evidence] of [['Reference', reference], ['Target', target]]) {
        if (evidence.pageErrors.length) {
          throw new Error(side + ' runtime page error: ' + evidence.pageErrors.join(' | '));
        }
      }
      const report = await comparePair({
        dir, component: component.name, viewport: viewport.name,
        geometryTolerancePx: config.geometryTolerancePx,
        pixelChannelTolerance: config.pixelChannelTolerance
      });
      if (target.consoleErrors.length) {
        console.warn('Target console errors (compare with pre-change baseline):',
          target.consoleErrors.join(' | '));
      }
      blocked ||= report.result === 'BLOCK';
    }
  }
  return blocked ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseOptions(process.argv.slice(2), ['config', 'component', 'viewport']);
    if (!args.config) throw new Error('Usage: node scripts/check.mjs --config CONFIG [--component NAME] [--viewport NAME]');
    process.exitCode = await runCheck(args.config, args.component, args.viewport);
  } catch (error) {
    console.error('CHECK ERROR:', error.message);
    process.exitCode = 2;
  }
}
