/** Exact historical selections and real Git/index divergence reject without repairing external effects. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { GitOperationId, GitResourceId } from '../src/index.ts'
import { inspectIntegration, integrationPreviewSchema, integrationEffectSchema, integrationRequestSchema, integrationConflictIds,
  materializeIntegrationIndex, verifyIntegrationIndex } from '../src/integration.ts'
import type { GitIntegrationEffect } from '../src/integration.ts'
import { abortAfterIntent, edgeFixture, edgeLimits, edgeSignal } from './edge-harness.ts'
import { ResourceGit } from '../src/git.ts'

it('selects an explicit historical base seal and retains its exact independently observed input', async () => {
  const test = await edgeFixture()
  const selected = { ...test.selection, basePreserveOperationId: test.version.operation.operationId }
  const preview = await test.ctx.gitResources.previewIntegration(selected)
  expect(preview.baseInput).toMatchObject({ operationId: test.version.operation.operationId,
    resourceId: test.version.resource.resourceId, tree: test.version.operation.effectTree })
  expect(preview.baseTree).toBe(test.version.operation.effectTree)
  expect(preview.originalTargetBaseTree).toBe(test.made.resource.baselineTree)
  const decoded = integrationPreviewSchema(z.custom<typeof test.identity>()).parse(preview)
  expect(decoded).toEqual(preview)
  expect(() => integrationRequestSchema.parse({ ...selected, operationId: GitOperationId('parsed-integration'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })).not.toThrow()
})

it('refuses a missing or different-resource historical base rather than using the latest resource fields', async () => {
  const test = await edgeFixture(), selected = { ...test.selection, basePreserveOperationId: test.version.operation.operationId }
  await expect(inspectIntegration(test.runner, test.identity, test.made.resource, [test.version], selected,
    edgeSignal, edgeLimits)).rejects.toMatchObject({ code: 'INTEGRATION_BASE_UNAVAILABLE' })
  const moved = { ...test.version, resource: { ...test.version.resource, resourceId: GitResourceId('another-recorded-resource') } }
  await expect(inspectIntegration(test.runner, test.identity, test.made.resource, [test.version], selected,
    edgeSignal, edgeLimits, moved)).rejects.toMatchObject({ code: 'INTEGRATION_BASE_UNAVAILABLE' })
})

it('rejects changed real refs and inconsistent persisted trees/manifests while leaving Git untouched', async () => {
  const test = await edgeFixture(), operation = test.version.operation
  const baselineTree = test.made.resource.baselineTree
  if (operation.effectRef === undefined || operation.effectCommit === undefined || baselineTree === undefined) {
    throw new Error('version ref and actual baseline tree must exist')
  }
  const inspect = (view = test.version) => inspectIntegration(test.runner, test.identity, test.made.resource, [view],
    test.selection, edgeSignal, edgeLimits)
  test.git(['update-ref', operation.effectRef, test.base, operation.effectCommit])
  const changedRefs = test.git(['show-ref']), index = await readFile(join(test.project, '.git', 'index'))
  await expect(test.ctx.gitResources.previewIntegration(test.selection)).rejects.toMatchObject({ code: 'INTEGRATION_VERSION_CHANGED' })
  expect(test.git(['show-ref'])).toBe(changedRefs)
  test.git(['update-ref', operation.effectRef, operation.effectCommit, test.base])
  await expect(inspect({ ...test.version, operation: { ...operation, effectTree: baselineTree } }))
    .rejects.toMatchObject({ code: 'INTEGRATION_VERSION_CHANGED' })
  await expect(inspect({ ...test.version, operation: { ...operation, effectManifestHash: 'persisted-manifest-mismatch' } }))
    .rejects.toMatchObject({ code: 'INTEGRATION_VERSION_CHANGED' })
  const legacy = { ...operation }; delete legacy.effectUnresolvedConflictIds
  expect((await inspect({ ...test.version, operation: legacy })).sources[0]?.operationId).toBe(operation.operationId)
  await expect(inspectIntegration(test.runner, test.identity, test.made.resource, [test.made], test.selection,
    edgeSignal, edgeLimits)).rejects.toMatchObject({ code: 'INTEGRATION_SOURCE_UNAVAILABLE' })
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
})

it.each(['sha1', 'sha256'] as const)('keeps installed %s stages read-only on retry and refuses a later real managed-index change', async (objectFormat) => {
  const test = await edgeFixture(undefined, objectFormat), tree = test.version.operation.effectTree,
    commit = test.version.operation.effectCommit,
    objectId = test.git(['rev-parse', `${test.base}:file.txt`])
  if (tree === undefined || commit === undefined || test.version.operation.effectManifestHash === undefined) throw new Error('actual version tree is required')
  const effect: GitIntegrationEffect = { originalTargetBaseTree: tree, commit, tree,
    manifestHash: test.version.operation.effectManifestHash, result: 'conflicted', attemptedInputCount: 1,
    remainingSourceOperationIds: [], conflictStages: [{ path: 'file.txt', mode: '100644', objectId, stage: 1 }], conflictMessages: [] }
  const worktree = test.version.resource.path
  test.git(['-C', worktree, 'read-tree', tree])
  await materializeIntegrationIndex(test.runner, test.identity, test.version.resource, effect, test.lease, edgeLimits)
  const actualIndex = test.git(['-C', worktree, 'rev-parse', '--git-path', 'index'])
  const bytes = await readFile(actualIndex)
  await materializeIntegrationIndex(test.runner, test.identity, test.version.resource, effect, test.lease, edgeLimits)
  expect(await readFile(actualIndex)).toEqual(bytes)
  await verifyIntegrationIndex(test.runner, test.identity, test.version.resource, effect, edgeSignal, edgeLimits)
  await writeFile(join(worktree, 'late.txt'), 'Later index ownership\n'); test.git(['-C', worktree, 'add', '--', 'late.txt'])
  const changed = await readFile(actualIndex)
  await expect(materializeIntegrationIndex(test.runner, test.identity, test.version.resource, effect, test.lease, edgeLimits))
    .rejects.toMatchObject({ code: 'INTEGRATION_INDEX_CHANGED' })
  await expect(verifyIntegrationIndex(test.runner, test.identity, test.version.resource, effect, edgeSignal, edgeLimits))
    .rejects.toMatchObject({ code: 'INTEGRATION_INDEX_CHANGED' })
  expect(await readFile(actualIndex)).toEqual(changed)
})

describe('an original resolution frozen after durable intent', () => {
  let test: Awaited<ReturnType<typeof edgeFixture>>
  let request: import('../src/integration.ts').GitIntegrationResolutionRequest
  beforeEach(async () => {
    test = await edgeFixture()
    const basePreview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id,
      baseline: { kind: 'commit', commit: test.base } })
    const second = await test.ctx.gitResources.create({ ...basePreview.request, consumerScope: test.selection.consumerScope,
      operationId: GitOperationId('other-resolution-copy'), originalRequestJson: '{}', expectedPreviewFingerprint: basePreview.fingerprint })
    await writeFile(join(second.resource.path, 'file.txt'), 'CONFLICTING OTHER RESULT\n')
    const other = await test.ctx.gitResources.preserve({ operationId: GitOperationId('other-resolution-version'),
      resourceId: second.resource.resourceId, expectedRevision: second.resource.revision, content: 'versioned' })
    const selected = { ...test.selection, sourcePreserveOperationIds: [test.version.operation.operationId, other.operation.operationId] }
    const preview = await test.ctx.gitResources.previewIntegration(selected)
    const integrated = await test.ctx.gitResources.integrate({ ...selected, operationId: GitOperationId('frozen-conflict'),
      originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
    const effect = integrated.operation.integrationEffect
    if (effect === undefined) throw new Error('real resolution fixture requires the original Git conflict')
    await writeFile(join(integrated.resource.path, 'file.txt'), 'EXPLICIT RESOLVED CANDIDATE\n')
    test.git(['-C', integrated.resource.path, 'add', '--', 'file.txt'])
    const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('frozen-resolution-version'),
      resourceId: integrated.resource.resourceId, expectedRevision: integrated.resource.revision, content: 'versioned' })
    const selection = { consumerScope: test.selection.consumerScope, integrationOperationId: integrated.operation.operationId,
      preserveOperationId: sealed.operation.operationId, confirmedConflictIds: integrationConflictIds(effect) }
    const cut = await test.ctx.gitResources.previewResolution(selection)
    request = { ...selection, operationId: GitOperationId('frozen-resolution-intent'), originalRequestJson: '{}',
      expectedPreviewFingerprint: cut.fingerprint }
  })
  it('abandons only its unconfirmed no-effect receipt and keeps retries terminal', async () => {
    const cancellation = new AbortController(), fault = abortAfterIntent(test, request.operationId, cancellation)
    try {
      await expect(test.ctx.gitResources.resolveIntegration(request, cancellation.signal, () => {}))
        .rejects.toThrow('frozen after durable original intent')
    } finally { fault.mockRestore() }
    const before = test.ctx.gitResources.status(request.operationId)
    if (before === undefined) throw new Error('frozen resolution must retain its exact durable intent')
    expect(before.operation).toMatchObject({ externalWriteStarted: false })
    expect(before.operation.resolutionEffect).toBeUndefined()
    const refs = test.git(['show-ref']), index = test.git(['-C', before.resource.path, 'ls-files', '--stage'])
    const abandoned = await test.ctx.gitResources.abandonOperation(request.operationId, before.operation.fingerprint,
      'User stopped before resolution confirmation', edgeSignal, () => {})
    expect(abandoned.operation.phase).toBe('abandoned')
    const run = vi.spyOn(ResourceGit.prototype, 'run')
    try { expect((await test.ctx.gitResources.resolveIntegration(request, edgeSignal, () => {})).operation).toEqual(abandoned.operation) }
    finally { const calls = run.mock.calls.length; run.mockRestore(); expect(calls).toBe(0) }
    expect(test.git(['show-ref'])).toBe(refs); expect(test.git(['-C', before.resource.path, 'ls-files', '--stage'])).toBe(index)
  })
})

it('accepts only an explicitly selected exact resolution receipt for an immutable historical source', async () => {
  const test = await edgeFixture(), operation = test.version.operation, integrationOperationId = GitOperationId('original-conflict')
  if (operation.effectTree === undefined || operation.effectManifestHash === undefined) throw new Error('immutable version has no observed tree')
  const view = { ...test.version, operation: { ...operation, effectIntegrationOperationId: integrationOperationId,
    effectUnresolvedConflictIds: ['known-conflict-id'] } }
  const receipt = { operationId: GitOperationId('exact-historical-resolution'), consumerScope: test.selection.consumerScope,
    phase: 'confirmed' as const, effect: { integrationOperationId, preserveOperationId: operation.operationId,
      resourceId: operation.resourceId, tree: operation.effectTree, manifestHash: operation.effectManifestHash,
      conflictIds: ['known-conflict-id'] } }
  await expect(inspectIntegration(test.runner, test.identity, test.made.resource, [view], test.selection,
    edgeSignal, edgeLimits)).rejects.toMatchObject({ code: 'INTEGRATION_UNRESOLVED' })
  const selected = { ...test.selection, resolutionOperationIds: [receipt.operationId] }
  const wrong = { ...receipt, effect: { ...receipt.effect, conflictIds: ['another-conflict-id'] } }
  await expect(inspectIntegration(test.runner, test.identity, test.made.resource, [view], selected,
    edgeSignal, edgeLimits, undefined, undefined, [wrong])).rejects.toMatchObject({ code: 'INTEGRATION_UNRESOLVED' })
  const resolved = await inspectIntegration(test.runner, test.identity, test.made.resource, [view], selected,
    edgeSignal, edgeLimits, undefined, undefined, [receipt])
  expect(resolved.sources[0]?.resolutionOperationId).toBe(receipt.operationId)
  expect(test.ctx.gitResources.status(operation.operationId)?.operation).toEqual(operation)
})

it('strictly rejects prepared effects with retained stages and parses a genuinely empty-conflict prepared effect', () => {
  const oid = 'a'.repeat(40), value: GitIntegrationEffect = { originalTargetBaseTree: oid, commit: oid, tree: oid,
    manifestHash: 'digest', result: 'prepared', attemptedInputCount: 1, remainingSourceOperationIds: [], conflictStages: [], conflictMessages: [] }
  expect(integrationEffectSchema.parse(value)).toEqual(value)
  expect(() => integrationEffectSchema.parse({ ...value, conflictStages: [{ path: 'file.txt', mode: '100644', objectId: oid, stage: 1 }] }))
    .toThrow('prepared integration retains unresolved inputs or conflict stages')
})
