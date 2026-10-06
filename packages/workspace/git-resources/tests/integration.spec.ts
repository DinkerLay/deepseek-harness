/** Real Loader integrations preserve source versions and materialize actual Git conflicts in a new copy. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { decodeIntegrationMerge, integrationConflictIds, integrationEffectSchema,
  integrationResolutionRequestSchema } from '../src/integration.ts'
import type { GitIntegrationEffect, GitIntegrationPreviewRequest } from '../src/integration.ts'
import { harness, repository } from './harness.ts'

const signal = new AbortController().signal
const scope = GitConsumerScope('real-integration-consumer')

async function setup() {
  const test = await harness(), base = await repository(test)
  const create = async (id: string) => {
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    return test.ctx.gitResources.create({ ...preview.request, consumerScope: scope, originalRequestJson: '{}',
      operationId: GitOperationId(`copy-${id}`), expectedPreviewFingerprint: preview.fingerprint })
  }
  const start = await create('base')
  let availableBase = true
  const version = async (id: string, change: (path: string) => Promise<void>, content: 'versioned' | 'all' = 'versioned') => {
    const made = availableBase ? start : await create(id)
    availableBase = false
    await test.ctx.gitResources.withWriteUse(made.resource.resourceId, { useId: id, ownerId: `producer-${id}`, epoch: '1' },
      signal, async (lease) => { lease.assertCurrent(); await change(lease.resource.path) })
    const current = test.ctx.gitResources.read(made.resource.resourceId)
    if (current === undefined) throw new Error('real resource must remain registered')
    return test.ctx.gitResources.preserve({ operationId: GitOperationId(`version-${id}`), resourceId: current.resourceId,
      expectedRevision: current.revision, content })
  }
  const request = async (ids: readonly ReturnType<typeof GitOperationId>[], id: string,
    extra: Partial<GitIntegrationPreviewRequest> = {}) => {
    const selection = { consumerScope: scope, baseResourceId: start.resource.resourceId, sourcePreserveOperationIds: ids, ...extra }
    const preview = await test.ctx.gitResources.previewIntegration(selection)
    return { ...selection, operationId: GitOperationId(id), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }
  }
  return { ...test, base, start, create, version, request }
}

it('previews immutable versions without object/ref/index/domain writes and prepares clean content in a separate copy', async () => {
  const test = await setup()
  const a = await test.version('a', async (path) => { await writeFile(join(path, 'file.txt'), 'LEFT\n') })
  const b = await test.version('b', async (path) => { await writeFile(join(path, 'removed.txt'), 'RIGHT\n') })
  const refs = test.git(['show-ref']), index = await readFile(join(test.project, '.git', 'index'))
  const objects = test.git(['count-objects', '-v']), operations = test.ctx.gitResources.listOperations(scope)
  const request = await test.request([a.operation.operationId, b.operation.operationId], 'clean-integration')
  expect(test.git(['show-ref'])).toBe(refs)
  expect(test.git(['count-objects', '-v'])).toBe(objects)
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
  expect(test.ctx.gitResources.listOperations(scope)).toEqual(operations)
  const integrated = await test.ctx.gitResources.integrate(request)
  expect(integrated.operation.phase).toBe('confirmed')
  expect(integrated.operation.integrationEffect).toMatchObject({ result: 'prepared', attemptedInputCount: 2,
    remainingSourceOperationIds: [], conflictStages: [] })
  expect(await readFile(join(integrated.resource.path, 'file.txt'), 'utf8')).toBe('LEFT\n')
  expect(await readFile(join(integrated.resource.path, 'removed.txt'), 'utf8')).toBe('RIGHT\n')
  expect(test.git(['-C', integrated.resource.path, 'ls-files', '-u'])).toBe('')
  expect(test.git(['rev-parse', 'HEAD'])).toBe(test.base)
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
  expect(await readFile(join(a.resource.path, 'file.txt'), 'utf8')).toBe('LEFT\n')
  const before = test.git(['worktree', 'list', '--porcelain'])
  expect(await test.ctx.gitResources.integrate(request)).toEqual(integrated)
  expect(test.git(['worktree', 'list', '--porcelain'])).toBe(before)
  await expect(test.ctx.gitResources.integrate({ ...request, originalRequestJson: '{"changed":true}' }))
    .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
})

it('retains real content markers and 1/2/3 stages, stops before later inputs and never applies the project', async () => {
  const test = await setup()
  const a = await test.version('text-a', async (path) => { await writeFile(join(path, 'file.txt'), 'LEFT\n') })
  const b = await test.version('text-b', async (path) => { await writeFile(join(path, 'file.txt'), 'RIGHT\n') })
  const later = await test.version('later', async (path) => { await writeFile(join(path, 'removed.txt'), 'Must remain pending\n') })
  const request = await test.request([a.operation.operationId, b.operation.operationId, later.operation.operationId], 'conflict-integration')
  const integrated = await test.ctx.gitResources.integrate(request)
  const effect = integrated.operation.integrationEffect
  if (effect === undefined) throw new Error('actual integration must record its exact merge effect')
  expect(effect).toMatchObject({ result: 'conflicted', attemptedInputCount: 2,
    remainingSourceOperationIds: [later.operation.operationId] })
  expect(effect.conflictStages.map(value => value.stage).sort()).toEqual([1, 2, 3])
  expect(effect.conflictMessages.some(value => value.kind === 'CONFLICT (contents)')).toBe(true)
  expect(integrationConflictIds(effect).length).toBeGreaterThan(0)
  expect(await readFile(join(integrated.resource.path, 'file.txt'), 'utf8')).toContain('<<<<<<<')
  expect(test.git(['-C', integrated.resource.path, 'ls-files', '-u']).split('\n')).toHaveLength(3)
  expect(await readFile(join(integrated.resource.path, 'removed.txt'), 'utf8')).toBe('Remove this deliberately\n')
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  expect(integrated.resource.state).toBe('conflicted')
})

async function resolutionFixture() {
  const test = await setup()
  const a = await test.version('resolution-a', async (path) => { await writeFile(join(path, 'file.txt'), 'LEFT\n') })
  const b = await test.version('resolution-b', async (path) => { await writeFile(join(path, 'file.txt'), 'RIGHT\n') })
  const integrated = await test.ctx.gitResources.integrate(await test.request([a.operation.operationId, b.operation.operationId], 'resolution-original'))
  const effect = integrated.operation.integrationEffect
  if (effect === undefined) throw new Error('original conflict effect must be retained')
  const original = structuredClone(integrated.operation), ids = integrationConflictIds(effect)
  await writeFile(join(integrated.resource.path, 'file.txt'), 'Explicitly chosen final candidate\n')
  test.git(['-C', integrated.resource.path, 'add', '--', 'file.txt'])
  const before = test.ctx.gitResources.read(integrated.resource.resourceId)
  if (before === undefined) throw new Error('original resource remains registered')
  const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('resolution-version'),
    resourceId: before.resourceId, expectedRevision: before.revision, content: 'versioned' })
  const sources = { consumerScope: scope, baseResourceId: test.start.resource.resourceId,
    sourcePreserveOperationIds: [sealed.operation.operationId] }
  const selection = { consumerScope: scope, integrationOperationId: integrated.operation.operationId,
    preserveOperationId: sealed.operation.operationId, confirmedConflictIds: ids }
  return { test, integrated, original, ids, sealed, sources, selection }
}

describe('exact integration resolution', () => {
  let fixture: Awaited<ReturnType<typeof resolutionFixture>> | undefined
  beforeEach(async () => { fixture = await resolutionFixture() })
  const current = () => {
    if (fixture === undefined) throw new Error('real Loader resolution fixture must be prepared')
    return fixture
  }
  it('does not infer readiness from actual stage-zero code or a partial conflict selection', async () => {
    const { test, ids, sealed, sources, selection } = current()
    expect(sealed.operation.effectConflictStages).toEqual([])
    expect(sealed.operation.effectUnresolvedConflictIds).toEqual(ids)
    await expect(test.ctx.gitResources.previewIntegration(sources)).rejects.toMatchObject({ code: 'INTEGRATION_UNRESOLVED' })
    await expect(test.ctx.gitResources.previewResolution({ ...selection, confirmedConflictIds: ids.slice(1) })).rejects.toThrow()
  })
  it('requires Host verification and only authorizes the exact immutable version explicitly selected', async () => {
    const { test, integrated, original, ids, sealed, sources, selection } = current()
    const preview = await test.ctx.gitResources.previewResolution(selection)
    const request = { ...selection, operationId: GitOperationId('resolution-confirmed'), originalRequestJson: '{}',
      expectedPreviewFingerprint: preview.fingerprint }
    await expect(test.ctx.gitResources.resolveIntegration(request, signal, () => { throw new Error('normal verification is not confirmed') }))
      .rejects.toThrow('verification is not confirmed')
    const resolution = await test.ctx.gitResources.resolveIntegration(request, signal, () => {})
    expect(resolution.operation.phase).toBe('confirmed')
    expect(resolution.operation.resolutionEffect).toMatchObject({ preserveOperationId: sealed.operation.operationId,
      tree: sealed.operation.effectTree, conflictIds: ids })
    expect(test.ctx.gitResources.status(integrated.operation.operationId)?.operation).toEqual(original)
    expect(test.ctx.gitResources.status(sealed.operation.operationId)?.operation).toEqual(sealed.operation)
    await expect(test.ctx.gitResources.previewIntegration(sources)).rejects.toMatchObject({ code: 'INTEGRATION_UNRESOLVED' })
    const resolved = await test.ctx.gitResources.previewIntegration({ ...sources,
      resolutionOperationIds: [resolution.operation.operationId] })
    expect(resolved.sources[0]?.resolutionOperationId).toBe(resolution.operation.operationId)
  })
  it('never transfers an old resolution receipt to a later actually sealed version', async () => {
    const { test, integrated, selection, sealed, sources } = current()
    const preview = await test.ctx.gitResources.previewResolution(selection)
    const resolution = await test.ctx.gitResources.resolveIntegration({ ...selection,
      operationId: GitOperationId('resolve-first-version'), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint },
    signal, () => {})
    await writeFile(join(integrated.resource.path, 'file.txt'), 'Later real working version\n')
    test.git(['-C', integrated.resource.path, 'add', '--', 'file.txt'])
    const owned = test.ctx.gitResources.read(integrated.resource.resourceId)
    if (owned === undefined) throw new Error('actual resource must remain available')
    const later = await test.ctx.gitResources.preserve({ operationId: GitOperationId('later-seal'), resourceId: owned.resourceId,
      expectedRevision: owned.revision, content: 'versioned' })
    await expect(test.ctx.gitResources.previewIntegration({ ...sources, sourcePreserveOperationIds: [later.operation.operationId],
      resolutionOperationIds: [resolution.operation.operationId] })).rejects.toMatchObject({ code: 'INTEGRATION_UNRESOLVED' })
    expect(test.ctx.gitResources.status(sealed.operation.operationId)?.operation).toEqual(sealed.operation)
  })
})

it.each(['binary', 'modify-delete'] as const)('retains structured %s conflicts without relying on marker text', async (kind) => {
  const test = await setup()
  const a = await test.version(`${kind}-a`, async (path) => { await writeFile(join(path, 'file.txt'), kind === 'binary' ? '\0LEFT\n' : 'LEFT\n') })
  const b = await test.version(`${kind}-b`, async (path) => {
    if (kind === 'binary') await writeFile(join(path, 'file.txt'), '\0RIGHT\n')
    else test.git(['-C', path, 'rm', '--quiet', '--', 'file.txt'])
  })
  const integrated = await test.ctx.gitResources.integrate(await test.request([a.operation.operationId, b.operation.operationId], `${kind}-integration`))
  const effect = integrated.operation.integrationEffect
  if (effect === undefined) throw new Error('real conflict effect is required')
  expect(effect.result).toBe('conflicted')
  expect(effect.conflictMessages.some(value => value.kind === `CONFLICT (${kind === 'binary' ? 'binary' : 'modify/delete'})`)).toBe(true)
  expect(await readFile(join(integrated.resource.path, 'file.txt'), 'utf8')).not.toContain('<<<<<<<')
  expect(test.git(['-C', integrated.resource.path, 'ls-files', '-u'])).not.toBe('')
})

it('records a real directory-rename split as conflicted even when every actual index entry is stage zero', async () => {
  const test = await harness()
  test.git(['init', '--quiet']); await mkdir(join(test.project, 'old'))
  await writeFile(join(test.project, 'old', 'one.txt'), 'ONE\n')
  await writeFile(join(test.project, 'old', 'two.txt'), 'TWO\n')
  test.git(['add', '--', 'old']); test.git(['commit', '--quiet', '-m', 'directory base'])
  const base = test.git(['rev-parse', 'HEAD'])
  const create = async (id: string) => {
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    return test.ctx.gitResources.create({ ...preview.request, consumerScope: scope, originalRequestJson: '{}',
      operationId: GitOperationId(`directory-${id}`), expectedPreviewFingerprint: preview.fingerprint })
  }
  const start = await create('base'), renamed = await create('renamed'), added = await create('added')
  await mkdir(join(renamed.resource.path, 'left')); await mkdir(join(renamed.resource.path, 'right'))
  test.git(['-C', renamed.resource.path, 'mv', 'old/one.txt', 'left/one.txt'])
  test.git(['-C', renamed.resource.path, 'mv', 'old/two.txt', 'right/two.txt'])
  await writeFile(join(added.resource.path, 'old', 'three.txt'), 'THREE\n')
  test.git(['-C', added.resource.path, 'add', '--', 'old/three.txt'])
  const seal = async (id: string, resourceId: typeof start.resource.resourceId) => {
    const actual = test.ctx.gitResources.read(resourceId)
    if (actual === undefined) throw new Error('real directory input remains registered')
    return test.ctx.gitResources.preserve({ operationId: GitOperationId(id), resourceId, expectedRevision: actual.revision, content: 'versioned' })
  }
  const a = await seal('directory-a', renamed.resource.resourceId), b = await seal('directory-b', added.resource.resourceId)
  const selection = { consumerScope: scope, baseResourceId: start.resource.resourceId,
    sourcePreserveOperationIds: [a.operation.operationId, b.operation.operationId] }
  const preview = await test.ctx.gitResources.previewIntegration(selection)
  const integrated = await test.ctx.gitResources.integrate({ ...selection, operationId: GitOperationId('directory-low-stage'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  const effect = integrated.operation.integrationEffect
  if (effect === undefined) throw new Error('directory conflict must retain the observed effect')
  expect(effect.result).toBe('conflicted')
  expect(effect.conflictStages).toEqual([])
  expect(effect.conflictMessages.some(value => value.kind === 'CONFLICT(directory rename unclear split)')).toBe(true)
  expect(integrationConflictIds(effect)).not.toEqual([])
  expect(test.git(['-C', integrated.resource.path, 'ls-files', '-u'])).toBe('')
  expect(integrated.resource.state).toBe('conflicted')
})

it('refuses an all-content seal, another consumer and a duplicated input rather than guessing a code baseline', async () => {
  const test = await setup()
  const all = await test.version('all', async (path) => { await writeFile(join(path, 'file.txt'), 'All-content history\n') }, 'all')
  const selection = { consumerScope: scope, baseResourceId: test.start.resource.resourceId,
    sourcePreserveOperationIds: [all.operation.operationId] }
  await expect(test.ctx.gitResources.previewIntegration(selection)).rejects.toMatchObject({ code: 'INTEGRATION_SOURCE_UNAVAILABLE' })
  await expect(test.ctx.gitResources.previewIntegration({ ...selection, consumerScope: GitConsumerScope('another-consumer') }))
    .rejects.toMatchObject({ code: 'INTEGRATION_BASE_UNAVAILABLE' })
  await expect(test.ctx.gitResources.previewIntegration({ ...selection,
    sourcePreserveOperationIds: [all.operation.operationId, all.operation.operationId] }))
    .rejects.toMatchObject({ code: 'INTEGRATION_SELECTION_INVALID' })
})

it('checks the actual Host scope before any merge object write and preserves its recoverable intent', async () => {
  const test = await setup()
  const a = await test.version('scope-a', async (path) => { await writeFile(join(path, 'file.txt'), 'Actual input\n') })
  const request = await test.request([a.operation.operationId], 'scope-refused')
  const before = test.git(['count-objects', '-v'])
  await expect(test.ctx.gitResources.integrate(request, signal, () => { throw new Error('Host authority changed') }))
    .rejects.toThrow('authority changed')
  expect(test.git(['count-objects', '-v'])).toBe(before)
  expect(test.ctx.gitResources.status(request.operationId)?.operation.phase).not.toBe('confirmed')
})

const oid = 'a'.repeat(40)
it('parses malformed process metadata fail-closed and never mistakes unsupported status or UTF-8 for clean output', () => {
  for (const value of [Buffer.from(`${oid}\0invalid stage\0\0`), Buffer.from(`${oid}\0\0not-count\0`),
    Buffer.from([oid, '', '2', 'only-one', ''].join('\0')), Buffer.concat([Buffer.from(oid + '\0'), Buffer.from([255])])]) {
    expect(() => decodeIntegrationMerge(value, 1)).toThrow()
  }
  expect(() => decodeIntegrationMerge(Buffer.from(`${oid}\0`), 2)).toThrow()
  const stages = `100644 ${oid} 1\tfile.txt\0`
  expect(() => decodeIntegrationMerge(Buffer.from(`${oid}\0${stages}${stages}\0`), 1)).toThrow()
  expect(() => decodeIntegrationMerge(Buffer.from(`${oid}\0${stages}\0`), 0)).toThrow()
})

it('keeps status1 with no stages unresolved and requires known conflicts in exact independent resolution data', () => {
  const raw = Buffer.from([oid, '', '1', 'old', 'CONFLICT(directory rename unclear split)', 'directory changed', ''].join('\0'))
  const result = decodeIntegrationMerge(raw, 1)
  const effect: GitIntegrationEffect = { originalTargetBaseTree: oid, commit: oid, tree: result.tree,
    manifestHash: 'digest', result: 'conflicted', attemptedInputCount: 1, remainingSourceOperationIds: [],
    conflictStages: result.stages, conflictMessages: result.messages }
  expect(integrationConflictIds(effect)).toHaveLength(1)
  expect(() => integrationConflictIds({ ...effect, conflictMessages: [{ paths: ['old'], kind: 'Unknown future conflict', message: '' }] })).toThrow()
  expect(() => integrationConflictIds({ ...effect, conflictMessages: [] })).toThrow()
  expect(integrationConflictIds({ ...effect, result: 'prepared' })).toEqual([])
  expect(() => integrationEffectSchema.parse({ ...effect, result: 'prepared', remainingSourceOperationIds: [GitOperationId('later')] })).toThrow()
  expect(() => integrationResolutionRequestSchema.parse({ operationId: GitOperationId('resolve'), consumerScope: scope,
    originalRequestJson: 'not-json', integrationOperationId: GitOperationId('original'), preserveOperationId: GitOperationId('version'),
    confirmedConflictIds: ['known'], expectedPreviewFingerprint: 'fingerprint' })).toThrow()
})
