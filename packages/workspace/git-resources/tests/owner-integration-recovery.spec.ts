/** Integration intents reserve exact paths, retain original identities and never adopt unknown physical effects. */
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { GitOperationId } from '../src/index.ts'
import { hash } from '../src/records.ts'
import { ResourceGit } from '../src/git.ts'
import { edgeFixture } from './edge-harness.ts'

describe('original prepared integration recovery', () => {
  let test: Awaited<ReturnType<typeof edgeFixture>>
  beforeEach(async () => { test = await edgeFixture() })
  async function request(id: string) {
    const preview = await test.ctx.gitResources.previewIntegration(test.selection)
    return { ...test.selection, operationId: GitOperationId(id), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }
  }
  it('refuses stale previews, absent operation selections and a pre-existing unknown reserved directory before intent', async () => {
    const original = await request('integration-path-collision')
    await expect(test.ctx.gitResources.integrate({ ...original, expectedPreviewFingerprint: 'not-the-preview' }))
      .rejects.toMatchObject({ code: 'PREVIEW_CHANGED' })
    await expect(test.ctx.gitResources.previewIntegration({ ...test.selection, sourcePreserveOperationIds: [GitOperationId('unknown-input')] }))
      .rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' })
    const path = join(test.home, 'git-resources', 'workcopies', hash([test.identity.repositoryId, original.operationId]))
    await mkdir(path); await writeFile(join(path, 'unknown.txt'), 'retain this unknown physical owner\n')
    await expect(test.ctx.gitResources.integrate(original)).rejects.toMatchObject({ code: 'RESOURCE_UNKNOWN' })
    expect(test.ctx.gitResources.status(original.operationId)).toBeUndefined()
    expect(await readFile(join(path, 'unknown.txt'), 'utf8')).toBe('retain this unknown physical owner\n')
  })
  it('abandons only an actual stopped no-effect integration intent and never reuses its id', async () => {
    const original = await request('abandoned-integration')
    const proof = () => {
      if (test.ctx.gitResources.status(original.operationId) !== undefined) throw new Error('caller froze after durable intent')
    }
    await expect(test.ctx.gitResources.integrate(original, new AbortController().signal, proof)).rejects.toThrow('caller froze')
    const pending = test.ctx.gitResources.status(original.operationId)
    if (pending === undefined) throw new Error('actual original intent must survive the stop')
    expect(pending.operation.externalWriteStarted).toBe(false)
    const observing = vi.spyOn(ResourceGit.prototype, 'run'); observing.mockClear()
    const observation = await test.ctx.gitResources.reconcile(original.operationId)
    expect(observation.operation.phase).toBe('needs_attention')
    expect(observation.operation.integrationEffect).toBeUndefined()
    expect(observing.mock.calls.some(([args]) => ['hash-object', 'read-tree', 'write-tree', 'commit-tree', 'update-ref', 'merge-tree'].includes(args[0] ?? '')))
      .toBe(false)
    observing.mockRestore()
    await expect(test.ctx.gitResources.abandonOperation(original.operationId, pending.operation.fingerprint, ' '))
      .rejects.toMatchObject({ code: 'DIAGNOSTIC_INVALID' })
    await expect(test.ctx.gitResources.abandonOperation(original.operationId, pending.operation.fingerprint, 'x'.repeat(128 * 1024 + 1)))
      .rejects.toMatchObject({ code: 'DIAGNOSTIC_INVALID' })
    const stopped = await test.ctx.gitResources.abandonOperation(original.operationId, pending.operation.fingerprint, 'explicitly stop unused preparation')
    expect(stopped.operation.phase).toBe('abandoned')
    const calls = vi.spyOn(ResourceGit.prototype, 'run'); calls.mockClear()
    expect(await test.ctx.gitResources.integrate(original)).toEqual(stopped)
    expect(calls).not.toHaveBeenCalled(); calls.mockRestore()
    await expect(lstat(pending.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not acknowledge a removed original directory after a genuine interrupted integration materialization', async () => {
    const original = await request('integration-directory-missing')
    const domain = test.ctx.storageDomain.get('git_resources')
    if (domain === undefined) throw new Error('actual domain must be open')
    const unit = Reflect.get(domain, 'unit') as KvUnit, put = unit.putRecord.bind(unit)
    const failure = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
      const value = args[2]
      if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
        && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
          && 'operationId' in operation && operation.operationId === original.operationId
          && 'phase' in operation && operation.phase === 'confirmed')) throw new Error('final integration confirmation failed')
      return put(...args)
    })
    await expect(test.ctx.gitResources.integrate(original)).rejects.toThrow('confirmation failed')
    failure.mockRestore()
    const pending = test.ctx.gitResources.status(original.operationId)
    if (pending === undefined) throw new Error('observed original directory must remain recorded')
    test.git(['worktree', 'remove', '--force', '--', pending.resource.path])
    await expect(test.ctx.gitResources.integrate(original)).rejects.toMatchObject({ code: 'RESOURCE_MISSING' })
    await expect(lstat(pending.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses unknown physical directory ownership after the integration creation-dispatch checkpoint failed', async () => {
    const original = await request('integration-unknown-directory'), domain = test.ctx.storageDomain.get('git_resources')
    if (domain === undefined) throw new Error('actual domain must be open')
    const unit = Reflect.get(domain, 'unit') as KvUnit, put = unit.putRecord.bind(unit)
    const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
      const value = args[2]
      if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
        && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
          && 'operationId' in operation && operation.operationId === original.operationId
          && 'worktreeCreateStarted' in operation && operation.worktreeCreateStarted === true)) {
        throw new Error('integration creation-dispatch checkpoint failed')
      }
      return put(...args)
    })
    await expect(test.ctx.gitResources.integrate(original)).rejects.toThrow('creation-dispatch checkpoint failed')
    fault.mockRestore()
    const pending = test.ctx.gitResources.status(original.operationId)
    if (pending?.operation.integrationEffect === undefined) throw new Error('the immutable original effect must already be recorded')
    // A real external Git operation creates the same-address copy, without this intent's durable creation witness.
    test.git(['worktree', 'add', '--quiet', '--detach', '--no-checkout', pending.resource.path, pending.operation.integrationEffect.commit])
    await writeFile(join(pending.resource.path, 'unrelated.txt'), 'unknown directory data\n')
    const observed = await test.ctx.gitResources.reconcile(original.operationId)
    expect(observed.operation.phase).toBe('needs_attention')
    expect(observed.operation.diagnostic).toContain('creation witness')
    await expect(test.ctx.gitResources.integrate(original)).rejects.toMatchObject({ code: 'RESOURCE_UNKNOWN' })
    expect(await readFile(join(pending.resource.path, 'unrelated.txt'), 'utf8')).toBe('unknown directory data\n')
  })
})
