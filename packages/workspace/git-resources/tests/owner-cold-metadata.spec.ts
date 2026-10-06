/** Explicit durable-byte corruption is refused on cold execution; these records are not legal writer crash products. */
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import type { GitResourceOperation } from '../src/types.ts'
import { ResourceGit } from '../src/git.ts'
import { repositorySchema } from '../src/records.ts'
import { harness, repository } from './harness.ts'

async function missingCreationMetadata(field: 'preview' | 'repository' | 'baseCommit' | 'baseTree') {
  const test = await harness(), base = await repository(test), cancellation = new AbortController()
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const request = { ...preview.request, consumerScope: GitConsumerScope('cold-metadata'), originalRequestJson: '{}',
    operationId: GitOperationId('legal-before-corruption'), expectedPreviewFingerprint: preview.fingerprint }
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('actual owner domain must be open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, put = unit.putRecord.bind(unit)
  const barrier = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    await put(...args)
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === request.operationId
        && 'phase' in operation && operation.phase === 'intended')) cancellation.abort(new Error('stop before external creation'))
  })
  await expect(test.ctx.gitResources.create(request, cancellation.signal)).rejects.toThrow('stop before external creation')
  barrier.mockRestore()
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('legal original intent must be queryable')
  const original = repositorySchema.parse(domain.table('repositories').get(pending.resource.repositoryId))
  await writeFile(join(test.root, `original-${field}.json`), JSON.stringify(original))
  const corrupted = structuredClone(original), operation = corrupted.operations.find(value => value.operationId === request.operationId)
  if (operation?.preview === undefined) throw new Error('legal original writer must have captured a complete preview')
  let damaged: GitResourceOperation
  if (field === 'preview') { const { preview: _missingPreview, ...rest } = operation; damaged = rest }
  else if (field === 'repository') {
    const { repository: _missingRepository, ...rest } = operation.preview; damaged = { ...operation, preview: rest }
  } else if (field === 'baseCommit') {
    const { baseCommit: _missingCommit, ...rest } = operation.preview; damaged = { ...operation, preview: rest }
  } else {
    const { baseTree: _missingTree, ...rest } = operation.preview; damaged = { ...operation, preview: rest }
  }
  // Fault injection at the durable input boundary only; the live Domain cache stays the legitimate original cut.
  await unit.putRecord('repositories', pending.resource.repositoryId,
    { ...corrupted, operations: corrupted.operations.map(value => value.operationId === request.operationId ? damaged : value) })
  await test.ctx.fiber.dispose()
  const cold = await harness({}, test.resources)
  return { ...cold, request, pending, original }
}

it.each(['preview', 'repository', 'baseCommit', 'baseTree'] as const)
('refuses damaged persisted creation %s metadata without replay, unknown-path adoption or loss of the original request', async (field) => {
  const test = await missingCreationMetadata(field), calls = vi.spyOn(ResourceGit.prototype, 'run')
  calls.mockClear()
  await expect(test.ctx.gitResources.create(test.request)).rejects.toMatchObject({ code: 'RECORD_INVALID' })
  expect(calls).not.toHaveBeenCalled()
  await expect(lstat(test.pending.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const observed = test.ctx.gitResources.status(test.request.operationId)
  expect(observed?.operation.request).toEqual(test.request)
  expect(observed?.operation.fingerprint).toBe(test.pending.operation.fingerprint)
  expect(observed?.operation.effectCommit).toBeUndefined()
  expect(JSON.parse(await readFile(join(test.root, `original-${field}.json`), 'utf8'))).toEqual(test.original)
  calls.mockRestore()
})

it.each(['baseline-cut', 'selected-object'] as const)
('does not confirm a real pre-checkpoint private ref when cold persisted %s metadata was explicitly damaged', async (kind) => {
  const test = await harness(), base = await repository(test)
  await writeFile(join(test.project, 'file.txt'), 'chosen staged content\n'); test.git(['add', '--', 'file.txt'])
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'selected', baseCommit: base,
    paths: [{ path: 'file.txt', source: 'index' }] } })
  const request = { ...preview.request, consumerScope: GitConsumerScope('cold-ref-metadata'), originalRequestJson: '{}',
    operationId: GitOperationId('legal-ref-before-corruption'), expectedPreviewFingerprint: preview.fingerprint }
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('actual owner domain must be open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, put = unit.putRecord.bind(unit)
  const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === request.operationId
        && 'effectCommit' in operation && operation.effectCommit !== undefined)) throw new Error('effect checkpoint failed')
    return put(...args)
  })
  await expect(test.ctx.gitResources.create(request)).rejects.toThrow('effect checkpoint failed')
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('actual ref-written intent must survive')
  const original = repositorySchema.parse(domain.table('repositories').get(pending.resource.repositoryId))
  await writeFile(join(test.root, `original-ref-${kind}.json`), JSON.stringify(original))
  const corrupted = { ...original, operations: original.operations.map((operation) => {
    if (operation.operationId !== request.operationId) return operation
    if (operation.preview === undefined) throw new Error('actual legal original cut must have its complete metadata')
    if (kind === 'baseline-cut') {
      const { baseCommit: _missingBase, ...rest } = operation.preview; return { ...operation, preview: rest }
    }
    return { ...operation, preview: { ...operation.preview, selected: operation.preview.selected.map((entry) => {
      const { objectId: _missingObject, ...rest } = entry; return rest
    }) } }
  }) }
  // Deliberate backend-byte fault, not a normal interrupted writer product or a change to its live cache.
  await unit.putRecord('repositories', pending.resource.repositoryId, corrupted)
  const commit = test.git(['rev-parse', pending.resource.privateRef])
  await test.ctx.fiber.dispose()
  const cold = await harness({}, test.resources), calls = vi.spyOn(ResourceGit.prototype, 'run'); calls.mockClear()
  const observed = await cold.ctx.gitResources.reconcile(request.operationId)
  expect(observed.operation.phase).toBe('needs_attention')
  expect(observed.operation.diagnostic).toContain(kind === 'baseline-cut' ? 'immutable baseline cut' : 'immutable object identity')
  expect(calls.mock.calls.some(([args]) => ['hash-object', 'read-tree', 'write-tree', 'commit-tree', 'update-ref'].includes(args[0] ?? '')))
    .toBe(false)
  expect(test.git(['rev-parse', pending.resource.privateRef])).toBe(commit)
  await expect(lstat(pending.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
  calls.mockRestore()
})
