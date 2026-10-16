import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeRecord, appendLog } from '../server-runner.mjs';
import { publicIPv4 } from '../probe.mjs';

test('diagnostics drop private values and rotate bounded files', () => {
  const record=safeRecord('tool_call',{tool:'bash',command:'PRIVATE_COMMAND',error:'PRIVATE_FILE',token:'PRIVATE_TOKEN',path:'/authorize?code=PRIVATE_CODE',status:401});
  const output=JSON.stringify(record);
  assert(!output.includes('PRIVATE'));assert.equal(record.path,'/other');assert.equal(record.tool,'bash');
  const file=join(mkdtempSync(join(tmpdir(),'devspace-log-test-')),'log.jsonl');
  appendLog(file,record,1);appendLog(file,record,1);
  assert.equal(readFileSync(file+'.1','utf8'),readFileSync(file,'utf8'));
});
test('external probes reject internal and Tailscale addresses',()=>{
  for(const ip of ['127.0.0.1','100.64.0.1','100.127.255.255','10.0.0.1','192.168.1.1','172.16.0.1','::1']) assert.equal(publicIPv4(ip),false);
  assert.equal(publicIPv4('185.40.234.198'),true);
});
