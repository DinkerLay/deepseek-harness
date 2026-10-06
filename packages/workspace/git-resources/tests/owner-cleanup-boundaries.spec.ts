/** Exact cleanup cuts reject physical races and cold durable faults without adopting or deleting unrelated identities. */
import { lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { coldCorruptOperation } from './owner-corruption-harness.ts'
import { harness, repository } from './harness.ts'

const signal = new AbortController().signal

async function fixture() {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await test.ctx.gitResources.create({ ...preview.request, consumerScope: GitConsumerScope('cleanup-boundaries'),
    operationId: GitOperationId('boundary-copy'), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  const all = await test.ctx.gitResources.preserve({ operationId: GitOperationId('boundary-all-files'),
    resourceId: made.resource.resourceId, expectedRevision: made.resource.revision, content: 'all' })
  const cut = await test.ctx.gitResources.previewCleanup(all.resource.resourceId)
  const request = { operationId: GitOperationId('boundary-cleanup'), resourceId: all.resource.resourceId,
    expectedPreviewFingerprint: cut.fingerprint, originalRequestJson: '{"request":"original-cleanup"}' }
  return { ...test, made, all, cut, request }
}

async function unstarted() {
  const test = await fixture()
  await expect(test.ctx.gitResources.cleanup(test.request, signal, () => {
    if (test.ctx.gitResources.status(test.request.operationId) !== undefined) throw new Error('original caller stopped before deletion')
  })).rejects.toThrow('caller stopped')
  expect(test.ctx.gitResources.status(test.request.operationId)?.operation.externalWriteStarted).toBe(false)
  return test
}

function observe() {
  const original: ResourceGit['run'] = Reflect.get(ResourceGit.prototype, 'run')
  const calls = vi.spyOn(ResourceGit.prototype, 'run')
  onTestFinished(() => { calls.mockRestore() })
  return { original, calls }
}

function noDelete(calls: ReturnType<typeof observe>['calls']) {
  expect(calls.mock.calls.filter(([args]) => args[0] === 'worktree' && args[1] === 'remove')).toEqual([])
}

it.each(['missing-cut', 'wrong-kind'] as const)('refuses cold cleanup %s corruption and retains the original legal record', async (fault) => {
  const test = await unstarted()
  const cold = await coldCorruptOperation(test, test.request.operationId, (operation) => {
    if (fault === 'wrong-kind') return { ...operation, kind: 'preserve' }
    const { cleanupPreview: _missing, ...rest } = operation
    return rest
  })
  const { calls } = observe()
  await expect(cold.ctx.gitResources.cleanup(test.request, signal, () => {})).rejects.toMatchObject({ code: 'RECORD_INVALID' })
  if (fault === 'missing-cut') {
    const observed = await cold.ctx.gitResources.reconcile(test.request.operationId)
    expect(observed.operation).toMatchObject({ phase: 'needs_attention', diagnostic: 'Original cleanup has no exact path/admin identities' })
  }
  expect(cold.ctx.gitResources.status(test.request.operationId)?.operation.request).toEqual(test.request)
  expect(JSON.parse(await readFile(cold.backup, 'utf8'))).toEqual(cold.original)
  expect(await readFile(join(test.all.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
  noDelete(calls)
})

it('retries only the receipt after a real complete removal lost its response', async () => {
  const test = await fixture(), first = observe()
  first.calls.mockImplementation(async function (this: ResourceGit, ...args) {
    const result = await first.original.call(this, ...args)
    if (args[0][0] === 'worktree' && args[0][1] === 'remove') throw new Error('actual removal response lost')
    return result
  })
  await expect(test.ctx.gitResources.cleanup(test.request, signal, () => {})).rejects.toThrow('response lost')
  first.calls.mockRestore()
  await expect(lstat(test.all.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const { calls } = observe(), recovered = await test.ctx.gitResources.cleanup(test.request, signal, () => {})
  expect(recovered.operation).toMatchObject({ phase: 'confirmed', cleanupObservation: { pathAbsent: true, metadataAbsent: true } })
  noDelete(calls)
  expect(test.git(['show', `${test.all.operation.effectCommit}:file.txt`])).toBe('BASE')
})

it('does not adopt a later legitimate preservation when retrying an original unstarted cleanup', async () => {
  const test = await unstarted(), current = test.ctx.gitResources.read(test.all.resource.resourceId)
  if (current === undefined) throw new Error('original owned copy must remain')
  await test.ctx.gitResources.preserve({ operationId: GitOperationId('later-actual-preservation'),
    resourceId: current.resourceId, expectedRevision: current.revision, content: 'all' })
  const { calls } = observe()
  await expect(test.ctx.gitResources.cleanup(test.request, signal, () => {})).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' })
  expect(test.ctx.gitResources.status(test.request.operationId)?.operation.request).toEqual(test.request)
  expect(await readFile(join(test.all.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
  noDelete(calls)
})

it('refuses acknowledgement when actual Git removed metadata but the original directory inode was restored by an external actor', async () => {
  const test = await fixture(), retained = `${test.all.resource.path}-temporarily-retained`, observed = observe()
  observed.calls.mockImplementation(async function (this: ResourceGit, ...args) {
    if (args[0][0] !== 'worktree' || args[0][1] !== 'remove') return observed.original.call(this, ...args)
    // Git performs its real metadata removal against an absent directory; the same original inode returns before observation.
    await rename(test.all.resource.path, retained)
    try { return await observed.original.call(this, ...args) }
    finally { await rename(retained, test.all.resource.path) }
  })
  await expect(test.ctx.gitResources.cleanup(test.request, signal, () => {})).rejects.toMatchObject({ code: 'CLEANUP_EFFECT_UNCERTAIN' })
  expect(test.ctx.gitResources.status(test.request.operationId)?.operation.phase).toBe('needs_attention')
  expect((await lstat(test.all.resource.path)).isDirectory()).toBe(true)
  await expect(lstat(test.cut.gitDirIdentity.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(test.all.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
})

it.each(['captured-file', 'final-index'] as const)('rejects an actual %s race during the complete readonly cleanup preview', async (fault) => {
  const test = await fixture(), observed = observe()
  let stages = 0, changed = false
  observed.calls.mockImplementation(async function (this: ResourceGit, ...args) {
    const result = await observed.original.call(this, ...args)
    if (args[1] === test.all.resource.path && args[0][0] === 'ls-files' && args[0].includes('--stage') && ++stages === 2) {
      changed = true
      if (fault === 'captured-file') await writeFile(join(test.all.resource.path, 'file.txt'), 'LATER USER BYTES\n')
      else {
        await writeFile(join(test.all.resource.path, 'later-user-stage.txt'), 'LATER USER INDEX\n')
        test.git(['-C', test.all.resource.path, 'add', '--', 'later-user-stage.txt'])
      }
    }
    return result
  })
  await expect(test.ctx.gitResources.previewCleanup(test.all.resource.resourceId)).rejects.toMatchObject({ code: 'CLEANUP_UNPRESERVED' })
  expect(changed).toBe(true)
  noDelete(observed.calls)
  expect((await lstat(test.all.resource.path)).isDirectory()).toBe(true)
})

it('does not reconcile deletion while a later real write use remains uncertain', async () => {
  const test = await unstarted()
  await expect(test.ctx.gitResources.withWriteUse(test.all.resource.resourceId,
    { useId: 'actual-uncertain-use', ownerId: 'actual-owner', epoch: '1' }, signal,
    async () => { throw new Error('real source did not confirm handback') })).rejects.toThrow('handback')
  const { calls } = observe(), observed = await test.ctx.gitResources.reconcile(test.request.operationId)
  expect(observed.operation).toMatchObject({ phase: 'needs_attention', diagnostic: 'Cleanup cannot settle current or uncertain use' })
  expect(await readFile(join(test.all.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
  noDelete(calls)
})

it.each(['replacement', 'link'] as const)('does not observe an unrelated %s as the original cleanup directory', async (fault) => {
  const test = await unstarted(), retained = `${test.all.resource.path}-original`
  await rename(test.all.resource.path, retained)
  if (fault === 'link') await symlink(retained, test.all.resource.path, process.platform === 'win32' ? 'junction' : 'dir')
  else { await mkdir(test.all.resource.path); await writeFile(join(test.all.resource.path, 'sentinel.txt'), 'UNKNOWN OWNER\n') }
  const { calls } = observe(), observed = await test.ctx.gitResources.reconcile(test.request.operationId)
  expect(observed.operation.phase).toBe('needs_attention')
  expect(observed.operation.diagnostic).toMatch(fault === 'link' ? /Symbolic-link/ : /identity was replaced/)
  expect(await readFile(join(retained, 'file.txt'), 'utf8')).toBe('BASE\n')
  noDelete(calls)
})

it('refuses an absent recorded admin identity when different actual metadata still names the original worktree', async () => {
  const test = await unstarted(), moved = `${test.cut.gitDirIdentity.path}-relocated`
  await rename(test.cut.gitDirIdentity.path, moved)
  await writeFile(join(test.all.resource.path, '.git'), `gitdir: ${moved}\n`)
  expect(test.git(['worktree', 'list', '--porcelain', '-z']).split('\0')).toContain(`worktree ${test.all.resource.path}`)
  const { calls } = observe(), observed = await test.ctx.gitResources.reconcile(test.request.operationId)
  expect(observed.operation).toMatchObject({ phase: 'needs_attention',
    diagnostic: 'Different administrative metadata still names the original path' })
  expect((await lstat(moved)).isDirectory()).toBe(true)
  expect(await readFile(join(test.all.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
  noDelete(calls)
})
