import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARTIFACTS_ROOT = path.join(SKILL_ROOT, 'artifacts');
export const STYLE_PROPERTIES = [
  'display', 'position',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'whiteSpace',
  'color', 'background', 'backgroundColor',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'gap', 'rowGap', 'columnGap',
  'justifyContent', 'alignItems', 'alignContent', 'flexDirection', 'flexWrap',
  'gridTemplateColumns', 'gridTemplateRows',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
  'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
  'borderRadius', 'boxShadow', 'opacity', 'transform',
  'overflow', 'overflowX', 'overflowY', 'objectFit', 'objectPosition', 'zIndex'
];

export function artifactPath(value) {
  const resolved = path.resolve(value);
  if (resolved !== ARTIFACTS_ROOT && !resolved.startsWith(ARTIFACTS_ROOT + path.sep)) {
    throw new Error('Output must remain inside ' + ARTIFACTS_ROOT);
  }
  return resolved;
}

export function parseOptions(argv, names) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || !names.includes(key.slice(2)) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      throw new Error('Invalid CLI argument: ' + String(key));
    }
    if (key.slice(2) in options) throw new Error('Duplicate option: ' + key);
    options[key.slice(2)] = argv[i + 1];
  }
  return options;
}

export function validViewport(viewport) {
  if (!viewport || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(viewport.name ?? '') ||
      !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) ||
      viewport.width < 1 || viewport.height < 1 || viewport.width > 7680 || viewport.height > 4320) {
    throw new Error('Invalid viewport (safe name, integer width/height required)');
  }
  return viewport;
}

export function validUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid HTTP URL: ' + String(value)); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported');
  }
  return url.href;
}

export async function capture({ url, selector, viewport, outDir, label }) {
  const out = artifactPath(outDir);
  await mkdir(out, { recursive: true });
  // Invalid arguments or failed capture invalidate any previous PASS and diff.
  await Promise.all(['report.json', 'diff.png'].map(file => rm(path.join(out, file), { force: true })));
  if (!['reference', 'target'].includes(label)) throw new Error('Label must be reference or target');
  await Promise.all(['.json', '.png'].map(ext => rm(path.join(out, label + ext), { force: true })));
  validUrl(url);
  validViewport(viewport);
  if (typeof selector !== 'string' || !selector.trim()) throw new Error('Selector is required');

  // Isolate browser installation from the system/global Playwright cache.
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(SKILL_ROOT, '.playwright-browsers');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      locale: 'en-US',
      colorScheme: 'light'
    });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error.message)));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (!response || response.status() >= 400) {
      throw new Error('HTTP navigation failed: ' + (response?.status() ?? 'no response') + ' ' + url);
    }
    const element = page.locator(selector);
    await element.waitFor({ state: 'visible', timeout: 15000 });
    if (await element.count() !== 1) throw new Error('Selector must match exactly one element: ' + selector);

    await page.evaluate(async () => {
      await document.fonts.ready;
      const visibleImages = [...document.images].filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 &&
          rect.right > 0 && rect.bottom > 0 &&
          rect.left < innerWidth && rect.top < innerHeight;
      });
      await Promise.all(visibleImages.map(image => image.decode()));
    });
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }'
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    ));

    const measured = await element.evaluate((el, properties) => {
      const r = el.getBoundingClientRect();
      const computed = getComputedStyle(el);
      return {
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        styles: Object.fromEntries(properties.map(property => [property, computed[property]])),
        textContent: el.textContent,
        scroll: { x: window.scrollX, y: window.scrollY }
      };
    }, STYLE_PROPERTIES);
    const { x, y, width, height } = measured.rect;
    if (width <= 0 || height <= 0 || x < 0 || y < 0 ||
        x + width > viewport.width || y + height > viewport.height) {
      throw new Error('Element must fit inside viewport at scroll (0,0); choose a visible container/viewport: ' + selector);
    }
    await element.screenshot({ path: path.join(out, label + '.png'), timeout: 20000 });
    if (pageErrors.length) throw new Error('Runtime page error (' + label + '): ' + pageErrors.join(' | '));
    const data = {
      timestamp: new Date().toISOString(),
      url: page.url(),
      selector,
      viewport: { ...viewport, deviceScaleFactor: 1, zoomPercent: 100 },
      rect: measured.rect,
      styles: measured.styles,
      textContent: measured.textContent,
      scroll: measured.scroll,
      pageErrors,
      consoleErrors
    };
    await writeFile(path.join(out, label + '.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
    return data;
  } catch (error) {
    await Promise.all(['.json', '.png'].map(ext =>
      rm(path.join(out, label + ext), { force: true })));
    throw error;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseOptions(process.argv.slice(2),
      ['url', 'selector', 'name', 'width', 'height', 'out', 'label']);
    await capture({
      url: o.url,
      selector: o.selector,
      viewport: { name: o.name ?? 'default', width: Number(o.width), height: Number(o.height) },
      outDir: o.out,
      label: o.label
    });
    console.log('CAPTURE PASS:', path.resolve(o.out));
  } catch (error) {
    console.error('CAPTURE ERROR:', error.message);
    process.exitCode = 2;
  }
}
