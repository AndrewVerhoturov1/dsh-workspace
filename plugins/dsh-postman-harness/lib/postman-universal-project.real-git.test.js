import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createPostmanTaskContexts } from './postman-task-context.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { createImplementationArtifactGrants, createImplementationArtifactApplyTool, verifiedRepository } from './implementation-artifact.js'
import { createPostmanInputFilesTool, PostmanInputGrants } from './postman-input-files.js'
import { DirectPostmanJobManager } from './direct-current-turn.js'
import { createPostmanWorkerTools } from './postman-worker.js'

const exec = promisify(execFile)
const REQ = 'REQ_20261016T102030Z_1234'
const git = async (cwd, ...args) => {
  const { stdout } = await exec('git', ['-C', cwd, ...args],
    { windowsHide: true, timeout: 30000 })
  return stdout.trim()
}
const leader = (id, cwd) => ({ id, session: { header: { cwd } } })

async function fixture(t, branch = 'main', { empty = false, offline = false, id = 'a' } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'postman-universal-'))
  t.after(async () => { await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const bare = join(temp, 'origin.git'), initial = join(temp, 'initial'), root = join(temp, 'checkout')
  await git(temp, 'init', '--bare', bare)
  await git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/' + branch)
  if (empty) {
    await mkdir(root)
    await git(root, 'init', '-b', branch)
  } else {
    await mkdir(initial)
    await git(initial, 'init', '-b', branch)
    await git(initial, 'config', 'user.name', 'Fixture')
    await git(initial, 'config', 'user.email', 'fixture@example.org')
    await writeFile(join(initial, 'tracked.txt'), 'unchanged\n')
    await git(initial, 'add', 'tracked.txt')
    await git(initial, 'commit', '-m', 'Fixture base')
    await git(initial, 'remote', 'add', 'origin', bare)
    await git(initial, 'push', 'origin', branch)
    await git(temp, 'clone', '-b', branch, bare, root)
  }
  const identity = 'ExampleOrg/local-project-' + id
  const originUrl = 'https://github.com/' + identity + '.git'
  await git(root, 'remote', empty ? 'add' : 'set-url', 'origin', originUrl)
  const base = empty ? null : await git(root, 'rev-parse', 'HEAD')
  const registry = createMemoryTaskRegistry()
  let networkCalls = 0, bootstrapCalls = 0
  const command = async (cwd, ...args) => {
    if (args[0] === 'ls-remote' && args.includes('origin')) {
      networkCalls++
      if (offline) throw Error('OFFLINE_NETWORK_UNAVAILABLE')
      return git(cwd, ...args.map(x => x === 'origin' ? bare : x))
    }
    if (args[0] === 'fetch' && args.includes('origin')) {
      if (offline) throw Error('UNEXPECTED_OFFLINE_FETCH')
      if (args[1] === '--prune') return git(cwd, 'fetch', '--prune', bare,
        '+refs/heads/*:refs/remotes/origin/*')
      return git(cwd, ...args.map(x => x === 'origin' ? bare : x))
    }
    if (args[0] === '-c' && args.includes('commit-tree')) bootstrapCalls++
    return git(cwd, ...args)
  }
  const contexts = createPostmanTaskContexts({ registry, gitCommand: command,
    temporaryDirectory: () => temp, githubDefaultBranch: async () => branch })
  return { temp, bare, root, branch, identity, originUrl, base, contexts, registry, command,
    get networkCalls() { return networkCalls },
    get bootstrapCalls() { return bootstrapCalls } }
}

test('real Git: default main/master/custom branches all bind exact root, SHA and local-only task tree', async t => {
  for (const [branch, id] of [['main', 'main'], ['master', 'master'], ['release/v2.3', 'custom']]) {
    await t.test(branch, async t => {
      const f = await fixture(t, branch, { id })
      await writeFile(join(f.root, 'tracked.txt'), 'dirty user bytes\n')
      await writeFile(join(f.root, 'staged.txt'), 'user staged\n')
      await git(f.root, 'add', 'staged.txt')
      await writeFile(join(f.root, 'untracked.txt'), 'untracked user bytes\n')
      const before = await git(f.root, 'status', '--porcelain=v1', '--untracked-files=all')
      const subject = leader('leader-' + id, f.root)
      const prepared = await f.contexts.prepare(subject, f.root)
      assert.equal(prepared.status, 'TASK_CONTEXT_READY', JSON.stringify(prepared))
      assert.equal(prepared.repository, f.identity)
      assert.equal(resolve(prepared.repositoryPath), resolve(f.root))
      assert.equal(prepared.originUrl, f.originUrl)
      assert.equal(prepared.defaultBranch, branch)
      assert.equal(prepared.baseSource, 'remote')
      assert.equal(prepared.baseCommit, f.base)
      assert.equal(f.registry.get(subject.id).universalProject, true)
      assert.match(prepared.branch, /^task\/postman-[0-9a-f]{32}$/)
      assert.equal(await git(prepared.worktree, 'rev-parse', 'HEAD'), f.base)
      assert.equal(await git(prepared.worktree, 'status', '--porcelain'), '')
      assert.equal(await git(f.root, 'status', '--porcelain=v1', '--untracked-files=all'), before)
      assert.equal(await git(f.bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/' + prepared.branch), '')
      assert.equal(await f.contexts.verifyWorktree(subject.id), true)
      assert.equal(await f.contexts.verifyDirectPublication(subject.id), false,
        'unpublished task branch cannot initiate legacy Direct REQ')
      assert.equal((await f.contexts.prepare(subject, f.root)).status, 'POSTMAN_TASK_CONTEXT_ALREADY_READY')
      assert.equal((await f.contexts.prepare(subject, f.temp)).status, 'POSTMAN_TASK_PROJECT_CHANGED')
      await writeFile(join(prepared.worktree, 'devspace-edited.txt'), 'local change\n')
      const cold = createPostmanTaskContexts({ registry: f.registry, gitCommand: f.command })
      const resumed = await cold.recover(subject)
      assert.equal(resumed.status, 'POSTMAN_TASK_CONTEXT_ALREADY_READY', JSON.stringify(resumed))
      assert.equal(await readFile(join(prepared.worktree, 'devspace-edited.txt'), 'utf8'), 'local change\n')
      assert.equal(await git(f.root, 'status', '--porcelain=v1', '--untracked-files=all'), before)
    })
  }
})

test('real Git: offline cached default branch permits local work without claiming current remote proof', async t => {
  const f = await fixture(t, 'master', { id: 'offline', offline: true })
  const parent = leader('offline-owner', f.root)
  const prepared = await f.contexts.prepare(parent, f.root)
  assert.equal(prepared.status, 'TASK_CONTEXT_READY', JSON.stringify(prepared))
  assert.equal(prepared.defaultBranch, 'master')
  assert.equal(prepared.baseSource, 'cached')
  assert.equal(prepared.baseCommit, f.base)
  assert.equal(f.networkCalls, 1)
  assert.equal((await f.contexts.prepare(parent)).baseSource, 'cached')
  assert.equal(await git(f.bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/' + prepared.branch), '')
  await git(prepared.worktree, 'config', 'user.name', 'Offline Fixture')
  await git(prepared.worktree, 'config', 'user.email', 'offline@example.org')
  await writeFile(join(prepared.worktree, 'offline.txt'), 'local only\\n')
  await git(prepared.worktree, 'add', 'offline.txt')
  await git(prepared.worktree, 'commit', '-m', 'Offline local fixture')
  assert.equal(await f.contexts.verifyWorktree(parent.id), true)
  const cold = createPostmanTaskContexts({ registry: f.registry, gitCommand: f.command })
  assert.equal((await cold.recover(parent)).status, 'POSTMAN_TASK_CONTEXT_ALREADY_READY')
  assert.equal(await readFile(join(prepared.worktree,'offline.txt'),'utf8'), 'local only\\n')
  assert.equal(await cold.verifyDirectPublication(parent.id), false)
})

test('real Git: empty remote starts exactly one empty local initial commit, no source add/stash/reset', async t => {
  const f = await fixture(t, 'main', { empty: true, id: 'empty' })
  await writeFile(join(f.root, 'private.txt'), 'keep me\n')
  await git(f.root, 'add', 'private.txt')
  await writeFile(join(f.root, 'untracked.txt'), 'also keep\n')
  const before = await git(f.root, 'status', '--porcelain=v1', '--untracked-files=all')
  const parent = leader('unborn-owner', f.root)
  const prepared = await f.contexts.prepare(parent, f.root)
  assert.equal(prepared.status, 'TASK_CONTEXT_READY', JSON.stringify(prepared))
  assert.equal(prepared.baseSource, 'bootstrap')
  assert.equal(f.bootstrapCalls, 1)
  assert.match(prepared.baseCommit, /^[0-9a-f]{40}$/)
  assert.equal(await git(prepared.worktree, 'rev-list', '--parents', '-n', '1', prepared.baseCommit), prepared.baseCommit)
  assert.equal(await git(prepared.worktree, 'ls-tree', '-r', '--name-only', prepared.baseCommit), '')
  assert.equal(await git(f.root, 'status', '--porcelain=v1', '--untracked-files=all'), before)
  assert.equal(await git(f.bare, 'for-each-ref', '--format=%(refname)', 'refs/heads'), '')
  const cold = createPostmanTaskContexts({ registry: f.registry, gitCommand: f.command })
  assert.equal((await cold.recover(parent)).status, 'POSTMAN_TASK_CONTEXT_ALREADY_READY')
  assert.equal(f.bootstrapCalls, 1, 'cold restart must never add another initial commit')
})

test('real Git: two independent repositories and Leader bindings do not globally block', async t => {
  const a = await fixture(t, 'main', { id: 'first' })
  const b = await fixture(t, 'release/next', { id: 'second' })
  const one = await a.contexts.prepare(leader('one', a.root), a.root)
  const two = await b.contexts.prepare(leader('two', b.root), b.root)
  assert.equal(one.status, 'TASK_CONTEXT_READY', JSON.stringify(one))
  assert.equal(two.status, 'TASK_CONTEXT_READY', JSON.stringify(two))
  assert.notEqual(one.worktree, two.worktree)
  assert.notEqual(one.repository, two.repository)
  assert.equal(await a.contexts.verifyWorktree('one'), true)
  assert.equal(await b.contexts.verifyWorktree('two'), true)
})

test('exact generic grant repository and source URL are bound, not a universal allow-all', async t => {
  const f = await fixture(t, 'main', { id: 'grant' })
  const parent = leader('grant-owner', f.root)
  const prepared = await f.contexts.prepare(parent, f.root)
  assert.equal(prepared.status, 'TASK_CONTEXT_READY')
  const zip = join(f.temp, 'owned-result.zip')
  await writeFile(zip, 'trusted fixture bytes')
  const sha256 = createHash('sha256').update('trusted fixture bytes').digest('hex')
  const grants = createImplementationArtifactGrants(f.registry)
  const result = { ok: true, code: 'RESULT_DURABLE', state: 'RESULT_DURABLE',
    requestId: REQ, repository: f.identity, branch:prepared.branch,
    taskPublicationCommit:'b'.repeat(40),
    taskUrl:'https://raw.githubusercontent.com/'+f.identity+'/'+'b'.repeat(40)+'/'+REQ+'.md',
    expectedFilename: 'POSTMAN_' + REQ + '_RESULT.zip', resultZip: zip, sha256 }
  const terminal = { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED',
    transportKind: 'artifact', requestId: REQ, result }
  assert.equal(await grants.register(parent.id, { ...terminal,
    result: { ...result, repository: 'Stranger/foreign' } }), false)
  assert.equal(await grants.register(parent.id, { ...terminal,
    result: { ...result, branch: 'task/postman-'+'f'.repeat(32) } }), false)
  assert.equal(await grants.register(parent.id, { ...terminal,
    result: { ...result, taskUrl: 'https://raw.githubusercontent.com/Foreign/repo/fake/'+REQ+'.md' } }), false)
  assert.equal(await grants.register(parent.id, terminal), true)
  assert.equal((await grants.resolve(parent.id, REQ)).repository, f.identity)
  assert.equal(await verifiedRepository(prepared.worktree, {repository:f.identity,originUrl:f.originUrl}), true)
  assert.equal(await verifiedRepository(prepared.worktree, {repository:'Elsewhere/other'}), false)
  assert.equal(await verifiedRepository(prepared.worktree, {repository:f.identity,originUrl:'https://github.com/Elsewhere/repo.git'}), false)
  await writeFile(zip, 'tampered')
  assert.equal(await grants.resolve(parent.id, REQ), null)
  const commit = 'a'.repeat(40)
  const publication = { requestId: REQ, repository: f.identity, branch: prepared.branch,
    baseCommit: commit, taskPublicationCommit: 'b'.repeat(40),
    taskUrl: 'https://raw.githubusercontent.com/' + f.identity + '/' + 'b'.repeat(40) + '/' + REQ + '.md' }
  const manager = new DirectPostmanJobManager({ directRoot: join(f.temp, 'direct'),
    readPublicationState(path) {
      if (!path.endsWith(REQ + '.json') || path.includes('results')) throw Error('ENOENT')
      return JSON.stringify({ ...publication, state: 'TASK_PUBLISHED' })
    } })
  assert.equal(manager.inspectRequest(REQ, prepared.branch, 'artifact', f.identity).state, 'published')
  assert.equal(manager.inspectRequest(REQ, prepared.branch, 'artifact', 'Foreign/repo').state, 'unknown')
})

test('input descriptors use exact selected GitHub project and reject cross-repository selections', async t => {
  const f = await fixture(t, 'main', { id: 'inputs' })
  const agent = { ...leader('input-leader', f.root),
    session: { header: { cwd: f.root, agentPreset: 'postman-leader', delegationDepth: 0 } } }
  const prepared = await f.contexts.prepare(agent, f.root)
  assert.equal(prepared.status, 'TASK_CONTEXT_READY')
  const data = Buffer.from('existing file fixture')
  const sha256 = createHash('sha256').update(data).digest('hex')
  const inputGrants = new PostmanInputGrants()
  let calls = 0
  const tool = createPostmanInputFilesTool({ agents: { get: id => id === agent.id ? agent : null } },
    f.contexts, { grants: inputGrants, async run(_host, args) {
      calls++
      assert.deepEqual(args.slice(0, 5),
        ['--existing', f.base, 'docs/guide.md', '--existing-repository', f.identity])
      const snapshotRoot = args.at(-1)
      const snapshot_path = join(snapshotRoot, '001.bin')
      await writeFile(snapshot_path, data)
      const descriptors = [{ source_kind: 'github', name: 'guide.md', media_type: 'application/octet-stream',
        repository: f.identity, commit: f.base, path: 'docs/guide.md',
        raw_url: 'https://raw.githubusercontent.com/' + f.identity + '/' + f.base + '/docs/guide.md',
        sha256, byte_length: data.length }]
      return { descriptors, materializations: [{ snapshot_path, sha256, byte_length: data.length }] }
    } })
  const execute = args => tool.execute(args, { agent, signal: new AbortController().signal })
  assert.equal((await execute({action:'describe_existing',repository:'Foreign/repo',
    commit:f.base,path:'docs/guide.md'})).status, 'POSTMAN_INPUT_ARGUMENTS_INVALID')
  assert.equal(calls, 0)
  const answer = await execute({action:'describe_existing',repository:f.identity,
    commit:f.base,path:'docs/guide.md'})
  assert.equal(answer.status, 'POSTMAN_INPUT_READY', JSON.stringify(answer))
  assert.equal(answer.descriptors[0].repository, f.identity)
  assert.equal(calls, 1)
  inputGrants.dispose()
})

test('offline with no proven origin/HEAD refuses task creation without guessing base', async t => {
  const f = await fixture(t, 'main', { empty: true, offline: true, id: 'unknown-offline' })
  const before = await git(f.root, 'status', '--porcelain=v1', '--untracked-files=all')
  const result = await f.contexts.prepare(leader('unknown-offline', f.root), f.root)
  assert.equal(result.status, 'POSTMAN_TASK_PREPARE_FAILED')
  assert.equal(result.diagnostic, 'POSTMAN_TASK_DEFAULT_BRANCH_UNPROVEN_OFFLINE')
  assert.equal(await git(f.root, 'status', '--porcelain=v1', '--untracked-files=all'), before)
  assert.equal(f.bootstrapCalls, 0)
  assert.equal(await git(f.bare, 'for-each-ref', '--format=%(refname)', 'refs/heads'), '')
})
test('owned generic Worker receives exact project/default branch and approved artifact, not ZIP path', async t => {
  const f = await fixture(t, 'release/custom', { id: 'worker-handoff' })
  const parent = { ...leader('generic-worker-owner', f.root),
    session: { header: { cwd: f.root, agentPreset: 'postman-leader', delegationDepth: 0 } } }
  const task = await f.contexts.prepare(parent, f.root)
  assert.equal(task.status, 'TASK_CONTEXT_READY')
  const zip = join(f.temp, 'worker-transport.zip')
  const bytes = Buffer.from('host trusted artifact')
  await writeFile(zip, bytes)
  const grants = createImplementationArtifactGrants(f.registry)
  const result = {ok:true,code:'RESULT_DURABLE',state:'RESULT_DURABLE',
    requestId:REQ,repository:f.identity,branch:task.branch,
    taskPublicationCommit:'b'.repeat(40),
    taskUrl:'https://raw.githubusercontent.com/'+f.identity+'/'+'b'.repeat(40)+'/'+REQ+'.md',
    expectedFilename:'POSTMAN_'+REQ+'_RESULT.zip',
    resultZip:zip,sha256:createHash('sha256').update(bytes).digest('hex')}
  assert.equal(await grants.register(parent.id,{status:'POSTMAN_BRIDGE_TERMINAL',
    terminalStatus:'COMPLETED',transportKind:'artifact',requestId:REQ,result}),true)
  let started
  const ctx={agents:{get:id=>id===parent.id?parent:null},
    tools:{schemas:()=>[{name:'postman_bridge'}]},
    subagents:{async startContinuable(spec){started=spec;return{childId:spec.childId,messageId:'accepted'}},
      async drainContinuableChildren(){}}}
  const worker=createPostmanWorkerTools(ctx,grants,{get:id=>id===parent.id?task:null})
  t.after(()=>worker.dispose())
  const answer=await worker.taskTool.execute({task:'Apply only the approved artifact',artifactRequestId:REQ},
    {agent:parent,signal:new AbortController().signal})
  assert.equal(answer.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(answer))
  const prompt=started.request.prompt[0].text
  assert.ok(prompt.includes(f.identity))
  assert.ok(prompt.includes(task.defaultBranch))
  assert.ok(prompt.includes(task.baseCommit))
  assert.ok(prompt.includes(task.worktree))
  assert.ok(prompt.includes('implementation_artifact_apply'))
  assert.equal(prompt.includes(zip),false)
})
test('generic branchless Devspace accepts master/custom/unborn without weakening Direct publication branch guard', async () => {
  const direct = new DirectPostmanJobManager({ exists: () => false })
  for (const branch of ['master', 'release/custom', 'unborn']) {
    await assert.rejects(() => direct.start({
      sessionId: 'exact-luna', workspace: 'C:/trusted-DSH-source', payload:'read only',
      branch, transportKind:'devspace', devspaceBinding:{lunaSessionId:'exact-luna'},
    }), error => error?.message === 'POSTMAN_DIRECT_BRIDGE_MISSING',
      'private mode must pass branch validation before missing-script preflight')
    await assert.rejects(() => direct.start({
      sessionId: 'standalone', workspace: 'C:/trusted-DSH-source', payload:'publish',
      branch, transportKind:'text',
    }), error => error?.message === 'POSTMAN_TASK_BRANCH_INVALID',
      'publishing mode must retain existing main/task branch validation')
  }
})
test('mock-only local bare publication preserves custom default PR base and exact remote task SHA', async t => {
  const f = await fixture(t, 'release/next', { id:'mock-publication' })
  const owner = leader('mock-Worker-owner', f.root)
  const task = await f.contexts.prepare(owner, f.root)
  assert.equal(task.status, 'TASK_CONTEXT_READY')
  assert.equal(task.defaultBranch, 'release/next')
  assert.equal(await git(f.bare,'rev-parse','refs/heads/release/next'),task.baseCommit)
  assert.equal(await git(f.bare,'for-each-ref','--format=%(refname)','refs/heads/'+task.branch),'')
  // Local fixture only. This is not GitHub, a real Worker permission, or a real PR.
  await git(task.worktree,'config','user.name','Mock Worker')
  await git(task.worktree,'config','user.email','mock-worker@example.org')
  await writeFile(join(task.worktree,'feature.txt'),'fixture feature\n')
  await git(task.worktree,'add','feature.txt')
  await git(task.worktree,'commit','-m','mock feature change')
  const localSha=await git(task.worktree,'rev-parse','HEAD')
  await git(task.worktree,'push',f.bare,'HEAD:refs/heads/'+task.branch)
  assert.equal(await git(f.bare,'rev-parse','refs/heads/'+task.branch),localSha)
  assert.equal(await git(f.bare,'rev-parse','refs/heads/release/next'),task.baseCommit,
    'the custom default branch is unchanged by mock task publication')
  assert.equal(await git(task.worktree,'merge-base',task.baseCommit,localSha),task.baseCommit)
  const plannedPrBase=task.defaultBranch
  assert.equal(plannedPrBase,'release/next','simulated PR target must use selected default, not main')
})
test('local-first generic artifact runner refuses an unpublished task ref before executing', async t => {
  const f=await fixture(t,'main',{id:'unpublished-runner'})
  const owner=leader('unpublished-runner-owner',f.root)
  const task=await f.contexts.prepare(owner,f.root)
  assert.equal(task.status,'TASK_CONTEXT_READY')
  const archive=join(f.temp,'runner-source.zip')
  const contents=Buffer.from('approved-but-not-remotely-published')
  await writeFile(archive,contents)
  const grants=createImplementationArtifactGrants(f.registry)
  const result={ok:true,code:'RESULT_DURABLE',state:'RESULT_DURABLE',
    requestId:REQ,repository:f.identity,branch:task.branch,
    taskPublicationCommit:'c'.repeat(40),
    taskUrl:'https://raw.githubusercontent.com/'+f.identity+'/'+'c'.repeat(40)+'/'+REQ+'.md',
    expectedFilename:'POSTMAN_'+REQ+'_RESULT.zip',resultZip:archive,
    sha256:createHash('sha256').update(contents).digest('hex')}
  assert.equal(await grants.register(owner.id,{status:'POSTMAN_BRIDGE_TERMINAL',
    terminalStatus:'COMPLETED',transportKind:'artifact',requestId:REQ,result}),true)
  const caller={id:'bound-generic-worker'}
  const worker={ownerOf:(agent,requestId)=>agent===caller&&requestId===REQ?owner.id:null,
    contextOf:()=>task,async pauseForOperation(){return true}}
  const tool=createImplementationArtifactApplyTool({agents:{get:id=>id===caller.id?caller:null}},grants,worker,
    {taskContexts:f.contexts,jobs:{hasActive:()=>false},verifiedRepository:async()=>true,
      spawnProcess(){throw Error('must not reach runner before proven remote REQ HEAD')}})
  const response=await tool.execute({requestId:REQ,worktree:task.worktree},{agent:caller})
  assert.equal(response.status,'IMPLEMENTATION_ARTIFACT_WORKTREE_REJECTED')
  assert.equal(await f.contexts.verifyDirectPublication(owner.id),false)
})
test('GitHub origin identity rejects query or malformed owner before any task worktree creation', async t => {
  const f=await fixture(t,'main',{id:'origin-boundary'})
  await git(f.root,'remote','set-url','origin',
    'https://github.com/ExampleOrg/local-project?ref=untrusted')
  const parent=leader('origin-boundary-owner',f.root)
  const result=await f.contexts.prepare(parent,f.root)
  assert.equal(result.status,'POSTMAN_TASK_PREPARE_FAILED')
  assert.equal(result.diagnostic,'POSTMAN_TASK_REPOSITORY_REJECTED')
  assert.equal(f.registry.get(parent.id),null)
  assert.equal((await git(f.root,'worktree','list','--porcelain')).split('worktree ').length,2)
})
test('real Git: generic failed-runner restore retains dirty tree and creates independent clean context', async t => {
  const f=await fixture(t,'main',{id:'generic-restore'})
  const parent=leader('generic-restore-owner',f.root)
  const task=await f.contexts.prepare(parent,f.root)
  assert.equal(task.status,'TASK_CONTEXT_READY')
  await writeFile(join(task.worktree,'runner-dirty.txt'),'untracked failed-runner bytes\n')
  await writeFile(join(task.worktree,'tracked.txt'),'dirty tracked failed-runner bytes\n')
  const contexts=createPostmanTaskContexts({registry:f.registry,gitCommand:f.command,temporaryDirectory:()=>f.temp})
  assert.equal((await contexts.recover(parent)).status,'POSTMAN_TASK_CONTEXT_ALREADY_READY')
  assert.equal(contexts.beginOperation(parent.id),true)
  await contexts.startRunner(parent.id,REQ)
  await contexts.endOperation(parent.id,{status:'IMPLEMENTATION_ARTIFACT_RUNNER_RESULT',
    result:{ok:false}})
  const restored=await contexts.restore(parent)
  assert.equal(restored.status,'POSTMAN_TASK_RESTORE_ISOLATED',JSON.stringify(restored))
  assert.notEqual(restored.worktree,task.worktree);assert.notEqual(restored.branch,task.branch)
  assert.equal(await readFile(join(task.worktree,'runner-dirty.txt'),'utf8'),'untracked failed-runner bytes\n')
  assert.equal(await readFile(join(task.worktree,'tracked.txt'),'utf8'),'dirty tracked failed-runner bytes\n')
  assert.equal((await readFile(join(restored.worktree,'tracked.txt'),'utf8')).replaceAll('\r\n','\n'),'unchanged\n')
  assert.equal(await git(restored.worktree,'status','--porcelain=v1','--untracked-files=all'),'')
  assert.equal(await git(task.worktree,'rev-parse','HEAD'),task.baseCommit)
  assert.equal(await git(f.root,'status','--porcelain=v1','--untracked-files=all'),'')
})
