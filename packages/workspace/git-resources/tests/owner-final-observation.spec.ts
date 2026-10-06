/** Cold observation of real lost confirmations never repairs files or discards later legal preservation. */
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { repositorySchema } from '../src/records.ts'
import { edgeFixture } from './edge-harness.ts'
import { harness, repository } from './harness.ts'
import { coldCorruptOperation } from './owner-corruption-harness.ts'

function rejectConfirmation(test: Pick<Awaited<ReturnType<typeof harness>>, 'ctx'>,
  operationId: ReturnType<typeof GitOperationId>) {
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('the actual resource domain must be open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, put = unit.putRecord.bind(unit)
  const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    const record = repositorySchema.safeParse(args[2])
    if (record.success && record.data.operations.some(operation => operation.operationId === operationId
      && operation.phase === 'confirmed')) throw new Error('actual final observation receipt was lost')
    return put(...args)
  })
  onTestFinished(() => { fault.mockRestore() })
  return fault
}

async function lostCreation() {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const request = { ...preview.request, consumerScope: GitConsumerScope('final-observation'),
    operationId: GitOperationId('final-observation-create'), originalRequestJson: '{"baseline":"original"}',
    expectedPreviewFingerprint: preview.fingerprint }
  const fault = rejectConfirmation(test, request.operationId)
  try { await expect(test.ctx.gitResources.create(request)).rejects.toThrow('observation receipt was lost') }
  finally { fault.mockRestore() }
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('the actual materialized creation must retain its original intent')
  expect(pending.operation).toMatchObject({ phase: 'needs_attention', worktreeCreateStarted: true, request })
  expect(await readFile(join(pending.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
  return { ...test, request, pending }
}

async function lostConflictedIntegration() {
  const test = await edgeFixture()
  await writeFile(join(test.made.resource.path, 'file.txt'), 'OTHER CONFLICT INPUT\n')
  const current = test.ctx.gitResources.read(test.made.resource.resourceId)
  if (current === undefined) throw new Error('the actual immutable input must retain its resource')
  const other = await test.ctx.gitResources.preserve({ operationId: GitOperationId('final-observation-other'),
    resourceId: current.resourceId, expectedRevision: current.revision, content: 'versioned' })
  const selection = { ...test.selection, basePreserveOperationId: test.version.operation.operationId,
    sourcePreserveOperationIds: [other.operation.operationId] }
  const preview = await test.ctx.gitResources.previewIntegration(selection)
  const request = { ...selection, operationId: GitOperationId('final-observation-conflict'),
    originalRequestJson: '{"integration":"explicit-conflicting-inputs"}', expectedPreviewFingerprint: preview.fingerprint }
  const fault = rejectConfirmation(test, request.operationId)
  try { await expect(test.ctx.gitResources.integrate(request)).rejects.toThrow('observation receipt was lost') }
  finally { fault.mockRestore() }
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending?.operation.integrationEffect?.result !== 'conflicted') throw new Error('a real conflicted Git effect must survive')
  expect(pending.operation.phase).toBe('needs_attention')
  expect(test.git(['-C', pending.resource.path, 'ls-files', '-u']).split('\n')).toHaveLength(3)
  return { ...test, request, pending }
}

async function cut(test: Pick<Awaited<ReturnType<typeof harness>>, 'git' | 'project'>, path: string) {
  return { head: test.git(['rev-parse', 'HEAD']), refs: test.git(['show-ref']),
    objects: test.git(['count-objects', '-v']), worktrees: test.git(['worktree', 'list', '--porcelain']),
    projectIndex: await readFile(join(test.project, '.git', 'index')),
    projectFile: await readFile(join(test.project, 'file.txt')),
    resourceHead: test.git(['-C', path, 'rev-parse', 'HEAD']),
    resourceIndex: await readFile(test.git(['-C', path, 'rev-parse', '--git-path', 'index'])),
    file: await readFile(join(path, 'file.txt')), fileMode: (await stat(join(path, 'file.txt'))).mode & 0o777,
    other: await readFile(join(path, 'removed.txt')) }
}

function observeGit() {
  const calls = vi.spyOn(ResourceGit.prototype, 'run')
  onTestFinished(() => { calls.mockRestore() })
  return calls
}

function noGitWrites(calls: ReturnType<typeof observeGit>) {
  expect(calls.mock.calls.filter(([args]) => ['apply', 'read-tree', 'write-tree', 'commit-tree', 'update-ref',
    'update-index', 'merge-tree'].includes(args[0] ?? '') || args[0] === 'hash-object' && args.includes('-w')
    || args[0] === 'worktree' && (args[1] === 'add' || args[1] === 'remove'))).toEqual([])
}

describe('original materialized creation observation', () => {
  let test: Awaited<ReturnType<typeof lostCreation>>
  beforeEach(async () => { test = await lostCreation() })

  it('refuses a cold missing creation-start witness without adopting or repairing the existing actual worktree', async () => {
    const before = await cut(test, test.pending.resource.path)
    const cold = await coldCorruptOperation(test, test.request.operationId, (operation) => {
      const { worktreeCreateStarted: _missingStartWitness, ...rest } = operation
      return rest
    })
    const calls = observeGit(), observed = await cold.ctx.gitResources.reconcile(test.request.operationId)
    expect(observed.operation).toMatchObject({ phase: 'needs_attention', request: test.request,
      fingerprint: test.pending.operation.fingerprint, effectCommit: test.pending.operation.effectCommit,
      effectTree: test.pending.operation.effectTree, diagnostic: 'Original operation did not start work-copy creation' })
    expect(observed.operation.worktreeCreateStarted).toBeUndefined()
    expect(cold.pending.operation.worktreeCreateStarted).toBe(true)
    expect(JSON.parse(await readFile(cold.backup, 'utf8'))).toEqual(cold.original)
    expect(await cut(test, test.pending.resource.path)).toEqual(before)
    noGitWrites(calls)
  })

  it.each(['bytes', 'mode'] as const)('refuses real later %s changes after a lost creation receipt without replacing them', async (kind) => {
    const path = test.pending.resource.path, file = join(path, 'file.txt')
    if (kind === 'bytes') await writeFile(file, 'ACTUAL LATER USER BYTES\n')
    else await chmod(file, 0o755)
    await test.ctx.fiber.dispose()
    const cold = await harness({}, test.resources), before = await cut(test, path), calls = observeGit()
    const observed = await cold.ctx.gitResources.reconcile(test.request.operationId)
    expect(observed.operation).toMatchObject({ phase: 'needs_attention', request: test.request,
      fingerprint: test.pending.operation.fingerprint, effectCommit: test.pending.operation.effectCommit,
      effectTree: test.pending.operation.effectTree,
      diagnostic: 'Observed work-copy bytes or modes do not match the original baseline' })
    expect(await cut(test, path)).toEqual(before)
    noGitWrites(calls)
  })

  it('confirms an old lost creation receipt without downgrading a later legal preserved resource', async () => {
    const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('final-observation-later-seal'),
      resourceId: test.pending.resource.resourceId, expectedRevision: test.pending.resource.revision, content: 'all' })
    expect(sealed.resource.state).toBe('preserved')
    expect(test.ctx.gitResources.status(test.request.operationId)?.operation.phase).toBe('needs_attention')
    await test.ctx.fiber.dispose()
    const cold = await harness({}, test.resources), before = await cut(test, test.pending.resource.path), calls = observeGit()
    const observed = await cold.ctx.gitResources.reconcile(test.request.operationId)
    expect(observed.operation).toMatchObject({ phase: 'confirmed', request: test.request,
      fingerprint: test.pending.operation.fingerprint, effectCommit: test.pending.operation.effectCommit,
      effectTree: test.pending.operation.effectTree })
    expect(observed.resource).toMatchObject({ state: 'preserved', preservedCommit: sealed.resource.preservedCommit,
      preservedTree: sealed.resource.preservedTree, preservedRef: sealed.resource.preservedRef,
      preservedManifestHash: sealed.resource.preservedManifestHash, preservedHead: sealed.resource.preservedHead,
      preservedContent: 'all', baselineCommit: test.pending.resource.baselineCommit, baselineTree: test.pending.resource.baselineTree })
    expect(cold.ctx.gitResources.status(sealed.operation.operationId)?.operation).toEqual(sealed.operation)
    expect(await cut(test, test.pending.resource.path)).toEqual(before)
    noGitWrites(calls)
  })
})

describe('original conflicted integration observation', () => {
  let test: Awaited<ReturnType<typeof lostConflictedIntegration>>
  beforeEach(async () => { test = await lostConflictedIntegration() })

  it('cold confirms an actually conflicted integration without clearing markers or higher-order index stages', async () => {
    await test.ctx.fiber.dispose()
    const cold = await harness({}, test.resources), before = await cut(test, test.pending.resource.path), calls = observeGit()
    const observed = await cold.ctx.gitResources.reconcile(test.request.operationId)
    expect(observed.operation).toMatchObject({ phase: 'confirmed', request: test.request,
      fingerprint: test.pending.operation.fingerprint, integrationEffect: test.pending.operation.integrationEffect })
    expect(observed.resource.state).toBe('conflicted')
    expect(await readFile(join(observed.resource.path, 'file.txt'), 'utf8')).toContain('<<<<<<<')
    expect(test.git(['-C', observed.resource.path, 'ls-files', '-u']).split('\n')).toHaveLength(3)
    expect(await cut(test, test.pending.resource.path)).toEqual(before)
    noGitWrites(calls)
  })
})
