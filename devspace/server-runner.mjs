import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {dshWriters,startWriterControl} from './writer-runtime.mjs';
import {prepareRuntime} from './prepare-runtime.mjs';

const allowed = new Set(['requestId', 'method', 'status', 'durationMs', 'success', 'tool', 'commandLength']);
export function safeRecord(event, fields = {}) {
  const result = { ts: new Date().toISOString(), event: /^[a-z_]{1,64}$/.test(event) ? event : 'runtime_event' };
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.has(key) && (typeof value === 'number' || typeof value === 'boolean' ||
      (key === 'requestId' && /^[a-f0-9-]{36}$/.test(value)) ||
      (['method', 'tool'].includes(key) && /^[a-zA-Z_/]{1,40}$/.test(value)))) result[key] = value;
  }
  if (fields.path) result.path = ['/mcp', '/healthz', '/token', '/authorize', '/register'].includes(fields.path) ? fields.path : '/other';
  return result;
}
export function appendLog(file, record, maxBytes = 2 * 1024 * 1024) {
  if (existsSync(file) && statSync(file).size >= maxBytes) {
    rmSync(file + '.1', { force: true });
    renameSync(file, file + '.1');
  }
  appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
}
async function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  prepareRuntime(root, {check:true});
  mkdirSync(join(root, 'logs'), { recursive: true });
  const write = (event, fields) => appendLog(join(root, 'logs', 'requests.jsonl'), safeRecord(event, fields));
  // Upstream errors can contain file contents and command text. Persist only these fields.
  for (const level of ['log', 'warn', 'error']) console[level] = (...args) => {
    try { const entry = JSON.parse(String(args[0])); write(entry.event, entry); }
    catch { write('runtime_message'); }
  };
  const { createServer } = await import('./node_modules/@waishnav/devspace/dist/server.js');
  const { loadConfig } = await import('./node_modules/@waishnav/devspace/dist/config.js');
  const config = loadConfig();
  if (config.host !== '127.0.0.1' || config.port !== 7676 || config.publicBaseUrl !== 'https://desktop-dujmm2g.tail3bd4f2.ts.net') throw new Error('Unexpected server configuration');
  const writerRuntime=dshWriters.configure();
  const writerControl=await startWriterControl(writerRuntime);
  const { app, close } = createServer(config);
  const server = createHttpServer((req, res) => {
    const requestId = randomUUID(), started = performance.now();
    const fields = { requestId, method: req.method, path: req.url.split('?')[0] };
    write('request_started', fields);
    res.once('finish', () => write('request_finished', { ...fields, status: res.statusCode, durationMs: Math.round(performance.now() - started) }));
    res.once('close', () => { if (!res.writableFinished) write('request_aborted', { ...fields, durationMs: Math.round(performance.now() - started) }); });
    app(req, res);
  });
  server.timeout = 0;
  server.requestTimeout = 330000;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;
  server.listen(config.port, config.host, () => write('server_ready'));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    write('server_draining');
    await new Promise(resolve => server.close(resolve));
    await close();
    await writerControl.close();
    write('server_stopped');
  };
  const timer = setInterval(() => {
    try {
      const file = join(root, 'stop-request.json');
      const request = JSON.parse(readFileSync(file, 'utf8'));
      if (request.pid === process.pid && request.instance === process.env.DSH_DEVSPACE_INSTANCE) {
        rmSync(file); void shutdown();
      }
    } catch {}
  }, 1000);
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('DevSpace runner failed; inspect safe diagnostic log.\n'); process.exit(1); });
}
