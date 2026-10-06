/** Abandonment is a terminal no-effect observation, never a rollback or a successful-looking partial creation. */
import { lstat } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { harness, repository } from './harness.ts'

it('can terminate an actually persisted aborted creation before external writes and never reuses its operation id', async () => {
  const test = await harness(), base = await repository(test), controller = new AbortController()
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const request = { ...preview.request, operationId: GitOperationId('aborted-no-effect'), consumerScope: GitConsumerScope('freeze-fixture'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('real resource owner domain must be open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, original = unit.putRecord.bind(unit)
  const barrier = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    await original(...args)
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === request.operationId
        && 'phase' in operation && operation.phase === 'intended')) {
      controller.abort(new Error('freeze-equivalent cancellation before first external write'))
    }
  })
  await expect(test.ctx.gitResources.create(request, controller.signal)).rejects.toThrow('freeze-equivalent cancellation')
  barrier.mockRestore()
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('durable original intent must survive cancellation')
  expect(pending.operation).toMatchObject({ phase: 'intended', externalWriteStarted: false })
  await expect(lstat(pending.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const commands = vi.spyOn(ResourceGit.prototype, 'run'); commands.mockClear()
  const observed = await test.ctx.gitResources.reconcile(request.operationId)
  expect(observed.operation.phase).toBe('needs_attention')
  const stopped = await test.ctx.gitResources.abandonOperation(request.operationId, pending.operation.fingerprint, 'explicitly abandon unused intent')
  expect(stopped.operation).toMatchObject({ phase: 'abandoned', externalWriteStarted: false })
  expect(stopped.resource.state).toBe('abandoned')
  const mutators = new Set(['hash-object', 'read-tree', 'write-tree', 'commit-tree', 'update-ref', 'update-index'])
  expect(commands.mock.calls.some(([args]) => mutators.has(args[0] ?? '') || args[0] === 'worktree' && args[1] === 'add')).toBe(false)
  commands.mockClear()
  expect(await test.ctx.gitResources.create(request)).toEqual(stopped)
  expect(await test.ctx.gitResources.reconcile(request.operationId)).toEqual(stopped)
  expect(commands).not.toHaveBeenCalled()
  expect(test.git(['for-each-ref', '--format=%(refname)', 'refs/dsh-resources'])).toBe('')
  expect(test.git(['worktree', 'list', '--porcelain']).match(/^worktree /gmu)).toHaveLength(1)
  await expect(test.ctx.gitResources.abandonOperation(request.operationId, 'different-original-request', 'no takeover'))
    .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  commands.mockRestore()
})

it('does not pretend a real pinned partial effect was absent, failed or abandoned', async () => {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const request = { ...preview.request, operationId: GitOperationId('partial-real-effect'), consumerScope: GitConsumerScope('freeze-fixture'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }
  // oxlint-disable-next-line typescript/unbound-method -- The spy delegates with .call(this) to the actual captured runner instance.
  const original = ResourceGit.prototype.run
  const fault = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
    if (args[0] === 'worktree' && args[1] === 'add') throw new Error('freeze after real private ref was written')
    return original.call(this, args, ...rest)
  })
  await expect(test.ctx.gitResources.create(request)).rejects.toThrow('freeze after real private ref')
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('actual partial-effect intent must be queryable')
  expect(pending.operation).toMatchObject({ phase: 'needs_attention', externalWriteStarted: true, effectCommit: base })
  expect(test.git(['rev-parse', pending.resource.privateRef])).toBe(base)
  await expect(test.ctx.gitResources.abandonOperation(request.operationId, pending.operation.fingerprint, 'cannot drop partial effect'))
    .rejects.toMatchObject({ code: 'OPERATION_EFFECT_UNKNOWN' })
  expect(test.ctx.gitResources.status(request.operationId)?.operation.phase).toBe('needs_attention')
  expect(test.git(['rev-parse', pending.resource.privateRef])).toBe(base)
  const observed = await test.ctx.gitResources.reconcile(request.operationId)
  expect(observed.operation.phase).toBe('needs_attention')
  await expect(lstat(pending.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const recovered = await test.ctx.gitResources.create(request)
  expect(recovered.operation.phase).toBe('confirmed')
  expect(recovered.resource.resourceId).toBe(pending.resource.resourceId)
  expect(test.git(['worktree', 'list', '--porcelain']).match(/^worktree /gmu)).toHaveLength(2)
})
