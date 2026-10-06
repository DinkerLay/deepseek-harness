/** Observable local Git effects and durable resource/use recovery through the real Loader. */
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import GitResources, { GitOperationId, GitConsumerScope, GitRepositoryId, GitResourceId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { hash } from '../src/records.ts'
import { acquireFileLease } from '@deepseek-ai/dsh-util-file-lease'
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { harness, repository } from './harness.ts'

const signal = new AbortController().signal
const consumer = { consumerScope: GitConsumerScope('owner-local-fixture'), originalRequestJson: '{"hostRequest":"original"}' }
describe('registered local Git resource owner', () => {
  it('reports non-Git refusal without initializing a repository or claiming a work copy', async () => {
    const test = await harness()
    const result = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: 'HEAD' } })
    expect(result).toMatchObject({ permitted: false, risks: ['NOT_GIT'] })
    await expect(lstat(join(test.project, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('previews commit baseline and all dirty classes without touching HEAD, index or file bytes', async () => {
    const test = await harness(), base = await repository(test)
    await writeFile(join(test.project, 'file.txt'), 'STAGED\n'); test.git(['add', '--', 'file.txt'])
    await writeFile(join(test.project, 'file.txt'), 'WORKTREE\n')
    await writeFile(join(test.project, 'untracked.txt'), 'Untracked\n')
    const before = await readFile(join(test.project, '.git', 'index'))
    const request = { workspaceId: test.workspace.id, baseline: { kind: 'commit' as const, commit: base } }
    const first = await test.ctx.gitResources.preview(request), second = await test.ctx.gitResources.preview(request)
    expect(first).toMatchObject({ permitted: true, baseCommit: base, dirty: {
      staged: ['file.txt'], unstaged: ['file.txt'], untracked: ['untracked.txt'], unmerged: [] } })
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(await readFile(join(test.project, '.git', 'index'))).toEqual(before)
    expect(test.git(['rev-parse', 'HEAD'])).toBe(base)
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('WORKTREE\n')
  })
  it('creates exactly selected index/raw binary/executable/untracked and deletion over an explicit commit', async () => {
    const test = await harness(), base = await repository(test)
    await writeFile(join(test.project, 'file.txt'), 'STAGED\n'); test.git(['add', '--', 'file.txt'])
    await writeFile(join(test.project, 'file.txt'), 'UNSELECTED WORKTREE\n')
    test.git(['rm', '--quiet', '--', 'removed.txt'])
    const binary = Buffer.from([0, 255, 128, 10, 13])
    await writeFile(join(test.project, 'binary.dat'), binary)
    await writeFile(join(test.project, 'run.sh'), '#!/bin/sh\nexit 0\n'); await chmod(join(test.project, 'run.sh'), 0o755)
    await writeFile(join(test.project, 'omitted.txt'), 'Not selected\n')
    const index = await readFile(join(test.project, '.git', 'index'))
    const request = { workspaceId: test.workspace.id, baseline: { kind: 'selected' as const, baseCommit: base, paths: [
      { path: 'file.txt', source: 'index' as const }, { path: 'removed.txt', source: 'index' as const },
      { path: 'binary.dat', source: 'untracked' as const }, { path: 'run.sh', source: 'untracked' as const }] } }
    const preview = await test.ctx.gitResources.preview(request)
    expect(preview.permitted).toBe(true)
    const create = { ...request, ...consumer, operationId: GitOperationId('create:selected'), expectedPreviewFingerprint: preview.fingerprint }
    const made = await test.ctx.gitResources.create(create)
    expect(made.operation.phase).toBe('confirmed')
    expect(await readFile(join(made.resource.path, 'file.txt'), 'utf8')).toBe('STAGED\n')
    expect(await readFile(join(made.resource.path, 'binary.dat'))).toEqual(binary)
    expect((await lstat(join(made.resource.path, 'run.sh'))).mode & 0o111).not.toBe(0)
    await expect(lstat(join(made.resource.path, 'removed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(made.resource.path, 'omitted.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const retried = await test.ctx.gitResources.create(create)
    expect(retried).toEqual(made)
    expect(test.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(2)
    expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
    expect(test.git(['rev-parse', 'HEAD'])).toBe(base)
    await expect(test.ctx.gitResources.create({ ...create, baseline: { kind: 'commit', commit: base } })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  })
  it.each(['include.path', 'filter.mock.clean', 'core.fsmonitor', 'merge.mock.driver'])('rejects risky local configuration key %s without executing its value', async (key) => {
    const test = await harness(), base = await repository(test), marker = join(test.root, 'MUST-NOT-EXIST')
    test.git(['config', key, `sh -c "touch ${marker}"`])
    const result = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    expect(result).toMatchObject({ permitted: false, risks: ['GIT_CONFIG_UNSAFE'] })
    expect(JSON.stringify(result)).not.toContain(marker)
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects changed preview and selected symlinks/protected content without silently dropping them', async () => {
    const test = await harness(), base = await repository(test)
    const request = { workspaceId: test.workspace.id, baseline: { kind: 'commit' as const, commit: base } }
    const preview = await test.ctx.gitResources.preview(request)
    await writeFile(join(test.project, 'late.txt'), 'User later change\n')
    await expect(test.ctx.gitResources.create({ ...request, ...consumer, operationId: GitOperationId('old-preview'), expectedPreviewFingerprint: preview.fingerprint }))
      .rejects.toMatchObject({ code: 'PREVIEW_CHANGED' })
    await symlink(join(test.root, 'outside'), join(test.project, 'link'))
    expect((await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'selected', baseCommit: base,
      paths: [{ path: 'link', source: 'untracked' }] } })).risks).toContain('SYMLINK_UNSUPPORTED')
    await writeFile(join(test.project, '.env'), 'Not read by the resource owner\n')
    expect((await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'selected', baseCommit: base,
      paths: [{ path: '.env', source: 'untracked' }] } })).risks).toContain('PROTECTED_PATH')
  })
  it('holds an actual live write scope, keeps failed use uncertain, and requires explicit Host quiet handback', async () => {
    const test = await harness(), base = await repository(test)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const made = await test.ctx.gitResources.create({ ...preview.request, ...consumer, operationId: GitOperationId('write-use-base'), expectedPreviewFingerprint: preview.fingerprint })
    const use = { useId: 'use-1', ownerId: 'caller-owned-execution', epoch: 'generation-2' }
    await expect(test.ctx.gitResources.withWriteUse(made.resource.resourceId, use, signal, async (scope) => {
      scope.assertCurrent(); scope.assertCurrent()
      await writeFile(join(scope.resource.path, 'file.txt'), 'Actual unsettled work\n')
      throw new Error('caller did not settle external work')
    })).rejects.toThrow('caller did not settle')
    const held = test.ctx.gitResources.read(made.resource.resourceId)!
    expect(held.use).toMatchObject({ ...use, phase: 'needs_attention' })
    await expect(test.ctx.gitResources.withWriteUse(held.resourceId, use, signal, async () => {})).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' })
    await expect(test.ctx.gitResources.confirmQuietUse(held.resourceId, use, held.revision, () => { throw new Error('real execution still active') }))
      .rejects.toThrow('still active')
    expect(test.ctx.gitResources.read(held.resourceId)?.use).toBeDefined()
    await test.ctx.gitResources.confirmQuietUse(held.resourceId, use, held.revision, () => {})
    expect(test.ctx.gitResources.read(held.resourceId)?.use).toBeUndefined()
    const before = test.ctx.gitResources.read(held.resourceId)!
    const preserved = await test.ctx.gitResources.preserve({ operationId: GitOperationId('preserve:actual'), resourceId: before.resourceId, expectedRevision: before.revision })
    expect(preserved.operation).toMatchObject({ phase: 'confirmed', effectTree: preserved.resource.preservedTree, effectManifestHash: preserved.resource.preservedManifestHash })
    expect(test.git(['rev-parse', preserved.resource.preservedRef!])).toBe(preserved.resource.preservedCommit)
    expect(test.git(['show', `${preserved.resource.preservedCommit}:file.txt`])).toBe('Actual unsettled work')
    expect(test.git(['rev-parse', 'HEAD'])).toBe(base)
  })
  it('reconciles a Git-created work copy when the confirmed record write failed without building another copy', async () => {
    const test = await harness(), base = await repository(test)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const request = { ...preview.request, ...consumer, operationId: GitOperationId('created-receipt-lost'), expectedPreviewFingerprint: preview.fingerprint }
    const domain = test.ctx.storageDomain.get('git_resources')
    if (domain === undefined) throw new Error('real resource domain must be open')
    const unit = Reflect.get(domain, 'unit') as import('@deepseek-ai/dsh-storage').KvUnit
    const original = unit.putRecord.bind(unit)
    let fail = true
    const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
      const value = args[2]
      if (fail && value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
        && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
          && 'phase' in operation && operation.phase === 'confirmed')) {
        throw new Error('final durable record failed')
      }
      return original(...args)
    })
    await expect(test.ctx.gitResources.create(request)).rejects.toThrow('durable record failed')
    const pending = test.ctx.gitResources.status(request.operationId)!
    expect(pending.operation.phase).toBe('needs_attention')
    expect(await readFile(join(pending.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
    fail = false; fault.mockRestore()
    const recovered = await test.ctx.gitResources.reconcile(request.operationId)
    expect(recovered.operation.phase).toBe('confirmed')
    expect(recovered.resource.resourceId).toBe(pending.resource.resourceId)
    expect(test.git(['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(2)
  })
  it('refuses a moved reserved work-copy identity and never deletes/recreates the unknown path', async () => {
    const test = await harness(), base = await repository(test)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const made = await test.ctx.gitResources.create({ ...preview.request, ...consumer, operationId: GitOperationId('move-original'), expectedPreviewFingerprint: preview.fingerprint })
    await rename(made.resource.path, `${made.resource.path}-moved`)
    await expect(test.ctx.gitResources.withWriteUse(made.resource.resourceId, { useId: 'moved', ownerId: 'original', epoch: '1' }, signal, async () => {}))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(made.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(`${made.resource.path}-moved`, 'file.txt'), 'utf8')).toBe('BASE\n')
  })
  it('restores authoritative records and retains failed use ownership after a real Loader restart', async () => {
    const first = await harness(), base = await repository(first)
    const preview = await first.ctx.gitResources.preview({ workspaceId: first.workspace.id, baseline: { kind: 'commit', commit: base } })
    const made = await first.ctx.gitResources.create({ ...preview.request, ...consumer, operationId: GitOperationId('cold-resource'), expectedPreviewFingerprint: preview.fingerprint })
    const use = { useId: 'cold-use', ownerId: 'original-execution', epoch: '4' }
    await expect(first.ctx.gitResources.withWriteUse(made.resource.resourceId, use, signal, async () => { throw new Error('unfinished') })).rejects.toThrow('unfinished')
    await first.ctx.fiber.dispose()
    const cold = await harness({ gitExecutable: '/nonexistent-dsh-owning-fixture-git' }, first.resources)
    expect(cold.ctx.gitResources.read(made.resource.resourceId)?.use).toMatchObject({ ...use, phase: 'needs_attention' })
    await expect(cold.ctx.gitResources.withWriteUse(made.resource.resourceId, use, signal, async () => {})).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' })
    expect(cold.ctx.gitResources.status(made.operation.operationId)?.operation.phase).toBe('confirmed')
  })
  it('rejects unreadable/oversized selected content instead of dropping a path from its baseline', async () => {
    const test = await harness({ maxFileBytes: 4 }), base = await repository(test)
    await writeFile(join(test.project, 'large.bin'), Buffer.alloc(8))
    expect((await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'selected', baseCommit: base,
      paths: [{ path: 'large.bin', source: 'untracked' }] } })).risks).toContain('FILE_LIMIT')
    await rm(join(test.project, 'large.bin'))
  })
  it('retains exact consumer scope and original payload, refuses identity takeover, and never groups by operation prefix', async () => {
    const test = await harness(), base = await repository(test)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const request = { ...preview.request, ...consumer, operationId: GitOperationId('scope:original'), expectedPreviewFingerprint: preview.fingerprint }
    const made = await test.ctx.gitResources.create(request)
    expect(made.resource.consumerScope).toBe(consumer.consumerScope)
    expect(test.ctx.gitResources.listOperations(consumer.consumerScope)).toHaveLength(1)
    expect(test.ctx.gitResources.listOperations(GitConsumerScope('scope'))).toEqual([])
    await expect(test.ctx.gitResources.create({ ...request, consumerScope: GitConsumerScope('other-scope') })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    await expect(test.ctx.gitResources.create({ ...request, originalRequestJson: '{"hostRequest":"changed"}' })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    await expect(test.ctx.gitResources.create({ ...request, operationId: GitOperationId('invalid-json'), originalRequestJson: 'not JSON' })).rejects.toMatchObject({ code: 'CONSUMER_REQUEST_INVALID' })
    expect(test.ctx.gitResources.listOperations(consumer.consumerScope)).toHaveLength(1)
  })
  it('rejects a request-before-intent path collision even when it is a real same-repository worktree', async () => {
    const test = await harness(), base = await repository(test)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const operationId = GitOperationId('unknown-existing-path')
    const resourceId = hash([preview.repository!.repositoryId, operationId])
    const path = join(test.home, 'git-resources', 'workcopies', resourceId)
    test.git(['worktree', 'add', '--quiet', '--detach', path, base])
    const request = { ...preview.request, ...consumer, operationId, expectedPreviewFingerprint: preview.fingerprint }
    await expect(test.ctx.gitResources.create(request))
      .rejects.toMatchObject({ code: 'RESOURCE_UNKNOWN' })
    expect(test.ctx.gitResources.status(operationId)).toBeUndefined()
    expect(await readFile(join(path, 'file.txt'), 'utf8')).toBe('BASE\n')
  })
  it('reconcile observes an intended operation without completing its missing external Git effects', async () => {
    const test = await harness(), base = await repository(test)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    // oxlint-disable-next-line typescript/unbound-method -- The spy delegates with .call(this) to the actual captured runner instance.
    const original = ResourceGit.prototype.run
    let fail = true
    const fault = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
      if (fail && args[0] === 'update-ref') throw new Error('before first private-ref effect')
      return original.call(this, args, ...rest)
    })
    const request = { ...preview.request, ...consumer, operationId: GitOperationId('intended-no-effect'), expectedPreviewFingerprint: preview.fingerprint }
    await expect(test.ctx.gitResources.create(request)).rejects.toThrow('before first')
    fail = false; fault.mockRestore()
    const commands = vi.spyOn(ResourceGit.prototype, 'run')
    const observed = await test.ctx.gitResources.reconcile(request.operationId)
    expect(observed.operation.phase).toBe('needs_attention')
    expect(commands.mock.calls.some(([args]) => ['hash-object', 'commit-tree', 'update-ref', 'worktree', 'write-tree'].includes(args[0]!))).toBe(false)
    await expect(lstat(observed.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
    commands.mockRestore()
    const retry = await test.ctx.gitResources.create(request)
    expect(retry.operation.phase).toBe('confirmed')
  })
  it('recovers a private ref written before its record checkpoint without rereading changed user content', async () => {
    const test = await harness(), base = await repository(test)
    await writeFile(join(test.project, 'selected.txt'), 'ORIGINAL SELECTED\n')
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'selected', baseCommit: base,
      paths: [{ path: 'selected.txt', source: 'untracked' }] } })
    const domain = test.ctx.storageDomain.get('git_resources')!
    const unit = Reflect.get(domain, 'unit') as import('@deepseek-ai/dsh-storage').KvUnit, original = unit.putRecord.bind(unit)
    let failing = true
    const failure = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
      const value = args[2]
      if (failing && value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
        && value.operations.some((op: unknown) => op !== null && typeof op === 'object' && 'effectCommit' in op && op.effectCommit !== undefined)) {
        throw new Error('private ref written; effect checkpoint lost')
      }
      return original(...args)
    })
    const request = { ...preview.request, ...consumer, operationId: GitOperationId('ref-before-record'), expectedPreviewFingerprint: preview.fingerprint }
    await expect(test.ctx.gitResources.create(request)).rejects.toThrow('checkpoint lost')
    await writeFile(join(test.project, 'selected.txt'), 'LATER USER CONTENT\n')
    failing = false; failure.mockRestore()
    const retried = await test.ctx.gitResources.create(request)
    expect(await readFile(join(retried.resource.path, 'selected.txt'), 'utf8')).toBe('ORIGINAL SELECTED\n')
    expect(await readFile(join(test.project, 'selected.txt'), 'utf8')).toBe('LATER USER CONTENT\n')
  })
  it('serializes preservation with write-use acquisition and rejects queued use cancellation before its callback', async () => {
    const test = await harness(), base = await repository(test)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const made = await test.ctx.gitResources.create({ ...preview.request, ...consumer, operationId: GitOperationId('serialization-base'), expectedPreviewFingerprint: preview.fingerprint })
    const entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
    // oxlint-disable-next-line typescript/unbound-method -- The spy delegates with .call(this) to the actual captured runner instance.
    const original = ResourceGit.prototype.text
    let first = true
    const gate = vi.spyOn(ResourceGit.prototype, 'text').mockImplementation(async function (this: ResourceGit, args, ...rest) {
      if (first && args[0] === 'rev-parse' && rest[0] === made.resource.path) { first = false; entered.resolve(undefined); await resume.promise }
      return original.call(this, args, ...rest)
    })
    const preserving = test.ctx.gitResources.preserve({ operationId: GitOperationId('serialize:preserve'), resourceId: made.resource.resourceId, expectedRevision: made.resource.revision })
    try {
      await entered.promise
      const controller = new AbortController(), callback = vi.fn(async () => {})
      const waiting = test.ctx.gitResources.withWriteUse(made.resource.resourceId, { useId: 'waiting', ownerId: 'actual-caller', epoch: '1' }, controller.signal, callback)
      const rejected = expect(waiting).rejects.toThrow('cancelled waiting use')
      controller.abort(new Error('cancelled waiting use'))
      await rejected
      expect(callback).not.toHaveBeenCalled()
      resume.resolve(undefined)
      const preserved = await preserving
      expect(preserved.operation.phase).toBe('confirmed')
      expect(test.ctx.gitResources.read(made.resource.resourceId)?.use).toBeUndefined()
    } finally { resume.resolve(undefined); await preserving; gate.mockRestore() }
  })
  it('cannot externally release an actual live callback before its owner hands back', async () => {
    const test = await harness(), base = await repository(test)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const made = await test.ctx.gitResources.create({ ...preview.request, ...consumer, operationId: GitOperationId('live-handoff'), expectedPreviewFingerprint: preview.fingerprint })
    const identity = { useId: 'held-live', ownerId: 'execution', epoch: '2' }, entered = Promise.withResolvers<undefined>(), resume = Promise.withResolvers<undefined>()
    const running = test.ctx.gitResources.withWriteUse(made.resource.resourceId, identity, signal, async (scope) => {
      entered.resolve(undefined); await resume.promise; scope.assertCurrent()
    })
    try {
      await entered.promise
      const held = test.ctx.gitResources.read(made.resource.resourceId)!
      await expect(test.ctx.gitResources.confirmQuietUse(held.resourceId, identity, held.revision, () => {})).rejects.toMatchObject({ code: 'RESOURCE_IN_USE' })
      expect(test.ctx.gitResources.read(held.resourceId)?.use).toBeDefined()
    } finally { resume.resolve(undefined); await running }
    expect(test.ctx.gitResources.read(made.resource.resourceId)?.use).toBeUndefined()
  })
  it('rejects a second actual owner before opening its mutable resource domain', async () => {
    const first = await harness(), second = await harness({}, first.resources, false)
    await expect(second.ctx.plugin(GitResources, { home: first.home })).rejects.toMatchObject({ name: 'FileLeaseBusyError' })
    expect(second.ctx.storageDomain.get('git_resources')).toBeUndefined()
    expect(first.ctx.gitResources).toBeDefined()
  })
  it('refuses unsupported submodule and link entries in a named commit baseline', async () => {
    const test = await harness(), base = await repository(test)
    await mkdir(join(test.project, 'nested'))
    test.git(['update-index', '--add', '--cacheinfo', `160000,${base},nested`])
    test.git(['commit', '--quiet', '-m', 'declared nested Git link'])
    expect((await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: 'HEAD' } })).risks).toContain('TREE_ENTRY_UNSUPPORTED')
  })
  it('rejects a mode change during preservation instead of confirming a stale executable baseline', async () => {
    const test = await harness(), base = await repository(test)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const made = await test.ctx.gitResources.create({ ...preview.request, ...consumer, operationId: GitOperationId('mode-race-base'), expectedPreviewFingerprint: preview.fingerprint })
    // oxlint-disable-next-line typescript/unbound-method -- Delegation calls the original on this real runner instance.
    const original = ResourceGit.prototype.run
    let first = true
    const mutate = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
      const result = await original.call(this, args, ...rest)
      if (first && args[0] === 'hash-object' && args.includes('-w')) {
        first = false; await chmod(join(made.resource.path, 'file.txt'), 0o755)
      }
      return result
    })
    try {
      await expect(test.ctx.gitResources.preserve({ operationId: GitOperationId('mode-race-preserve'), resourceId: made.resource.resourceId,
        expectedRevision: made.resource.revision })).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
      expect(test.ctx.gitResources.status(GitOperationId('mode-race-preserve'))?.operation.phase).toBe('needs_attention')
      expect(test.ctx.gitResources.read(made.resource.resourceId)?.preservedCommit).toBeUndefined()
    } finally { mutate.mockRestore() }
  })
  it('closes a real opened domain before returning its kernel lease after cold use recovery durability fails', async () => {
    const first = await harness(), base = await repository(first)
    const preview = await first.ctx.gitResources.preview({ workspaceId: first.workspace.id, baseline: { kind: 'commit', commit: base } })
    const made = await first.ctx.gitResources.create({ ...preview.request, ...consumer, operationId: GitOperationId('cold-init-failure'), expectedPreviewFingerprint: preview.fingerprint })
    const domain = first.ctx.storageDomain.get('git_resources')!
    const unit = Reflect.get(domain, 'unit') as import('@deepseek-ai/dsh-storage').KvUnit, originalWrite = unit.putRecord.bind(unit)
    const failAttention = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
      const value = args[2]
      if (value !== null && typeof value === 'object' && 'resources' in value && Array.isArray(value.resources)
        && value.resources.some((resource: unknown) => resource !== null && typeof resource === 'object'
          && 'use' in resource && resource.use !== null && typeof resource.use === 'object'
          && 'phase' in resource.use && resource.use.phase === 'needs_attention')) throw new Error('attention checkpoint failed')
      return originalWrite(...args)
    })
    await expect(first.ctx.gitResources.withWriteUse(made.resource.resourceId, { useId: 'held-cold', ownerId: 'original', epoch: '8' }, signal,
      async () => { throw new Error('unfinished actual use') })).rejects.toThrow('attention checkpoint failed')
    failAttention.mockRestore()
    expect(first.ctx.gitResources.read(made.resource.resourceId)?.use?.phase).toBe('held')
    await first.ctx.fiber.dispose()
    const cold = await harness({}, first.resources, false), originalOpen = cold.ctx.storageDomain.open.bind(cold.ctx.storageDomain)
    const opening = vi.spyOn(cold.ctx.storageDomain, 'open').mockImplementation(async <S extends DomainSpec>(spec: S): Promise<Domain<S>> => {
      const opened = await originalOpen(spec)
      if (spec.name === 'git_resources') {
        const actual = cold.ctx.storageDomain.get(spec.name)!
        const backend = Reflect.get(actual, 'unit') as import('@deepseek-ai/dsh-storage').KvUnit
        vi.spyOn(backend, 'putRecord').mockRejectedValue(new Error('cold recovery durability failed'))
      }
      return opened
    })
    try {
      await expect(cold.ctx.plugin(GitResources, { home: first.home })).rejects.toThrow('cold recovery durability failed')
      expect(cold.ctx.storageDomain.get('git_resources')).toBeUndefined()
      const lease = await acquireFileLease(join(first.home, 'git-resources', 'owner.lock'))
      await lease.release()
    } finally { opening.mockRestore() }
  })
  it('canonicalizes an explicitly configured symlink home without weakening reciprocal worktree identity', async () => {
    const test = await harness({}, undefined, false), base = await repository(test)
    const alias = join(test.root, 'home-alias')
    await symlink(test.home, alias)
    await test.ctx.plugin(GitResources, { home: alias })
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const made = await test.ctx.gitResources.create({ ...preview.request, ...consumer, operationId: GitOperationId('home-alias-real'), expectedPreviewFingerprint: preview.fingerprint })
    expect(made.resource.path).toBe(await realpath(made.resource.path))
    expect(made.resource.path.startsWith(`${await realpath(test.home)}/git-resources/workcopies/`)).toBe(true)
    expect((await test.ctx.gitResources.reconcile(made.operation.operationId)).operation.phase).toBe('confirmed')
    expect(await readFile(join(made.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
  })
  it('observes an original private ref without creating its absent work copy during reconcile', async () => {
    const test = await harness(), base = await repository(test)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    // oxlint-disable-next-line typescript/unbound-method -- Delegation calls the original on this real runner instance.
    const original = ResourceGit.prototype.run
    const failure = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
      if (args[0] === 'worktree' && args[1] === 'add') throw new Error('before actual work-copy creation')
      return original.call(this, args, ...rest)
    })
    const request = { ...preview.request, ...consumer, operationId: GitOperationId('ref-only-observation'), expectedPreviewFingerprint: preview.fingerprint }
    await expect(test.ctx.gitResources.create(request)).rejects.toThrow('before actual')
    failure.mockRestore()
    const observed = test.ctx.gitResources.status(request.operationId)!
    expect(test.git(['rev-parse', observed.resource.privateRef])).toBe(observed.operation.effectCommit)
    const commands = vi.spyOn(ResourceGit.prototype, 'run')
    const reconciled = await test.ctx.gitResources.reconcile(request.operationId)
    expect(reconciled.operation.phase).toBe('needs_attention')
    expect(commands.mock.calls.some(([args]) => ['hash-object', 'commit-tree', 'update-ref', 'worktree', 'write-tree'].includes(args[0]!))).toBe(false)
    await expect(lstat(reconciled.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
    commands.mockRestore()
    expect((await test.ctx.gitResources.create(request)).operation.phase).toBe('confirmed')
  })
  it('retains an incomplete materialization for observation and only an explicit original retry writes the missing bytes', async () => {
    const test = await harness(), base = await repository(test)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    // oxlint-disable-next-line typescript/unbound-method -- Delegation calls the original on this real runner instance.
    const original = ResourceGit.prototype.run
    let blobs = 0
    const failure = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
      if (args[0] === 'cat-file' && args[1] === 'blob' && ++blobs === 2) throw new Error('second materialization read failed')
      return original.call(this, args, ...rest)
    })
    const request = { ...preview.request, ...consumer, operationId: GitOperationId('partial-materialization'), expectedPreviewFingerprint: preview.fingerprint }
    await expect(test.ctx.gitResources.create(request)).rejects.toThrow('second materialization')
    failure.mockRestore()
    const partial = test.ctx.gitResources.status(request.operationId)!
    expect(partial.resource.pathIdentity).toBeDefined()
    expect(await readFile(join(partial.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
    await expect(lstat(join(partial.resource.path, 'removed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    const observed = await test.ctx.gitResources.reconcile(request.operationId)
    expect(observed.operation.phase).toBe('needs_attention')
    expect(observed.operation.diagnostic).toContain('incomplete')
    await expect(lstat(join(partial.resource.path, 'removed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await test.ctx.gitResources.create(request)).operation.phase).toBe('confirmed')
    expect(await readFile(join(partial.resource.path, 'removed.txt'), 'utf8')).toBe('Remove this deliberately\n')
  })
  it('rejects unknown public identities, invalid bounds and oversized consumer metadata before any external action', async () => {
    const test = await harness({ maxConsumerRequestBytes: 64 }), base = await repository(test)
    expect(GitRepositoryId('repository-name')).toBe('repository-name')
    expect(test.ctx.gitResources.read(GitResourceId('unknown'))).toBeUndefined()
    expect(test.ctx.gitResources.status(GitOperationId('unknown'))).toBeUndefined()
    await expect(test.ctx.gitResources.reconcile(GitOperationId('unknown'))).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' })
    await expect(test.ctx.gitResources.withWriteUse(GitResourceId('unknown'), { useId: 'x', ownerId: 'x', epoch: 'x' }, signal,
      async () => {})).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' })
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const request = { ...preview.request, ...consumer, operationId: GitOperationId('large-original'), expectedPreviewFingerprint: preview.fingerprint }
    await expect(test.ctx.gitResources.create({ ...request, originalRequestJson: JSON.stringify('x'.repeat(100)) }))
      .rejects.toMatchObject({ code: 'CONSUMER_REQUEST_INVALID' })
    await expect(test.ctx.gitResources.create({ ...request, operationId: GitOperationId('invalid/id') })).rejects.toMatchObject({ code: 'IDENTITY_INVALID' })
    expect(test.ctx.gitResources.listOperations(consumer.consumerScope)).toEqual([])
    const invalid = await harness({}, test.resources, false)
    await expect(invalid.ctx.plugin(GitResources, { home: join(test.root, 'invalid-home'), timeoutMs: 0 })).rejects.toThrow('positive integers')
  })
  it('rejects stale quiet proof and remembers preserved operation identity on repeated requests', async () => {
    const test = await harness(), base = await repository(test)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const created = await test.ctx.gitResources.create({ ...preview.request, ...consumer, operationId: GitOperationId('preserve-retry-base'), expectedPreviewFingerprint: preview.fingerprint })
    const use = { useId: 'use-owned', ownerId: 'original-owner', epoch: '1' }
    await expect(test.ctx.gitResources.withWriteUse(created.resource.resourceId, use, signal, async () => { throw new Error('unfinished') })).rejects.toThrow('unfinished')
    const held = test.ctx.gitResources.read(created.resource.resourceId)!
    await expect(test.ctx.gitResources.confirmQuietUse(held.resourceId, { ...use, epoch: '2' }, held.revision, () => {})).rejects.toMatchObject({ code: 'USE_CHANGED' })
    await test.ctx.gitResources.confirmQuietUse(held.resourceId, use, held.revision, () => {})
    const current = test.ctx.gitResources.read(held.resourceId)!
    const request = { operationId: GitOperationId('preserve:stable'), resourceId: current.resourceId, expectedRevision: current.revision }
    const saved = await test.ctx.gitResources.preserve(request)
    expect(await test.ctx.gitResources.preserve(request)).toEqual(saved)
    await expect(test.ctx.gitResources.preserve({ ...request, expectedRevision: request.expectedRevision + 1 })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    expect(test.ctx.gitResources.listOperations(consumer.consumerScope)).toHaveLength(2)
    expect((await test.ctx.gitResources.reconcile(request.operationId)).operation.phase).toBe('confirmed')
  })
  it('rejects actual Git command failure and oversized raw output without returning truncated metadata', async () => {
    const test = await harness(), executable = await test.ctx.subprocess.resolveExecutable('git')
    const isolation = join(test.home, 'git-resources', 'isolated')
    const bounds = { timeoutMs: 3_000, maxOutputBytes: 2, graceMs: 1_000 }
    const bounded = new ResourceGit(test.ctx.subprocess, executable, isolation, bounds)
    await expect(bounded.run(['--version'], test.project, signal)).rejects.toMatchObject({ code: 'GIT_OUTPUT_LIMIT' })
    const ordinary = new ResourceGit(test.ctx.subprocess, executable, isolation, { ...bounds, maxOutputBytes: 4_096 })
    await expect(ordinary.run(['rev-parse', '--verify', 'MISSING'], test.project, signal)).rejects.toMatchObject({ code: 'GIT_COMMAND_FAILED' })
    const observed = await ordinary.run(['rev-parse', '--verify', 'MISSING'], test.project, signal, { allowFailure: true })
    expect(observed.status).not.toBe(0)
    const cancelled = new AbortController(); cancelled.abort(new Error('cancelled before spawn'))
    await expect(ordinary.run(['--version'], test.project, cancelled.signal)).rejects.toThrow('cancelled before spawn')
  })
  it('starts real text/data services without Git and refuses isolated mode rather than initializing or falling back', async () => {
    const test = await harness({ gitExecutable: '/nonexistent-dsh-owning-fixture-git' })
    await test.workspace.setTitle('Plain text project stays available')
    expect(test.ctx.workspaceRegistry.get(test.workspace.id)?.title).toBe('Plain text project stays available')
    expect(test.ctx.gitResources.listOperations(consumer.consumerScope)).toEqual([])
    expect(test.ctx.gitResources.status(GitOperationId('old'))).toBeUndefined()
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: 'HEAD' } })
    expect(preview).toMatchObject({ permitted: false, risks: ['GIT_UNAVAILABLE'] })
    await expect(test.ctx.gitResources.create({ ...preview.request, ...consumer, operationId: GitOperationId('no-git-create'), expectedPreviewFingerprint: preview.fingerprint }))
      .rejects.toMatchObject({ code: 'PREVIEW_CHANGED' })
    await expect(lstat(join(test.project, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(test.ctx.gitResources.listOperations(consumer.consumerScope)).toEqual([])
  })
})
