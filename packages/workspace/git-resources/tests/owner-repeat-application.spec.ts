/** Repeated applications compare the target with its Host-known state: the version line's project start and earlier writes. */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import type { GitApplicationPreviewRequest, GitResourceOperationView, GitResourceRecord } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { coldCorruptOperation } from './owner-corruption-harness.ts'
import { harness, repository } from './harness.ts'

const signal = new AbortController().signal
const scope = GitConsumerScope('repeat-application')

async function fixture() {
  const test = await harness(), base = await repository(test), owner = test.ctx.gitResources
  const copy = async (name: string, commit: string): Promise<GitResourceRecord> => {
    const preview = await owner.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit } })
    return (await owner.create({ ...preview.request, consumerScope: scope, operationId: GitOperationId(`${name}-copy`),
      originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })).resource
  }
  const work = async (name: string, resource: GitResourceRecord, files: Readonly<Record<string, string | null>>) => {
    await owner.withWriteUse(resource.resourceId, { useId: name, ownerId: name, epoch: '1' }, signal, async (lease) => {
      for (const [path, text] of Object.entries(files)) {
        if (text === null) await rm(join(lease.resource.path, path))
        else await writeFile(join(lease.resource.path, path), text)
      }
    })
    const current = owner.read(resource.resourceId)
    if (current === undefined) throw new Error('work copy remains registered')
    return owner.preserve({ operationId: GitOperationId(`${name}-seal`), resourceId: current.resourceId,
      expectedRevision: current.revision, content: 'versioned' })
  }
  /** Integrate one sealed work copy onto itself, then seal the integration copy, optionally after more work on it. */
  const version = async (name: string, sealed: GitResourceOperationView, files?: Readonly<Record<string, string | null>>) => {
    const selection = { consumerScope: scope, baseResourceId: sealed.resource.resourceId,
      sourcePreserveOperationIds: [sealed.operation.operationId] }
    const preview = await owner.previewIntegration(selection)
    const integrated = await owner.integrate({ ...selection, operationId: GitOperationId(`${name}-integration`),
      originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
    const result = await work(`${name}-validated`, integrated.resource, files ?? {})
    const request: GitApplicationPreviewRequest = { consumerScope: scope, integrationOperationId: integrated.operation.operationId,
      preserveOperationId: result.operation.operationId, targetWorkspaceId: test.workspace.id }
    return { integrated, result, request }
  }
  const apply = async (name: string, request: GitApplicationPreviewRequest) => {
    const preview = await owner.previewApplication(request)
    return owner.apply({ ...request, operationId: GitOperationId(`${name}-apply`), originalRequestJson: '{}',
      expectedPreviewFingerprint: preview.fingerprint }, signal, () => {})
  }
  const commitOf = (sealed: GitResourceOperationView) => {
    if (sealed.operation.effectCommit === undefined) throw new Error('seal has its commit')
    return sealed.operation.effectCommit
  }
  const read = (path: string) => readFile(join(test.project, path), 'utf8')
  return { ...test, base, owner, copy, work, version, apply, commitOf, read, baseTree: test.git(['rev-parse', `${base}^{tree}`]) }
}

it('applies work started from an accepted version against the project start, before anything was applied', async () => {
  const test = await fixture()
  const first = await test.version('first', await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n' }))
  // The next copy starts from the first integration's commit, as a code Task with an accepted input does.
  if (first.integrated.operation.integrationEffect === undefined) throw new Error('integration has its effect')
  const next = await test.copy('next', first.integrated.operation.integrationEffect.commit)
  const second = await test.version('second', await test.work('next', next, { 'app.js': 'v2\n', 'notes.md': 'notes\n' }))
  expect(second.integrated.operation.integrationEffect?.originalTargetBaseTree).toBe(test.baseTree)
  const preview = await test.owner.previewApplication(second.request)
  expect(preview.source).toMatchObject({ originalTargetBaseTree: test.baseTree })
  expect(preview.source.written).toBeUndefined()
  expect(preview.target.touched.map(path => path.path)).toEqual(['app.js', 'notes.md'])
  expect((await test.apply('second', second.request)).operation.phase).toBe('confirmed')
  expect(await test.read('app.js')).toBe('v2\n')
})

it('applies a version built on the last application as the change from what that application wrote', async () => {
  const test = await fixture()
  const first = await test.version('first', await test.work('first', await test.copy('first', test.base),
    { 'app.js': 'v1\n', 'removed.txt': null }))
  const applied = await test.apply('first', first.request)
  // The next copy starts from the applied seal, so its version descends from the written result.
  const next = await test.copy('next', test.commitOf(first.result))
  const second = await test.version('second', await test.work('next', next,
    { 'app.js': 'v2\n', 'notes.md': 'notes\n', 'removed.txt': 'restored\n' }))
  const preview = await test.owner.previewApplication(second.request)
  expect(preview.source).toMatchObject({ originalTargetBaseTree: first.result.operation.effectTree,
    written: [{ applicationOperationId: applied.operation.operationId, paths: ['app.js', 'removed.txt'], missing: [] }] })
  expect(preview.replacesWritten).toBeUndefined()
  expect(preview.patch).toContain('-v1\n+v2')
  const latest = await test.apply('second', second.request)
  expect(await test.read('app.js')).toBe('v2\n')
  expect(await test.read('notes.md')).toBe('notes\n')

  // A file the user changed after the last application is named and never overwritten.
  const third = await test.version('third', await test.work('third', await test.copy('third', test.commitOf(second.result)),
    { 'app.js': 'v3\n', 'notes.md': 'notes v3\n' }))
  // The second application rewrote every file the first wrote, so only the second still holds written files.
  expect((await test.owner.previewApplication(third.request)).source.written).toEqual([{
    applicationOperationId: latest.operation.operationId, paths: ['app.js', 'notes.md', 'removed.txt'], missing: [] }])
  await writeFile(join(test.project, 'notes.md'), 'user notes\n')
  await expect(test.owner.previewApplication(third.request)).rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED',
    message: 'Target files changed from the state this version starts from and are not overwritten: notes.md' })
  expect(await test.read('notes.md')).toBe('user notes\n')
})

it('names written files a version not built on the last application replaces or deletes', async () => {
  const test = await fixture()
  const work = await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n', 'removed.txt': null })
  // Validation on the integration copy adds files the applied version carries.
  const first = await test.version('first', work, { 'check.sh': 'check\n', 'notes.md': 'validated\n' })
  await test.apply('first', first.request)
  // A sibling line starts from the accepted work seal, not from the applied validation result. It edits app.js onward
  // from the written v1, which its own commits hold, so only the validation files count as replaced or deleted.
  const sibling = await test.version('sibling', await test.work('sibling', await test.copy('sibling', test.commitOf(work)),
    { 'app.js': 'v2\n', 'notes.md': 'sibling\n' }))
  const preview = await test.owner.previewApplication(sibling.request)
  expect(preview.source.written).toMatchObject([{ paths: ['app.js', 'check.sh', 'notes.md', 'removed.txt'],
    missing: ['check.sh', 'notes.md', 'removed.txt'] }])
  expect(preview.replacesWritten).toEqual({ replaced: ['notes.md'], deleted: ['check.sh'] })
  expect((await test.apply('sibling', sibling.request)).operation.phase).toBe('confirmed')
  await expect(test.read('check.sh')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('waits for an earlier application with possible effects, and ignores one stopped before any write', async () => {
  const test = await fixture()
  const first = await test.version('first', await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n' }))
  const preview = await test.owner.previewApplication(first.request)
  const stopped = { ...first.request, operationId: GitOperationId('stopped-apply'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  // Authority holds when the intent is recorded and is withdrawn before the first write.
  let checks = 0
  await expect(test.owner.apply(stopped, signal, () => { if (++checks > 1) throw new Error('authority withdrawn') }))
    .rejects.toThrow('authority withdrawn')
  expect(test.owner.status(stopped.operationId)?.operation).toMatchObject({ phase: 'needs_attention', externalWriteStarted: false })
  expect((await test.owner.previewApplication(first.request)).fingerprint).toBe(preview.fingerprint)

  const request = { ...first.request, operationId: GitOperationId('unconfirmed-apply'), originalRequestJson: '{}',
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
  await expect(test.owner.apply(request, signal, () => {})).rejects.toThrow('checkpoint failed')
  fault.mockRestore()
  const next = await test.version('next', await test.work('next', await test.copy('next', test.commitOf(first.result)),
    { 'app.js': 'v2\n' }))
  await expect(test.owner.previewApplication(next.request)).rejects.toMatchObject({ code: 'APPLICATION_EFFECT_UNCERTAIN',
    message: 'An earlier application to this target may have written files and is not confirmed: unconfirmed-apply' })
  expect((await test.owner.reconcile(request.operationId)).operation.phase).toBe('confirmed')
  expect((await test.owner.previewApplication(next.request)).source.originalTargetBaseTree).toBe(first.result.operation.effectTree)
})

it('composes the known state from a line started on a later project commit and files an earlier line wrote', async () => {
  const test = await fixture()
  const early = await test.version('early', await test.work('early', await test.copy('early', test.base), { 'a.txt': 'A\n' }))
  await writeFile(join(test.project, 'added.txt'), 'USER COMMIT\n')
  test.git(['rm', '--quiet', '--', 'removed.txt']); test.git(['add', '--', 'added.txt'])
  test.git(['commit', '--quiet', '-m', 'user change after the early line started'])
  const head = test.git(['rev-parse', 'HEAD'])
  const later = await test.version('later', await test.work('later', await test.copy('later', head), { 'b.txt': 'B\n' }))
  await test.apply('early', early.request)
  // Neither the later line's start nor the early result is the known state, so its tree is written for the preview.
  const preview = await test.owner.previewApplication(later.request)
  expect(test.git(['ls-tree', '--name-only', preview.source.originalTargetBaseTree]).split('\n'))
    .toEqual(['a.txt', 'added.txt', 'file.txt'])
  // The later line never held a.txt, so writing it deletes what the early line wrote, and the preview says so.
  expect(preview.target.touched.map(path => path.path)).toEqual(['a.txt', 'b.txt'])
  expect(preview.replacesWritten).toEqual({ replaced: [], deleted: ['a.txt'] })
  expect((await test.apply('later', later.request)).operation.phase).toBe('confirmed')
  expect(await test.read('b.txt')).toBe('B\n')
  expect(await test.read('added.txt')).toBe('USER COMMIT\n')
  expect(test.git(['rev-parse', 'HEAD'])).toBe(head)
})

it('lets an application that stopped before writing retry itself, and does not hold back later ones', async () => {
  const test = await fixture()
  const first = await test.version('first', await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n' }))
  const preview = await test.owner.previewApplication(first.request)
  const request = { ...first.request, operationId: GitOperationId('ref-failed-apply'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  const run: ResourceGit['run'] = Reflect.get(ResourceGit.prototype, 'run')
  const refs = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(function (this: ResourceGit, ...args) {
    if (args[0][0] === 'update-ref') return Promise.reject(new Error('reference write failed'))
    return run.call(this, ...args)
  })
  await expect(test.owner.apply(request, signal, () => {})).rejects.toThrow('reference write failed')
  refs.mockRestore()
  expect(test.owner.status(request.operationId)?.operation).toMatchObject({ phase: 'needs_attention', externalWriteStarted: true })
  // Nothing was written, so an unrelated later version previews normally.
  const other = await test.version('other', await test.work('other', await test.copy('other', test.base), { 'b.txt': 'B\n' }))
  expect((await test.owner.previewApplication(other.request)).source.originalTargetBaseTree).toBe(test.baseTree)
  // The same request rechecks itself without being held back by its own record, then writes.
  expect((await test.owner.apply(request, signal, () => {})).operation.phase).toBe('confirmed')
  expect(await test.read('app.js')).toBe('v1\n')
})

it('abandons an application that never started after another application to the target was confirmed', async () => {
  const test = await fixture()
  const x = await test.version('x', await test.work('x', await test.copy('x', test.base), { 'a.txt': 'A\n' }))
  const preview = await test.owner.previewApplication(x.request)
  const stopped = { ...x.request, operationId: GitOperationId('never-started-apply'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  let checks = 0
  await expect(test.owner.apply(stopped, signal, () => { if (++checks > 1) throw new Error('authority withdrawn') }))
    .rejects.toThrow('authority withdrawn')
  const y = await test.version('y', await test.work('y', await test.copy('y', test.base), { 'b.txt': 'B\n' }))
  expect((await test.apply('y', y.request)).operation.phase).toBe('confirmed')
  const pending = test.owner.status(stopped.operationId)
  if (pending === undefined) throw new Error('the stopped intent is recorded')
  expect((await test.owner.abandonOperation(stopped.operationId, pending.operation.fingerprint, 'Stop the unstarted write-back',
    signal, () => {})).operation.phase).toBe('abandoned')
  await expect(test.read('a.txt')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('holds back later applications while an unconfirmed one cannot be observed', async () => {
  const test = await fixture()
  const first = await test.version('first', await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n' }))
  const preview = await test.owner.previewApplication(first.request)
  const request = { ...first.request, operationId: GitOperationId('unobserved-apply'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  const run: ResourceGit['run'] = Reflect.get(ResourceGit.prototype, 'run')
  const refs = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(function (this: ResourceGit, ...args) {
    if (args[0][0] === 'update-ref') return Promise.reject(new Error('reference write failed'))
    return run.call(this, ...args)
  })
  await expect(test.owner.apply(request, signal, () => {})).rejects.toThrow('reference write failed')
  refs.mockRestore()
  const other = await test.version('other', await test.work('other', await test.copy('other', test.base), { 'b.txt': 'B\n' }))
  const cold = await coldCorruptOperation(test, request.operationId, (operation) => {
    const { applicationPreview: _lost, ...rest } = operation
    return rest
  })
  await expect(cold.ctx.gitResources.previewApplication(other.request)).rejects.toMatchObject({ code: 'APPLICATION_EFFECT_UNCERTAIN',
    message: 'An earlier application to this target may have written files and is not confirmed: unobserved-apply' })
})

it('starts a line from a selected project snapshot, including files the user had not committed', async () => {
  const test = await fixture()
  await writeFile(join(test.project, 'draft.txt'), 'user draft\n')
  const preview = await test.owner.preview({ workspaceId: test.workspace.id,
    baseline: { kind: 'selected', baseCommit: test.base, paths: [{ path: 'draft.txt', source: 'untracked' }] } })
  const copy = (await test.owner.create({ ...preview.request, consumerScope: scope, operationId: GitOperationId('selected-copy'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })).resource
  const version = await test.version('selected', await test.work('selected', copy, { 'draft.txt': 'team draft\n' }))
  const application = await test.owner.previewApplication(version.request)
  expect(application.source.originalTargetBaseTree).toBe(copy.baselineTree)
  expect(application.patch).toContain('-user draft\n+team draft')
})

it('continues a line after an inverse candidate undid a later application', async () => {
  const test = await fixture()
  const x1 = await test.version('x1', await test.work('x1', await test.copy('x1', test.base), { 'f.txt': 'F1\n' }))
  await test.apply('x1', x1.request)
  const x2 = await test.version('x2', await test.work('x2', await test.copy('x2', test.commitOf(x1.result)), { 'g.txt': 'G\n' }))
  const second = await test.apply('x2', x2.request)
  const cut = await test.owner.previewInverse({ consumerScope: scope, applicationOperationId: second.operation.operationId,
    targetWorkspaceId: test.workspace.id })
  const inverse = await test.owner.prepareInverse({ consumerScope: scope, applicationOperationId: second.operation.operationId,
    targetWorkspaceId: test.workspace.id, operationId: GitOperationId('x2-inverse'), originalRequestJson: '{}',
    expectedPreviewFingerprint: cut.fingerprint })
  const undone = await test.work('x2-inverse-validated', inverse.resource, {})
  await test.apply('x2-inverse', { consumerScope: scope, integrationOperationId: inverse.operation.operationId,
    preserveOperationId: undone.operation.operationId, targetWorkspaceId: test.workspace.id })
  await expect(test.read('g.txt')).rejects.toMatchObject({ code: 'ENOENT' })
  const x3 = await test.version('x3', await test.work('x3', await test.copy('x3', test.commitOf(x1.result)), { 'h.txt': 'H\n' }))
  const preview = await test.owner.previewApplication(x3.request)
  expect(preview.target.touched.map(path => path.path)).toEqual(['h.txt'])
  expect(preview.replacesWritten).toBeUndefined()
})

it('names at most twenty changed files and counts the rest', async () => {
  const test = await fixture()
  const files = Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`f${String(index).padStart(2, '0')}.txt`, 'team\n']))
  const first = await test.version('first', await test.work('first', await test.copy('first', test.base), files))
  for (const path of Object.keys(files)) await writeFile(join(test.project, path), 'user\n')
  await expect(test.owner.previewApplication(first.request)).rejects.toThrow(
    `${Object.keys(files).slice(0, 20).join(', ')} and 2 more`)
})

it('reports a damaged version line or earlier application record instead of guessing', async () => {
  const test = await fixture()
  const first = await test.version('first', await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n' }))
  const applied = await test.apply('first', first.request)
  const next = await test.version('next', await test.work('next', await test.copy('next', test.commitOf(first.result)),
    { 'app.js': 'v2\n' }))
  const lost = await coldCorruptOperation(test, applied.operation.operationId, (operation) => {
    const effect = operation.applicationEffect
    if (effect === undefined) throw new Error('confirmed application has its effect')
    return { ...operation, applicationEffect: { ...effect, preview: { ...effect.preview,
      source: { ...effect.preview.source, resultCommit: 'f'.repeat(40) } } } }
  })
  await expect(lost.ctx.gitResources.previewApplication(next.request)).rejects.toMatchObject({ code: 'APPLICATION_SOURCE_UNAVAILABLE' })
  const cyclic = await coldCorruptOperation(lost, next.integrated.operation.operationId, (operation) => {
    const preview = operation.integrationPreview
    if (preview === undefined) throw new Error('integration has its preview')
    return { ...operation, integrationPreview: { ...preview, request: { ...preview.request, baseResourceId: operation.resourceId } } }
  })
  await expect(cyclic.ctx.gitResources.previewApplication(next.request)).rejects.toMatchObject({ code: 'RECORD_INVALID',
    message: 'Managed version line refers back to itself' })
  const baseless = await coldCorruptOperation(cyclic, next.integrated.operation.operationId, (operation) => {
    const { integrationPreview: _lost, ...rest } = operation
    return rest
  })
  await expect(baseless.ctx.gitResources.previewApplication(next.request)).rejects.toMatchObject({ code: 'RECORD_INVALID',
    message: 'Integration has no recorded base resource' })
})

it('starts an inverse candidate line from the target it was prepared on, and reports a lost snapshot', async () => {
  const test = await fixture()
  const first = await test.version('first', await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n' }))
  const applied = await test.apply('first', first.request)
  const cut = await test.owner.previewInverse({ consumerScope: scope, applicationOperationId: applied.operation.operationId,
    targetWorkspaceId: test.workspace.id })
  const inverse = await test.owner.prepareInverse({ consumerScope: scope, applicationOperationId: applied.operation.operationId,
    targetWorkspaceId: test.workspace.id, operationId: GitOperationId('first-inverse'), originalRequestJson: '{}',
    expectedPreviewFingerprint: cut.fingerprint })
  const sealed = await test.work('inverse-validated', inverse.resource, {})
  const request = { consumerScope: scope, integrationOperationId: inverse.operation.operationId,
    preserveOperationId: sealed.operation.operationId, targetWorkspaceId: test.workspace.id }
  const preview = await test.owner.previewApplication(request)
  expect(preview.source.originalTargetBaseTree).toBe(inverse.operation.integrationEffect?.originalTargetBaseTree)
  expect(preview.target.touched.map(path => path.path)).toEqual(['app.js'])
  const lost = await coldCorruptOperation(test, inverse.operation.operationId, (operation) => {
    const { integrationEffect: _lost, ...rest } = operation
    return rest
  })
  await expect(lost.ctx.gitResources.previewIntegration({ consumerScope: scope, baseResourceId: inverse.resource.resourceId,
    sourcePreserveOperationIds: [sealed.operation.operationId] })).rejects.toMatchObject({ code: 'RECORD_INVALID',
    message: 'Inverse candidate has no target snapshot' })
})
