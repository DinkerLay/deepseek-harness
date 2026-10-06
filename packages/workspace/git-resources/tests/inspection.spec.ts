/** Pure work-copy facts remain available inside the actual write-use range without acknowledging or running work. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { harness, repository } from './harness.ts'

async function setup() {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await test.ctx.gitResources.create({ ...preview.request, operationId: GitOperationId('inspect-base'),
    consumerScope: GitConsumerScope('inspection-fixture'), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  return { ...test, base, made }
}

it('inspects while held without a lane deadlock, Git/domain writes, ignored reads or a quiet claim', async () => {
  const test = await setup(), path = test.made.resource.path
  const originalIndex = await readFile(join(test.project, '.git', 'index'))
  const inspected = await test.ctx.gitResources.withWriteUse(test.made.resource.resourceId,
    { useId: 'actual-live-use', ownerId: 'normal-command-execution', epoch: '1' }, new AbortController().signal, async (scope) => {
      await writeFile(join(path, 'file.txt'), Buffer.from([0, 255, 13, 10]))
      await writeFile(join(path, '.gitignore'), 'ignored/\n.env\n')
      await mkdir(join(path, 'ignored')); await writeFile(join(path, 'ignored', 'out'), Buffer.alloc(1000))
      await writeFile(join(path, '.env'), 'ignored private canary\n')
      await writeFile(join(path, '\uE000.txt'), 'private-use Unicode filename\n')
      await writeFile(join(path, '😀.txt'), 'non-BMP filename\n')
      const domain = test.ctx.storageDomain.get('git_resources')
      if (domain === undefined) throw new Error('real resource domain must be open')
      const unit = Reflect.get(domain, 'unit') as KvUnit, writes = vi.spyOn(unit, 'putRecord')
      const commands = vi.spyOn(ResourceGit.prototype, 'run'); commands.mockClear()
      const before = test.ctx.gitResources.read(scope.resource.resourceId)
      const first = await test.ctx.gitResources.inspectWorkCopy(scope.resource.resourceId)
      const second = await test.ctx.gitResources.inspectWorkCopy(scope.resource.resourceId)
      expect(second).toEqual(first)
      expect(first).toMatchObject({ resourceId: scope.resource.resourceId, resourceRevision: scope.resource.revision,
        head: test.base, conflictStages: [], unpreservedPaths: ['.env', 'ignored/'] })
      expect('quiet' in first || 'verified' in first).toBe(false)
      expect(writes).not.toHaveBeenCalled()
      const mutators = new Set(['read-tree', 'write-tree', 'commit-tree', 'update-ref', 'update-index', 'apply'])
      expect(commands.mock.calls.some(([args]) => mutators.has(args[0] ?? '') || args[0] === 'hash-object' && args.includes('-w'))).toBe(false)
      expect(commands.mock.calls.some(([, , , options]) => options?.input?.includes('private canary'))).toBe(false)
      expect(test.ctx.gitResources.read(scope.resource.resourceId)).toEqual(before)
      scope.assertCurrent(); writes.mockRestore(); commands.mockRestore()
      return first
    })
  const current = test.ctx.gitResources.read(test.made.resource.resourceId)
  if (current === undefined) throw new Error('actual handback must retain the work copy')
  const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('inspect-seal'), resourceId: current.resourceId,
    expectedRevision: current.revision, content: 'versioned' })
  expect(sealed.operation.effectManifestHash).toBe(inspected.manifestHash)
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(originalIndex)
  expect(test.git(['rev-parse', 'HEAD'])).toBe(test.base)
})

it('refuses a real content change between the observation passes rather than returning a successful version hash', async () => {
  const test = await setup(), path = test.made.resource.path
  // oxlint-disable-next-line typescript/unbound-method -- The spy delegates with .call(this) to the actual captured runner instance.
  const original = ResourceGit.prototype.run
  let first = true
  const gate = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
    const actual = await original.call(this, args, ...rest)
    if (first && args[0] === 'hash-object' && !args.includes('-w')) {
      first = false; await writeFile(join(path, 'file.txt'), 'changed after first real object hash\n')
    }
    return actual
  })
  const before = test.ctx.gitResources.read(test.made.resource.resourceId)
  await expect(test.ctx.gitResources.inspectWorkCopy(test.made.resource.resourceId)).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
  expect(test.ctx.gitResources.read(test.made.resource.resourceId)).toEqual(before)
  gate.mockRestore()
})
