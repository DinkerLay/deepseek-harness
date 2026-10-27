/** The real resource owner retains its lease and rejects changed filesystem ownership facts. */
import { execFileSync } from 'node:child_process'
import fs, { chmod, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Service } from '@deepseek-ai/cordis'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { acquireFileLease } from '@deepseek-ai/dsh-util-file-lease'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import GitResources, { GitConsumerScope, GitOperationId, GitResourceId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { harness, repository } from './harness.ts'

const signal = new AbortController().signal
async function copy(config: ConstructorParameters<typeof GitResources>[1] = {}) {
  const test = await harness(config), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await test.ctx.gitResources.create({ ...preview.request, consumerScope: GitConsumerScope('owner-lifecycle'),
    originalRequestJson: '{}', operationId: GitOperationId('owned-copy'), expectedPreviewFingerprint: preview.fingerprint })
  return { ...test, base, made }
}

it.each([{ home: ' ' }, { gitExecutable: ' ' }])('rejects an empty explicit owner option %j before initializing it', async (config) => {
  const test = await harness({}, undefined, false)
  await expect(test.ctx.plugin(GitResources, config)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
  expect(test.ctx.storageDomain.get('git_resources')).toBeUndefined()
})

it.each(['directory-link', 'nonempty-config'])('rejects actual invalid private owner metadata %s and returns the lease', async (kind) => {
  const test = await harness({}, undefined, false), root = join(test.home, 'git-resources')
  await mkdir(root, { recursive: true })
  if (kind === 'directory-link') {
    const target = join(test.root, 'not-owned-isolation'); await mkdir(target)
    await symlink(target, join(root, 'isolated'))
  } else {
    await mkdir(join(root, 'isolated'))
    await writeFile(join(root, 'isolated', 'empty-config'), 'unexpected configuration')
  }
  await expect(test.ctx.plugin(GitResources, { home: test.home })).rejects.toMatchObject({ code: 'RESOURCE_HOME_INVALID' })
  expect(test.ctx.storageDomain.get('git_resources')).toBeUndefined()
  const lease = await acquireFileLease(join(root, 'owner.lock')); await lease.release()
})

it.skipIf(process.platform === 'win32')('propagates a real isolated-directory write denial and returns the acquired kernel lease', async () => {
  const test = await harness({}, undefined, false), root = join(test.home, 'git-resources'), isolation = join(root, 'isolated')
  await mkdir(isolation, { recursive: true }); await chmod(isolation, 0o500)
  try {
    await expect(test.ctx.plugin(GitResources, { home: test.home })).rejects.toMatchObject({ code: 'EACCES' })
    expect(test.ctx.storageDomain.get('git_resources')).toBeUndefined()
    const lease = await acquireFileLease(join(root, 'owner.lock')); await lease.release()
  } finally { await chmod(isolation, 0o700) }
})

it('propagates executable discovery failures and shares one actual resolution between concurrent previews', async () => {
  const test = await harness(), base = await repository(test)
  const original = test.ctx.subprocess.resolveExecutable.bind(test.ctx.subprocess)
  const fault = vi.spyOn(test.ctx.subprocess, 'resolveExecutable').mockRejectedValueOnce(new Error('provider discovery failed'))
  const request = { workspaceId: test.workspace.id, baseline: { kind: 'commit' as const, commit: base } }
  await expect(test.ctx.gitResources.preview(request)).rejects.toThrow('provider discovery failed')
  fault.mockRestore()
  const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  const gate = vi.spyOn(test.ctx.subprocess, 'resolveExecutable').mockImplementation(async (...args) => {
    const executable = await original(...args)
    entered.resolve(undefined); await resume.promise; return executable
  })
  const first = test.ctx.gitResources.preview(request)
  try {
    await entered.promise
    const second = test.ctx.gitResources.preview(request)
    // Allow the second real ensureGit call to await the already admitted resolution promise.
    await Promise.resolve(); await Promise.resolve()
    resume.resolve(undefined)
    const [left, right] = await Promise.all([first, second])
    expect(left.permitted).toBe(true); expect(right).toEqual(left)
    expect(gate).toHaveBeenCalledTimes(1)
  } finally { resume.resolve(undefined); await first; gate.mockRestore() }
})

it('refuses a missing registered project and a removed original workspace without adopting another path', async () => {
  const test = await copy()
  await expect(test.ctx.gitResources.preview({ workspaceId: WorkspaceId('not-registered'),
    baseline: { kind: 'commit', commit: test.base } })).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
  await test.ctx.workspaceRegistry.delete(test.workspace.id)
  await expect(test.ctx.gitResources.withWriteUse(test.made.resource.resourceId,
    { useId: 'missing-project', ownerId: 'caller', epoch: '1' }, signal, async () => {}))
    .rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
  expect(test.ctx.gitResources.read(test.made.resource.resourceId)?.use).toBeUndefined()
})

it.each(['empty-config', 'isolated-directory'])('refuses changed private %s before any Git command', async (kind) => {
  const test = await copy(), isolation = join(test.home, 'git-resources', 'isolated')
  if (kind === 'empty-config') await writeFile(join(isolation, 'empty-config'), 'later local bytes')
  else { await rename(isolation, `${isolation}-original`); await mkdir(isolation) }
  const calls = vi.spyOn(ResourceGit.prototype, 'run'); calls.mockClear()
  const result = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id,
    baseline: { kind: 'commit', commit: test.base } })
  expect(result).toMatchObject({ permitted: false, risks: ['RESOURCE_HOME_INVALID'] })
  expect(calls).not.toHaveBeenCalled(); calls.mockRestore()
})

it.each(['bad-marker', 'marker-directory', 'wrong-admin', 'metadata-link', 'wrong-common', 'wrong-backpointer'])
('refuses changed reciprocal work-copy metadata %s without acquiring a use', async (kind) => {
  const test = await copy(), path = test.made.resource.path, marker = join(path, '.git')
  const originalMarker = await readFile(marker, 'utf8'), admin = originalMarker.trim().slice(8)
  if (kind === 'bad-marker') await writeFile(marker, 'not a managed git marker')
  else if (kind === 'marker-directory') { await rm(marker); await mkdir(marker) }
  else if (kind === 'wrong-admin') await writeFile(marker, `gitdir: ${test.project}/.git\n`)
  else if (kind === 'metadata-link') {
    await rename(join(admin, 'gitdir'), join(admin, 'gitdir-original'))
    await symlink(join(admin, 'gitdir-original'), join(admin, 'gitdir'))
  } else if (kind === 'wrong-common') await writeFile(join(admin, 'commondir'), `${path}\n`)
  else await writeFile(join(admin, 'gitdir'), `${test.project}/.git\n`)
  const callback = vi.fn(async () => {})
  await expect(test.ctx.gitResources.withWriteUse(test.made.resource.resourceId,
    { useId: 'invalid-metadata', ownerId: 'caller', epoch: '1' }, signal, callback))
    .rejects.toMatchObject({ code: 'RESOURCE_UNKNOWN' })
  expect(callback).not.toHaveBeenCalled()
  expect(test.ctx.gitResources.read(test.made.resource.resourceId)?.use).toBeUndefined()
  expect(await readFile(join(path, 'file.txt'), 'utf8')).toBe('BASE\n')
})

it('checks real directory and repository identities synchronously throughout an admitted write use', async () => {
  const test = await copy(), identity = { useId: 'actual-use', ownerId: 'caller', epoch: '1' }
  await expect(test.ctx.gitResources.withWriteUse(test.made.resource.resourceId, identity, signal, async (scope) => {
    const admin = resolve(test.project, '.git'), retained = `${admin}-original`
    await rename(admin, retained); await mkdir(admin)
    try { expect(() => { scope.assertCurrent() }).toThrow(expect.objectContaining({ code: 'REPOSITORY_REPLACED' })) }
    finally { await rm(admin, { recursive: true }); await rename(retained, admin) }
    const path = scope.resource.path, retainedCopy = `${path}-original`
    await rename(path, retainedCopy); await mkdir(path)
    try { scope.assertCurrent() }
    finally { await rm(path, { recursive: true }); await rename(retainedCopy, path) }
  })).rejects.toMatchObject({ code: 'USE_CHANGED' })
  expect(test.ctx.gitResources.read(test.made.resource.resourceId)?.use).toMatchObject({ ...identity, phase: 'needs_attention' })
})

it('refuses a genuine replacement repository identity before acquiring any managed-copy use', async () => {
  const test = await copy(), gitDir = join(test.project, '.git'), retained = `${gitDir}-original`
  await rename(gitDir, retained); test.git(['init', '--quiet'])
  try {
    await expect(test.ctx.gitResources.withWriteUse(test.made.resource.resourceId,
      { useId: 'replaced-repo', ownerId: 'caller', epoch: '1' }, signal, async () => {}))
      .rejects.toMatchObject({ code: 'REPOSITORY_REPLACED' })
    expect(test.ctx.gitResources.read(test.made.resource.resourceId)?.use).toBeUndefined()
  } finally { await rm(gitDir, { recursive: true }); await rename(retained, gitDir) }
})

it('retains the kernel lease after shutdown times out until the actual admitted callback has drained', async () => {
  const test = await copy({ closeTimeoutMs: 1 }), entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  const running = test.ctx.gitResources.withWriteUse(test.made.resource.resourceId,
    { useId: 'slow-shutdown', ownerId: 'actual-caller', epoch: '1' }, signal,
    async () => { entered.resolve(undefined); await resume.promise })
  const rejected = expect(running).rejects.toMatchObject({ code: 'OWNER_CLOSED' })
  const close = Reflect.get(test.ctx.gitResources, 'close') as () => Promise<void>
  try {
    await entered.promise
    await expect(close.call(test.ctx.gitResources)).rejects.toMatchObject({ code: 'OWNER_DRAIN_TIMEOUT' })
    await expect(acquireFileLease(join(test.home, 'git-resources', 'owner.lock'))).rejects.toMatchObject({ name: 'FileLeaseBusyError' })
  } finally {
    resume.resolve(undefined); await rejected
    await close.call(test.ctx.gitResources)
  }
  const lease = await acquireFileLease(join(test.home, 'git-resources', 'owner.lock')); await lease.release()
})

it('cancels a genuinely queued use after its lane listener is installed while the original writer keeps ownership', async () => {
  const test = await copy(), entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
  const active = test.ctx.gitResources.withWriteUse(test.made.resource.resourceId,
    { useId: 'first-writer', ownerId: 'original', epoch: '1' }, signal,
    async () => { entered.resolve(undefined); await resume.promise })
  await entered.promise
  const cancellation = new AbortController(), callback = vi.fn(async () => {})
  const queued = test.ctx.gitResources.withWriteUse(test.made.resource.resourceId,
    { useId: 'second-writer', ownerId: 'next', epoch: '1' }, cancellation.signal, callback)
  const rejection = expect(queued).rejects.toThrow('queued writer cancelled')
  try {
    // owned() schedules its real lane entry in this microtask, behind the admitted writer's unresolved tail.
    await Promise.resolve()
    cancellation.abort(new Error('queued writer cancelled'))
    await rejection
    expect(callback).not.toHaveBeenCalled()
    expect(test.ctx.gitResources.read(test.made.resource.resourceId)?.use?.useId).toBe('first-writer')
  } finally { resume.resolve(undefined); await active }
  expect(test.ctx.gitResources.read(test.made.resource.resourceId)?.use).toBeUndefined()
})

it('requires readiness after direct construction and resolves omitted bounds for the explicit private home', async () => {
  const test = await harness({}, undefined, false)
  const owner = new GitResources(test.ctx, { home: test.home })
  expect(() => owner.read(GitResourceId('not-ready')))
    .toThrow(expect.objectContaining({ code: 'OWNER_CLOSED' }))
  expect(test.ctx.storageDomain.get('git_resources')).toBeUndefined()
  const initialize = Reflect.get(owner, Service.init) as () => Promise<void>
  await initialize.call(owner)
  const base = await repository(test)
  const preview = await owner.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await owner.create({ ...preview.request, consumerScope: GitConsumerScope('direct-default-config'), originalRequestJson: '{}',
    operationId: GitOperationId('direct-default-copy'), expectedPreviewFingerprint: preview.fingerprint })
  expect(made.operation.phase).toBe('confirmed')
  expect(await readFile(join(made.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
  const sealed = await owner.preserve({ operationId: GitOperationId('direct-default-preserve'), resourceId: made.resource.resourceId,
    expectedRevision: made.resource.revision, originalRequestJson: '{}' })
  expect(sealed.operation.phase).toBe('confirmed')
  expect(sealed.operation.request).toMatchObject({ content: 'versioned', originalRequestJson: '{}' })
})

it('replays an exact confirmed creation from a cold Loader before any other method initializes Git', async () => {
  const test = await copy(), request = test.made.operation.request
  if (!('workspaceId' in request && 'baseline' in request)) throw new Error('real creation must retain its original request')
  await test.ctx.fiber.dispose()
  const cold = await harness({}, test.resources)
  expect(cold.ctx.gitResources.status(test.made.operation.operationId)?.operation).toEqual(test.made.operation)
  const replay = await cold.ctx.gitResources.create(request)
  expect(replay.operation).toEqual(test.made.operation)
  expect(replay.resource).toEqual(test.made.resource)
  expect(await readFile(join(replay.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
})

it('keeps cold creation records observable with no Git and refuses replay with an explicit capability diagnosis', async () => {
  const test = await copy(), request = test.made.operation.request
  if (!('workspaceId' in request && 'baseline' in request)) throw new Error('actual original creation must retain its request')
  await test.ctx.fiber.dispose()
  const cold = await harness({ gitExecutable: join(test.root, 'not-installed-git') }, test.resources)
  expect(cold.ctx.gitResources.status(test.made.operation.operationId)?.operation).toEqual(test.made.operation)
  await expect(cold.ctx.gitResources.create(request)).rejects.toMatchObject({ code: 'GIT_UNAVAILABLE' })
  expect(cold.ctx.gitResources.status(test.made.operation.operationId)?.operation).toEqual(test.made.operation)
  expect(await readFile(join(test.made.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
})

it('retains the exact use as uncertain when the real backend rejects durable handback', async () => {
  const test = await copy(), domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('actual resource owner domain must be open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, put = unit.putRecord.bind(unit)
  const identity = { useId: 'handback-checkpoint', ownerId: 'actual-execution', epoch: '1' }
  const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'resources' in value && Array.isArray(value.resources)
      && value.resources.some((resource: unknown) => resource !== null && typeof resource === 'object'
        && 'resourceId' in resource && resource.resourceId === test.made.resource.resourceId
        && !('use' in resource) && 'useHistory' in resource && Array.isArray(resource.useHistory)
        && resource.useHistory.some((use: unknown) => use !== null && typeof use === 'object'
          && 'useId' in use && use.useId === identity.useId && 'phase' in use && use.phase === 'released'))) {
      throw new Error('handback checkpoint rejected')
    }
    return put(...args)
  })
  await expect(test.ctx.gitResources.withWriteUse(test.made.resource.resourceId, identity, signal, async () => {}))
    .rejects.toThrow('handback checkpoint rejected')
  fault.mockRestore()
  const pending = test.ctx.gitResources.read(test.made.resource.resourceId)
  if (pending === undefined) throw new Error('original admitted use must remain recorded')
  expect(pending.use).toEqual({ ...identity, phase: 'needs_attention' })
  expect(pending.useHistory.filter(use => use.useId === identity.useId).map(use => use.phase)).toEqual(['held'])
  await test.ctx.gitResources.confirmQuietUse(pending.resourceId, identity, pending.revision, () => {})
  expect(test.ctx.gitResources.read(pending.resourceId)?.use).toBeUndefined()
})

it('recovers one actually held cold use without changing a second settled resource in the same repository', async () => {
  const test = await copy(), baseline = { workspaceId: test.workspace.id, baseline: { kind: 'commit' as const, commit: test.base } }
  const preview = await test.ctx.gitResources.preview(baseline)
  const untouched = await test.ctx.gitResources.create({ ...baseline, operationId: GitOperationId('settled-neighbor'),
    consumerScope: test.made.resource.consumerScope, originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('actual domain must be open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, put = unit.putRecord.bind(unit)
  const identity = { useId: 'cold-held', ownerId: 'actual-unsettled-execution', epoch: '1' }
  const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'resources' in value && Array.isArray(value.resources)
      && value.resources.some((resource: unknown) => resource !== null && typeof resource === 'object'
        && 'use' in resource && resource.use !== null && typeof resource.use === 'object'
        && 'phase' in resource.use && resource.use.phase === 'needs_attention')) throw new Error('attention checkpoint failed')
    return put(...args)
  })
  await expect(test.ctx.gitResources.withWriteUse(test.made.resource.resourceId, identity, signal,
    async () => { throw new Error('actual unsettled callback') })).rejects.toThrow('attention checkpoint failed')
  fault.mockRestore()
  expect(test.ctx.gitResources.read(test.made.resource.resourceId)?.use?.phase).toBe('held')
  await test.ctx.fiber.dispose()
  const cold = await harness({}, test.resources)
  expect(cold.ctx.gitResources.read(test.made.resource.resourceId)?.use).toEqual({ ...identity, phase: 'needs_attention' })
  expect(cold.ctx.gitResources.read(untouched.resource.resourceId)).toEqual(untouched.resource)
})

it('keeps a package enclosing the home out of work copies and snapshots, and names the package lookups they still share', async () => {
  const test = await harness({}, undefined, false)
  await writeFile(join(test.root, 'package.json'), '{"type":"module","imports":{"#x":"./x.js"}}\n')
  await mkdir(join(test.root, 'node_modules'))
  await test.ctx.plugin(GitResources, { home: test.home })
  const root = join(await realpath(test.home), 'git-resources')
  for (const name of ['workcopies', 'snapshots']) {
    expect(JSON.parse(await readFile(join(root, name, 'package.json'), 'utf8'))).toEqual({ private: true,
      description: 'Package boundary of managed Git work copies and snapshots: no module type, imports or exports.' })
  }
  expect(test.ctx.gitResources.enclosingPackage()).toEqual({ directory: await realpath(test.root), entries: ['package.json', 'node_modules'], nodeModules: [join(await realpath(test.root), 'node_modules')] })
  // A CommonJS project without a package.json of its own runs as CommonJS in a work copy, not as the enclosing ESM package.
  const probe = join(root, 'workcopies', 'probe')
  await mkdir(probe)
  await writeFile(join(probe, 'probe.js'), "const { join } = require('node:path'); process.stdout.write(typeof join)\n")
  expect(execFileSync(process.execPath, [join(probe, 'probe.js')], { encoding: 'utf8' })).toBe('function')
  await rm(probe, { recursive: true })
})

it('reports no enclosing package for a home no package encloses, and refuses a changed package boundary', async () => {
  const plain = await harness()
  expect(plain.ctx.gitResources.enclosingPackage()).toBeUndefined()
  const test = await harness({}, undefined, false), root = join(test.home, 'git-resources')
  await mkdir(join(root, 'workcopies'), { recursive: true })
  await writeFile(join(root, 'workcopies', 'package.json'), '{"type":"module"}\n')
  await expect(test.ctx.plugin(GitResources, { home: test.home })).rejects.toMatchObject({ code: 'RESOURCE_HOME_INVALID' })
})

it.skipIf(process.platform === 'win32')('propagates a real package-boundary write denial and returns the acquired kernel lease', async () => {
  const test = await harness({}, undefined, false), root = join(test.home, 'git-resources'), workcopies = join(root, 'workcopies')
  await mkdir(workcopies, { recursive: true }); await chmod(workcopies, 0o500)
  try {
    await expect(test.ctx.plugin(GitResources, { home: test.home })).rejects.toMatchObject({ code: 'EACCES' })
    const lease = await acquireFileLease(join(root, 'owner.lock')); await lease.release()
  } finally { await chmod(workcopies, 0o700) }
})

it('propagates an enclosing package lookup that fails other than by absence', async () => {
  const test = await harness({}, undefined, false), original = fs.lstat.bind(fs)
  await mkdir(test.home, { recursive: true })
  const blocked = join(await realpath(test.home), 'package.json')
  const stat = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    if (String(args[0]) === blocked) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    return original(...args)
  })
  syncBuiltinESMExports()
  onTestFinished(() => { stat.mockRestore(); syncBuiltinESMExports() })
  await expect(test.ctx.plugin(GitResources, { home: test.home })).rejects.toMatchObject({ code: 'EACCES' })
})

it('reports higher dependency directories even when a nearer directory contains only package.json', async () => {
  const test = await harness({}, undefined, false)
  await mkdir(join(test.root, 'node_modules'))
  await writeFile(join(test.home, 'package.json'), '{"private":true}\n')
  await test.ctx.plugin(GitResources, { home: test.home })
  expect(test.ctx.gitResources.enclosingPackage()).toEqual({ directory: await realpath(test.home), entries: ['package.json'],
    nodeModules: [join(await realpath(test.root), 'node_modules')] })
})
