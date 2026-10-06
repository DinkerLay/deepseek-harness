/** Final delivery guards observe legal original operations and explicit cold durable faults, never manufactured live state. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { abortAfterIntent, applicationEdgeFixture, edgeFixture, edgeScope, edgeSignal } from './edge-harness.ts'
import { coldCorruptOperation } from './owner-corruption-harness.ts'
import { harness, repository } from './harness.ts'

async function cleanupFixture() {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await test.ctx.gitResources.create({ ...preview.request, consumerScope: GitConsumerScope('final-delivery'),
    operationId: GitOperationId('delivery-copy'), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  const all = await test.ctx.gitResources.preserve({ operationId: GitOperationId('delivery-all-files'),
    resourceId: made.resource.resourceId, expectedRevision: made.resource.revision, content: 'all' })
  const cut = await test.ctx.gitResources.previewCleanup(all.resource.resourceId)
  const request = { operationId: GitOperationId('delivery-cleanup'), resourceId: all.resource.resourceId,
    expectedPreviewFingerprint: cut.fingerprint, originalRequestJson: '{"intent":"original-cleanup"}' }
  return { ...test, made, all, cut, request }
}

async function unstartedCleanup() {
  const test = await cleanupFixture()
  await expect(test.ctx.gitResources.cleanup(test.request, edgeSignal, () => {
    if (test.ctx.gitResources.status(test.request.operationId) !== undefined) throw new Error('actual caller stopped before removal')
  })).rejects.toThrow('caller stopped before removal')
  const pending = test.ctx.gitResources.status(test.request.operationId)
  if (pending === undefined) throw new Error('original cleanup intent must be durable')
  expect(pending.operation.externalWriteStarted).toBe(false)
  return { ...test, pending }
}

function observeWrites() {
  const calls = vi.spyOn(ResourceGit.prototype, 'run')
  onTestFinished(() => { calls.mockRestore() })
  return calls
}

function noGitWrites(calls: ReturnType<typeof observeWrites>) {
  expect(calls.mock.calls.filter(([args]) => ['apply', 'read-tree', 'write-tree', 'commit-tree', 'update-ref', 'update-index', 'merge-tree']
    .includes(args[0] ?? '') || args[0] === 'hash-object' && args.includes('-w')
    || args[0] === 'worktree' && (args[1] === 'add' || args[1] === 'remove'))).toEqual([])
}

async function originalBackup(cold: Pick<Awaited<ReturnType<typeof coldCorruptOperation>>, 'backup' | 'original'>) {
  expect(JSON.parse(await readFile(cold.backup, 'utf8'))).toEqual(cold.original)
}

it('refuses abandonment when a cold unstarted cleanup has lost its original preview', async () => {
  const test = await unstartedCleanup()
  const cold = await coldCorruptOperation(test, test.request.operationId, (operation) => {
    const { cleanupPreview: _explicitFault, ...rest } = operation
    return rest
  })
  const calls = observeWrites()
  await expect(cold.ctx.gitResources.abandonOperation(test.request.operationId, test.pending.operation.fingerprint,
    'Stop only the original definitely unstarted cleanup')).rejects.toMatchObject({ code: 'OPERATION_EFFECT_UNKNOWN' })
  expect(cold.ctx.gitResources.status(test.request.operationId)?.operation).toMatchObject({
    phase: 'needs_attention', request: test.request, fingerprint: test.pending.operation.fingerprint })
  expect(await readFile(join(test.all.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
  await originalBackup(cold); noGitWrites(calls)
})

it('refuses abandoning the original cleanup after a distinct legal seal changed its owned cut', async () => {
  const test = await unstartedCleanup(), current = test.ctx.gitResources.read(test.all.resource.resourceId)
  if (current === undefined) throw new Error('original owned directory must remain')
  await test.ctx.gitResources.preserve({ operationId: GitOperationId('delivery-later-all-files'),
    resourceId: current.resourceId, expectedRevision: current.revision, content: 'all' })
  const calls = observeWrites(), fresh = await test.ctx.gitResources.previewCleanup(current.resourceId)
  expect(fresh.fingerprint).not.toBe(test.cut.fingerprint)
  await expect(test.ctx.gitResources.abandonOperation(test.request.operationId, test.pending.operation.fingerprint,
    'Stop without adopting the later preservation')).rejects.toMatchObject({ code: 'OPERATION_EFFECT_UNKNOWN' })
  expect(test.ctx.gitResources.status(test.request.operationId)?.operation.request).toEqual(test.request)
  expect(test.ctx.gitResources.status(test.request.operationId)?.operation.phase).toBe('needs_attention')
  expect(await readFile(join(test.all.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
  noGitWrites(calls)
})

it('does not abandon a real nonterminal preserve even if cold bytes falsely claim no external write', async () => {
  const test = await edgeFixture(), current = test.ctx.gitResources.read(test.made.resource.resourceId)
  if (current === undefined) throw new Error('actual preservation source must remain')
  const request = { operationId: GitOperationId('delivery-original-preserve'), resourceId: current.resourceId,
    expectedRevision: current.revision, content: 'versioned' as const }
  const cancellation = new AbortController(), fault = abortAfterIntent(test, request.operationId, cancellation)
  try { await expect(test.ctx.gitResources.preserve(request, cancellation.signal)).rejects.toThrow('durable original intent') }
  finally { fault.mockRestore() }
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('legal original preserve intent must be durable')
  expect(pending.operation).toMatchObject({ kind: 'preserve', phase: 'intended' })
  expect(pending.operation.effectTree).toBeUndefined(); expect(pending.operation.effectCommit).toBeUndefined()
  expect(pending.operation.externalWriteStarted).toBeUndefined()
  // Normal preservation has no no-write witness: this explicit backend fault must not turn it into an abandonable create.
  const cold = await coldCorruptOperation(test, request.operationId, operation => ({ ...operation, externalWriteStarted: false }))
  const calls = observeWrites()
  await expect(cold.ctx.gitResources.abandonOperation(request.operationId, pending.operation.fingerprint,
    'Do not infer creation semantics from the corrupted witness')).rejects.toMatchObject({ code: 'OPERATION_EFFECT_UNKNOWN' })
  expect(cold.ctx.gitResources.status(request.operationId)?.operation).toMatchObject({
    phase: 'intended', request: pending.operation.request, fingerprint: pending.operation.fingerprint })
  expect(await readFile(join(current.path, 'file.txt'), 'utf8')).toBe('EDGE RESULT\n')
  await originalBackup(cold); noGitWrites(calls)
})

it('observes a real all-file seal with absent optional conflict stages as empty without writing Git', async () => {
  const test = await cleanupFixture()
  expect(test.all.operation.effectConflictStages).toEqual([])
  const cold = await coldCorruptOperation(test, test.all.operation.operationId, (operation) => {
    const { effectConflictStages: _explicitFault, ...rest } = operation
    return rest
  })
  const calls = observeWrites(), observed = await cold.ctx.gitResources.previewCleanup(test.all.resource.resourceId)
  expect(observed.preserveOperationId).toBe(test.all.operation.operationId)
  expect(observed.fingerprint).toBe(test.cut.fingerprint)
  expect(cold.ctx.gitResources.status(test.all.operation.operationId)?.operation.request).toEqual(test.all.operation.request)
  expect(await readFile(join(test.all.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
  await originalBackup(cold); noGitWrites(calls)
})

it('keeps cold application reconciliation unknown when the original target preview is missing', async () => {
  const test = await applicationEdgeFixture()
  const selection = { consumerScope: edgeScope, integrationOperationId: test.integrated.operation.operationId,
    preserveOperationId: test.sealed.operation.operationId, targetWorkspaceId: test.workspace.id }
  const cut = await test.ctx.gitResources.previewApplication(selection)
  const request = { ...selection, operationId: GitOperationId('delivery-original-apply'), originalRequestJson: '{}',
    expectedPreviewFingerprint: cut.fingerprint }
  const cancellation = new AbortController(), fault = abortAfterIntent(test, request.operationId, cancellation)
  try { await expect(test.ctx.gitResources.apply(request, cancellation.signal, () => {})).rejects.toThrow('durable original intent') }
  finally { fault.mockRestore() }
  const cold = await coldCorruptOperation(test, request.operationId, (operation) => {
    const { applicationPreview: _explicitFault, ...rest } = operation
    return rest
  })
  const calls = observeWrites(), before = cold.ctx.gitResources.read(test.integrated.resource.resourceId)
  const observed = await cold.ctx.gitResources.reconcile(request.operationId)
  expect(observed.operation).toMatchObject({ phase: 'needs_attention', request,
    diagnostic: 'Application intent has no original target cut', fingerprint: cold.pending.operation.fingerprint })
  expect(observed.operation.applicationObservation).toBeUndefined()
  expect(observed.operation.applicationEffect).toBeUndefined()
  expect(cold.ctx.gitResources.read(test.integrated.resource.resourceId)).toEqual(before)
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  await originalBackup(cold); noGitWrites(calls)
})
