import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { findVudaRuntime } from '../../../postman/devspace/vuda-runtime.mjs';
import { withHardwareChromium } from '../../../.agents/skills/pixel-perfect-ui-port/scripts/browser-runtime.mjs';
import { createTemplate } from '../lib/domain.js';

test('editor pauses hidden polling, serializes slow calls and keeps unchanged activity DOM', { timeout: 30000 }, async () => {
  const html = await readFile(new URL('../src/client/editor.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/client/editor.js', import.meta.url), 'utf8');
  const runtime = await findVudaRuntime();
  const { chromium } = createRequire(runtime.serverEntry)('playwright');
  const server = createServer((req, res) => res.end('<!doctype html><div id="root">' + html + '</div>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await withHardwareChromium(chromium, async browser => {
      const page = await browser.newPage();
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.addScriptTag({ content: source });
      await page.evaluate(team => {
        window.pollTest = { calls: [], hidden: false, hold: false, status: 'RUNNING', errors: [] };
        const state = window.pollTest;
        window.addEventListener('unhandledrejection', event => state.errors.push(String(event.reason)));
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => state.hidden });
        // Drive the production interval explicitly, without real multi-second waits.
        const nativeSetInterval = window.setInterval.bind(window);
        window.setInterval = (callback, delay) => {
          if (delay === 2500) { state.tick = callback; return 0; }
          return nativeSetInterval(callback, delay);
        };
        state.dispose = mountEditor(document.getElementById('root'), {
          sessionId: () => 'test-session',
          async call(endpoint) {
            state.calls.push(endpoint);
            if (endpoint === 'catalog') return { models: [], tools: [], skills: { items: [] } };
            if (endpoint === 'teams/list') return [{ id: team.definition.id, name: team.definition.name }];
            if (endpoint === 'teams/get') return team;
            if (endpoint === 'runs/for-session') {
              if (state.hold) await new Promise(resolve => { state.release = resolve; });
              return { id: 'run-test', teamDefinitionId: team.definition.id, status: state.status,
                bindings: {}, lunas: [], lunaArchive: {} };
            }
            if (endpoint === 'runs/activity') return { tasks: [{ goal: 'Owned test task', status: state.status }], messages: [] };
            throw Error('Unexpected endpoint: ' + endpoint);
          }
        });
      }, createTemplate());
      await page.waitForFunction(() => document.querySelector('#nodesActivity')?.children.length === 1);
      await page.evaluate(() => {
        pollTest.calls = [];
        pollTest.row = document.querySelector('#nodesActivity').firstElementChild;
        pollTest.tick();
      });
      await page.waitForFunction(() => pollTest.calls.includes('runs/activity'));
      assert.equal(await page.evaluate(() => pollTest.row === document.querySelector('#nodesActivity').firstElementChild), true);

      await page.evaluate(() => {
        pollTest.calls = [];
        pollTest.hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        pollTest.tick(); pollTest.tick();
      });
      assert.deepEqual(await page.evaluate(() => pollTest.calls), []);
      await page.evaluate(() => {
        pollTest.hold = true;
        pollTest.hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(() => typeof pollTest.release === 'function');
      await page.evaluate(() => { pollTest.tick(); pollTest.tick(); pollTest.tick(); });
      assert.deepEqual(await page.evaluate(() => pollTest.calls), ['runs/for-session']);

      // If a request finishes after hiding, it must not render or fetch activity.
      await page.evaluate(() => {
        pollTest.hidden = true;
        pollTest.status = 'PAUSED';
        pollTest.release();
      });
      await page.evaluate(() => Promise.resolve());
      assert.deepEqual(await page.evaluate(() => pollTest.calls), ['runs/for-session']);
      assert.equal(await page.locator('#nodesActivity').textContent(), 'Task: Owned test task (RUNNING)');
      await page.evaluate(() => {
        pollTest.calls = [];
        pollTest.hold = false;
        pollTest.hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(() => document.querySelector('#nodesActivity').textContent.includes('PAUSED'));
      assert.equal(await page.evaluate(() => pollTest.row === document.querySelector('#nodesActivity').firstElementChild), false);
      await page.evaluate(() => { pollTest.calls = []; pollTest.dispose(); pollTest.tick(); });
      assert.deepEqual(await page.evaluate(() => pollTest.calls), []);
      assert.deepEqual(await page.evaluate(() => pollTest.errors), []);
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
