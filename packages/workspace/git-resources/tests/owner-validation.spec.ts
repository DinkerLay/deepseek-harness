/** Immutable blob facts and persisted ownership relations reject corruption before acknowledgement or publication. */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { acquireFileLease } from '@deepseek-ai/dsh-util-file-lease'
import GitResources, { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { repositorySchema } from '../src/records.ts'
import { harness, repository } from './harness.ts'

it('rejects blob output inconsistent with its complete bounded manifest and resumes only the original request', async () => {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const request = { ...preview.request, consumerScope: GitConsumerScope('blob-integrity'), originalRequestJson: '{}',
    operationId: GitOperationId('actual-blob-output'), expectedPreviewFingerprint: preview.fingerprint }
  const index = await readFile(join(test.project, '.git', 'index'))
  // oxlint-disable-next-line typescript/unbound-method -- Delegate to actual Git, then corrupt its declared output boundary.
  const original = ResourceGit.prototype.run
  const fault = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, args, ...rest) {
    const actual = await original.call(this, args, ...rest)
    return args[0] === 'cat-file' && args[1] === 'blob'
      ? { ...actual, stdout: Buffer.concat([actual.stdout, Buffer.from('unexpected bytes')]) } : actual
  })
  await expect(test.ctx.gitResources.create(request)).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('the actual original operation must remain observable')
  expect(pending.operation.phase).toBe('needs_attention')
  await expect(lstat(join(pending.resource.path, 'file.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  const completed = await test.ctx.gitResources.create(request)
  expect(completed.operation.phase).toBe('confirmed')
  expect(await readFile(join(completed.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
})

it('rejects a persisted orphan operation as an entire cold domain rather than silently skipping it during lookup', async () => {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await test.ctx.gitResources.create({ ...preview.request, consumerScope: GitConsumerScope('ownership-read'), originalRequestJson: '{}',
    operationId: GitOperationId('actual-owned-record'), expectedPreviewFingerprint: preview.fingerprint })
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('real authoritative domain must be open')
  const record = repositorySchema.parse(domain.table('repositories').get(made.resource.repositoryId))
  const backend = Reflect.get(domain, 'unit') as KvUnit
  // Corrupt only the durable read boundary; no resource API runs against the invalid backend bytes in the live owner.
  await backend.putRecord('repositories', made.resource.repositoryId, { ...record, resources: [] })
  await test.ctx.fiber.dispose()
  const cold = await harness({}, test.resources, false)
  await expect(cold.ctx.plugin(GitResources, { home: test.home })).rejects.toMatchObject({ code: 'invalid-record' })
  expect(cold.ctx.storageDomain.get('git_resources')).toBeUndefined()
  const lease = await acquireFileLease(join(test.home, 'git-resources', 'owner.lock')); await lease.release()
})
