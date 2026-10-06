/** Content preservation checks live files, actual HEAD and durable original effects rather than inferred summaries. */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { hash } from '../src/records.ts'
import { harness, repository } from './harness.ts'
import { coldCorruptOperation } from './owner-corruption-harness.ts'

async function contentFixture(config: Config = {}) {
  const test = await harness(config), base = await repository(test)
  await writeFile(join(test.project, '.git', 'info', 'exclude'), '')
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await test.ctx.gitResources.create({ ...preview.request, consumerScope: GitConsumerScope('owner-content'),
    originalRequestJson: '{}', operationId: GitOperationId('content-copy'), expectedPreviewFingerprint: preview.fingerprint })
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('real content fixture domain must be open')
  return { ...test, base, made, unit: Reflect.get(domain, 'unit') as KvUnit }
}

it('rejects stale revisions and current write-use preservation without creating any operation', async () => {
  const test = await contentFixture(), resourceId = test.made.resource.resourceId
  await expect(test.ctx.gitResources.preserve({ operationId: GitOperationId('stale-content'), resourceId,
    expectedRevision: test.made.resource.revision - 1 })).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' })
  await test.ctx.gitResources.withWriteUse(resourceId, { useId: 'held-content', ownerId: 'caller', epoch: '1' },
    new AbortController().signal, async () => {
      await expect(test.ctx.gitResources.preserve({ operationId: GitOperationId('held-content'), resourceId,
        expectedRevision: test.made.resource.revision })).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' })
    })
  expect(test.ctx.gitResources.status(GitOperationId('stale-content'))).toBeUndefined()
  expect(test.ctx.gitResources.status(GitOperationId('held-content'))).toBeUndefined()
})

it('applies configured total-byte bounds to both inspection and preservation of actual changed files', async () => {
  const test = await contentFixture({ maxTotalBytes: 40 }), path = test.made.resource.path
  await writeFile(join(path, 'file.txt'), 'a'.repeat(30)); await writeFile(join(path, 'removed.txt'), 'b'.repeat(30))
  await expect(test.ctx.gitResources.inspectWorkCopy(test.made.resource.resourceId)).rejects.toMatchObject({ code: 'FILE_LIMIT' })
  await expect(test.ctx.gitResources.preserve({ operationId: GitOperationId('total-overflow'), resourceId: test.made.resource.resourceId,
    expectedRevision: test.made.resource.revision })).rejects.toMatchObject({ code: 'FILE_LIMIT' })
  expect(test.ctx.gitResources.status(GitOperationId('total-overflow'))?.operation.phase).toBe('needs_attention')
  expect(test.ctx.gitResources.read(test.made.resource.resourceId)?.preservedRef).toBeUndefined()
})

it.each(['inventory', 'head'])('refuses actual %s movement during the preservation passes', async (kind) => {
  const test = await contentFixture(), path = test.made.resource.path
  // oxlint-disable-next-line typescript/unbound-method -- Every Git command delegates to the same actual runner.
  const original = ResourceGit.prototype.run
  let first = true
  const barrier = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
    const result = await original.call(this, args, ...rest)
    if (first && args[0] === (kind === 'head' ? 'write-tree' : 'hash-object')) {
      first = false
      await writeFile(join(path, 'later.txt'), 'real intervening bytes\n')
      if (kind === 'head') {
        test.git(['-C', path, 'add', '--', 'later.txt'])
        test.git(['-C', path, 'commit', '--quiet', '-m', 'actual concurrent detached commit'])
      }
    }
    return result
  })
  try {
    await expect(test.ctx.gitResources.preserve({ operationId: GitOperationId(`changed-${kind}`),
      resourceId: test.made.resource.resourceId, expectedRevision: test.made.resource.revision }))
      .rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
    expect(test.ctx.gitResources.read(test.made.resource.resourceId)?.preservedCommit).toBeUndefined()
    expect(await readFile(join(path, 'later.txt'), 'utf8')).toBe('real intervening bytes\n')
  } finally { barrier.mockRestore() }
})

it('does not overwrite a pre-existing unknown preservation reference or claim it during reconcile', async () => {
  const test = await contentFixture(), operationId = GitOperationId('unknown-seal-ref')
  const ref = `refs/dsh-resources/${test.made.resource.resourceId}/preserved/${hash(operationId)}`
  test.git(['update-ref', ref, test.base])
  await expect(test.ctx.gitResources.preserve({ operationId, resourceId: test.made.resource.resourceId,
    expectedRevision: test.made.resource.revision })).rejects.toMatchObject({ code: 'PRESERVATION_UNKNOWN' })
  const observed = await test.ctx.gitResources.reconcile(operationId)
  expect(observed.operation.phase).toBe('needs_attention')
  expect(observed.operation.effectCommit).toBeUndefined()
  expect(test.git(['rev-parse', ref])).toBe(test.base)
})

it('refuses a private preservation ref changed after its immutable effect checkpoint without replacing it', async () => {
  const test = await contentFixture(), operationId = GitOperationId('late-ref-conflict')
  const ref = `refs/dsh-resources/${test.made.resource.resourceId}/preserved/${hash(operationId)}`
  const original = Reflect.get(ResourceGit.prototype, 'run')
  const invokeOriginal = (receiver: ResourceGit, ...args: Parameters<ResourceGit['run']>) => original.call(receiver, ...args)
  let refReads = 0
  const barrier = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
    if (args[0] === 'rev-parse' && args[2] === ref && ++refReads === 2) test.git(['update-ref', ref, test.base])
    return invokeOriginal(this, args, ...rest)
  })
  try {
    await expect(test.ctx.gitResources.preserve({ operationId, resourceId: test.made.resource.resourceId,
      expectedRevision: test.made.resource.revision })).rejects.toMatchObject({ code: 'PRIVATE_REF_CONFLICT' })
    const pending = test.ctx.gitResources.status(operationId)
    expect(pending?.operation.effectCommit).toBeDefined()
    expect(pending?.operation.effectCommit).not.toBe(test.base)
    expect(test.git(['rev-parse', ref])).toBe(test.base)
    expect((await test.ctx.gitResources.reconcile(operationId)).operation.phase).toBe('needs_attention')
  } finally { barrier.mockRestore() }
})

it('rejects a new actual index and file inventory after immutable byte reads in a pure observation', async () => {
  const test = await contentFixture(), path = test.made.resource.path
  const original = Reflect.get(ResourceGit.prototype, 'run')
  const invokeOriginal = (receiver: ResourceGit, ...args: Parameters<ResourceGit['run']>) => original.call(receiver, ...args)
  let first = true
  const barrier = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
    const result = await invokeOriginal(this, args, ...rest)
    if (first && args[0] === 'hash-object' && !args.includes('-w')) {
      first = false; await writeFile(join(path, 'late-index.txt'), 'actual late indexed content\n')
      test.git(['-C', path, 'add', '--', 'late-index.txt'])
    }
    return result
  })
  const before = test.ctx.gitResources.read(test.made.resource.resourceId)
  try {
    await expect(test.ctx.gitResources.inspectWorkCopy(test.made.resource.resourceId)).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
    expect(test.ctx.gitResources.read(test.made.resource.resourceId)).toEqual(before)
    expect(test.git(['-C', path, 'show', ':late-index.txt'])).toBe('actual late indexed content')
  } finally { barrier.mockRestore() }
})

it('confirms an immutable recorded preservation after its final checkpoint failed and repeats no Git write', async () => {
  const test = await contentFixture(), original = test.unit.putRecord.bind(test.unit), operationId = GitOperationId('seal-final-checkpoint')
  const fault = vi.spyOn(test.unit, 'putRecord').mockImplementation(async (...args) => {
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === operationId
        && 'phase' in operation && operation.phase === 'confirmed')) throw new Error('seal final checkpoint failed')
    return original(...args)
  })
  await expect(test.ctx.gitResources.preserve({ operationId, resourceId: test.made.resource.resourceId,
    expectedRevision: test.made.resource.revision })).rejects.toThrow('seal final checkpoint failed')
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(operationId)
  if (pending?.operation.effectCommit === undefined) throw new Error('actual immutable effect must have its durable pre-ref receipt')
  const run = vi.spyOn(ResourceGit.prototype, 'run'); run.mockClear()
  const observed = await test.ctx.gitResources.reconcile(operationId)
  expect(observed.operation).toMatchObject({ phase: 'confirmed', effectCommit: pending.operation.effectCommit,
    effectContent: 'versioned', effectConflictStages: [], unpreservedPaths: [] })
  expect(observed.resource).toMatchObject({ state: 'preserved', preservedContent: 'versioned',
    preservedHead: test.base, preservedConflictStages: [], unpreservedPaths: [] })
  expect(run.mock.calls.some(([args]) => ['hash-object', 'read-tree', 'write-tree', 'commit-tree', 'update-ref'].includes(args[0] ?? '')))
    .toBe(false)
  run.mockRestore()
})

it('observes an aborted preservation intent without Git writes and completes only an explicit original-id retry', async () => {
  const test = await contentFixture(), cancellation = new AbortController(), operationId = GitOperationId('aborted-preserve-intent')
  const request = { operationId, resourceId: test.made.resource.resourceId, expectedRevision: test.made.resource.revision }
  const put = test.unit.putRecord.bind(test.unit)
  const fault = vi.spyOn(test.unit, 'putRecord').mockImplementation(async (...args) => {
    await put(...args)
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === operationId
        && 'phase' in operation && operation.phase === 'intended')) cancellation.abort(new Error('caller froze before preservation began'))
  })
  await expect(test.ctx.gitResources.preserve(request, cancellation.signal)).rejects.toThrow('caller froze')
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(operationId)
  if (pending === undefined) throw new Error('the legitimate original preservation intent must survive')
  const calls = vi.spyOn(ResourceGit.prototype, 'run'); calls.mockClear()
  const observed = await test.ctx.gitResources.reconcile(operationId)
  expect(observed.operation.phase).toBe('needs_attention')
  expect(observed.operation.effectCommit).toBeUndefined()
  expect(calls.mock.calls.some(([args]) => ['hash-object', 'read-tree', 'write-tree', 'commit-tree', 'update-ref'].includes(args[0] ?? '')))
    .toBe(false)
  await expect(test.ctx.gitResources.abandonOperation(operationId, pending.operation.fingerprint, 'not a supported no-effect abandonment'))
    .rejects.toMatchObject({ code: 'OPERATION_EFFECT_UNKNOWN' })
  calls.mockRestore()
  const completed = await test.ctx.gitResources.preserve(request)
  expect(completed.operation.phase).toBe('confirmed')
  expect(completed.operation.operationId).toBe(operationId)
  expect(test.ctx.gitResources.listOperations(GitConsumerScope('owner-content')).filter(view => view.operation.operationId === operationId))
    .toHaveLength(1)
  expect(test.git(['show', `${completed.operation.effectCommit}:file.txt`])).toBe('BASE')
})

it('retains immutable tree evidence after optional persisted seal metadata was explicitly damaged without inventing a content mode', async () => {
  const test = await contentFixture(), operationId = GitOperationId('damaged-optional-seal'), put = test.unit.putRecord.bind(test.unit)
  const fault = vi.spyOn(test.unit, 'putRecord').mockImplementation(async (...args) => {
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === operationId
        && 'phase' in operation && operation.phase === 'confirmed')) throw new Error('final seal checkpoint failed')
    return put(...args)
  })
  await expect(test.ctx.gitResources.preserve({ operationId, resourceId: test.made.resource.resourceId,
    expectedRevision: test.made.resource.revision })).rejects.toThrow('final seal checkpoint failed')
  fault.mockRestore()
  const cold = await coldCorruptOperation(test, operationId, (operation) => {
    const { effectContent: _missingContent, effectHead: _missingHead, unpreservedPaths: _missingRemaining,
      effectConflictStages: _missingStages, effectUnresolvedConflictIds: _missingConflicts, ...rest } = operation
    return rest
  })
  const originalCommit = cold.pending.operation.effectCommit, calls = vi.spyOn(ResourceGit.prototype, 'run'); calls.mockClear()
  const observed = await cold.ctx.gitResources.reconcile(operationId)
  expect(observed.operation).toMatchObject({ phase: 'confirmed', effectCommit: originalCommit })
  expect(observed.operation.effectContent).toBeUndefined()
  expect(observed.resource.preservedContent).toBeUndefined()
  expect(observed.resource.preservedHead).toBeUndefined()
  expect(observed.resource.preservedConflictStages).toBeUndefined()
  expect(calls.mock.calls.some(([args]) => ['hash-object', 'read-tree', 'write-tree', 'commit-tree', 'update-ref'].includes(args[0] ?? '')))
    .toBe(false)
  await expect(cold.ctx.gitResources.previewIntegration({ consumerScope: test.made.resource.consumerScope,
    baseResourceId: test.made.resource.resourceId, sourcePreserveOperationIds: [operationId] }))
    .rejects.toMatchObject({ code: 'INTEGRATION_SOURCE_UNAVAILABLE' })
  calls.mockRestore()
})

it('retries a recorded immutable seal after final checkpoint failure without making another tree or commit', async () => {
  const test = await contentFixture(), operationId = GitOperationId('retry-recorded-seal'), put = test.unit.putRecord.bind(test.unit)
  const request = { operationId, resourceId: test.made.resource.resourceId, expectedRevision: test.made.resource.revision }
  const fault = vi.spyOn(test.unit, 'putRecord').mockImplementation(async (...args) => {
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === operationId
        && 'phase' in operation && operation.phase === 'confirmed')) throw new Error('seal final checkpoint rejected')
    return put(...args)
  })
  await expect(test.ctx.gitResources.preserve(request)).rejects.toThrow('seal final checkpoint rejected')
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(operationId), calls = vi.spyOn(ResourceGit.prototype, 'run'); calls.mockClear()
  const completed = await test.ctx.gitResources.preserve(request)
  expect(completed.operation.phase).toBe('confirmed')
  expect(completed.operation.effectCommit).toBe(pending?.operation.effectCommit)
  expect(calls.mock.calls.some(([args]) => ['hash-object', 'read-tree', 'write-tree', 'commit-tree'].includes(args[0] ?? ''))).toBe(false)
  calls.mockRestore()
})

it('bounds empty directories separately instead of treating them as archived regular-file data', async () => {
  const test = await contentFixture({ maxFiles: 3 }), path = test.made.resource.path
  await writeFile(join(path, '.gitignore'), 'generated-*/\n')
  for (const name of ['generated-a', 'generated-b', 'generated-c', 'generated-d']) await mkdir(join(path, name))
  await expect(test.ctx.gitResources.preserve({ operationId: GitOperationId('too-many-empty-dirs'), resourceId: test.made.resource.resourceId,
    expectedRevision: test.made.resource.revision, content: 'all' })).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
})

it.skipIf(process.platform === 'win32')('rejects a real FIFO from all-file preservation without reading it', async () => {
  const test = await contentFixture(), path = join(test.made.resource.path, 'not-a-regular-file')
  execFileSync('mkfifo', [path])
  await expect(test.ctx.gitResources.preserve({ operationId: GitOperationId('fifo-not-file'), resourceId: test.made.resource.resourceId,
    expectedRevision: test.made.resource.revision, content: 'all' })).rejects.toMatchObject({ code: 'TREE_ENTRY_UNSUPPORTED' })
})
