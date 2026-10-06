/** Deliberately damaged durable integration metadata is refused without replaying immutable or physical effects. */
import { lstat, readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { edgeFixture } from './edge-harness.ts'
import { coldCorruptOperation } from './owner-corruption-harness.ts'

describe('cold damaged original integration metadata', () => {
  let test: Awaited<ReturnType<typeof edgeFixture>>
  beforeEach(async () => { test = await edgeFixture() })
  it.each(['missing-cut', 'wrong-kind', 'changed-cut-fingerprint'] as const)
  ('refuses explicit persisted %s corruption without creating objects, refs or adopting its reserved path', async (kind) => {
    const preview = await test.ctx.gitResources.previewIntegration(test.selection)
    const request = { ...test.selection, operationId: GitOperationId('cold-original-integration'), originalRequestJson: '{}',
      expectedPreviewFingerprint: preview.fingerprint }
    await expect(test.ctx.gitResources.integrate(request, new AbortController().signal, () => {
      if (test.ctx.gitResources.status(request.operationId) !== undefined) throw new Error('caller stopped before preparation')
    })).rejects.toThrow('caller stopped')
    const cold = await coldCorruptOperation(test, request.operationId, (operation) => {
      if (kind === 'wrong-kind') return { ...operation, kind: 'create' }
      if (kind === 'missing-cut') { const { integrationPreview: _missingCut, ...rest } = operation; return rest }
      if (operation.integrationPreview === undefined) throw new Error('the legal original must include its captured cut')
      return { ...operation, integrationPreview: { ...operation.integrationPreview, fingerprint: 'explicitly-corrupted-cut' } }
    })
    const refs = test.git(['show-ref']), calls = vi.spyOn(ResourceGit.prototype, 'run'); calls.mockClear()
    await expect(cold.ctx.gitResources.integrate(request)).rejects.toMatchObject({
      code: kind === 'changed-cut-fingerprint' ? 'PREVIEW_CHANGED' : 'RECORD_INVALID' })
    expect(calls.mock.calls.some(([args]) => ['hash-object', 'read-tree', 'write-tree', 'commit-tree', 'update-ref', 'merge-tree'].includes(args[0] ?? '')
      || args[0] === 'worktree' && args[1] === 'add')).toBe(false)
    await expect(lstat(cold.pending.resource.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(test.git(['show-ref'])).toBe(refs)
    expect(cold.ctx.gitResources.status(request.operationId)?.operation.request).toEqual(request)
    expect(JSON.parse(await readFile(cold.backup, 'utf8'))).toEqual(cold.original)
    calls.mockRestore()
  })
})
