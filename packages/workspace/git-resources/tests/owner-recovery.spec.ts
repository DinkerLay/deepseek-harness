/** Actual copy/ref checkpoint losses are recovered only from registered original evidence. */
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { harness, repository } from './harness.ts'

async function integrationFixture() {
  const test = await harness(), base = await repository(test), scope = GitConsumerScope('own-recovery')
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await test.ctx.gitResources.create({ ...preview.request, operationId: GitOperationId('recovery-source'),
    consumerScope: scope, originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  await writeFile(join(made.resource.path, 'file.txt'), 'real preserved input\n')
  const version = await test.ctx.gitResources.preserve({ operationId: GitOperationId('recovery-version'), resourceId: made.resource.resourceId,
    expectedRevision: made.resource.revision })
  const selection = { consumerScope: scope, baseResourceId: made.resource.resourceId,
    sourcePreserveOperationIds: [version.operation.operationId] }
  const cut = await test.ctx.gitResources.previewIntegration(selection)
  const request = { ...selection, operationId: GitOperationId('recovery-integration'), originalRequestJson: '{}',
    expectedPreviewFingerprint: cut.fingerprint }
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('real owner domain must be open')
  return { ...test, scope, made, request, unit: Reflect.get(domain, 'unit') as KvUnit }
}

it('confirms an actual fully materialized integration after the final backend checkpoint failed without repeating writes', async () => {
  const test = await integrationFixture(), original = test.unit.putRecord.bind(test.unit)
  const fault = vi.spyOn(test.unit, 'putRecord').mockImplementation(async (...args) => {
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === test.request.operationId
        && 'phase' in operation && operation.phase === 'confirmed')) throw new Error('integration final checkpoint rejected')
    return original(...args)
  })
  await expect(test.ctx.gitResources.integrate(test.request)).rejects.toThrow('checkpoint rejected')
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(test.request.operationId)
  if (pending === undefined) throw new Error('original partial receipt must be queryable')
  expect(pending.operation.phase).toBe('needs_attention')
  expect(await readFile(join(pending.resource.path, 'file.txt'), 'utf8')).toBe('real preserved input\n')
  const commands = vi.spyOn(ResourceGit.prototype, 'run'); commands.mockClear()
  const observed = await test.ctx.gitResources.reconcile(test.request.operationId)
  expect(observed.operation).toMatchObject({ phase: 'confirmed', integrationEffect: pending.operation.integrationEffect })
  const writes = new Set(['read-tree', 'write-tree', 'commit-tree', 'update-ref', 'update-index', 'merge-tree'])
  expect(commands.mock.calls.some(([args]) => writes.has(args[0] ?? '') || args[0] === 'hash-object' && args.includes('-w')
    || args[0] === 'worktree' && args[1] === 'add')).toBe(false)
  commands.mockClear()
  expect(await test.ctx.gitResources.reconcile(test.request.operationId)).toEqual(observed)
  commands.mockRestore()
})

it('retains changed materialized integration as attention-required rather than repairing it during observation', async () => {
  const test = await integrationFixture(), original = test.unit.putRecord.bind(test.unit)
  const fault = vi.spyOn(test.unit, 'putRecord').mockImplementation(async (...args) => {
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === test.request.operationId
        && 'phase' in operation && operation.phase === 'confirmed')) throw new Error('integration receipt missing')
    return original(...args)
  })
  await expect(test.ctx.gitResources.integrate(test.request)).rejects.toThrow('receipt missing')
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(test.request.operationId)
  if (pending === undefined) throw new Error('actual original integration must remain tracked')
  const effect = pending.operation.integrationEffect
  if (effect === undefined) throw new Error('the immutable original integration effect must remain recorded')
  test.git(['update-ref', pending.resource.privateRef, test.made.resource.baselineCommit!])
  const changedRef = await test.ctx.gitResources.reconcile(test.request.operationId)
  expect(changedRef.operation).toMatchObject({ phase: 'needs_attention', diagnostic: 'Observed integration reference differs from its exact recorded version' })
  test.git(['update-ref', pending.resource.privateRef, effect.commit])
  await writeFile(join(pending.resource.path, 'unknown.txt'), 'later unknown content\n')
  const incomplete = await test.ctx.gitResources.reconcile(test.request.operationId)
  expect(incomplete.operation).toMatchObject({ phase: 'needs_attention', diagnostic: 'Original integration materialization is incomplete; reconciliation did not write files' })
  await rm(join(pending.resource.path, 'unknown.txt'))
  await writeFile(join(pending.resource.path, 'file.txt'), 'later user bytes must remain\n')
  const result = await test.ctx.gitResources.reconcile(test.request.operationId)
  expect(result.operation.phase).toBe('needs_attention')
  expect(await readFile(join(pending.resource.path, 'file.txt'), 'utf8')).toBe('later user bytes must remain\n')
})

it.each(['commit', 'selected'] as const)('observes a pinned %s baseline with a lost effect checkpoint without creating a work copy', async (kind) => {
  const test = await harness(), base = await repository(test)
  await writeFile(join(test.project, 'selected.txt'), 'original chosen bytes\n')
  if (kind === 'selected') {
    test.git(['rm', '--quiet', '--', 'removed.txt'])
    await writeFile(join(test.project, 'file.txt'), 'chosen index bytes\n'); test.git(['add', '--', 'file.txt'])
  }
  const baseline = kind === 'commit' ? { kind, commit: base } : { kind, baseCommit: base,
    paths: [{ path: 'selected.txt', source: 'untracked' as const }, { path: 'removed.txt', source: 'index' as const },
      { path: 'file.txt', source: 'index' as const }] }
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline })
  const request = { ...preview.request, operationId: GitOperationId(`lost-baseline-${kind}`),
    consumerScope: GitConsumerScope('checkpoint-recovery'), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('the real domain must be open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, original = unit.putRecord.bind(unit)
  const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === request.operationId
        && 'effectCommit' in operation && operation.effectCommit !== undefined)) throw new Error('effect checkpoint rejected')
    return original(...args)
  })
  await expect(test.ctx.gitResources.create(request)).rejects.toThrow('effect checkpoint rejected')
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('the original creation must remain recorded')
  expect(pending.operation.effectCommit).toBeUndefined()
  const commit = test.git(['rev-parse', pending.resource.privateRef])
  await writeFile(join(test.project, 'selected.txt'), 'later user bytes\n')
  const calls = vi.spyOn(ResourceGit.prototype, 'run'); calls.mockClear()
  const observed = await test.ctx.gitResources.reconcile(request.operationId)
  expect(observed.operation.phase).toBe('needs_attention')
  expect(calls.mock.calls.some(([args]) => ['hash-object', 'write-tree', 'commit-tree', 'update-ref', 'read-tree'].includes(args[0] ?? '')
    || args[0] === 'worktree' && args[1] === 'add')).toBe(false)
  await expect(lstat(pending.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(test.git(['rev-parse', pending.resource.privateRef])).toBe(commit)
  calls.mockRestore()
  test.git(['commit', '--allow-empty', '--quiet', '-m', 'actual different project commit'])
  test.git(['update-ref', pending.resource.privateRef, 'HEAD'])
  const conflict = await test.ctx.gitResources.reconcile(request.operationId)
  expect(conflict.operation.phase).toBe('needs_attention')
  expect(conflict.operation.diagnostic).toContain(kind === 'commit' ? 'baseline commit does not match' : 'tree differs')
  test.git(['update-ref', pending.resource.privateRef, commit])
  const completed = await test.ctx.gitResources.create(request)
  expect(completed.operation.effectCommit).toBe(commit)
  expect(await readFile(join(test.project, 'selected.txt'), 'utf8')).toBe('later user bytes\n')
  if (kind === 'selected') expect(await readFile(join(completed.resource.path, 'selected.txt'), 'utf8')).toBe('original chosen bytes\n')
})

it('refuses an unknown reserved path appearing after the baseline checkpoint but before work-copy creation was recorded', async () => {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const request = { ...preview.request, operationId: GitOperationId('unknown-after-baseline'),
    consumerScope: GitConsumerScope('checkpoint-recovery'), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('the real domain must be open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, original = unit.putRecord.bind(unit)
  const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'worktreeCreateStarted' in operation && operation.worktreeCreateStarted === true)) throw new Error('creation dispatch checkpoint failed')
    return original(...args)
  })
  await expect(test.ctx.gitResources.create(request)).rejects.toThrow('dispatch checkpoint failed')
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('the registered original operation must survive')
  await mkdir(pending.resource.path); await writeFile(join(pending.resource.path, 'unrelated.txt'), 'new ownership\n')
  await expect(test.ctx.gitResources.create(request)).rejects.toMatchObject({ code: 'RESOURCE_UNKNOWN' })
  expect(await readFile(join(pending.resource.path, 'unrelated.txt'), 'utf8')).toBe('new ownership\n')
})

it('does not recreate a previously observed work-copy directory removed after interrupted materialization', async () => {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const request = { ...preview.request, operationId: GitOperationId('missing-after-observation'),
    consumerScope: GitConsumerScope('checkpoint-recovery'), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }
  // oxlint-disable-next-line typescript/unbound-method -- This fault delegates all actual Git calls on the real runner.
  const original = ResourceGit.prototype.run
  let blobs = 0
  const fault = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
    if (args[0] === 'cat-file' && args[1] === 'blob' && ++blobs === 2) throw new Error('materialization interrupted')
    return original.call(this, args, ...rest)
  })
  await expect(test.ctx.gitResources.create(request)).rejects.toThrow('materialization interrupted')
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('the original observed directory must be recorded')
  expect(pending.resource.pathIdentity).toBeDefined()
  await rm(pending.resource.path, { recursive: true })
  await expect(test.ctx.gitResources.create(request)).rejects.toMatchObject({ code: 'RESOURCE_MISSING' })
  await expect(lstat(pending.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses an actual source change after the original creation intent but before its first external effect', async () => {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const request = { ...preview.request, operationId: GitOperationId('source-after-intent'), consumerScope: GitConsumerScope('checkpoint-recovery'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('the actual owner domain must be open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, put = unit.putRecord.bind(unit)
  const barrier = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    await put(...args)
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === request.operationId
        && 'phase' in operation && operation.phase === 'intended')) await writeFile(join(test.project, 'later.txt'), 'later source input\n')
  })
  await expect(test.ctx.gitResources.create(request)).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' })
  barrier.mockRestore()
  const pending = test.ctx.gitResources.status(request.operationId)
  expect(pending?.operation).toMatchObject({ phase: 'needs_attention', externalWriteStarted: false })
  expect(test.git(['for-each-ref', '--format=%(refname)', 'refs/dsh-resources'])).toBe('')
  expect(await readFile(join(test.project, 'later.txt'), 'utf8')).toBe('later source input\n')
})

it('refuses selected bytes changed after the refreshed cut before raw object creation without hashing the new bytes', async () => {
  const test = await harness(), base = await repository(test)
  await writeFile(join(test.project, 'selected.txt'), 'selected earlier bytes\n')
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'selected', baseCommit: base,
    paths: [{ path: 'selected.txt', source: 'untracked' }] } })
  const request = { ...preview.request, operationId: GitOperationId('bytes-after-fresh-cut'), consumerScope: GitConsumerScope('checkpoint-recovery'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }
  const index = await readFile(join(test.project, '.git', 'index'))
  const original = Reflect.get(ResourceGit.prototype, 'run')
  const barrier = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
    const result = await original.call(this, args, ...rest)
    if (args[0] === 'read-tree') await writeFile(join(test.project, 'selected.txt'), 'new bytes after the fresh cut\n')
    return result
  })
  await expect(test.ctx.gitResources.create(request)).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' })
  expect(barrier.mock.calls.some(([args]) => args[0] === 'hash-object' && args.includes('-w'))).toBe(false)
  barrier.mockRestore()
  expect(test.git(['for-each-ref', '--format=%(refname)', 'refs/dsh-resources'])).toBe('')
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
  expect(await readFile(join(test.project, 'selected.txt'), 'utf8')).toBe('new bytes after the fresh cut\n')
})

it.each(['unknown-file', 'changed-file', 'changed-head'] as const)
('refuses actual %s in an interrupted owned creation instead of repairing or discarding it', async (kind) => {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const request = { ...preview.request, operationId: GitOperationId(`materialized-${kind}`), consumerScope: GitConsumerScope('checkpoint-recovery'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }
  const original = Reflect.get(ResourceGit.prototype, 'run')
  let blobs = 0
  const fault = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
    if (args[0] === 'cat-file' && args[1] === 'blob' && ++blobs === 2) throw new Error('original materialization interrupted')
    return original.call(this, args, ...rest)
  })
  await expect(test.ctx.gitResources.create(request)).rejects.toThrow('materialization interrupted')
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('the actual original directory must be recorded')
  const path = pending.resource.path
  if (kind === 'unknown-file') await writeFile(join(path, 'unknown.txt'), 'do not discard unowned working data\n')
  else if (kind === 'changed-file') await writeFile(join(path, 'file.txt'), 'actual later working bytes\n')
  else test.git(['-C', path, 'commit', '--allow-empty', '--quiet', '-m', 'actual new detached creation HEAD'])
  const calls = vi.spyOn(ResourceGit.prototype, 'run'); calls.mockClear()
  await expect(test.ctx.gitResources.create(request)).rejects.toMatchObject({
    code: kind === 'unknown-file' ? 'RESOURCE_UNKNOWN' : 'RESOURCE_CHANGED' })
  expect(calls.mock.calls.some(([args]) => args[0] === 'worktree' && args[1] === 'add' || args[0] === 'read-tree')).toBe(false)
  if (kind === 'unknown-file') expect(await readFile(join(path, 'unknown.txt'), 'utf8')).toBe('do not discard unowned working data\n')
  else if (kind === 'changed-file') expect(await readFile(join(path, 'file.txt'), 'utf8')).toBe('actual later working bytes\n')
  else expect(test.git(['-C', path, 'rev-parse', 'HEAD'])).not.toBe(base)
  calls.mockRestore()
})
