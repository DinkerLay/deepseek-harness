/** Public delivery commands retain their original Git cut and reject unrelated or unattributed effects. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { integrationConflictIds } from '../src/integration.ts'
import { ResourceGit } from '../src/git.ts'
import { hash } from '../src/records.ts'
import { abortAfterIntent, applicationEdgeFixture, edgeFixture, edgeScope, edgeSignal } from './edge-harness.ts'
import { harness } from './harness.ts'

async function conflictFixture() {
  const test = await edgeFixture()
  await writeFile(join(test.made.resource.path, 'file.txt'), 'OTHER RESULT\n')
  const current = test.ctx.gitResources.read(test.made.resource.resourceId)
  if (current === undefined) throw new Error('the first immutable input must retain its actual work copy')
  const version = await test.ctx.gitResources.preserve({ operationId: GitOperationId('delivery-other-version'),
    resourceId: current.resourceId, expectedRevision: current.revision, content: 'versioned' })
  const inputs = { ...test.selection, basePreserveOperationId: test.version.operation.operationId,
    sourcePreserveOperationIds: [version.operation.operationId] }
  const preview = await test.ctx.gitResources.previewIntegration(inputs)
  const integrated = await test.ctx.gitResources.integrate({ ...inputs, operationId: GitOperationId('delivery-conflict'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  const effect = integrated.operation.integrationEffect
  if (effect?.result !== 'conflicted') throw new Error('delivery fixture requires an actual Git conflict')
  await writeFile(join(integrated.resource.path, 'file.txt'), 'CHOSEN RESOLUTION\n')
  test.git(['-C', integrated.resource.path, 'add', '--', 'file.txt'])
  const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('delivery-resolution-version'),
    resourceId: integrated.resource.resourceId, expectedRevision: integrated.resource.revision, content: 'versioned' })
  const selection = { consumerScope: edgeScope, integrationOperationId: integrated.operation.operationId,
    preserveOperationId: sealed.operation.operationId, confirmedConflictIds: integrationConflictIds(effect) }
  const cut = await test.ctx.gitResources.previewResolution(selection)
  const request = { ...selection, operationId: GitOperationId('delivery-resolution'), originalRequestJson: '{}',
    expectedPreviewFingerprint: cut.fingerprint }
  return { ...test, integrated, sealed, selection, request }
}

async function applicationFixture(twoPaths = false) {
  const test = await applicationEdgeFixture(twoPaths ? async (path) => {
    await writeFile(join(path, 'file.txt'), 'EDGE RESULT\n')
    await writeFile(join(path, 'removed.txt'), 'SECOND RESULT\n')
  } : undefined)
  const selection = { consumerScope: edgeScope, integrationOperationId: test.integrated.operation.operationId,
    preserveOperationId: test.sealed.operation.operationId, targetWorkspaceId: test.workspace.id }
  const preview = await test.ctx.gitResources.previewApplication(selection)
  const request = { ...selection, operationId: GitOperationId('delivery-application'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  return { ...test, selection, preview, request }
}

function checkpointFault(test: Awaited<ReturnType<typeof applicationFixture>>, operationId: ReturnType<typeof GitOperationId>) {
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('delivery domain must be open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, put = unit.putRecord.bind(unit)
  const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    const record = args[2]
    if (record !== null && typeof record === 'object' && 'operations' in record && Array.isArray(record.operations)
      && record.operations.some((value: unknown) => value !== null && typeof value === 'object'
        && 'operationId' in value && value.operationId === operationId && 'phase' in value && value.phase === 'confirmed')) {
      throw new Error('delivery final checkpoint unavailable')
    }
    return put(...args)
  })
  onTestFinished(() => { fault.mockRestore() })
  return fault
}

function freezeAfterIntent(test: Omit<Awaited<ReturnType<typeof edgeFixture>>, 'selection'>,
  operationId: ReturnType<typeof GitOperationId>, cancellation: AbortController) {
  return abortAfterIntent({ ...test, selection: { consumerScope: edgeScope, baseResourceId: test.made.resource.resourceId,
    sourcePreserveOperationIds: [test.version.operation.operationId] } }, operationId, cancellation)
}

describe('exact public conflict resolution', () => {
  let test: Awaited<ReturnType<typeof conflictFixture>>
  beforeEach(async () => { test = await conflictFixture() })

  it('requires an explicit base seal and rejects a preservation selected as a resolution receipt', async () => {
    const base = { consumerScope: edgeScope, baseResourceId: test.integrated.resource.resourceId,
      sourcePreserveOperationIds: [test.version.operation.operationId] }
    await expect(test.ctx.gitResources.previewIntegration(base)).rejects.toMatchObject({ code: 'INTEGRATION_UNRESOLVED' })
    await expect(test.ctx.gitResources.previewIntegration({ ...base, basePreserveOperationId: test.sealed.operation.operationId,
      resolutionOperationIds: [test.version.operation.operationId] })).rejects.toMatchObject({ code: 'INTEGRATION_UNRESOLVED' })
    expect(test.ctx.gitResources.status(test.integrated.operation.operationId)?.operation).toEqual(test.integrated.operation)
  })

  it('reuses one confirmed resolution and rejects an altered request under the same identity', async () => {
    const resolved = await test.ctx.gitResources.resolveIntegration(test.request, edgeSignal, () => {})
    expect((await test.ctx.gitResources.resolveIntegration(test.request, edgeSignal, () => {})).operation).toEqual(resolved.operation)
    await expect(test.ctx.gitResources.resolveIntegration({ ...test.request, originalRequestJson: '{"changed":true}' }, edgeSignal, () => {}))
      .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    expect(test.ctx.gitResources.listOperations(edgeScope).filter(value => value.operation.kind === 'resolve')).toHaveLength(1)
  })

  it('does not register a resolution from an obsolete preview fingerprint', async () => {
    await expect(test.ctx.gitResources.resolveIntegration({ ...test.request, expectedPreviewFingerprint: 'old-cut' }, edgeSignal, () => {}))
      .rejects.toMatchObject({ code: 'PREVIEW_CHANGED' })
    expect(test.ctx.gitResources.status(test.request.operationId)).toBeUndefined()
  })

  it('retains the original resolution intent when a later preservation changes its resource revision', async () => {
    const cancellation = new AbortController(), fault = freezeAfterIntent(test, test.request.operationId, cancellation)
    try {
      await expect(test.ctx.gitResources.resolveIntegration(test.request, cancellation.signal, () => {})).rejects.toThrow('durable original intent')
    } finally { fault.mockRestore() }
    const current = test.ctx.gitResources.read(test.integrated.resource.resourceId)
    if (current === undefined) throw new Error('frozen resolution resource must remain registered')
    await test.ctx.gitResources.preserve({ operationId: GitOperationId('later-unchanged-resolution-seal'),
      resourceId: current.resourceId, expectedRevision: current.revision, content: 'versioned' })
    await expect(test.ctx.gitResources.resolveIntegration(test.request, edgeSignal, () => {})).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' })
    expect(test.ctx.gitResources.status(test.request.operationId)?.operation).toMatchObject({ phase: 'needs_attention', externalWriteStarted: false })
    expect(await readFile(join(test.integrated.resource.path, 'file.txt'), 'utf8')).toBe('CHOSEN RESOLUTION\n')
  })

  it.each(['head', 'reference', 'working'] as const)('refuses an actual %s change after the selected immutable resolution seal', async (kind) => {
    if (kind === 'head') test.git(['-C', test.integrated.resource.path, 'commit', '--quiet', '--allow-empty', '-m', 'later actual HEAD'])
    else if (kind === 'reference') {
      if (test.sealed.operation.effectRef === undefined) throw new Error('actual resolution seal requires its managed ref')
      test.git(['update-ref', test.sealed.operation.effectRef, test.base])
    } else await writeFile(join(test.integrated.resource.path, 'file.txt'), 'LATER WORKING INPUT\n')
    await expect(test.ctx.gitResources.previewResolution(test.selection)).rejects.toMatchObject({ code: 'RESOLUTION_VERSION_CHANGED' })
    expect(test.ctx.gitResources.status(test.request.operationId)).toBeUndefined()
  })

  it('rejects an unrelated integration or seal and requires the exact selected resolution for application', async () => {
    await expect(test.ctx.gitResources.previewResolution({ ...test.selection, integrationOperationId: test.version.operation.operationId }))
      .rejects.toMatchObject({ code: 'RESOLUTION_VERSION_UNAVAILABLE' })
    await expect(test.ctx.gitResources.previewResolution({ ...test.selection, preserveOperationId: test.version.operation.operationId }))
      .rejects.toMatchObject({ code: 'RESOLUTION_VERSION_UNAVAILABLE' })
    const application = { consumerScope: edgeScope, integrationOperationId: test.integrated.operation.operationId,
      preserveOperationId: test.sealed.operation.operationId, targetWorkspaceId: test.workspace.id }
    await expect(test.ctx.gitResources.previewApplication(application)).rejects.toMatchObject({ code: 'APPLICATION_SOURCE_UNRESOLVED' })
    await expect(test.ctx.gitResources.previewApplication({ ...application, resolutionOperationId: test.version.operation.operationId }))
      .rejects.toMatchObject({ code: 'APPLICATION_SOURCE_UNRESOLVED' })
    const resolved = await test.ctx.gitResources.resolveIntegration(test.request, edgeSignal, () => {})
    const resolvedApplication = { ...application, resolutionOperationId: resolved.operation.operationId }
    const preview = await test.ctx.gitResources.previewApplication(resolvedApplication)
    const result = await test.ctx.gitResources.apply({ ...application, resolutionOperationId: resolved.operation.operationId,
      operationId: GitOperationId('resolved-delivery-application'), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint },
    edgeSignal, () => {})
    expect(result.operation.applicationEffect?.observation.state).toBe('after')
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('CHOSEN RESOLUTION\n')
  })
})

describe('public application admission and recovery', () => {
  let test: Awaited<ReturnType<typeof applicationFixture>>
  beforeEach(async () => { test = await applicationFixture() })

  it('rejects an unregistered target, foreign scope and an unrelated source or preservation', async () => {
    await expect(test.ctx.gitResources.previewApplication({ ...test.selection, targetWorkspaceId: WorkspaceId('not-registered') }))
      .rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
    await expect(test.ctx.gitResources.previewApplication({ ...test.selection, consumerScope: GitConsumerScope('another-consumer') }))
      .rejects.toMatchObject({ code: 'APPLICATION_SOURCE_UNAVAILABLE' })
    const unrelated = { ...test.selection, integrationOperationId: test.version.operation.operationId }
    await expect(test.ctx.gitResources.previewApplication(unrelated))
      .rejects.toMatchObject({ code: 'APPLICATION_SOURCE_UNAVAILABLE' })
    await expect(test.ctx.gitResources.previewApplication({ ...test.selection, preserveOperationId: test.version.operation.operationId }))
      .rejects.toMatchObject({ code: 'APPLICATION_SOURCE_UNAVAILABLE' })
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  })

  it('rejects a changed immutable application reference without using the current resource as its replacement', async () => {
    if (test.sealed.operation.effectRef === undefined) throw new Error('application seal requires its managed ref')
    test.git(['update-ref', test.sealed.operation.effectRef, test.base])
    await expect(test.ctx.gitResources.previewApplication(test.selection)).rejects.toMatchObject({ code: 'APPLICATION_VERSION_CHANGED' })
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  })

  it('does not register an old target preview after unrelated user index work changes its cut', async () => {
    await writeFile(join(test.project, 'user-stage.txt'), 'User-owned staged content\n')
    test.git(['add', '--', 'user-stage.txt'])
    const index = await readFile(join(test.project, '.git', 'index'))
    await expect(test.ctx.gitResources.apply(test.request, edgeSignal, () => {})).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' })
    expect(test.ctx.gitResources.status(test.request.operationId)).toBeUndefined()
    expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  })

  it('observes a cold original before cut without replay and rejects later fingerprint collisions', async () => {
    const cancellation = new AbortController(), fault = freezeAfterIntent(test, test.request.operationId, cancellation)
    try { await expect(test.ctx.gitResources.apply(test.request, cancellation.signal, () => {})).rejects.toThrow('durable original intent') }
    finally { fault.mockRestore() }
    await test.ctx.fiber.dispose()
    const cold = await harness({}, test.resources)
    const commands = vi.spyOn(ResourceGit.prototype, 'run')
    try {
      const observed = await cold.ctx.gitResources.reconcile(test.request.operationId)
      expect(observed.operation).toMatchObject({ phase: 'needs_attention', applicationObservation: { state: 'before' } })
      expect(commands.mock.calls.some(([args]) => args[0] === 'apply')).toBe(false)
      await expect(cold.ctx.gitResources.apply({ ...test.request, originalRequestJson: '{"changed":true}' }, edgeSignal, () => {}))
        .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    } finally { commands.mockRestore() }
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  })

  it('confirms an actual all-after application on retry after its final durable acknowledgement failed', async () => {
    const fault = checkpointFault(test, test.request.operationId)
    try { await expect(test.ctx.gitResources.apply(test.request, edgeSignal, () => {})).rejects.toThrow('final checkpoint unavailable') }
    finally { fault.mockRestore() }
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('EDGE RESULT\n')
    const commands = vi.spyOn(ResourceGit.prototype, 'run')
    try {
      const recovered = await test.ctx.gitResources.apply(test.request, edgeSignal, () => {})
      expect(recovered.operation).toMatchObject({ phase: 'confirmed', applicationObservation: { state: 'after' } })
      expect(commands.mock.calls.some(([args]) => args[0] === 'apply')).toBe(false)
      await writeFile(join(test.project, 'file.txt'), 'LATER USER WORK\n')
      expect((await test.ctx.gitResources.reconcile(test.request.operationId)).operation).toEqual(recovered.operation)
    } finally { commands.mockRestore() }
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('LATER USER WORK\n')
  })

  it('retains observation errors when original target ownership was actually replaced', async () => {
    const cancellation = new AbortController(), fault = freezeAfterIntent(test, test.request.operationId, cancellation)
    try { await expect(test.ctx.gitResources.apply(test.request, cancellation.signal, () => {})).rejects.toThrow('durable original intent') }
    finally { fault.mockRestore() }
    await rename(test.project, join(test.root, 'retained-original-target'))
    await mkdir(test.project)
    await writeFile(join(test.project, 'file.txt'), 'REPLACEMENT DIRECTORY\n')
    const observed = await test.ctx.gitResources.reconcile(test.request.operationId)
    expect(observed.operation.phase).toBe('needs_attention')
    expect(observed.operation.applicationEffect).toBeUndefined()
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('REPLACEMENT DIRECTORY\n')
    expect(await readFile(join(test.root, 'retained-original-target', 'file.txt'), 'utf8')).toBe('BASE\n')
  })
})

describe('a registered alternate application target', () => {
  let test: Awaited<ReturnType<typeof applicationFixture>>
  beforeEach(async () => { test = await applicationFixture() })
  it('prepares the first inverse resource for another actual worktree of the same repository', async () => {
    const target = join(test.root, 'alternate-user-worktree')
    test.git(['worktree', 'add', '--quiet', '--detach', target, test.base])
    const workspace = await test.ctx.workspaceRegistry.create(target)
    const application = { ...test.selection, targetWorkspaceId: workspace.id }
    const cut = await test.ctx.gitResources.previewApplication(application)
    const applied = await test.ctx.gitResources.apply({ ...application, operationId: GitOperationId('alternate-target-application'),
      originalRequestJson: '{}', expectedPreviewFingerprint: cut.fingerprint }, edgeSignal, () => {})
    const selection = { consumerScope: edgeScope, applicationOperationId: applied.operation.operationId, targetWorkspaceId: workspace.id }
    const preview = await test.ctx.gitResources.previewInverse(selection)
    expect(preview.currentTarget.repository.repositoryId).not.toBe(test.identity.repositoryId)
    const inverse = await test.ctx.gitResources.prepareInverse({ ...selection, operationId: GitOperationId('first-alternate-target-inverse'),
      originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
    expect(inverse.operation).toMatchObject({ phase: 'confirmed', kind: 'inverse' })
    expect(inverse.resource.repositoryId).toBe(preview.currentTarget.repository.repositoryId)
    expect(await readFile(join(inverse.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
    expect(await readFile(join(target, 'file.txt'), 'utf8')).toBe('EDGE RESULT\n')
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  })
})

it.each(['partial', 'unknown', 'unattributed-after'] as const)('does not apply over the actual %s effects of a frozen original target', async (state) => {
  const test = await applicationFixture(true), cancellation = new AbortController()
  const fault = freezeAfterIntent(test, test.request.operationId, cancellation)
  try { await expect(test.ctx.gitResources.apply(test.request, cancellation.signal, () => {})).rejects.toThrow('durable original intent') }
  finally { fault.mockRestore() }
  await writeFile(join(test.project, 'file.txt'), state === 'unknown' ? 'UNKNOWN USER RESULT\n' : 'EDGE RESULT\n')
  if (state === 'unattributed-after') await writeFile(join(test.project, 'removed.txt'), 'SECOND RESULT\n')
  const before = await readFile(join(test.project, 'file.txt'))
  const commands = vi.spyOn(ResourceGit.prototype, 'run')
  try {
    await expect(test.ctx.gitResources.apply(test.request, edgeSignal, () => {})).rejects.toMatchObject({ code: 'APPLICATION_EFFECT_UNCERTAIN' })
    const observed = await test.ctx.gitResources.reconcile(test.request.operationId)
    expect(observed.operation.phase).toBe('needs_attention')
    expect(observed.operation.applicationObservation?.state).toBe(state === 'unattributed-after' ? 'after' : state)
    expect(commands.mock.calls.some(([args]) => args[0] === 'apply')).toBe(false)
  } finally { commands.mockRestore() }
  expect(await readFile(join(test.project, 'file.txt'))).toEqual(before)
})

describe('public inverse candidates', () => {
  let test: Awaited<ReturnType<typeof applicationFixture>>
  let selection: { consumerScope: ReturnType<typeof GitConsumerScope>
    applicationOperationId: ReturnType<typeof GitOperationId>
    targetWorkspaceId: ReturnType<typeof WorkspaceId> }
  beforeEach(async () => {
    test = await applicationFixture()
    await test.ctx.gitResources.apply(test.request, edgeSignal, () => {})
    selection = { consumerScope: edgeScope, applicationOperationId: test.request.operationId, targetWorkspaceId: test.workspace.id }
  })

  it('rejects a different original operation, consumer or target', async () => {
    await expect(test.ctx.gitResources.previewInverse({ ...selection, applicationOperationId: test.sealed.operation.operationId }))
      .rejects.toMatchObject({ code: 'INVERSE_SOURCE_UNAVAILABLE' })
    await expect(test.ctx.gitResources.previewInverse({ ...selection, consumerScope: GitConsumerScope('foreign-inverse') }))
      .rejects.toMatchObject({ code: 'INVERSE_SOURCE_UNAVAILABLE' })
    await expect(test.ctx.gitResources.previewInverse({ ...selection, targetWorkspaceId: WorkspaceId('another-target') }))
      .rejects.toMatchObject({ code: 'INVERSE_SOURCE_UNAVAILABLE' })
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('EDGE RESULT\n')
  })

  it('retains one inverse candidate on retry and rejects a different same-ID original request', async () => {
    const preview = await test.ctx.gitResources.previewInverse(selection)
    const request = { ...selection, operationId: GitOperationId('delivery-inverse'), originalRequestJson: '{}',
      expectedPreviewFingerprint: preview.fingerprint }
    const inverse = await test.ctx.gitResources.prepareInverse(request)
    expect((await test.ctx.gitResources.prepareInverse(request)).operation).toEqual(inverse.operation)
    await expect(test.ctx.gitResources.prepareInverse({ ...request, originalRequestJson: '{"changed":true}' }))
      .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('delivery-inverse-version'),
      resourceId: inverse.resource.resourceId, expectedRevision: inverse.resource.revision, content: 'versioned' })
    const application = await test.ctx.gitResources.previewApplication({ consumerScope: edgeScope,
      integrationOperationId: inverse.operation.operationId, preserveOperationId: sealed.operation.operationId,
      targetWorkspaceId: test.workspace.id })
    expect(application.source.integrationOperationId).toBe(inverse.operation.operationId)
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('EDGE RESULT\n')
    expect(await readFile(join(inverse.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
  })

  it('rejects an obsolete reverse cut without overwriting later user work', async () => {
    const preview = await test.ctx.gitResources.previewInverse(selection)
    await writeFile(join(test.project, 'file.txt'), 'LATER USER REPLACEMENT\n')
    const operationId = GitOperationId('stale-delivery-inverse')
    await expect(test.ctx.gitResources.prepareInverse({ ...selection, operationId, originalRequestJson: '{}',
      expectedPreviewFingerprint: preview.fingerprint })).rejects.toMatchObject({ code: 'PREVIEW_CHANGED' })
    expect(test.ctx.gitResources.status(operationId)).toBeUndefined()
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('LATER USER REPLACEMENT\n')
  })

  it('refuses an unknown path already occupying its deterministic inverse reservation', async () => {
    const preview = await test.ctx.gitResources.previewInverse(selection), operationId = GitOperationId('occupied-delivery-inverse')
    const path = join(test.home, 'git-resources', 'workcopies', hash([preview.currentTarget.repository.repositoryId, operationId]))
    await mkdir(path); await writeFile(join(path, 'sentinel.txt'), 'Unknown ownership must remain\n')
    await expect(test.ctx.gitResources.prepareInverse({ ...selection, operationId, originalRequestJson: '{}',
      expectedPreviewFingerprint: preview.fingerprint })).rejects.toMatchObject({ code: 'RESOURCE_UNKNOWN' })
    expect(test.ctx.gitResources.status(operationId)).toBeUndefined()
    expect(await readFile(join(path, 'sentinel.txt'), 'utf8')).toBe('Unknown ownership must remain\n')
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('EDGE RESULT\n')
  })

  it('abandons a frozen no-effect inverse and returns the same terminal receipt on retry', async () => {
    const preview = await test.ctx.gitResources.previewInverse(selection)
    const request = { ...selection, operationId: GitOperationId('frozen-delivery-inverse'), originalRequestJson: '{}',
      expectedPreviewFingerprint: preview.fingerprint }
    const cancellation = new AbortController(), fault = freezeAfterIntent(test, request.operationId, cancellation)
    try { await expect(test.ctx.gitResources.prepareInverse(request, cancellation.signal)).rejects.toThrow('durable original intent') }
    finally { fault.mockRestore() }
    const original = test.ctx.gitResources.status(request.operationId)
    if (original === undefined) throw new Error('frozen inverse must retain its original intent')
    const abandoned = await test.ctx.gitResources.abandonOperation(request.operationId, original.operation.fingerprint,
      'User stopped before inverse resource writes', edgeSignal, () => {})
    expect((await test.ctx.gitResources.prepareInverse(request)).operation).toEqual(abandoned.operation)
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('EDGE RESULT\n')
  })
})
