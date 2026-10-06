/** Code seals exclude ignored content; directory preservation and detached commits remain explicit facts. */
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { harness, repository } from './harness.ts'

const consumer = { consumerScope: GitConsumerScope('preservation-fixture'), originalRequestJson: '{}' }
async function create(test: Awaited<ReturnType<typeof harness>>, base: string) {
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  expect(preview.permitted).toBe(true)
  return test.ctx.gitResources.create({ ...preview.request, ...consumer, operationId: GitOperationId('preservation-base'),
    expectedPreviewFingerprint: preview.fingerprint })
}

describe('versioned code and explicit all-content preservation', () => {
  it('retains bounded original consumer JSON without interpreting it or permitting same-id replacement', async () => {
    const test = await harness({ maxConsumerRequestBytes: 64 }), base = await repository(test), made = await create(test, base)
    const request = { operationId: GitOperationId('correlated-preserve'), resourceId: made.resource.resourceId,
      expectedRevision: made.resource.revision, originalRequestJson: '{"userRevision":1,"actor":"opaque-user"}' }
    await expect(test.ctx.gitResources.preserve({ ...request, originalRequestJson: 'not-json' }))
      .rejects.toMatchObject({ code: 'CONSUMER_REQUEST_INVALID' })
    await expect(test.ctx.gitResources.preserve({ ...request, originalRequestJson: JSON.stringify('x'.repeat(65)) }))
      .rejects.toMatchObject({ code: 'CONSUMER_REQUEST_INVALID' })
    expect(test.ctx.gitResources.status(request.operationId)).toBeUndefined()
    const preserved = await test.ctx.gitResources.preserve(request)
    expect(preserved.operation.request).toMatchObject({ originalRequestJson: request.originalRequestJson, content: 'versioned' })
    await expect(test.ctx.gitResources.preserve({ ...request, originalRequestJson: '{"userRevision":2,"actor":"opaque-user"}' }))
      .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    expect(await test.ctx.gitResources.preserve(request)).toEqual(preserved)
  })
  it('does not read or hash ignored dependencies or credential-shaped files and records remaining directories', async () => {
    const test = await harness({ maxFileBytes: 128 }), initial = await repository(test)
    await writeFile(join(test.project, '.gitignore'), 'node_modules/\ndist/\n.env\n')
    test.git(['add', '--', '.gitignore']); test.git(['commit', '--quiet', '-m', 'declare ignored outputs'])
    const base = test.git(['rev-parse', 'HEAD']), originalIndex = await readFile(join(test.project, '.git', 'index'))
    expect(base).not.toBe(initial)
    const made = await create(test, base), path = made.resource.path
    expect(test.git(['-C', path, 'ls-files']).split('\n')).toEqual(['.gitignore', 'file.txt', 'removed.txt'])
    await mkdir(join(path, 'node_modules')); await mkdir(join(path, 'dist'))
    const ignored = Buffer.alloc(4096, 'x')
    await writeFile(join(path, 'node_modules', 'dependency.js'), ignored)
    await writeFile(join(path, 'dist', 'compiled.js'), ignored)
    await writeFile(join(path, '.env'), 'DO-NOT-READ-OR-HASH-THIS\n')
    await writeFile(join(path, 'extra.ts'), 'actual code\n')
    const commands = vi.spyOn(ResourceGit.prototype, 'run')
    commands.mockClear()
    const request = { operationId: GitOperationId('versioned'), resourceId: made.resource.resourceId,
      expectedRevision: made.resource.revision }
    const sealed = await test.ctx.gitResources.preserve(request)
    expect(sealed.operation).toMatchObject({ phase: 'confirmed', effectContent: 'versioned',
      request: { content: 'versioned' }, unpreservedPaths: ['.env', 'dist/', 'node_modules/'] })
    expect(sealed.resource).toMatchObject({ preservedContent: 'versioned', unpreservedPaths: sealed.operation.unpreservedPaths })
    expect(test.git(['ls-tree', '-r', '--name-only', sealed.operation.effectTree!]).split('\n'))
      .toEqual(['.gitignore', 'extra.ts', 'file.txt', 'removed.txt'])
    const hashed = commands.mock.calls.filter(([args]) => args[0] === 'hash-object').map(([, , , options]) => options?.input)
    expect(hashed).toHaveLength(4)
    expect(hashed.some(bytes => bytes?.equals(ignored) || bytes?.includes('DO-NOT-READ'))).toBe(false)
    expect(await test.ctx.gitResources.preserve({ ...request, content: 'versioned' })).toEqual(sealed)
    expect(await readFile(join(test.project, '.git', 'index'))).toEqual(originalIndex)
    expect(test.git(['rev-parse', 'HEAD'])).toBe(base)
    await expect(test.ctx.gitResources.preserve({ operationId: GitOperationId('explicit-all-refuses-protected'),
      resourceId: sealed.resource.resourceId, expectedRevision: sealed.resource.revision, content: 'all' }))
      .rejects.toMatchObject({ code: 'PROTECTED_PATH' })
    // A code seal is not evidence that these remaining contents may be deleted.
    expect(await readFile(join(path, '.env'), 'utf8')).toBe('DO-NOT-READ-OR-HASH-THIS\n')
    expect(test.ctx.gitResources.status(request.operationId)?.operation.unpreservedPaths).toEqual(['.env', 'dist/', 'node_modules/'])
    commands.mockRestore()
  })

  it('keeps immutable mode/remaining facts when a later all-content preservation is made', async () => {
    const test = await harness(), base = await repository(test), made = await create(test, base)
    await writeFile(join(made.resource.path, '.gitignore'), 'output/\n')
    await mkdir(join(made.resource.path, 'output')); await writeFile(join(made.resource.path, 'output', 'generated.txt'), 'generated bytes\n')
    const code = await test.ctx.gitResources.preserve({ operationId: GitOperationId('code'), resourceId: made.resource.resourceId,
      expectedRevision: made.resource.revision })
    expect(code.operation).toMatchObject({ effectContent: 'versioned', unpreservedPaths: ['output/'] })
    const all = await test.ctx.gitResources.preserve({ operationId: GitOperationId('all'), resourceId: made.resource.resourceId,
      expectedRevision: code.resource.revision, content: 'all' })
    expect(all.operation).toMatchObject({ effectContent: 'all', unpreservedPaths: [] })
    expect(test.git(['show', `${all.operation.effectCommit}:output/generated.txt`])).toBe('generated bytes')
    expect(test.ctx.gitResources.status(code.operation.operationId)?.operation)
      .toMatchObject({ effectContent: 'versioned', unpreservedPaths: ['output/'] })
    expect(test.ctx.gitResources.read(made.resource.resourceId)?.preservedContent).toBe('all')
  })

  it.each(['.gitignore', 'nested/.gitignore', '.git/info/exclude'])('rejects linked local ignore source %s before evaluating it', async (path) => {
    const test = await harness(), base = await repository(test), outside = join(test.root, 'outside-ignore')
    await writeFile(outside, '*.txt\n')
    await mkdir(join(test.project, 'nested'), { recursive: true })
    if (path === '.git/info/exclude') await rm(join(test.project, path))
    await symlink(outside, join(test.project, path))
    const calls = vi.spyOn(ResourceGit.prototype, 'run')
    calls.mockClear()
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    expect(preview).toMatchObject({ permitted: false, risks: ['IGNORE_SOURCE_UNSAFE'] })
    expect(calls.mock.calls.some(([args]) => args[0] === 'status' || args[0] === 'ls-files')).toBe(false)
    expect(await readFile(outside, 'utf8')).toBe('*.txt\n')
    calls.mockRestore()
  })

  it('overrides an external core.excludesFile instead of reading it or omitting ordinary code', async () => {
    const test = await harness(), base = await repository(test), outside = join(test.root, 'external-ignore')
    await writeFile(outside, 'new-code.ts\n'); test.git(['config', 'core.excludesFile', outside])
    await writeFile(join(test.project, 'new-code.ts'), 'new code\n')
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    expect(preview).toMatchObject({ permitted: true, dirty: { untracked: ['new-code.ts'] } })
    const made = await test.ctx.gitResources.create({ ...preview.request, ...consumer, operationId: GitOperationId('external-exclude'),
      expectedPreviewFingerprint: preview.fingerprint })
    await writeFile(join(made.resource.path, 'new-code.ts'), 'actual work-copy code\n')
    const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('external-exclude-seal'),
      resourceId: made.resource.resourceId, expectedRevision: made.resource.revision })
    expect(test.git(['show', `${sealed.operation.effectCommit}:new-code.ts`])).toBe('actual work-copy code')
  })

  it('preserves a real detached commit and subsequent working bytes without changing the immutable baseline or project branch', async () => {
    const test = await harness(), base = await repository(test), made = await create(test, base), path = made.resource.path
    await writeFile(join(path, 'file.txt'), 'committed in managed work copy\n')
    test.git(['-C', path, 'add', '--', 'file.txt']); test.git(['-C', path, 'commit', '--quiet', '-m', 'real detached change'])
    const actualHead = test.git(['-C', path, 'rev-parse', 'HEAD'])
    expect(actualHead).not.toBe(base)
    await test.ctx.gitResources.withWriteUse(made.resource.resourceId, { useId: 'after-commit', ownerId: 'actual-execution', epoch: '1' },
      new AbortController().signal, async (scope) => {
        scope.assertCurrent(); await writeFile(join(path, 'untracked.ts'), 'after commit\n')
      })
    const current = test.ctx.gitResources.read(made.resource.resourceId)!
    const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('detached-head'), resourceId: made.resource.resourceId,
      expectedRevision: current.revision })
    expect(sealed.operation).toMatchObject({ phase: 'confirmed', effectHead: actualHead, effectContent: 'versioned' })
    expect(sealed.resource).toMatchObject({ baselineCommit: base, preservedHead: actualHead })
    expect(test.git(['rev-parse', `${sealed.operation.effectCommit}^`])).toBe(actualHead)
    expect(test.git(['show', `${sealed.operation.effectCommit}:untracked.ts`])).toBe('after commit')
    expect(test.git(['rev-parse', 'HEAD'])).toBe(base)
    test.git(['-C', path, 'switch', '--quiet', '-c', 'fixture-attached'])
    await expect(test.ctx.gitResources.withWriteUse(current.resourceId, { useId: 'attached', ownerId: 'same', epoch: '1' },
      new AbortController().signal, async () => {})).rejects.toMatchObject({ code: 'RESOURCE_ATTACHED' })
    expect(test.git(['-C', path, 'symbolic-ref', 'HEAD'])).toBe('refs/heads/fixture-attached')
  })

  it('records genuine unresolved index stages immutably and requires a new seal after actual resolution', async () => {
    const test = await harness(), base = await repository(test), made = await create(test, base), path = made.resource.path
    await writeFile(join(path, 'file.txt'), 'left side\n')
    test.git(['-C', path, 'add', '--', 'file.txt']); test.git(['-C', path, 'commit', '--quiet', '-m', 'left detached change'])
    const left = test.git(['-C', path, 'rev-parse', 'HEAD'])
    test.git(['-C', path, 'checkout', '--quiet', '--detach', base])
    await writeFile(join(path, 'file.txt'), 'right side\n')
    test.git(['-C', path, 'add', '--', 'file.txt']); test.git(['-C', path, 'commit', '--quiet', '-m', 'right detached change'])
    expect(() => test.git(['-C', path, 'merge', '--no-commit', left])).toThrow('fixture git -C failed')
    const actualStages = test.git(['-C', path, 'ls-files', '--unmerged']).split('\n').map((row) => {
      const [metadata, itemPath] = row.split('\t')
      if (metadata === undefined || itemPath === undefined) throw new Error('real unresolved index must contain complete stage facts')
      const [mode, objectId, stage] = metadata.split(' ')
      return { path: itemPath, mode, objectId, stage: Number(stage) }
    })
    expect(actualStages).toHaveLength(3)
    const request = { operationId: GitOperationId('unresolved-snapshot'), resourceId: made.resource.resourceId,
      expectedRevision: made.resource.revision }
    const snapshot = await test.ctx.gitResources.preserve(request)
    expect(snapshot.operation).toMatchObject({ phase: 'confirmed', effectContent: 'versioned', effectConflictStages: actualStages })
    expect(snapshot.resource).toMatchObject({ state: 'conflicted', preservedConflictStages: actualStages })
    await writeFile(join(path, 'file.txt'), 'explicitly resolved\n'); test.git(['-C', path, 'add', '--', 'file.txt'])
    expect(test.git(['-C', path, 'ls-files', '--unmerged'])).toBe('')
    const old = await test.ctx.gitResources.preserve(request)
    expect(old.operation.effectConflictStages).toEqual(actualStages)
    const resolved = await test.ctx.gitResources.preserve({ operationId: GitOperationId('new-resolved-seal'),
      resourceId: made.resource.resourceId, expectedRevision: snapshot.resource.revision })
    expect(resolved.operation.effectConflictStages).toEqual([])
    expect(resolved.resource.state).toBe('preserved')
    expect(test.git(['show', `${resolved.operation.effectCommit}:file.txt`])).toBe('explicitly resolved')
    expect(test.ctx.gitResources.status(request.operationId)?.operation.effectConflictStages).toEqual(actualStages)
    expect(test.git(['rev-parse', 'HEAD'])).toBe(base)
  })

  it('does not reset an unknown managed index on original creation retry or touch the project index', async () => {
    const test = await harness(), base = await repository(test)
    const originalIndex = await readFile(join(test.project, '.git', 'index'))
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const request = { ...preview.request, ...consumer, operationId: GitOperationId('partial-with-unknown-index'),
      expectedPreviewFingerprint: preview.fingerprint }
    // oxlint-disable-next-line typescript/unbound-method -- The spy delegates with .call(this) to the actual captured runner instance.
    const original = ResourceGit.prototype.run
    let first = true
    const fault = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
      if (first && args[0] === 'cat-file' && args[1] === 'blob') { first = false; throw new Error('materialization deferred after actual index creation') }
      return original.call(this, args, ...rest)
    })
    await expect(test.ctx.gitResources.create(request)).rejects.toThrow('materialization deferred')
    fault.mockRestore()
    const pending = test.ctx.gitResources.status(request.operationId)
    if (pending === undefined) throw new Error('real creation intent must survive the materialization failure')
    expect(test.git(['-C', pending.resource.path, 'ls-files']).split('\n')).toEqual(['file.txt', 'removed.txt'])
    test.git(['-C', pending.resource.path, 'read-tree', '--empty'])
    const commands = vi.spyOn(ResourceGit.prototype, 'run'); commands.mockClear()
    await expect(test.ctx.gitResources.create(request)).rejects.toMatchObject({ code: 'RESOURCE_INDEX_CHANGED' })
    expect(commands.mock.calls.some(([args, cwd]) => args[0] === 'read-tree' && cwd === pending.resource.path)).toBe(false)
    expect(test.git(['-C', pending.resource.path, 'ls-files'])).toBe('')
    expect(await readFile(join(test.project, '.git', 'index'))).toEqual(originalIndex)
    commands.mockRestore()
  })
})
