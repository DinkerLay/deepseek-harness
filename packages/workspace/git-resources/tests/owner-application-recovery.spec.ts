/** Cold application refuses explicitly damaged durable bytes; these faults are not legal writer crash products. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { expect, it, onTestFinished, vi } from 'vitest'
import { GitOperationId } from '../src/index.ts'
import type { GitResourceOperation } from '../src/types.ts'
import { repositorySchema } from '../src/records.ts'
import { ResourceGit } from '../src/git.ts'
import { abortAfterIntent, applicationEdgeFixture, edgeScope, edgeSignal } from './edge-harness.ts'
import { harness } from './harness.ts'

type ApplicationFixture = Awaited<ReturnType<typeof applicationEdgeFixture>>

async function coldRecord(test: ApplicationFixture, operationId: ReturnType<typeof GitOperationId>,
  damage: (operation: GitResourceOperation) => GitResourceOperation) {
  const domain = test.ctx.storageDomain.get('git_resources'), pending = test.ctx.gitResources.status(operationId)
  if (domain === undefined || pending === undefined) throw new Error('actual original operation and domain are required')
  const unit = Reflect.get(domain, 'unit') as KvUnit
  const original = repositorySchema.parse(domain.table('repositories').get(pending.resource.repositoryId))
  const backup = join(test.root, 'original-application-record.json')
  await writeFile(backup, JSON.stringify(original))
  const damaged = { ...original, operations: original.operations.map(operation =>
    operation.operationId === operationId ? damage(structuredClone(operation)) : operation) }
  // Only private backend bytes are faulted; the live Domain must retain the genuine original publication.
  await unit.putRecord('repositories', pending.resource.repositoryId, damaged)
  expect(test.ctx.gitResources.status(operationId)?.operation).toEqual(pending.operation)
  await test.ctx.fiber.dispose()
  const originalRun: ResourceGit['run'] = Reflect.get(ResourceGit.prototype, 'run')
  const calls = vi.spyOn(ResourceGit.prototype, 'run')
  onTestFinished(() => { calls.mockRestore() })
  const cold = await harness({}, test.resources)
  return { ...test, ...cold, pending, original, backup, originalRun, calls }
}

async function applicationIntent(damage: (operation: GitResourceOperation, fixture: ApplicationFixture) => GitResourceOperation =
  operation => operation) {
  const test = await applicationEdgeFixture()
  const selection = { consumerScope: edgeScope, integrationOperationId: test.integrated.operation.operationId,
    preserveOperationId: test.sealed.operation.operationId, targetWorkspaceId: test.workspace.id }
  const preview = await test.ctx.gitResources.previewApplication(selection)
  const request = { ...selection, operationId: GitOperationId('cold-original-application'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  const cancellation = new AbortController(), barrier = abortAfterIntent(test, request.operationId, cancellation)
  try {
    await expect(test.ctx.gitResources.apply(request, cancellation.signal, () => {})).rejects.toThrow('durable original intent')
  } finally { barrier.mockRestore() }
  const cold = await coldRecord(test, request.operationId, operation => damage(operation, test))
  expect(cold.pending.operation.externalWriteStarted).toBe(false)
  return { ...cold, selection, preview, request }
}

function assertNoGitWrites(test: Pick<Awaited<ReturnType<typeof coldRecord>>, 'calls'>) {
  const commands = new Set(['apply', 'read-tree', 'write-tree', 'commit-tree', 'update-ref', 'update-index', 'merge-tree'])
  expect(test.calls.mock.calls.filter(([args]) => commands.has(args[0] ?? '')
    || args[0] === 'hash-object' && args.includes('-w')
    || args[0] === 'worktree' && (args.includes('add') || args.includes('remove')))).toEqual([])
}

async function assertOriginalRetained(test: Pick<Awaited<ReturnType<typeof coldRecord>>,
  'ctx' | 'pending' | 'original' | 'backup' | 'calls'>) {
  const operation = test.ctx.gitResources.status(test.pending.operation.operationId)?.operation
  expect(operation?.fingerprint).toBe(test.pending.operation.fingerprint)
  expect(operation?.applicationEffect).toBeUndefined()
  expect(JSON.parse(await readFile(test.backup, 'utf8'))).toEqual(test.original)
  assertNoGitWrites(test)
}

it.each(['conflict-mismatch', 'missing-integration', 'absent-empty-conflicts'] as const)
('reads actual cold seals with %s evidence without inventing a replacement or writing Git', async (fault) => {
  const test = await applicationEdgeFixture()
  const cold = await coldRecord(test, test.sealed.operation.operationId, (operation) => {
    if (fault === 'conflict-mismatch') return { ...operation, effectUnresolvedConflictIds: ['explicit-durable-fault'] }
    Reflect.deleteProperty(operation, fault === 'missing-integration' ? 'effectIntegrationOperationId' : 'effectUnresolvedConflictIds')
    return operation
  })
  const selection = { consumerScope: edgeScope, integrationOperationId: test.integrated.operation.operationId,
    preserveOperationId: test.sealed.operation.operationId, targetWorkspaceId: test.workspace.id }
  if (fault === 'absent-empty-conflicts') {
    const cut = await cold.ctx.gitResources.previewApplication(selection)
    expect(cut.source.resultTree).toBe(test.sealed.operation.effectTree)
    expect(cut.source.preserveOperationId).toBe(test.sealed.operation.operationId)
  } else await expect(cold.ctx.gitResources.previewApplication(selection)).rejects.toMatchObject({ code: 'APPLICATION_SOURCE_UNAVAILABLE' })
  expect(cold.ctx.gitResources.status(test.sealed.operation.operationId)?.operation.request).toEqual(test.sealed.operation.request)
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  expect(JSON.parse(await readFile(cold.backup, 'utf8'))).toEqual(cold.original)
  assertNoGitWrites(cold)
})

it.each(['preview', 'request'] as const)('rejects cold application retry and abandonment with damaged %s metadata', async (field) => {
  const test = await applicationIntent((operation, fixture) => {
    if (field === 'request') return { ...operation, request: fixture.version.operation.request }
    Reflect.deleteProperty(operation, 'applicationPreview')
    return operation
  })
  await expect(test.ctx.gitResources.apply(test.request, edgeSignal, () => {})).rejects.toMatchObject({ code: 'RECORD_INVALID' })
  await expect(test.ctx.gitResources.abandonOperation(test.request.operationId, test.pending.operation.fingerprint,
    'Explicitly stop only the original unstarted operation', edgeSignal, () => {})).rejects.toMatchObject({ code: 'RECORD_INVALID' })
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  await assertOriginalRetained(test)
})

it('does not abandon an original unstarted application after user working bytes became unknown', async () => {
  const test = await applicationIntent()
  await writeFile(join(test.project, 'file.txt'), 'LATER USER WORK\n')
  await expect(test.ctx.gitResources.abandonOperation(test.request.operationId, test.pending.operation.fingerprint,
    'Stop after observing the changed original target', edgeSignal, () => {})).rejects.toMatchObject({ code: 'OPERATION_EFFECT_UNKNOWN' })
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('LATER USER WORK\n')
  expect(test.ctx.gitResources.status(test.request.operationId)?.operation.request).toEqual(test.request)
  await assertOriginalRetained(test)
})

it.each(['retry', 'abandon'] as const)('retains a real before observation but rejects a changed full target cut during %s', async (action) => {
  const test = await applicationIntent(), staged = join(test.project, 'later-user-stage.txt')
  let changed = false, index: Buffer | undefined
  test.calls.mockImplementation(async function (this: ResourceGit, ...args) {
    const result = await test.originalRun.call(this, ...args)
    // The original-target observation has completed before previewApplication reads its immutable source ref.
    if (!changed && args[0][0] === 'rev-parse' && args[0][1] === '--verify' && args[0][2] === test.sealed.operation.effectRef) {
      changed = true
      await writeFile(staged, 'USER INDEX CHANGE\n')
      test.git(['add', '--', 'later-user-stage.txt'])
      index = await readFile(join(test.project, '.git', 'index'))
    }
    return result
  })
  const command = action === 'retry' ? test.ctx.gitResources.apply(test.request, edgeSignal, () => {})
    : test.ctx.gitResources.abandonOperation(test.request.operationId, test.pending.operation.fingerprint,
      'Stop only while the complete original cut remains before', edgeSignal, () => {})
  await expect(command).rejects.toMatchObject({ code: action === 'retry' ? 'APPLICATION_TARGET_CHANGED' : 'OPERATION_EFFECT_UNKNOWN' })
  expect(changed).toBe(true)
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
  expect(await readFile(staged, 'utf8')).toBe('USER INDEX CHANGE\n')
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  expect(test.ctx.gitResources.status(test.request.operationId)?.operation.request).toEqual(test.request)
  await assertOriginalRetained(test)
})
