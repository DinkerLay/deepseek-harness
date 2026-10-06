/** Public resource requests retain a later queued owner and share actual executable discovery. */
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { harness, repository } from './harness.ts'

it('shares executable discovery after both real filesystem checks have completed', async () => {
  const test = await harness(), base = await repository(test)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const secondChecked = Promise.withResolvers<undefined>()
  const originalResolve = test.ctx.subprocess.resolveExecutable.bind(test.ctx.subprocess)
  const resolve = vi.spyOn(test.ctx.subprocess, 'resolveExecutable').mockImplementation(async (...args) => {
    const executable = await originalResolve(...args)
    entered.resolve(undefined); await release.promise; return executable
  })
  const originalStat = fs.lstat.bind(fs), configPath = join(await fs.realpath(test.home), 'git-resources', 'isolated', 'empty-config')
  let checks = 0
  const stat = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
    const info = await originalStat(...args)
    if (String(args[0]) === configPath) {
      const isFile = info.isFile.bind(info)
      vi.spyOn(info, 'isFile').mockImplementation(() => {
        const actual = isFile()
        if (++checks === 2) {
          secondChecked.resolve(undefined)
          // This real check is synchronous with ensureGit reading the shared pending resolver.
          release.resolve(undefined)
        }
        return actual
      })
    }
    return info
  })
  syncBuiltinESMExports()
  const request = { workspaceId: test.workspace.id, baseline: { kind: 'commit' as const, commit: base } }
  const first = test.ctx.gitResources.preview(request)
  let second: ReturnType<typeof test.ctx.gitResources.preview> | undefined
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled(second === undefined ? [first] : [first, second])
    stat.mockRestore(); resolve.mockRestore(); syncBuiltinESMExports()
  })
  try {
    await entered.promise
    second = test.ctx.gitResources.preview(request)
    await secondChecked.promise
    const [left, right] = await Promise.all([first, second])
    expect(left.permitted).toBe(true); expect(right).toEqual(left)
    expect(resolve).toHaveBeenCalledTimes(1)
  } finally {
    release.resolve(undefined)
    await Promise.allSettled(second === undefined ? [first] : [first, second])
    stat.mockRestore(); resolve.mockRestore(); syncBuiltinESMExports()
  }
})

it('keeps a later writer queued when an earlier cancelled waiter finally settles', async () => {
  const test = await harness(), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await test.ctx.gitResources.create({ ...preview.request, consumerScope: GitConsumerScope('queued-successors'),
    originalRequestJson: '{}', operationId: GitOperationId('queued-successors-copy'), expectedPreviewFingerprint: preview.fingerprint })
  const firstEntered = Promise.withResolvers<undefined>(), releaseFirst = Promise.withResolvers<undefined>()
  const thirdEntered = Promise.withResolvers<undefined>(), releaseThird = Promise.withResolvers<undefined>()
  const normal = new AbortController().signal, cancelled = new AbortController()
  const order: string[] = [], skipped = vi.fn(async () => { order.push('cancelled') })
  const first = test.ctx.gitResources.withWriteUse(made.resource.resourceId,
    { useId: 'first', ownerId: 'first', epoch: '1' }, normal, async () => {
      order.push('first'); firstEntered.resolve(undefined); await releaseFirst.promise
    })
  let third: Promise<void> | undefined, fourth: Promise<void> | undefined
  try {
    await firstEntered.promise
    const second = test.ctx.gitResources.withWriteUse(made.resource.resourceId,
      { useId: 'cancelled', ownerId: 'cancelled', epoch: '1' }, cancelled.signal, skipped)
    const rejected = expect(second).rejects.toThrow('cancel this queued request')
    // owned() installs this waiter's lane entry in the already queued microtask.
    await Promise.resolve()
    cancelled.abort(new Error('cancel this queued request'))
    await rejected
    third = test.ctx.gitResources.withWriteUse(made.resource.resourceId,
      { useId: 'third', ownerId: 'third', epoch: '1' }, normal, async () => {
        order.push('third'); thirdEntered.resolve(undefined); await releaseThird.promise
      })
    await Promise.resolve()
    releaseFirst.resolve(undefined)
    await thirdEntered.promise
    fourth = test.ctx.gitResources.withWriteUse(made.resource.resourceId,
      { useId: 'fourth', ownerId: 'fourth', epoch: '1' }, normal, async () => { order.push('fourth') })
    const final = expect(fourth).resolves.toBeUndefined()
    releaseThird.resolve(undefined)
    await Promise.all([first, third, final])
    expect(skipped).not.toHaveBeenCalled()
    expect(order).toEqual(['first', 'third', 'fourth'])
    expect(test.ctx.gitResources.read(made.resource.resourceId)?.use).toBeUndefined()
  } finally {
    releaseFirst.resolve(undefined); releaseThird.resolve(undefined)
    await Promise.allSettled([first, ...(third === undefined ? [] : [third]), ...(fourth === undefined ? [] : [fourth])])
  }
})
