/** Conflict recovery retains exact index stages and unresolved immutable-version evidence across checkpoint failures. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { integrationConflictIds } from '../src/integration.ts'
import type { GitIntegrationRequest } from '../src/integration.ts'
import { edgeFixture } from './edge-harness.ts'

describe('real prepared conflict versions', () => {
  let test: Awaited<ReturnType<typeof edgeFixture>>
  let request: GitIntegrationRequest
  let unit: KvUnit
  beforeEach(async () => {
    test = await edgeFixture()
    const baseline = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: test.base } })
    const other = await test.ctx.gitResources.create({ ...baseline.request, consumerScope: test.selection.consumerScope,
      originalRequestJson: '{}', operationId: GitOperationId('other-conflict-copy'), expectedPreviewFingerprint: baseline.fingerprint })
    await writeFile(join(other.resource.path, 'file.txt'), 'different conflict input\n')
    const version = await test.ctx.gitResources.preserve({ operationId: GitOperationId('other-conflict-version'),
      resourceId: other.resource.resourceId, expectedRevision: other.resource.revision })
    const selection = { ...test.selection, sourcePreserveOperationIds: [test.version.operation.operationId, version.operation.operationId] }
    const preview = await test.ctx.gitResources.previewIntegration(selection)
    request = { ...selection, operationId: GitOperationId('conflict-recovery'), originalRequestJson: '{}',
      expectedPreviewFingerprint: preview.fingerprint }
    const domain = test.ctx.storageDomain.get('git_resources')
    if (domain === undefined) throw new Error('actual conflict recovery domain must be open')
    unit = Reflect.get(domain, 'unit') as KvUnit
  })

  it('retains installed genuine conflict stages during the same original integration retry after final durability failed', async () => {
    const put = unit.putRecord.bind(unit)
    const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
      const value = args[2]
      if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
        && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
          && 'operationId' in operation && operation.operationId === request.operationId
          && 'phase' in operation && operation.phase === 'confirmed')) throw new Error('conflict completion checkpoint failed')
      return put(...args)
    })
    await expect(test.ctx.gitResources.integrate(request)).rejects.toThrow('completion checkpoint failed')
    fault.mockRestore()
    const pending = test.ctx.gitResources.status(request.operationId)
    if (pending?.operation.integrationEffect === undefined) throw new Error('the real merge effect must survive')
    expect(pending.operation.integrationEffect.conflictStages).toHaveLength(3)
    const path = pending.resource.path, index = test.git(['-C', path, 'rev-parse', '--git-path', 'index'])
    const originalIndex = await readFile(index), originalContent = await readFile(join(path, 'file.txt'))
    const calls = vi.spyOn(ResourceGit.prototype, 'run'); calls.mockClear()
    const completed = await test.ctx.gitResources.integrate(request)
    expect(completed.operation.phase).toBe('confirmed')
    expect(completed.resource.state).toBe('conflicted')
    expect(completed.operation.integrationEffect).toEqual(pending.operation.integrationEffect)
    expect(await readFile(index)).toEqual(originalIndex)
    expect(await readFile(join(path, 'file.txt'))).toEqual(originalContent)
    expect(calls.mock.calls.some(([args]) => args[0] === 'worktree' && args[1] === 'add' || args[0] === 'merge-tree')).toBe(false)
    calls.mockRestore()
  })

  it('keeps known unresolved conflict evidence after a stage-zero seal lost its final checkpoint and is reconciled', async () => {
    const integrated = await test.ctx.gitResources.integrate(request), effect = integrated.operation.integrationEffect
    if (effect === undefined) throw new Error('actual original conflict must exist')
    await writeFile(join(integrated.resource.path, 'file.txt'), 'explicit stage-zero candidate\n')
    test.git(['-C', integrated.resource.path, 'add', '--', 'file.txt'])
    const operationId = GitOperationId('unresolved-stage-zero-seal'), put = unit.putRecord.bind(unit)
    const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
      const value = args[2]
      if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
        && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
          && 'operationId' in operation && operation.operationId === operationId
          && 'phase' in operation && operation.phase === 'confirmed')) throw new Error('stage-zero seal completion checkpoint failed')
      return put(...args)
    })
    await expect(test.ctx.gitResources.preserve({ operationId, resourceId: integrated.resource.resourceId,
      expectedRevision: integrated.resource.revision })).rejects.toThrow('completion checkpoint failed')
    fault.mockRestore()
    const observed = await test.ctx.gitResources.reconcile(operationId)
    expect(observed.operation).toMatchObject({ phase: 'confirmed', effectConflictStages: [],
      effectIntegrationOperationId: request.operationId, effectUnresolvedConflictIds: integrationConflictIds(effect) })
    expect(observed.resource).toMatchObject({ state: 'conflicted', preservedIntegrationOperationId: request.operationId,
      unresolvedConflictIds: integrationConflictIds(effect) })
  })
})
