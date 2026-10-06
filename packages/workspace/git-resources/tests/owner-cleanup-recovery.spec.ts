/** Cleanup recovery observes the original exact deletion intent and never retries an uncertain physical removal. */
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { harness, repository } from './harness.ts'

const signal = new AbortController().signal
async function cleanupFixture() {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await test.ctx.gitResources.create({ ...preview.request, consumerScope: GitConsumerScope('cleanup-recovery'),
    originalRequestJson: '{}', operationId: GitOperationId('cleanup-source'), expectedPreviewFingerprint: preview.fingerprint })
  const preserved = await test.ctx.gitResources.preserve({ operationId: GitOperationId('all-before-cleanup'),
    resourceId: made.resource.resourceId, expectedRevision: made.resource.revision, content: 'all' })
  const cut = await test.ctx.gitResources.previewCleanup(preserved.resource.resourceId)
  const request = { operationId: GitOperationId('cleanup-original'), resourceId: preserved.resource.resourceId,
    expectedPreviewFingerprint: cut.fingerprint }
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('real cleanup domain must be open')
  return { ...test, preserved, cut, request, unit: Reflect.get(domain, 'unit') as KvUnit }
}

it('does not repeat an originally dispatched removal with unknown response while both original identities remain', async () => {
  const test = await cleanupFixture()
  // oxlint-disable-next-line typescript/unbound-method -- The fault delegates every non-removal call on the actual runner.
  const original = ResourceGit.prototype.run
  const fault = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
    if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('transport lost before removal response')
    return original.call(this, args, ...rest)
  })
  await expect(test.ctx.gitResources.cleanup(test.request, signal, () => {})).rejects.toThrow('transport lost')
  fault.mockRestore()
  const before = test.ctx.gitResources.status(test.request.operationId)
  if (before === undefined) throw new Error('the actual dispatched deletion intent must remain recorded')
  expect(before.operation.externalWriteStarted).toBe(true)
  const calls = vi.spyOn(ResourceGit.prototype, 'run'); calls.mockClear()
  const observed = await test.ctx.gitResources.reconcile(test.request.operationId)
  expect(observed.operation).toMatchObject({ phase: 'needs_attention', cleanupObservation: { pathAbsent: false, metadataAbsent: false } })
  await expect(test.ctx.gitResources.cleanup(test.request, signal, () => {})).rejects.toMatchObject({ code: 'CLEANUP_EFFECT_UNCERTAIN' })
  expect(calls.mock.calls.some(([args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false)
  await expect(test.ctx.gitResources.abandonOperation(test.request.operationId, before.operation.fingerprint, 'not an absent effect'))
    .rejects.toMatchObject({ code: 'OPERATION_EFFECT_UNKNOWN' })
  expect((await lstat(test.preserved.resource.path)).isDirectory()).toBe(true)
  expect(await readFile(join(test.preserved.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
  calls.mockRestore()
})

it('can abandon an original cleanup intent before any delete began while preserving the entire owned copy and refs', async () => {
  const test = await cleanupFixture(), cancellation = new AbortController(), original = test.unit.putRecord.bind(test.unit)
  const barrier = vi.spyOn(test.unit, 'putRecord').mockImplementation(async (...args) => {
    await original(...args)
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === test.request.operationId
        && 'phase' in operation && operation.phase === 'intended')) cancellation.abort(new Error('freeze before actual deletion'))
  })
  await expect(test.ctx.gitResources.cleanup(test.request, cancellation.signal, () => {})).rejects.toThrow('freeze before actual deletion')
  barrier.mockRestore()
  const before = test.ctx.gitResources.status(test.request.operationId)
  if (before === undefined) throw new Error('the original no-effect cleanup must be durable')
  expect(before.operation).toMatchObject({ phase: 'needs_attention', externalWriteStarted: false })
  const refs = test.git(['show-ref'])
  const stopped = await test.ctx.gitResources.abandonOperation(test.request.operationId, before.operation.fingerprint, 'explicit stop before deletion')
  expect(stopped.operation.phase).toBe('abandoned')
  expect(await test.ctx.gitResources.abandonOperation(test.request.operationId, before.operation.fingerprint, 'same terminal stop'))
    .toEqual(stopped)
  expect((await lstat(test.preserved.resource.path)).isDirectory()).toBe(true)
  expect(test.git(['show-ref'])).toBe(refs)
  expect(await test.ctx.gitResources.cleanup(test.request, signal, () => {})).toEqual(stopped)
})

it('refuses new cleanup requests with stale previews or reused identities and observes confirmed removal without changing it', async () => {
  const test = await cleanupFixture()
  await expect(test.ctx.gitResources.cleanup({ ...test.request, expectedPreviewFingerprint: 'not-the-original-cut' }, signal, () => {}))
    .rejects.toMatchObject({ code: 'PREVIEW_CHANGED' })
  expect(test.ctx.gitResources.status(test.request.operationId)).toBeUndefined()
  const completed = await test.ctx.gitResources.cleanup(test.request, signal, () => {})
  await expect(test.ctx.gitResources.cleanup({ ...test.request, originalRequestJson: '{"differentRequest":true}' }, signal, () => {}))
    .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  expect(await test.ctx.gitResources.reconcile(test.request.operationId)).toEqual(completed)
})

it('rejects a changed all-preserved file rather than deleting it based on an old ref or preview', async () => {
  const test = await cleanupFixture(), path = join(test.preserved.resource.path, 'file.txt')
  await writeFile(path, 'later unpreserved bytes\n')
  await expect(test.ctx.gitResources.previewCleanup(test.preserved.resource.resourceId)).rejects.toMatchObject({ code: 'CLEANUP_UNPRESERVED' })
  expect(await readFile(path, 'utf8')).toBe('later unpreserved bytes\n')
})

it('refuses cleanup while a real use is held and after the original directory has already been cleaned', async () => {
  const test = await cleanupFixture()
  await test.ctx.gitResources.withWriteUse(test.preserved.resource.resourceId,
    { useId: 'cleanup-use', ownerId: 'actual-caller', epoch: '1' }, signal, async () => {
      await expect(test.ctx.gitResources.previewCleanup(test.preserved.resource.resourceId))
        .rejects.toMatchObject({ code: 'RESOURCE_IN_USE' })
    })
  const fresh = await test.ctx.gitResources.previewCleanup(test.preserved.resource.resourceId)
  await test.ctx.gitResources.cleanup({ ...test.request, expectedPreviewFingerprint: fresh.fingerprint }, signal, () => {})
  await expect(test.ctx.gitResources.previewCleanup(test.preserved.resource.resourceId)).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' })
})

it.each(['head', 'preservation-ref', 'empty-directory'])
('refuses actual %s movement after complete preservation while retaining the directory', async (kind) => {
  const test = await cleanupFixture(), path = test.preserved.resource.path
  if (kind === 'head') test.git(['-C', path, 'commit', '--allow-empty', '--quiet', '-m', 'actual later detached HEAD'])
  else if (kind === 'preservation-ref') {
    if (test.preserved.operation.effectRef === undefined) throw new Error('real preservation must have its private ref')
    test.git(['commit', '--allow-empty', '--quiet', '-m', 'another actual parented commit'])
    test.git(['update-ref', test.preserved.operation.effectRef, test.git(['rev-parse', 'HEAD'])])
  } else { await mkdir(join(path, 'later-empty-directory')) }
  await expect(test.ctx.gitResources.previewCleanup(test.preserved.resource.resourceId)).rejects.toMatchObject({ code: 'CLEANUP_UNPRESERVED' })
  expect((await lstat(path)).isDirectory()).toBe(true)
})
