/** Exact original intents reject cold durable-input damage and later target changes, without adopting fresh effects. */
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { expect, it, onTestFinished, vi } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { applicationEdgeFixture, edgeFixture, edgeScope, edgeSignal } from './edge-harness.ts'
import { coldCorruptOperation } from './owner-corruption-harness.ts'
import { harness, repository } from './harness.ts'

function freezeIntent(test: Pick<Awaited<ReturnType<typeof harness>>, 'ctx'>,
  operationId: ReturnType<typeof GitOperationId>, cancellation: AbortController) {
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('real intent owner must have its domain open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, put = unit.putRecord.bind(unit)
  const gate = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    await put(...args)
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === operationId
        && 'phase' in operation && operation.phase === 'intended')) cancellation.abort(new Error('frozen after actual original intent'))
  })
  onTestFinished(() => { gate.mockRestore() })
  return gate
}

function observeGit() {
  const calls = vi.spyOn(ResourceGit.prototype, 'run')
  onTestFinished(() => { calls.mockRestore() })
  return calls
}

function assertNoGitEffects(calls: ReturnType<typeof observeGit>) {
  const writes = new Set(['apply', 'read-tree', 'write-tree', 'commit-tree', 'update-ref', 'update-index', 'merge-tree'])
  expect(calls.mock.calls.filter(([args]) => writes.has(args[0] ?? '')
    || args[0] === 'hash-object' && args.includes('-w')
    || args[0] === 'worktree' && (args.includes('add') || args.includes('remove')))).toEqual([])
}

async function appliedFixture() {
  const test = await applicationEdgeFixture()
  const selection = { consumerScope: edgeScope, integrationOperationId: test.integrated.operation.operationId,
    preserveOperationId: test.sealed.operation.operationId, targetWorkspaceId: test.workspace.id }
  const preview = await test.ctx.gitResources.previewApplication(selection)
  const applied = await test.ctx.gitResources.apply({ ...selection, operationId: GitOperationId('final-intent-application'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }, edgeSignal, () => {})
  const inverseSelection = { consumerScope: edgeScope, applicationOperationId: applied.operation.operationId,
    targetWorkspaceId: test.workspace.id }
  const inversePreview = await test.ctx.gitResources.previewInverse(inverseSelection)
  return { ...test, applied, inverseSelection, inversePreview }
}

it('refuses an indexed selected input whose immutable object id was damaged after its durable create intent', async () => {
  const test = await harness(), base = await repository(test)
  await writeFile(join(test.project, 'file.txt'), 'EXACT SELECTED INDEX\n')
  test.git(['add', '--', 'file.txt'])
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id,
    baseline: { kind: 'selected', baseCommit: base, paths: [{ path: 'file.txt', source: 'index' }] } })
  const request = { ...preview.request, consumerScope: GitConsumerScope('final-index-intent'), originalRequestJson: '{}',
    operationId: GitOperationId('final-index-intent'), expectedPreviewFingerprint: preview.fingerprint }
  const cancellation = new AbortController(), gate = freezeIntent(test, request.operationId, cancellation)
  try { await expect(test.ctx.gitResources.create(request, cancellation.signal)).rejects.toThrow('actual original intent') }
  finally { gate.mockRestore() }
  const index = await readFile(join(test.project, '.git', 'index')), head = test.git(['rev-parse', 'HEAD'])
  const cold = await coldCorruptOperation(test, request.operationId, (operation) => {
    if (operation.preview === undefined) throw new Error('the real writer must capture selected input facts')
    // Explicit private durable-byte fault, not a representation emitted by the writer after a normal crash.
    return { ...operation, preview: { ...operation.preview, selected: operation.preview.selected.map((entry) => {
      const { objectId: _missingObject, ...rest } = entry; return rest
    }) } }
  })
  const calls = observeGit()
  await expect(cold.ctx.gitResources.create(request)).rejects.toMatchObject({ code: 'RECORD_INVALID' })
  expect(calls.mock.calls.filter(([args]) => args[0] === 'read-tree')).toHaveLength(1)
  expect(calls.mock.calls.filter(([args]) => ['hash-object', 'update-index', 'write-tree', 'commit-tree', 'update-ref', 'worktree']
    .includes(args[0] ?? ''))).toEqual([])
  const retained = cold.ctx.gitResources.status(request.operationId)
  expect(retained?.operation.request).toEqual(request)
  expect(retained?.operation.fingerprint).toBe(cold.pending.operation.fingerprint)
  expect(retained?.operation.effectCommit).toBeUndefined()
  await expect(lstat(cold.pending.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
  expect(test.git(['rev-parse', 'HEAD'])).toBe(head)
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('EXACT SELECTED INDEX\n')
  expect(JSON.parse(await readFile(cold.backup, 'utf8'))).toEqual(cold.original)
})

it('does not prepare an original inverse intent against later user working bytes', async () => {
  const test = await appliedFixture()
  const request = { ...test.inverseSelection, operationId: GitOperationId('final-stale-inverse'), originalRequestJson: '{}',
    expectedPreviewFingerprint: test.inversePreview.fingerprint }
  const cancellation = new AbortController(), gate = freezeIntent(test, request.operationId, cancellation)
  try {
    await expect(test.ctx.gitResources.prepareInverse(request, cancellation.signal, () => {})).rejects.toThrow('actual original intent')
  } finally { gate.mockRestore() }
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('the real stopped reverse intent must remain observable')
  await writeFile(join(test.project, 'file.txt'), 'LATER USER TARGET\n')
  const index = await readFile(join(test.project, '.git', 'index')), head = test.git(['rev-parse', 'HEAD'])
  await test.ctx.fiber.dispose()
  const cold = await harness({}, test.resources), calls = observeGit()
  await expect(cold.ctx.gitResources.prepareInverse(request, edgeSignal, () => {})).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' })
  assertNoGitEffects(calls)
  expect(cold.ctx.gitResources.status(request.operationId)?.operation).toMatchObject({ request,
    fingerprint: pending.operation.fingerprint, phase: 'needs_attention', externalWriteStarted: false })
  expect(cold.ctx.gitResources.status(request.operationId)?.operation.integrationEffect).toBeUndefined()
  await expect(lstat(pending.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('LATER USER TARGET\n')
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
  expect(test.git(['rev-parse', 'HEAD'])).toBe(head)
})

it('rejects a cold integrate intent whose input preview was replaced by a genuine but unrelated inverse cut', async () => {
  const test = await appliedFixture(), preview = await test.ctx.gitResources.previewIntegration(test.selection)
  const request = { ...test.selection, operationId: GitOperationId('final-misplaced-inverse-cut'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  const cancellation = new AbortController(), gate = freezeIntent(test, request.operationId, cancellation)
  try {
    await expect(test.ctx.gitResources.integrate(request, cancellation.signal, () => {})).rejects.toThrow('actual original intent')
  } finally { gate.mockRestore() }
  const cold = await coldCorruptOperation(test, request.operationId, (operation) => {
    const { integrationPreview: _missingIntegration, ...rest } = operation
    // Actual separately observed reverse facts are deliberately misplaced only in private durable bytes.
    return { ...rest, inversePreview: test.inversePreview }
  })
  const calls = observeGit()
  await expect(cold.ctx.gitResources.integrate(request, edgeSignal, () => {})).rejects.toMatchObject({ code: 'RECORD_INVALID' })
  assertNoGitEffects(calls)
  expect(cold.ctx.gitResources.status(request.operationId)?.operation).toMatchObject({ request,
    fingerprint: cold.pending.operation.fingerprint, externalWriteStarted: false })
  expect(cold.ctx.gitResources.status(request.operationId)?.operation.integrationEffect).toBeUndefined()
  await expect(lstat(cold.pending.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('EDGE RESULT\n')
  expect(JSON.parse(await readFile(cold.backup, 'utf8'))).toEqual(cold.original)
})

it('rejects a cold preserve intent carrying a valid creation request instead of its captured content mode', async () => {
  const test = await edgeFixture()
  const request = { operationId: GitOperationId('final-preserve-request-cut'), resourceId: test.made.resource.resourceId,
    expectedRevision: test.version.resource.revision, content: 'versioned' as const }
  const cancellation = new AbortController(), gate = freezeIntent(test, request.operationId, cancellation)
  try { await expect(test.ctx.gitResources.preserve(request, cancellation.signal)).rejects.toThrow('actual original intent') }
  finally { gate.mockRestore() }
  const cold = await coldCorruptOperation(test, request.operationId, operation => ({ ...operation, request: test.made.operation.request }))
  const calls = observeGit()
  await expect(cold.ctx.gitResources.preserve(request, edgeSignal)).rejects.toMatchObject({ code: 'RECORD_INVALID' })
  assertNoGitEffects(calls)
  expect(cold.ctx.gitResources.status(request.operationId)?.operation.fingerprint).toBe(cold.pending.operation.fingerprint)
  expect(cold.ctx.gitResources.status(request.operationId)?.operation.effectCommit).toBeUndefined()
  expect(cold.ctx.gitResources.status(test.version.operation.operationId)?.operation).toEqual(test.version.operation)
  expect(await readFile(join(test.made.resource.path, 'file.txt'), 'utf8')).toBe('EDGE RESULT\n')
  expect(JSON.parse(await readFile(cold.backup, 'utf8'))).toEqual(cold.original)
})
