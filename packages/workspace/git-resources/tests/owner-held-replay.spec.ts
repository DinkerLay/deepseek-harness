/** Original operation retries remain serialized behind real use owners; cold metadata faults never invent executable state. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { expect, it, onTestFinished, vi } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import type { GitResourceId } from '../src/types.ts'
import { repositorySchema } from '../src/records.ts'
import { ResourceGit } from '../src/git.ts'
import { abortAfterIntent, applicationEdgeFixture, edgeFixture, edgeScope, edgeSignal } from './edge-harness.ts'
import { harness, repository } from './harness.ts'

function backend(test: Pick<Awaited<ReturnType<typeof harness>>, 'ctx'>) {
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('actual resource domain must be open')
  return { domain, unit: Reflect.get(domain, 'unit') as KvUnit }
}

function rejectConfirmation(test: Pick<Awaited<ReturnType<typeof harness>>, 'ctx'>, operationId: ReturnType<typeof GitOperationId>) {
  const { unit } = backend(test), put = unit.putRecord.bind(unit)
  const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    const record = repositorySchema.safeParse(args[2])
    if (record.success && record.data.operations.some(operation => operation.operationId === operationId && operation.phase === 'confirmed')) {
      throw new Error('actual final confirmation checkpoint failed')
    }
    return put(...args)
  })
  onTestFinished(() => { fault.mockRestore() })
  return fault
}

async function recoverState(test: Pick<Awaited<ReturnType<typeof harness>>, 'ctx'>, resourceId: GitResourceId) {
  const current = test.ctx.gitResources.read(resourceId)
  if (current === undefined) throw new Error('actual materialized original resource must remain')
  // A distinct legal seal restores the resource's availability without acknowledging the earlier operation's lost receipt.
  await test.ctx.gitResources.preserve({ operationId: GitOperationId('actual-state-preservation'), resourceId,
    expectedRevision: current.revision, content: 'versioned' })
}

async function creation() {
  const test = await harness(), base = await repository(test)
  const cut = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const request = { ...cut.request, operationId: GitOperationId('original-create-replay'),
    consumerScope: GitConsumerScope('held-replay'), originalRequestJson: '{}', expectedPreviewFingerprint: cut.fingerprint }
  const fault = rejectConfirmation(test, request.operationId)
  try { await expect(test.ctx.gitResources.create(request)).rejects.toThrow('confirmation checkpoint failed') }
  finally { fault.mockRestore() }
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('original creation must have a real durable receipt')
  await recoverState(test, pending.resource.resourceId)
  return { ...test, pending, request, resourceId: pending.resource.resourceId, retry: () => test.ctx.gitResources.create(request) }
}

async function integration() {
  const test = await edgeFixture(), cut = await test.ctx.gitResources.previewIntegration(test.selection)
  const request = { ...test.selection, operationId: GitOperationId('original-integration-replay'),
    originalRequestJson: '{}', expectedPreviewFingerprint: cut.fingerprint }
  const fault = rejectConfirmation(test, request.operationId)
  try { await expect(test.ctx.gitResources.integrate(request)).rejects.toThrow('confirmation checkpoint failed') }
  finally { fault.mockRestore() }
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('original integration must have actual materialized evidence')
  await recoverState(test, pending.resource.resourceId)
  return { ...test, pending, resourceId: pending.resource.resourceId, retry: () => test.ctx.gitResources.integrate(request) }
}

async function preservation() {
  const test = await edgeFixture(), current = test.ctx.gitResources.read(test.made.resource.resourceId)
  if (current === undefined) throw new Error('actual edge resource must remain')
  const request = { operationId: GitOperationId('original-preservation-replay'), resourceId: current.resourceId,
    expectedRevision: current.revision, content: 'versioned' as const }
  const cancellation = new AbortController(), fault = abortAfterIntent(test, request.operationId, cancellation)
  try { await expect(test.ctx.gitResources.preserve(request, cancellation.signal)).rejects.toThrow('durable original intent') }
  finally { fault.mockRestore() }
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('original preservation must have a durable legal intent')
  await recoverState(test, pending.resource.resourceId)
  return { ...test, pending, resourceId: pending.resource.resourceId, retry: () => test.ctx.gitResources.preserve(request) }
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

it.each(['create', 'integrate', 'preserve'] as const)
('queues an original nonterminal %s replay behind the actual failing write owner and refuses it after release', async (kind) => {
  const test = kind === 'create' ? await creation() : kind === 'integrate' ? await integration() : await preservation()
  expect(test.ctx.gitResources.status(test.pending.operation.operationId)?.operation.phase)
    .toBe(kind === 'preserve' ? 'intended' : 'needs_attention')
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>(), calls = observeWrites()
  onTestFinished(() => { release.resolve(undefined) })
  const use = test.ctx.gitResources.withWriteUse(test.resourceId,
    { useId: 'actual-replay-owner', ownerId: 'actual-source', epoch: '1' }, edgeSignal, async (scope) => {
      scope.assertCurrent(); entered.resolve(undefined); await release.promise
      throw new Error('actual source failed without handback')
    })
  const useCheck = expect(use).rejects.toThrow('without handback')
  // Both calls enter in one turn: the original retry passes its synchronous precheck before use publication, then queues on that lane.
  expect(test.ctx.gitResources.read(test.resourceId)?.use).toBeUndefined()
  let replaySettled = false
  const retryCheck = expect(test.retry().finally(() => { replaySettled = true })).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' })
  try {
    await entered.promise
    expect(replaySettled).toBe(false)
    expect(test.ctx.gitResources.read(test.resourceId)?.use?.phase).toBe('held')
  } finally {
    release.resolve(undefined)
    await useCheck; await retryCheck
  }
  expect(test.ctx.gitResources.read(test.resourceId)?.use?.phase).toBe('needs_attention')
  expect(test.ctx.gitResources.status(test.pending.operation.operationId)?.operation.request).toEqual(test.pending.operation.request)
  noGitWrites(calls)
})

it.each(['apply', 'cleanup'] as const)('refuses abandoning an original unstarted %s while a real failed use remains', async (kind) => {
  const test = await applicationEdgeFixture()
  let requestId: ReturnType<typeof GitOperationId>, resourceId = test.integrated.resource.resourceId
  const cancellation = new AbortController()
  if (kind === 'apply') {
    const selection = { consumerScope: edgeScope, integrationOperationId: test.integrated.operation.operationId,
      preserveOperationId: test.sealed.operation.operationId, targetWorkspaceId: test.workspace.id }
    const cut = await test.ctx.gitResources.previewApplication(selection)
    requestId = GitOperationId('held-original-application')
    const fault = abortAfterIntent(test, requestId, cancellation)
    try { await expect(test.ctx.gitResources.apply({ ...selection, operationId: requestId,
      originalRequestJson: '{}', expectedPreviewFingerprint: cut.fingerprint }, cancellation.signal, () => {})).rejects.toThrow('durable original intent') }
    finally { fault.mockRestore() }
  } else {
    const current = test.ctx.gitResources.read(resourceId)
    if (current === undefined) throw new Error('cleanup source must remain')
    const all = await test.ctx.gitResources.preserve({ operationId: GitOperationId('actual-all-before-held-cleanup'),
      resourceId, expectedRevision: current.revision, content: 'all' })
    resourceId = all.resource.resourceId
    const cut = await test.ctx.gitResources.previewCleanup(resourceId)
    requestId = GitOperationId('held-original-cleanup')
    const fault = abortAfterIntent(test, requestId, cancellation)
    try { await expect(test.ctx.gitResources.cleanup({ operationId: requestId, resourceId,
      expectedPreviewFingerprint: cut.fingerprint }, cancellation.signal, () => {})).rejects.toThrow('durable original intent') }
    finally { fault.mockRestore() }
  }
  await expect(test.ctx.gitResources.withWriteUse(resourceId, { useId: 'actual-unsettled-use', ownerId: 'actual-source', epoch: '1' },
    edgeSignal, async () => { throw new Error('source did not confirm quiet use') })).rejects.toThrow('quiet use')
  const pending = test.ctx.gitResources.status(requestId)
  if (pending === undefined) throw new Error('the original unstarted receipt must remain')
  expect(pending.operation.externalWriteStarted).toBe(false)
  const calls = observeWrites()
  await expect(test.ctx.gitResources.abandonOperation(requestId, pending.operation.fingerprint,
    'Stop only after exact source quiescence')).rejects.toMatchObject({ code: 'OPERATION_EFFECT_UNKNOWN' })
  expect(test.ctx.gitResources.status(requestId)?.operation.request).toEqual(pending.operation.request)
  noGitWrites(calls)
})

it('rejects a cold missing baseline tree while retaining the real baseline commit and original creation request', async () => {
  const test = await creation(), { domain, unit } = backend(test)
  const original = repositorySchema.parse(domain.table('repositories').get(test.pending.resource.repositoryId))
  const backup = join(test.root, 'original-before-baseline-tree-fault.json')
  await writeFile(backup, JSON.stringify(original))
  await unit.putRecord('repositories', test.pending.resource.repositoryId, { ...original, resources: original.resources.map((resource) => {
    if (resource.resourceId !== test.resourceId) return resource
    const { baselineTree: _explicitFault, ...rest } = resource
    return rest
  }) })
  expect(test.ctx.gitResources.read(test.resourceId)?.baselineTree).toBe(test.pending.resource.baselineTree)
  await test.ctx.fiber.dispose()
  const cold = await harness({}, test.resources), calls = observeWrites()
  expect(cold.ctx.gitResources.read(test.resourceId)?.baselineCommit).toBe(test.pending.resource.baselineCommit)
  expect(cold.ctx.gitResources.read(test.resourceId)?.baselineTree).toBeUndefined()
  await expect(cold.ctx.gitResources.create(test.request)).rejects.toMatchObject({ code: 'RECORD_INVALID' })
  expect(cold.ctx.gitResources.status(test.request.operationId)?.operation.request).toEqual(test.request)
  expect(JSON.parse(await readFile(backup, 'utf8'))).toEqual(original)
  noGitWrites(calls)
})
