/** Actual Git user-target application preserves index/branch and inverse preparation never reapplies its source. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { inspectApplication, applyApplication, observeApplication, inspectInverse, prepareInverse } from '../src/application.ts'
import type { GitApplicationSource } from '../src/application.ts'
import { harness } from './harness.ts'

const signal = new AbortController().signal
const limits = { maxFiles: 100, maxFileBytes: 100_000, maxTotalBytes: 1_000_000 }
const sourceScope = GitConsumerScope('actual-application-consumer')

async function setup(onePath = false) {
  const test = await harness(); test.git(['init', '--quiet'])
  const text = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n') + '\n'
  await writeFile(join(test.project, 'file.txt'), text)
  await writeFile(join(test.project, 'removed.txt'), 'Remove this deliberately\n')
  test.git(['add', '--', 'file.txt', 'removed.txt']); test.git(['commit', '--quiet', '-m', 'wide initial target'])
  const base = test.git(['rev-parse', 'HEAD'])
  const basePreview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  if (basePreview.repository === undefined) throw new Error('real project must be a safe repository')
  const made = await test.ctx.gitResources.create({ ...basePreview.request, consumerScope: sourceScope,
    operationId: GitOperationId('application-source-copy'), originalRequestJson: '{}', expectedPreviewFingerprint: basePreview.fingerprint })
  await test.ctx.gitResources.withWriteUse(made.resource.resourceId, { useId: 'source-work', ownerId: 'actual-source', epoch: '1' },
    signal, async (lease) => {
      await writeFile(join(lease.resource.path, 'file.txt'), text.replace('line-2\n', 'APPLIED-2\n'))
      if (!onePath) await writeFile(join(lease.resource.path, 'removed.txt'), 'APPLIED second path\n')
    })
  const resource = test.ctx.gitResources.read(made.resource.resourceId)
  if (resource === undefined) throw new Error('source remains registered')
  const input = await test.ctx.gitResources.preserve({ operationId: GitOperationId('application-source-version'),
    resourceId: resource.resourceId, expectedRevision: resource.revision, content: 'versioned' })
  const selection = { consumerScope: sourceScope, baseResourceId: resource.resourceId,
    sourcePreserveOperationIds: [input.operation.operationId] }
  const preview = await test.ctx.gitResources.previewIntegration(selection)
  const integrated = await test.ctx.gitResources.integrate({ ...selection, operationId: GitOperationId('application-integration'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('application-verified-version'),
    resourceId: integrated.resource.resourceId, expectedRevision: integrated.resource.revision, content: 'versioned' })
  if (sealed.operation.effectCommit === undefined || sealed.operation.effectTree === undefined
    || sealed.operation.effectManifestHash === undefined || integrated.operation.integrationEffect === undefined) {
    throw new Error('actual seal requires complete immutable facts')
  }
  const source: GitApplicationSource = { repository: basePreview.repository, consumerScope: sourceScope,
    integrationOperationId: integrated.operation.operationId, preserveOperationId: sealed.operation.operationId,
    resourceId: integrated.resource.resourceId, originalTargetBaseTree: integrated.operation.integrationEffect.originalTargetBaseTree,
    resultCommit: sealed.operation.effectCommit, resultTree: sealed.operation.effectTree,
    manifestHash: sealed.operation.effectManifestHash }
  const runner = new ResourceGit(test.ctx.subprocess, 'git', join(test.root, 'git-home'), {
    timeoutMs: 10_000, graceMs: 100, maxOutputBytes: 1_000_000 })
  const lease = { signal, assertCurrent: () => {} }
  const scratch = join(test.root, 'inverse-scratch'); await mkdir(scratch)
  return { ...test, runner, source, lease, scratch, text, identity: basePreview.repository }
}

it('applies only the selected plain patch while preserving actual HEAD/ref/index and unrelated staged/untracked input', async () => {
  const test = await setup()
  await writeFile(join(test.project, 'user-note.txt'), 'Staged user ownership\n')
  test.git(['add', '--', 'user-note.txt'])
  await writeFile(join(test.project, 'user-untracked.txt'), 'Untracked user ownership\n')
  const before = await readFile(join(test.project, '.git', 'index')), head = test.git(['rev-parse', 'HEAD']), ref = test.git(['symbolic-ref', 'HEAD'])
  const objects = test.git(['count-objects', '-v']), refs = test.git(['show-ref'])
  const preview = await inspectApplication(test.runner, test.identity, test.source, signal, limits)
  expect(test.git(['count-objects', '-v'])).toBe(objects); expect(test.git(['show-ref'])).toBe(refs)
  const effect = await applyApplication(test.runner, preview, test.lease, limits)
  expect(effect.observation).toMatchObject({ state: 'after', headUnchanged: true, indexUnchanged: true })
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toContain('APPLIED-2')
  expect(await readFile(join(test.project, 'user-note.txt'), 'utf8')).toBe('Staged user ownership\n')
  expect(await readFile(join(test.project, 'user-untracked.txt'), 'utf8')).toBe('Untracked user ownership\n')
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(before)
  expect(test.git(['rev-parse', 'HEAD'])).toBe(head); expect(test.git(['symbolic-ref', 'HEAD'])).toBe(ref)
})

it('publishes the complete real user diff through the owning service and reuses the original confirmed application', async () => {
  const test = await setup()
  const selection = { consumerScope: sourceScope, integrationOperationId: test.source.integrationOperationId,
    preserveOperationId: test.source.preserveOperationId, targetWorkspaceId: test.workspace.id }
  const preview = await test.ctx.gitResources.previewApplication(selection)
  expect(preview.patch).toContain('-line-2\n+APPLIED-2')
  expect(preview.binary).toBe(false)
  const request = { ...selection, operationId: GitOperationId('owning-application'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  const applied = await test.ctx.gitResources.apply(request, signal, () => {})
  expect(applied.operation).toMatchObject({ phase: 'confirmed', applicationEffect: {
    preview: { patch: preview.patch }, observation: { state: 'after', headUnchanged: true, indexUnchanged: true } } })
  await writeFile(join(test.project, 'file.txt'), 'New user edit after the confirmed historical application\n')
  expect((await test.ctx.gitResources.apply(request, signal, () => {})).operation).toEqual(applied.operation)
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('New user edit after the confirmed historical application\n')
})

it('recovers a lost final receipt by observing the same all-after effect without replaying the patch', async () => {
  const test = await setup()
  const selection = { consumerScope: sourceScope, integrationOperationId: test.source.integrationOperationId,
    preserveOperationId: test.source.preserveOperationId, targetWorkspaceId: test.workspace.id }
  const preview = await test.ctx.gitResources.previewApplication(selection)
  const request = { ...selection, operationId: GitOperationId('lost-application-receipt'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('real owning resource domain is open')
  const unit = Reflect.get(domain, 'unit') as import('@deepseek-ai/dsh-storage').KvUnit
  const put = unit.putRecord.bind(unit)
  const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === request.operationId
        && 'phase' in operation && operation.phase === 'confirmed')) throw new Error('final application checkpoint failed')
    return put(...args)
  })
  await expect(test.ctx.gitResources.apply(request, signal, () => {})).rejects.toThrow('checkpoint failed')
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toContain('APPLIED-2')
  expect(test.ctx.gitResources.status(request.operationId)?.operation.phase).not.toBe('confirmed')
  fault.mockRestore()
  const run = vi.spyOn(ResourceGit.prototype, 'run')
  const recovered = await test.ctx.gitResources.reconcile(request.operationId)
  expect(recovered.operation.phase).toBe('confirmed')
  expect(run.mock.calls.some(([args]) => args[0] === 'apply')).toBe(false)
  run.mockRestore()
})

it('rejects a later touched user edit before writing and observes partial/unknown without replay', async () => {
  const test = await setup(), preview = await inspectApplication(test.runner, test.identity, test.source, signal, limits)
  await writeFile(join(test.project, 'file.txt'), 'User changed after preview\n')
  await expect(applyApplication(test.runner, preview, test.lease, limits)).rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED' })
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('User changed after preview\n')
  expect((await observeApplication(test.runner, preview, signal, limits)).state).toBe('unknown')
  await writeFile(join(test.project, 'file.txt'), test.text.replace('line-2\n', 'APPLIED-2\n'))
  expect((await observeApplication(test.runner, preview, signal, limits)).state).toBe('partial')
  expect(await readFile(join(test.project, 'removed.txt'), 'utf8')).toBe('Remove this deliberately\n')
})

it('denies the Host scope immediately before its working write and treats later index changes as unknown', async () => {
  const test = await setup(), preview = await inspectApplication(test.runner, test.identity, test.source, signal, limits)
  await expect(applyApplication(test.runner, preview, { signal, assertCurrent: () => { throw new Error('user range revoked') } }, limits))
    .rejects.toThrow('user range revoked')
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe(test.text)
  expect((await observeApplication(test.runner, preview, signal, limits)).state).toBe('before')
  await writeFile(join(test.project, 'new-user-stage.txt'), 'User staged after preview\n')
  test.git(['add', '--', 'new-user-stage.txt'])
  expect(await observeApplication(test.runner, preview, signal, limits)).toMatchObject({ state: 'unknown', indexUnchanged: false })
})

it.each(['touched', 'index', 'after'] as const)('does not hide a real %s change across patch preflight or external write', async (race) => {
  const test = await setup(true), preview = await inspectApplication(test.runner, test.identity, test.source, signal, limits)
  const run = test.runner.run.bind(test.runner)
  const fault = vi.spyOn(test.runner, 'run').mockImplementation(async (...args) => {
    const result = await run(...args)
    if (args[0][0] === 'apply' && (race === 'after' ? !args[0].includes('--check') : args[0].includes('--check'))) {
      if (race === 'index') {
        await writeFile(join(test.project, 'late-index.txt'), 'User later staged work\n')
        test.git(['add', '--', 'late-index.txt'])
      } else await writeFile(join(test.project, 'file.txt'), 'User change in the actual operation window\n')
    }
    return result
  })
  await expect(applyApplication(test.runner, preview, test.lease, limits)).rejects.toMatchObject({
    code: race === 'after' ? 'APPLICATION_EFFECT_UNCERTAIN' : 'APPLICATION_TARGET_CHANGED' })
  fault.mockRestore()
  if (race !== 'index') expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('User change in the actual operation window\n')
})

it('refuses an independently registered different repository and observes an unchanged no-content selection without writing', async () => {
  const test = await setup()
  const otherPath = join(test.root, 'different-project'); await mkdir(otherPath)
  test.git(['-C', otherPath, 'init', '--quiet'])
  await writeFile(join(otherPath, 'different.txt'), 'Independent real repository\n')
  test.git(['-C', otherPath, 'add', '--', 'different.txt'])
  test.git(['-C', otherPath, 'commit', '--quiet', '-m', 'other repository'])
  const workspace = await test.ctx.workspaceRegistry.create(otherPath)
  const other = await test.ctx.gitResources.preview({ workspaceId: workspace.id,
    baseline: { kind: 'commit', commit: test.git(['-C', otherPath, 'rev-parse', 'HEAD']) } })
  if (other.repository === undefined) throw new Error('other registered sample must be a real repository')
  await expect(inspectApplication(test.runner, other.repository, test.source, signal, limits))
    .rejects.toMatchObject({ code: 'APPLICATION_REPOSITORY_MISMATCH' })
  await test.ctx.gitResources.withWriteUse(test.source.resourceId, { useId: 'unchanged-source', ownerId: 'real-source-owner', epoch: '2' },
    signal, async (scope) => {
      await writeFile(join(scope.resource.path, 'file.txt'), test.text)
      await writeFile(join(scope.resource.path, 'removed.txt'), 'Remove this deliberately\n')
    })
  const current = test.ctx.gitResources.read(test.source.resourceId)
  if (current === undefined) throw new Error('actual code resource remains registered')
  const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('unchanged-real-version'),
    resourceId: current.resourceId, expectedRevision: current.revision, content: 'versioned' })
  if (sealed.operation.effectCommit === undefined || sealed.operation.effectTree === undefined
    || sealed.operation.effectManifestHash === undefined) throw new Error('no-content seal must still have actual immutable facts')
  const preview = await inspectApplication(test.runner, test.identity, { ...test.source,
    preserveOperationId: sealed.operation.operationId, resultCommit: sealed.operation.effectCommit,
    resultTree: sealed.operation.effectTree, manifestHash: sealed.operation.effectManifestHash }, signal, limits)
  const before = test.git(['status', '--porcelain'])
  expect((await applyApplication(test.runner, preview, test.lease, limits)).observation.state).toBe('after')
  expect(test.git(['status', '--porcelain'])).toBe(before)
})

it('prepares inverse from the current touched snapshot, retains later independent edits and never changes the user target', async () => {
  const test = await setup(), preview = await inspectApplication(test.runner, test.identity, test.source, signal, limits)
  const original = await applyApplication(test.runner, preview, test.lease, limits)
  const current = test.text.replace('line-2\n', 'APPLIED-2\n').replace('line-10\n', 'USER-LATER-10\n')
  await writeFile(join(test.project, 'file.txt'), current)
  const before = await readFile(join(test.project, '.git', 'index')), head = test.git(['rev-parse', 'HEAD'])
  const inverse = await inspectInverse(test.runner, original, GitOperationId('original-application'), signal, limits)
  const effect = await prepareInverse(test.runner, inverse, GitOperationId('actual-inverse'), '2026-10-06T00:00:00.000Z',
    test.scratch, test.lease, limits)
  expect(effect.result).toBe('prepared')
  const material = test.git(['show', `${effect.tree}:file.txt`])
  expect(material).not.toContain('APPLIED-2'); expect(material).toContain('USER-LATER-10')
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe(current)
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(before)
  expect(test.git(['rev-parse', 'HEAD'])).toBe(head)
})

it('keeps a conflicting later edit as inverse conflict material, not a rollback overwrite', async () => {
  const test = await setup(), preview = await inspectApplication(test.runner, test.identity, test.source, signal, limits)
  const original = await applyApplication(test.runner, preview, test.lease, limits)
  const later = test.text.replace('line-2\n', 'USER-REPLACED-APPLIED-LINE\n')
  await writeFile(join(test.project, 'file.txt'), later)
  const inverse = await inspectInverse(test.runner, original, GitOperationId('old-conflicting-application'), signal, limits)
  const effect = await prepareInverse(test.runner, inverse, GitOperationId('conflicting-inverse'), '2026-10-06T00:00:00.000Z',
    test.scratch, test.lease, limits)
  expect(effect.result).toBe('conflicted')
  expect(effect.conflictStages.length).toBeGreaterThan(0)
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe(later)
})

it('creates an owning inverse work copy from the current target without reapplying or modifying that target', async () => {
  const test = await setup(true)
  const application = { consumerScope: sourceScope, integrationOperationId: test.source.integrationOperationId,
    preserveOperationId: test.source.preserveOperationId, targetWorkspaceId: test.workspace.id }
  const selected = await test.ctx.gitResources.previewApplication(application)
  const original = await test.ctx.gitResources.apply({ ...application, operationId: GitOperationId('inverse-original-applied'),
    originalRequestJson: '{}', expectedPreviewFingerprint: selected.fingerprint }, signal, () => {})
  const current = test.text.replace('line-2\n', 'APPLIED-2\n').replace('line-10\n', 'USER-CURRENT-10\n')
  await writeFile(join(test.project, 'file.txt'), current)
  const selection = { consumerScope: sourceScope, applicationOperationId: original.operation.operationId,
    targetWorkspaceId: test.workspace.id }
  const preview = await test.ctx.gitResources.previewInverse(selection)
  const inverse = await test.ctx.gitResources.prepareInverse({ ...selection, operationId: GitOperationId('owning-inverse-copy'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }, signal, () => {})
  expect(inverse.operation).toMatchObject({ kind: 'inverse', phase: 'confirmed', integrationEffect: { result: 'prepared' } })
  expect(await readFile(join(inverse.resource.path, 'file.txt'), 'utf8')).toBe(test.text.replace('line-10\n', 'USER-CURRENT-10\n'))
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe(current)
  expect(inverse.operation.integrationEffect?.originalTargetBaseTree).not.toBe(test.source.originalTargetBaseTree)
})
