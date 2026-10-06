/** Actual external path/ref/administrative effects prevent abandonment even when an original intent never dispatched a write. */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { harness, repository } from './harness.ts'

async function unusedIntent() {
  const test = await harness(), base = await repository(test), cancellation = new AbortController()
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const request = { ...preview.request, consumerScope: GitConsumerScope('abandon-boundaries'), originalRequestJson: '{}',
    operationId: GitOperationId('actual-unused-intent'), expectedPreviewFingerprint: preview.fingerprint }
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('actual owner domain must be open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, put = unit.putRecord.bind(unit)
  const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    await put(...args)
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === request.operationId
        && 'phase' in operation && operation.phase === 'intended')) cancellation.abort(new Error('caller froze before dispatch'))
  })
  await expect(test.ctx.gitResources.create(request, cancellation.signal)).rejects.toThrow('caller froze')
  fault.mockRestore()
  const pending = test.ctx.gitResources.status(request.operationId)
  if (pending === undefined) throw new Error('legal original no-write witness must persist')
  expect(pending.operation.externalWriteStarted).toBe(false)
  return { ...test, base, request, pending }
}

describe('readonly original no-effect proof', () => {
  let test: Awaited<ReturnType<typeof unusedIntent>>
  beforeEach(async () => { test = await unusedIntent() })
  it.each(['directory', 'private-ref', 'git-admin', 'git-registration'] as const)
  ('refuses actual %s appearing outside the original operation rather than deleting or adopting it', async (kind) => {
    const resource = test.pending.resource
    if (kind === 'directory') {
      await mkdir(resource.path); await writeFile(join(resource.path, 'unrelated.txt'), 'preserve unknown directory contents\n')
    } else if (kind === 'private-ref') test.git(['update-ref', resource.privateRef, test.base])
    else if (kind === 'git-admin') {
      test.git(['worktree', 'add', '--quiet', '--detach', '--no-checkout', resource.path, test.base])
      await rename(resource.path, `${resource.path}-moved`)
    } else {
      const external = join(test.root, 'external-worktree')
      test.git(['worktree', 'add', '--quiet', '--detach', '--no-checkout', external, test.base])
      test.git(['worktree', 'move', '--', external, resource.path])
      await rename(resource.path, `${resource.path}-moved`)
    }
    const refs = test.git(['for-each-ref', '--format=%(refname):%(objectname)'])
    await expect(test.ctx.gitResources.abandonOperation(test.request.operationId, test.pending.operation.fingerprint, 'cannot discard unknown effects'))
      .rejects.toMatchObject({ code: 'OPERATION_EFFECT_UNKNOWN' })
    expect(test.ctx.gitResources.status(test.request.operationId)?.operation).toEqual(test.pending.operation)
    expect(test.git(['for-each-ref', '--format=%(refname):%(objectname)'])).toBe(refs)
    if (kind === 'directory') expect(await readFile(join(resource.path, 'unrelated.txt'), 'utf8')).toBe('preserve unknown directory contents\n')
  })
  it.skipIf(process.platform === 'win32')('propagates actual reserved-parent lookup and administrative read denial without terminal acknowledgement', async () => {
    const parent = join(test.home, 'git-resources', 'workcopies')
    await chmod(parent, 0o500)
    // Remove search permission while preserving its actual inode; absence cannot be inferred from EACCES.
    await chmod(parent, 0o400)
    try {
      await expect(test.ctx.gitResources.abandonOperation(test.request.operationId, test.pending.operation.fingerprint, 'cannot prove absent path'))
        .rejects.toMatchObject({ code: 'EACCES' })
    } finally { await chmod(parent, 0o700) }
    const admin = join(test.project, '.git', 'worktrees'); await mkdir(admin); await chmod(admin, 0o100)
    try {
      await expect(test.ctx.gitResources.abandonOperation(test.request.operationId, test.pending.operation.fingerprint, 'cannot prove absent metadata'))
        .rejects.toMatchObject({ code: 'EACCES' })
    } finally { await chmod(admin, 0o700) }
    expect(test.ctx.gitResources.status(test.request.operationId)?.operation).toEqual(test.pending.operation)
  })
})
