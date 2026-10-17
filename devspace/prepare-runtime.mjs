import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

export function prepareRuntime(root, {check=false}={}) {
  const pkg = join(root, 'node_modules/@waishnav/devspace');
  if (JSON.parse(readFileSync(join(pkg, 'package.json'))).version !== '1.1.0-beta.4') throw new Error('Unreviewed DevSpace version; no patch applied');
  const file = join(pkg, 'dist/pi-tools.js');
  const runtime=pathToFileURL(join(root,'writer-runtime.mjs')).href;
  const shellFile=createRequire(file).resolve.paths('@earendil-works/pi-coding-agent')
    .map(base=>join(base,'@earendil-works/pi-coding-agent/dist/utils/shell.js')).find(existsSync);
  if(!shellFile) throw Error('Reviewed native shell implementation unavailable; no patch applied');
  const shell=pathToFileURL(shellFile).href;
  const before = 'export async function runShellTool(input, context) {';
  const after = `// DSH: bound active Bash calls; never queue or replay commands after disconnect.
let dshActiveShells = 0;
export async function runShellTool(input, context) {
    if (dshActiveShells >= 8) return { content: [{ type: "text", text: "Eight Bash calls are already running. No command was started." }], isError: true };
    dshActiveShells++;
    try { return await dshRunShellTool(input, context); }
    finally { dshActiveShells--; }
}
async function dshRunShellTool(input, context) {`;
  const managedAfter=after.replace('    if (dshActiveShells >= 8)',
    '    if (["status", "stop"].includes(input.execution)) return await dshRunShellTool(input, context);\n    if (dshActiveShells >= 8)');
  const oldPiPrefix='import {dshWriters} from '+JSON.stringify(runtime)+';\nimport {getShellConfig} from '+JSON.stringify(shell)+';\n';
  const piPrefix='import {dshWriters} from '+JSON.stringify(runtime)+';\nimport {getShellConfig,getShellEnv} from '+JSON.stringify(shell)+';\n';
  const previousPi=source=>oldPiPrefix+source.replace(before,after)
    .replace('createBashTool(context.cwd);','createBashTool(context.cwd, {operations: dshWriters.bashOperations(getShellConfig)});');
  const changes=[
    {file,sha:'98f0b596058dad3aa34d99f6735ef9fdb5f1053844da41f7a59117e4d9fd6b00',
      previous:previousPi,
      transform:source=>piPrefix+source.replace(before,managedAfter).replace('const tool = createBashTool(context.cwd);',
        `const managed = dshWriters.background(input, { ...context, env: getShellEnv() }, getShellConfig);
    if (managed !== undefined) return await managed;
    if ((input.execution && input.execution !== "foreground") || input.job_id) return { isError: true, content: [{ type: "text", text: "WRITER_BINDING_REQUIRED" }] };
    if (typeof input.command !== "string") return { isError: true, content: [{ type: "text", text: "Shell command is required" }] };
    const operations = dshWriters.bashOperations(getShellConfig);
    const tool = operations ? createBashTool(context.cwd, { operations }) : createBashTool(context.cwd);`)},
    {file:join(pkg,'dist/server.js'),sha:'0c7601c4be6b9d3a53ef7b4d672f43a3b728914cf10f255fdaed6c6cd849269a',
      transform:source=>'import {dshWriters} from '+JSON.stringify(runtime)+';\n'+source
        .replace('withTrackedToolHandlers(server, trackToolActivity)','withTrackedToolHandlers(server, trackToolActivity, workspaces)')
        .replace('function withTrackedToolHandlers(server, trackToolActivity) {','function withTrackedToolHandlers(server, trackToolActivity, workspaces) {')
        .replace('trackToolActivity(() => Promise.resolve(handler(...handlerArgs)))',
          'trackToolActivity(() => dshWriters.runTool(args[0], handlerArgs[0], handlerArgs[1], workspaces, () => Promise.resolve(handler(...handlerArgs)), args[1]?.annotations?.readOnlyHint === true))')},
    {file:join(pkg,'dist/tool-surfaces/claude.js'),sha:'6fd9cb01bd4efcee55a457e310ae58530c92cd67fd623db274ba9f59d4bcf8f8',
      transform:source=>{
        const index=source.indexOf('function registerShellTool(context) {');
        const head=source.slice(0,index), body=source.slice(index);
        return head+body.replace('inputSchema: {',`inputSchema: {
            execution: z.enum(["foreground", "background", "status", "stop"]).optional().describe("Postman writer only: background starts an owned native job; status lists or inspects it; stop requires its exact job_id. Default foreground. Timeout bounds waiting, never background lifetime."),
            job_id: z.string().optional().describe("Exact native_job_id from Postman background/status; omit for status discovery."),`)
          .replace(/command:\s*z\s*\.string\(\)/,'command: z.string().optional()')
          .replace('outputSchema: resultOutputSchema(),',`outputSchema: resultOutputSchema({
            native_job_id: z.string().optional(), state: z.string().optional(), jobs: z.array(z.unknown()).optional(),
            foregroundFinished: z.boolean().optional(), exitCode: z.number().nullable().optional(), treeSettled: z.boolean().optional(),
            output: z.string().optional(), waitExpired: z.boolean().optional(), evidence: z.string().optional(),
        }),`)
          .replace(/structuredContent: \{\s*result:/,'structuredContent: { ...response.structuredContent, result:')
          .replaceAll('input.command.length','(input.command?.length ?? 0)');
      }},
  ];
  // Validate every upstream input before changing any file. Retain original bytes.
  const prepared=changes.map(change=>{
    const saved=readFileSync(change.file,'utf8'), backup=change.file+'.dsh-original';
    const canonical=existsSync(backup)?readFileSync(backup,'utf8'):saved;
    if(createHash('sha256').update(canonical).digest('hex')!==change.sha) throw Error('Unexpected upstream source; preserved');
    const patched=change.transform(canonical);
    const legacy=change.file.endsWith('pi-tools.js') ? canonical.replace(before,after) : canonical;
    if(![canonical,legacy,patched,...(change.previous?[change.previous(canonical)]:[])].includes(saved)) throw Error('Unexpected patched source; preserved');
    return {...change,canonical,patched,backup,saved};
  });
  if(check) {
    if(prepared.some(change=>change.saved!==change.patched)) throw Error('DevSpace runtime patch required; run prepare-runtime.mjs <root> before starting the server. No files changed.');
    return;
  }
  for(const change of prepared) {
    if(!existsSync(change.backup)) writeFileSync(change.backup,change.canonical);
    writeFileSync(change.file,change.patched);
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [root,...flags]=process.argv.slice(2);
  if(!root || flags.some(flag=>flag!=='--check')) throw Error('Usage: node prepare-runtime.mjs <root> [--check]');
  prepareRuntime(root,{check:flags.includes('--check')});
  console.log(flags.includes('--check') ? 'Reviewed DevSpace runtime is prepared; no files changed' : 'Reviewed Bash limit and native writer instrumentation prepared');
}
