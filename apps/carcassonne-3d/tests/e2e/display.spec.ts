import { expect, test } from '@playwright/test';

// Separate runner context is needed to set deviceScaleFactor before page load.
test.use({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });

test('measure rendered WebGL frame cadence at DPR 2 during camera input', async ({ page }) => {
  await page.addInitScript(() => {
    const gl2 = window.WebGL2RenderingContext?.prototype;
    const gl1 = window.WebGLRenderingContext?.prototype;
    const countFrame = (proto: object | undefined, name: string) => {
      if (!proto) return;
      const original = (proto as Record<string, unknown>)[name];
      if (typeof original !== 'function') return;
      (proto as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
        const key = Math.floor(performance.now() / 16);
        const state = (window as typeof window & { __webglFrames?: Set<number> }).__webglFrames ??= new Set<number>();
        state.add(key);
        return (original as (...values: unknown[]) => unknown).apply(this, args);
      };
    };
    for (const proto of [gl2, gl1]) {
      countFrame(proto, 'drawElements');
      countFrame(proto, 'drawArrays');
      countFrame(proto, 'drawElementsInstanced');
      countFrame(proto, 'drawArraysInstanced');
    }
  });
  await page.goto('/');
  await page.getByTestId('seed-input').fill('DISPLAY_METRICS_5188');
  await page.getByTestId('start-game').click();
  const canvas = page.locator('[data-testid="scene-container"] canvas').first();
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.getContext('webgl2') !== null || c.getContext('webgl') !== null)).toBe(true);
  const initial = await canvas.evaluate((c: HTMLCanvasElement) => ({
    dpr: window.devicePixelRatio,
    css: { width: c.clientWidth, height: c.clientHeight },
    buffer: { width: c.width, height: c.height },
    renderer: (() => {
      const gl = c.getContext('webgl2') ?? c.getContext('webgl');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return ext && gl ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) ?? null;
    })(),
  }));
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Scene canvas has no layout box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.63, box.y + box.height * 0.43, { steps: 10 });
  await page.mouse.up();
  await page.mouse.wheel(0, -160);
  await page.getByTestId('scene-fit-board').click();
  await page.waitForTimeout(2000);
  const renderedFrames = await page.evaluate(() => (window as typeof window & { __webglFrames?: Set<number> }).__webglFrames?.size ?? 0);
  const result = { initial, renderedFramesInTwoSeconds: renderedFrames, method: 'unique 16ms time buckets with WebGL drawArrays/drawElements/instanced draw calls during drag, wheel, and Fit Board input' };
  await test.info().attach('display-measurement.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(initial.dpr).toBe(2);
  expect(initial.buffer.width).toBeGreaterThan(initial.css.width);
  expect(initial.buffer.height).toBeGreaterThan(initial.css.height);
  expect(renderedFrames).toBeGreaterThan(0);
});
