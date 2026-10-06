/** Physical cleanup requires pinned complete file content, known index objects and explicit unused-cwd proof. */
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { harness, repository } from './harness.ts'

const signal = new AbortController().signal
async function setup() {
  const test = await harness(), base = await repository(test), scope = GitConsumerScope('cleanup-fixture')
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await test.ctx.gitResources.create({ ...preview.request, operationId: GitOperationId('cleanup-base'),
    consumerScope: scope, originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  const preserve = async (id: string, content: 'versioned' | 'all' = 'all') => {
    const current = test.ctx.gitResources.read(made.resource.resourceId)
    if (current === undefined) throw new Error('real owned work copy must remain registered')
    return test.ctx.gitResources.preserve({ operationId: GitOperationId(id), resourceId: current.resourceId,
      expectedRevision: current.revision, content,
      originalRequestJson: JSON.stringify({ id, originalUserRevision: made.resource.revision }) })
  }
  return { ...test, base, scope, made, preserve }
}

it('cleans only an explicitly unused all-preserved copy while retaining immutable refs and history', async () => {
  const test = await setup(), path = test.made.resource.path
  await writeFile(join(path, 'file.txt'), 'working bytes not yet in the index\n')
  const all = await test.preserve('all-full'), preview = await test.ctx.gitResources.previewCleanup(all.resource.resourceId)
  const index = await readFile(join(test.project, '.git', 'index'))
  const request = { operationId: GitOperationId('cleanup-complete'), resourceId: all.resource.resourceId,
    expectedPreviewFingerprint: preview.fingerprint, originalRequestJson: '{"userAction":"remove-unused-copy"}' }
  await expect(test.ctx.gitResources.cleanup(request, signal, () => { throw new Error('this remains the current cwd') }))
    .rejects.toThrow('current cwd')
  expect((await lstat(path)).isDirectory()).toBe(true)
  expect(test.ctx.gitResources.status(request.operationId)).toBeUndefined()
  const completed = await test.ctx.gitResources.cleanup(request, signal, () => {})
  expect(completed.operation).toMatchObject({ phase: 'confirmed', cleanupObservation: { pathAbsent: true, metadataAbsent: true } })
  expect(completed.resource.state).toBe('cleaned')
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(test.git(['show', `${all.operation.effectCommit}:file.txt`])).toBe('working bytes not yet in the index')
  expect(test.ctx.gitResources.status(all.operation.operationId)?.operation).toEqual(all.operation)
  expect(await test.ctx.gitResources.cleanup(request, signal, () => {})).toEqual(completed)
  expect(test.ctx.gitResources.listOperations(test.scope)).toHaveLength(3)
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
  expect(test.git(['rev-parse', 'HEAD'])).toBe(test.base)
  await expect(test.ctx.gitResources.withWriteUse(all.resource.resourceId, { useId: 'removed', ownerId: 'caller', epoch: '2' }, signal, async () => {}))
    .rejects.toMatchObject({ code: 'RESOURCE_IN_USE' })
})

it('refuses ignored content under a versioned seal and refuses empty directories not preserved as file data', async () => {
  const test = await setup(), path = test.made.resource.path
  await writeFile(join(path, '.gitignore'), 'output/\n'); await mkdir(join(path, 'output'))
  await writeFile(join(path, 'output', 'generated.bin'), Buffer.from([0, 255]))
  const code = await test.preserve('only-code', 'versioned')
  await expect(test.ctx.gitResources.previewCleanup(code.resource.resourceId)).rejects.toMatchObject({ code: 'CLEANUP_UNPRESERVED' })
  const all = await test.preserve('all-including-output')
  expect(all.operation.unpreservedPaths).toEqual([])
  expect((await test.ctx.gitResources.previewCleanup(all.resource.resourceId)).preserveOperationId).toBe(all.operation.operationId)
  await mkdir(join(path, 'empty'))
  const empty = await test.preserve('all-empty-directory')
  expect(empty.operation.unpreservedPaths).toEqual(['empty/'])
  await expect(test.ctx.gitResources.previewCleanup(empty.resource.resourceId)).rejects.toMatchObject({ code: 'CLEANUP_UNPRESERVED' })
  expect((await lstat(join(path, 'output', 'generated.bin'))).isFile()).toBe(true)
})

it('does not claim that an all-file snapshot preserved a distinct staged version', async () => {
  const test = await setup(), path = test.made.resource.path
  await writeFile(join(path, 'file.txt'), 'staged-only version\n'); test.git(['-C', path, 'add', '--', 'file.txt'])
  await writeFile(join(path, 'file.txt'), 'different working version\n')
  const all = await test.preserve('all-does-not-archive-index')
  await expect(test.ctx.gitResources.previewCleanup(all.resource.resourceId)).rejects.toMatchObject({ code: 'CLEANUP_INDEX_UNPRESERVED' })
  expect(test.git(['-C', path, 'show', ':file.txt'])).toBe('staged-only version')
  expect(await readFile(join(path, 'file.txt'), 'utf8')).toBe('different working version\n')
})

it('refuses a replaced original path after preview instead of deleting the new directory', async () => {
  const test = await setup(), all = await test.preserve('all-before-replacement')
  const preview = await test.ctx.gitResources.previewCleanup(all.resource.resourceId), original = all.resource.path
  await rename(original, `${original}-retained`); await mkdir(original); await writeFile(join(original, 'new-owner.txt'), 'must not delete\n')
  await expect(test.ctx.gitResources.cleanup({ operationId: GitOperationId('cleanup-replaced'), resourceId: all.resource.resourceId,
    expectedPreviewFingerprint: preview.fingerprint }, signal, () => {})).rejects.toMatchObject({ code: 'RESOURCE_REPLACED' })
  expect(await readFile(join(original, 'new-owner.txt'), 'utf8')).toBe('must not delete\n')
  expect((await lstat(`${original}-retained`)).isDirectory()).toBe(true)
})

it('confirms actual removal after the command response is lost without deleting anything again', async () => {
  const test = await setup(), all = await test.preserve('all-before-lost-response')
  const preview = await test.ctx.gitResources.previewCleanup(all.resource.resourceId)
  const request = { operationId: GitOperationId('cleanup-response-lost'), resourceId: all.resource.resourceId,
    expectedPreviewFingerprint: preview.fingerprint }
  // oxlint-disable-next-line typescript/unbound-method -- The spy delegates with .call(this) to the actual captured runner instance.
  const original = ResourceGit.prototype.run
  const fault = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
    const result = await original.call(this, args, ...rest)
    if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('actual remove response lost')
    return result
  })
  await expect(test.ctx.gitResources.cleanup(request, signal, () => {})).rejects.toThrow('response lost')
  fault.mockRestore()
  await expect(lstat(all.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const calls = vi.spyOn(ResourceGit.prototype, 'run'); calls.mockClear()
  const recovered = await test.ctx.gitResources.reconcile(request.operationId)
  expect(recovered.operation).toMatchObject({ phase: 'confirmed', cleanupObservation: { pathAbsent: true, metadataAbsent: true } })
  expect(calls.mock.calls.some(([args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(false)
  expect(test.git(['show', `${all.operation.effectCommit}:file.txt`])).toBe('BASE')
  calls.mockRestore()
})

it('retains exact immutable code sources after cleanup but refuses the removed copy as a writable base', async () => {
  const test = await setup(), path = test.made.resource.path
  await writeFile(join(path, 'file.txt'), 'sealed historical code\n')
  const code = await test.preserve('historical-code', 'versioned'), all = await test.preserve('all-for-removal')
  const cut = await test.ctx.gitResources.previewCleanup(all.resource.resourceId)
  await test.ctx.gitResources.cleanup({ operationId: GitOperationId('remove-historical-copy'), resourceId: all.resource.resourceId,
    expectedPreviewFingerprint: cut.fingerprint }, signal, () => {})
  const request = { workspaceId: test.workspace.id, baseline: { kind: 'commit' as const, commit: test.base } }
  const fresh = await test.ctx.gitResources.preview(request)
  const base = await test.ctx.gitResources.create({ ...request, operationId: GitOperationId('new-explicit-base'),
    consumerScope: test.scope, originalRequestJson: '{}', expectedPreviewFingerprint: fresh.fingerprint })
  const selection = { consumerScope: test.scope, baseResourceId: base.resource.resourceId,
    sourcePreserveOperationIds: [code.operation.operationId] }
  const preview = await test.ctx.gitResources.previewIntegration(selection)
  expect(preview.sources[0]).toMatchObject({ operationId: code.operation.operationId, tree: code.operation.effectTree })
  expect(test.git(['show', `${preview.sources[0]?.commit}:file.txt`])).toBe('sealed historical code')
  await expect(test.ctx.gitResources.previewIntegration({ ...selection, baseResourceId: all.resource.resourceId }))
    .rejects.toMatchObject({ code: 'INTEGRATION_BASE_UNAVAILABLE' })
  const joined = await test.ctx.gitResources.integrate({ ...selection, operationId: GitOperationId('new-from-historical-code'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  expect(joined.operation.integrationEffect?.result).toBe('prepared')
  expect(await readFile(join(joined.resource.path, 'file.txt'), 'utf8')).toBe('sealed historical code\n')
})
