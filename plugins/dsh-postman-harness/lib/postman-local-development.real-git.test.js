import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { Config } from './postman-bridge.js'
import { createPostmanTaskContexts } from './postman-task-context.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args])).stdout.trim()

test('localDevelopment requires an explicit boolean Host configuration', () => {
  assert.equal(Config.parse({}).localDevelopment, false)
  assert.equal(Config.parse({ localDevelopment: true }).localDevelopment, true)
  assert.throws(() => Config.parse({ localDevelopment: 'true' }))
})

test('local dirty recovery preserves staged, unstaged, untracked and ignored bytes in original tree',async t=>{
  const root=await mkdtemp(join(tmpdir(),'postman-local-isolation-'))
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
  const repository=join(root,'repo'),bare=join(root,'origin.git')
  await exec('git',['init','--bare',bare]);await exec('git',['init','-b','main',repository])
  await git(repository,'config','user.email','test@example.invalid');await git(repository,'config','user.name','Isolation test')
  await git(repository,'config','core.autocrlf','false')
  await writeFile(join(repository,'.gitignore'),'secret.local\n');await writeFile(join(repository,'payload.txt'),'original\n')
  await git(repository,'add','.gitignore','payload.txt');await git(repository,'commit','-m','base')
  await git(repository,'remote','add','origin','https://github.com/AndrewVerhoturov1/dsh-workspace.git')
  await git(repository,'remote','set-url','--push','origin',bare);await git(repository,'push','origin','main')
  const registry=createMemoryTaskRegistry()
  const contexts=createPostmanTaskContexts({registry,localDevelopment:true,temporaryDirectory:()=>root,
    gitCommand:async(cwd,...args)=>{
      if(args[0]==='fetch')return args[1]==='--prune'?git(cwd,'fetch',bare,'+refs/heads/*:refs/remotes/origin/*'):git(cwd,'fetch',bare,...args.slice(2))
      if(args[0]==='ls-remote')return git(cwd,'ls-remote',args[1],bare,...args.slice(3))
      return git(cwd,...args)}})
  const leader={id:'local-isolation',session:{header:{cwd:repository}}}
  const prepared=await contexts.prepare(leader);assert.equal(prepared.status,'TASK_CONTEXT_READY')
  const {worktree}=prepared
  await writeFile(join(worktree,'payload.txt'),'staged user changes\n');await git(worktree,'add','payload.txt')
  const index=await readFile(await git(worktree,'rev-parse','--git-path','index'))
  await writeFile(join(worktree,'payload.txt'),'unstaged user changes\n')
  await writeFile(join(worktree,'private.bin'),Buffer.from([0,1,2,255]))
  await writeFile(join(worktree,'secret.local'),'fixture-secret-not-for-output')
  await registry.change(leader.id,row=>({...row,runner:{state:'failed',requestId:'failed-package'},
    bridgeOperations:{receipt:{state:'received',synchronization:'pending'}}}))
  const restored=await contexts.restore(leader)
  assert.equal(restored.status,'POSTMAN_TASK_RESTORE_ISOLATED',JSON.stringify(restored))
  assert.equal(await readFile(join(worktree,'payload.txt'),'utf8'),'unstaged user changes\n')
  assert.deepEqual(await readFile(join(worktree,'private.bin')),Buffer.from([0,1,2,255]))
  assert.equal(await readFile(join(worktree,'secret.local'),'utf8'),'fixture-secret-not-for-output')
  assert.deepEqual(await readFile(await git(worktree,'rev-parse','--git-path','index')),index)
  assert.equal(await readFile(join(restored.worktree,'payload.txt'),'utf8'),'original\n')
  assert.equal(await git(restored.worktree,'status','--porcelain=v1','--untracked-files=all'),'')
  assert.equal(registry.get(leader.id).retiredTasks.at(-1).bridgeOperations.receipt.synchronization,'pending')
  assert.equal(await git(repository,'branch','--show-current'),'main')
})
