/** Exact resolution selections survive replay; cold metadata faults never invent new Git authority. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { integrationConflictIds } from '../src/integration.ts'
import { abortAfterIntent, edgeFixture, edgeScope, edgeSignal } from './edge-harness.ts'
import { harness } from './harness.ts'
import { coldCorruptOperation } from './owner-corruption-harness.ts'

async function resolutionFixture() {
  const test = await edgeFixture()
  await writeFile(join(test.made.resource.path, 'file.txt'), 'OTHER VERSION\n')
  const current = test.ctx.gitResources.read(test.made.resource.resourceId)
  if (current === undefined) throw new Error('the real input resource must remain registered')
  const other = await test.ctx.gitResources.preserve({ operationId: GitOperationId('replay-other-version'),
    resourceId: current.resourceId, expectedRevision: current.revision, content: 'versioned' })
  const inputs = { ...test.selection, basePreserveOperationId: test.version.operation.operationId,
    sourcePreserveOperationIds: [other.operation.operationId] }
  const preview = await test.ctx.gitResources.previewIntegration(inputs)
  const integrated = await test.ctx.gitResources.integrate({ ...inputs, operationId: GitOperationId('replay-conflicted'),
    originalRequestJson: '{"selection":"original-conflict"}', expectedPreviewFingerprint: preview.fingerprint })
  const effect = integrated.operation.integrationEffect
  if (effect?.result !== 'conflicted') throw new Error('the fixture requires actual Git conflict stages')
  await writeFile(join(integrated.resource.path, 'file.txt'), 'EXPLICIT RESOLUTION\n')
  test.git(['-C', integrated.resource.path, 'add', '--', 'file.txt'])
  const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('replay-resolution-seal'),
    resourceId: integrated.resource.resourceId, expectedRevision: integrated.resource.revision, content: 'versioned' })
  const selection = { consumerScope: edgeScope, integrationOperationId: integrated.operation.operationId,
    preserveOperationId: sealed.operation.operationId, confirmedConflictIds: integrationConflictIds(effect) }
  const cut = await test.ctx.gitResources.previewResolution(selection)
  const request = { ...selection, operationId: GitOperationId('replay-resolution'),
    originalRequestJson: '{"selection":"exact-sealed-conflicts"}', expectedPreviewFingerprint: cut.fingerprint }
  return { ...test, integrated, sealed, resolutionSelection: selection, request }
}

async function projectCut(test: Awaited<ReturnType<typeof resolutionFixture>>) {
  return { head: test.git(['rev-parse', 'HEAD']), refs: test.git(['show-ref']),
    worktrees: test.git(['worktree', 'list', '--porcelain']), objects: test.git(['count-objects', '-v']),
    index: await readFile(join(test.project, '.git', 'index')), file: await readFile(join(test.project, 'file.txt')) }
}

describe('real resolution selection and cold replay', () => {
  let test: Awaited<ReturnType<typeof resolutionFixture>>
  beforeEach(async () => { test = await resolutionFixture() })

  it.each(['base', 'source'] as const)('integrates an explicitly resolved exact version as the new %s', async (kind) => {
    const resolved = await test.ctx.gitResources.resolveIntegration(test.request, edgeSignal, () => {})
    const selection = { consumerScope: edgeScope,
      baseResourceId: kind === 'base' ? test.integrated.resource.resourceId : test.made.resource.resourceId,
      ...kind === 'base' ? { basePreserveOperationId: test.sealed.operation.operationId } : {},
      sourcePreserveOperationIds: [test.sealed.operation.operationId],
      resolutionOperationIds: [resolved.operation.operationId] }
    const preview = await test.ctx.gitResources.previewIntegration(selection)
    const index = await readFile(join(test.project, '.git', 'index'))
    const request = { ...selection, operationId: GitOperationId(`replay-resolved-${kind}`),
      originalRequestJson: JSON.stringify({ kind, selectedReceipt: resolved.operation.operationId }),
      expectedPreviewFingerprint: preview.fingerprint }
    const next = await test.ctx.gitResources.integrate(request)
    expect(next.operation.phase).toBe('confirmed')
    expect(next.operation.request).toEqual(request)
    expect(next.operation.integrationPreview).toEqual(preview)
    expect(preview.sources[0]?.resolutionOperationId).toBe(resolved.operation.operationId)
    if (kind === 'base') expect(preview.baseInput?.resolutionOperationId).toBe(resolved.operation.operationId)
    expect(await readFile(join(next.resource.path, 'file.txt'), 'utf8')).toBe('EXPLICIT RESOLUTION\n')
    expect(test.ctx.gitResources.status(test.integrated.operation.operationId)?.operation).toEqual(test.integrated.operation)
    expect(test.ctx.gitResources.status(test.sealed.operation.operationId)?.operation).toEqual(test.sealed.operation)
    expect(test.ctx.gitResources.status(resolved.operation.operationId)?.operation).toEqual(resolved.operation)
    expect(test.git(['rev-parse', 'HEAD'])).toBe(test.base)
    expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  })

  it('abandons only the original unstarted application with its exact selected resolution receipt', async () => {
    const resolved = await test.ctx.gitResources.resolveIntegration(test.request, edgeSignal, () => {})
    const selection = { consumerScope: edgeScope, integrationOperationId: test.integrated.operation.operationId,
      preserveOperationId: test.sealed.operation.operationId, resolutionOperationId: resolved.operation.operationId,
      targetWorkspaceId: test.workspace.id }
    const preview = await test.ctx.gitResources.previewApplication(selection)
    const request = { ...selection, operationId: GitOperationId('replay-unstarted-resolved-apply'),
      originalRequestJson: '{"apply":"resolved-version"}', expectedPreviewFingerprint: preview.fingerprint }
    const cancellation = new AbortController(), fault = abortAfterIntent(test, request.operationId, cancellation)
    try {
      await expect(test.ctx.gitResources.apply(request, cancellation.signal, () => {})).rejects.toThrow('durable original intent')
    } finally { fault.mockRestore() }
    const pending = test.ctx.gitResources.status(request.operationId)
    if (pending === undefined) throw new Error('the original unstarted application intent must survive')
    expect(pending.operation.externalWriteStarted).toBe(false)
    const before = await projectCut(test)
    const abandoned = await test.ctx.gitResources.abandonOperation(request.operationId, pending.operation.fingerprint,
      'The exact resolved application was never started')
    expect(abandoned.operation).toMatchObject({ phase: 'abandoned', externalWriteStarted: false, request,
      fingerprint: pending.operation.fingerprint, applicationPreview: preview })
    expect(abandoned.operation.applicationEffect).toBeUndefined()
    expect(await projectCut(test)).toEqual(before)
    expect(test.ctx.gitResources.status(test.integrated.operation.operationId)?.operation).toEqual(test.integrated.operation)
    expect(test.ctx.gitResources.status(test.sealed.operation.operationId)?.operation).toEqual(test.sealed.operation)
    expect(test.ctx.gitResources.status(resolved.operation.operationId)?.operation).toEqual(resolved.operation)
  })

  it('refuses a cold seal missing conflict metadata without changing its original effect or interpreting it as resolved', async () => {
    const before = await projectCut(test)
    const cold = await coldCorruptOperation(test, test.sealed.operation.operationId, (operation) => {
      const { effectUnresolvedConflictIds: _missingConflictIds, ...rest } = operation
      return rest
    })
    const calls = vi.spyOn(ResourceGit.prototype, 'run')
    try {
      await expect(cold.ctx.gitResources.previewResolution(test.resolutionSelection))
        .rejects.toMatchObject({ code: 'RESOLUTION_CONFLICT_SELECTION' })
      expect(calls).not.toHaveBeenCalled()
      const observed = cold.ctx.gitResources.status(test.sealed.operation.operationId)
      expect(observed?.operation).toMatchObject({ request: test.sealed.operation.request,
        fingerprint: test.sealed.operation.fingerprint, effectCommit: test.sealed.operation.effectCommit,
        effectTree: test.sealed.operation.effectTree, effectRef: test.sealed.operation.effectRef,
        effectManifestHash: test.sealed.operation.effectManifestHash })
      expect(observed?.operation.effectUnresolvedConflictIds).toBeUndefined()
      expect(cold.ctx.gitResources.status(test.integrated.operation.operationId)?.operation).toEqual(test.integrated.operation)
      expect(cold.ctx.gitResources.status(test.request.operationId)).toBeUndefined()
      expect(JSON.parse(await readFile(cold.backup, 'utf8'))).toEqual(cold.original)
      expect(await projectCut(test)).toEqual(before)
      expect(await readFile(join(test.integrated.resource.path, 'file.txt'), 'utf8')).toBe('EXPLICIT RESOLUTION\n')
    } finally { calls.mockRestore() }
  })

  it.each(['unstarted', 'confirmed'] as const)('cold reconcile of a %s resolution only returns the original receipt', async (phase) => {
    if (phase === 'confirmed') await test.ctx.gitResources.resolveIntegration(test.request, edgeSignal, () => {})
    else {
      const cancellation = new AbortController(), fault = abortAfterIntent(test, test.request.operationId, cancellation)
      try {
        await expect(test.ctx.gitResources.resolveIntegration(test.request, cancellation.signal, () => {}))
          .rejects.toThrow('durable original intent')
      } finally { fault.mockRestore() }
    }
    await writeFile(join(test.integrated.resource.path, 'file.txt'), 'LATER UNSEALED WORK\n')
    await test.ctx.fiber.dispose()
    const cold = await harness({}, test.resources), pending = cold.ctx.gitResources.status(test.request.operationId)
    if (pending === undefined) throw new Error('the legal original resolution receipt must survive the new Loader')
    const before = await projectCut(test), calls = vi.spyOn(ResourceGit.prototype, 'run')
    try {
      const observed = await cold.ctx.gitResources.reconcile(test.request.operationId)
      expect(observed).toEqual(pending)
      expect(observed.operation.request).toEqual(test.request)
      expect(observed.operation.phase).toBe(phase === 'confirmed' ? 'confirmed' : 'needs_attention')
      expect(calls).not.toHaveBeenCalled()
      expect(await projectCut(test)).toEqual(before)
      expect(await readFile(join(test.integrated.resource.path, 'file.txt'), 'utf8')).toBe('LATER UNSEALED WORK\n')
      expect(cold.ctx.gitResources.status(test.integrated.operation.operationId)?.operation).toEqual(test.integrated.operation)
      expect(cold.ctx.gitResources.status(test.sealed.operation.operationId)?.operation).toEqual(test.sealed.operation)
    } finally { calls.mockRestore() }
  })
})
