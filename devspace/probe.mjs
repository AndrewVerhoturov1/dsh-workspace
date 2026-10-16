import https from 'node:https';
import http from 'node:http';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

export const origin = 'https://desktop-dujmm2g.tail3bd4f2.ts.net';
export function publicIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19)));
}
export function request(url, { address, method = 'GET', timeout = 6000, headers = {}, body } = {}) {
  return new Promise(resolve => {
    const target = new URL(url);
    let phase = 'connect';
    const req = (target.protocol === 'https:' ? https : http).request(target, {
      method, agent: false, headers, ...(address ? {
        family: 4, servername: target.hostname,
        lookup: (_host, options, callback) => callback(null, options.all ? [{address, family: 4}] : address, 4),
      } : {}),
    }, res => {
      phase = 'http';
      let text = '';
      res.on('data', data => {
        text += data;
        if (text.length > 131072) req.destroy(new Error('size'));
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on('error', () => resolve({ status: 0, phase }));
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeout);
    req.on('socket', socket => {
      socket.on('connect', () => { phase = target.protocol === 'https:' ? 'tls' : 'http'; });
      socket.on('secureConnect', () => { phase = 'http'; });
    });
    req.on('error', () => resolve({ status: 0, phase }));
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}
export async function checkEndpoint(base, address) {
  const health = await request(base + '/healthz', { address });
  let healthOk = false;
  try { const value = JSON.parse(health.text); healthOk = health.status === 200 && value.ok === true && value.name === 'devspace'; } catch {}
  if (!healthOk) return { healthy: false, health: health.status, phase: health.phase ?? 'http' };
  const [gate, metadata] = await Promise.all([
    request(base + '/mcp', { address, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' }),
    request(base + '/.well-known/oauth-authorization-server', { address }),
  ]);
  let issuerOk = false;
  try { issuerOk = metadata.status === 200 && JSON.parse(metadata.text).issuer.replace(/\/+$/, '') === origin; } catch {}
  const authGate = gate.status === 401 && /resource_metadata=/.test(gate.headers?.['www-authenticate'] ?? '');
  return { healthy: healthOk && authGate && issuerOk, health: health.status, mcp: gate.status, authGate, issuerOk };
}
export async function probePublic() {
  let addresses = [], dnsSource;
  for (const resolver of ['https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query']) {
    const answer = await request(`${resolver}?name=${new URL(origin).hostname}&type=A`, { headers: { Accept: 'application/dns-json' } });
    try { addresses = [...new Set(JSON.parse(answer.text).Answer.filter(a => a.type === 1).map(a => a.data).filter(publicIPv4))].slice(0, 4); } catch {}
    if (addresses.length) { dnsSource = new URL(resolver).hostname; break; }
  }
  if (!addresses.length) return { state: 'unknown', dns: false, edges: [] };
  const edges = await Promise.all(addresses.map(async address => ({ address, ...await checkEndpoint(origin, address) })));
  const good = edges.filter(e => e.healthy).length;
  return { state: good === edges.length ? 'healthy' : good ? 'degraded' : 'down', dns: true, dnsSource, edges };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = process.argv[2] === 'local' ? await checkEndpoint(process.argv[3] ?? 'http://127.0.0.1:7676') : await probePublic();
    process.stdout.write(JSON.stringify(result));
  } catch { process.stdout.write('{"state":"unknown","healthy":false}'); process.exitCode = 1; }
}
