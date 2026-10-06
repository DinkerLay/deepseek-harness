/** Real application filesystem edges, cancellation and inverse CAS retain the user's own Git state. */
import { chmod, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { GitOperationId } from '../src/index.ts'
import { applicationRequestSchema, applicationSchemas, applyApplication, inspectApplication, inspectInverse,
  inverseRequestSchema, observeApplication, prepareInverse } from '../src/application.ts'
import { abortAfterIntent, applicationEdgeFixture, edgeLimits, edgeSignal } from './edge-harness.ts'
import { ResourceGit } from '../src/git.ts'
import { deflateSync } from 'node:zlib'

/** Keep real Git's result, then move one owned fixture fact at an exact observation step. */
async function afterGitStep(test: Awaited<ReturnType<typeof applicationEdgeFixture>>, matches: (args: readonly string[]) => boolean,
  change: () => Promise<void>, body: () => Promise<void>) {
  const run = test.runner.run.bind(test.runner); let changed = false
  const fault = vi.spyOn(test.runner, 'run').mockImplementation(async (...args) => {
    const result = await run(...args)
    if (!changed && matches(args[0])) { changed = true; await change() }
    return result
  })
  try { await body(); expect(changed).toBe(true) } finally { fault.mockRestore() }
}

describe('real additions/deletions through absent parents', () => {
  let test: Awaited<ReturnType<typeof applicationEdgeFixture>>
  beforeEach(async () => { test = await applicationEdgeFixture(async (path) => {
    await mkdir(join(path, 'new', 'nested'), { recursive: true })
    await writeFile(join(path, 'new', 'nested', 'added.txt'), 'New exact content\n')
    await rm(join(path, 'removed.txt'))
  }) })
  it('applies exact added/deleted bytes while preserving target HEAD and index', async () => {
    const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
    expect(preview.target.touched).toMatchObject([{ path: 'new/nested/added.txt', before: { kind: 'absent' }, after: { kind: 'file' } },
      { path: 'removed.txt', before: { kind: 'file' }, after: { kind: 'absent' } }])
    expect(preview.target.ancestors.filter(value => value.identity === undefined).map(value => value.path)).toEqual(['new', 'new/nested'])
    const before = await readFile(join(test.project, '.git', 'index')), head = test.git(['rev-parse', 'HEAD'])
    const effect = await applyApplication(test.runner, preview, test.lease, edgeLimits)
    expect(effect.observation.state).toBe('after')
    expect(await readFile(join(test.project, 'new', 'nested', 'added.txt'), 'utf8')).toBe('New exact content\n')
    await expect(readFile(join(test.project, 'removed.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(test.project, '.git', 'index'))).toEqual(before)
    expect(test.git(['rev-parse', 'HEAD'])).toBe(head)
  })
  it('prepares a separate inverse for the added/deleted paths and drains its scratch directory', async () => {
    const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
    const before = await readFile(join(test.project, '.git', 'index')), head = test.git(['rev-parse', 'HEAD'])
    const effect = await applyApplication(test.runner, preview, test.lease, edgeLimits)
    const inverse = await inspectInverse(test.runner, effect, GitOperationId('addition-deletion-application'), edgeSignal, edgeLimits)
    const candidate = await prepareInverse(test.runner, inverse, GitOperationId('addition-deletion-inverse'),
      '2026-10-06T00:00:00.000Z', test.scratch, test.lease, edgeLimits)
    expect(candidate.result).toBe('prepared')
    expect(test.git(['ls-tree', '-r', '--name-only', candidate.tree])).toBe('file.txt\nremoved.txt')
    expect(test.git(['show', `${candidate.tree}:removed.txt`])).toBe('Remove this deliberately')
    expect(await readFile(join(test.project, '.git', 'index'))).toEqual(before)
    expect(test.git(['rev-parse', 'HEAD'])).toBe(head)
    expect(await readdir(test.scratch)).toEqual([])
  })
})

it('detects binary patches and retains a detached target and genuinely absent index', async () => {
  const test = await applicationEdgeFixture(async (path) => { await writeFile(join(path, 'file.txt'), Buffer.from([0, 1, 255, 2])) })
  test.git(['checkout', '--detach', '--quiet', test.base]); await rm(join(test.project, '.git', 'index'))
  const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
  expect(preview.binary).toBe(true); expect(preview.patch).toContain('GIT binary patch\n')
  expect(preview.target.symbolicRef).toBeUndefined()
  const applied = await applyApplication(test.runner, preview, test.lease, edgeLimits)
  expect(applied.observation).toMatchObject({ state: 'after', headUnchanged: true, indexUnchanged: true })
  expect(await readFile(join(test.project, 'file.txt'))).toEqual(Buffer.from([0, 1, 255, 2]))
  await expect(readFile(join(test.project, '.git', 'index'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects unresolved real index stages and invalid durable application/inverse requests', async () => {
  const test = await applicationEdgeFixture()
  const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
  const schemas = applicationSchemas(z.custom<typeof test.identity>())
  expect(schemas.source.parse(test.source)).toEqual(test.source)
  expect(schemas.preview.parse(preview)).toEqual(preview)
  const effect = await applyApplication(test.runner, preview, test.lease, edgeLimits)
  const inverse = await inspectInverse(test.runner, effect, GitOperationId('schema-original'), edgeSignal, edgeLimits)
  expect(schemas.effect.parse(effect)).toEqual(effect); expect(schemas.inversePreview.parse(inverse)).toEqual(inverse)
  expect(() => schemas.target.parse({ ...preview.target, extraAuthority: true })).toThrow()
  const request = { consumerScope: test.source.consumerScope, integrationOperationId: test.source.integrationOperationId,
    preserveOperationId: test.source.preserveOperationId, targetWorkspaceId: test.workspace.id,
    operationId: GitOperationId('parsed-application'), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }
  expect(applicationRequestSchema.parse(request)).toEqual(request)
  expect(() => applicationRequestSchema.parse({ ...request, originalRequestJson: 'not-json' })).toThrow()
  expect(() => inverseRequestSchema.parse({ consumerScope: test.source.consumerScope, applicationOperationId: request.operationId,
    targetWorkspaceId: test.workspace.id, operationId: GitOperationId('parsed-inverse'), originalRequestJson: 'not-json',
    expectedPreviewFingerprint: inverse.fingerprint })).toThrow()
  const object = test.git(['rev-parse', `${test.base}:file.txt`])
  test.git(['update-index', '--force-remove', '--', 'file.txt'])
  test.git(['update-index', '-z', '--index-info'], `100644 ${object} 1\tfile.txt\0`)
  const before = await readFile(join(test.project, '.git', 'index'))
  await expect(observeApplication(test.runner, preview, edgeSignal, edgeLimits)).rejects.toMatchObject({ code: 'APPLICATION_INDEX_UNMERGED' })
  expect(await readFile(join(test.project, '.git', 'index'))).toEqual(before)
})

it('refuses an occupied new path and nonregular or linked target content without treating errors as absence', async () => {
  const test = await applicationEdgeFixture(async (path) => { await writeFile(join(path, 'added.txt'), 'Selected addition\n') })
  await writeFile(join(test.project, 'added.txt'), 'User-owned occupied path\n')
  await expect(inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits))
    .rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED' })
  await rm(join(test.project, 'added.txt')); await mkdir(join(test.project, 'added.txt'))
  await expect(inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)).rejects.toMatchObject({ code: 'FILE_LIMIT' })
  await rm(join(test.project, 'added.txt'), { recursive: true }); await symlink(join(test.project, 'file.txt'), join(test.project, 'added.txt'))
  await expect(inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits))
    .rejects.toMatchObject({ code: 'SYMLINK_UNSUPPORTED' })
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
})

it('rejects a replaced target repository witness and reports identical bytes under a replaced parent as unknown', async () => {
  const test = await applicationEdgeFixture(async (path) => {
    await mkdir(join(path, 'nested')); await writeFile(join(path, 'nested', 'new.txt'), 'Selected\n')
  })
  const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
  const effect = await applyApplication(test.runner, preview, test.lease, edgeLimits)
  const inverse = await inspectInverse(test.runner, effect, GitOperationId('parent-change-original'), edgeSignal, edgeLimits)
  await rename(join(test.project, 'nested'), join(test.root, 'prior-nested')); await mkdir(join(test.project, 'nested'))
  await writeFile(join(test.project, 'nested', 'new.txt'), 'Selected\n')
  const changed = { ...preview, target: inverse.currentTarget }
  expect(await observeApplication(test.runner, changed, edgeSignal, edgeLimits)).toMatchObject({ state: 'unknown', headUnchanged: true, indexUnchanged: true })
  await rm(join(test.project, 'nested'), { recursive: true })
  expect((await observeApplication(test.runner, changed, edgeSignal, edgeLimits)).state).toBe('unknown')
  await rename(join(test.project, '.git'), join(test.root, 'prior-git')); await mkdir(join(test.project, '.git'))
  await expect(observeApplication(test.runner, preview, edgeSignal, edgeLimits)).rejects.toMatchObject({ code: 'APPLICATION_TARGET_REPLACED' })
})

describe('a parent replaced between a real file read and ancestor inspection', () => {
  let test: Awaited<ReturnType<typeof applicationEdgeFixture>>
  beforeEach(async () => { test = await applicationEdgeFixture(async (path) => {
    await mkdir(join(path, 'nested')); await writeFile(join(path, 'nested', 'new.txt'), 'Selected\n')
  }) })
  it('refuses a non-directory ancestor without rewriting the substituted path', async () => {
    const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
    await applyApplication(test.runner, preview, test.lease, edgeLimits)
    await afterGitStep(test, args => args[0] === 'hash-object', async () => {
      await rename(join(test.project, 'nested'), join(test.root, 'prior-parent'))
      await writeFile(join(test.project, 'nested'), 'A user-owned regular file replaced the directory\n')
    }, async () => { await expect(observeApplication(test.runner, preview, edgeSignal, edgeLimits))
      .rejects.toMatchObject({ code: 'APPLICATION_TARGET_UNAVAILABLE' }) })
    expect(await readFile(join(test.project, 'nested'), 'utf8')).toBe('A user-owned regular file replaced the directory\n')
  })
})

it('cancels after successful patch preflight with no working-file write or process left active', async () => {
  const test = await applicationEdgeFixture()
  const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
  const cancellation = new AbortController(), run = test.runner.run.bind(test.runner)
  const actualCalls: string[][] = []
  const fault = vi.spyOn(test.runner, 'run').mockImplementation(async (...args) => {
    actualCalls.push([...args[0]])
    const result = await run(...args)
    if (args[0][0] === 'apply' && args[0].includes('--check')) cancellation.abort(new Error('user stopped the pending application'))
    return result
  })
  try {
    await expect(applyApplication(test.runner, preview, { signal: cancellation.signal, assertCurrent: () => {} }, edgeLimits))
      .rejects.toThrow('user stopped the pending application')
  } finally { fault.mockRestore() }
  expect(actualCalls.filter(args => args[0] === 'apply').every(args => args.includes('--check'))).toBe(true)
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  expect((await observeApplication(test.runner, preview, edgeSignal, edgeLimits)).state).toBe('before')
})

it('refuses uncertain inverse input and rejects changes after inverse preview or while snapshotting', async () => {
  const test = await applicationEdgeFixture()
  const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
  const original = await applyApplication(test.runner, preview, test.lease, edgeLimits)
  await expect(inspectInverse(test.runner, { ...original, observation: { ...original.observation, state: 'partial' } },
    GitOperationId('uncertain-original'), edgeSignal, edgeLimits)).rejects.toMatchObject({ code: 'INVERSE_SOURCE_UNCERTAIN' })
  const inverse = await inspectInverse(test.runner, original, GitOperationId('inverse-original'), edgeSignal, edgeLimits)
  await writeFile(join(test.project, 'file.txt'), 'User changed after the inverse preview\n')
  await expect(prepareInverse(test.runner, inverse, GitOperationId('stale-inverse'), '2026-10-06T00:00:00.000Z',
    test.scratch, test.lease, edgeLimits)).rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED' })
  const current = await inspectInverse(test.runner, original, GitOperationId('inverse-original'), edgeSignal, edgeLimits)
  const run = test.runner.run.bind(test.runner)
  const fault = vi.spyOn(test.runner, 'run').mockImplementation(async (...args) => {
    const result = await run(...args)
    if (args[0][0] === 'read-tree') await writeFile(join(test.project, 'file.txt'), 'User changed during inverse snapshot\n')
    return result
  })
  try {
    await expect(prepareInverse(test.runner, current, GitOperationId('raced-inverse'), '2026-10-06T00:00:00.000Z',
      test.scratch, test.lease, edgeLimits)).rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED' })
  } finally { fault.mockRestore() }
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('User changed during inverse snapshot\n')
  expect(await readdir(test.scratch)).toEqual([])
})

describe('an original application frozen after durable intent', () => {
  let test: Awaited<ReturnType<typeof applicationEdgeFixture>>
  beforeEach(async () => { test = await applicationEdgeFixture() })
  it('abandons an exact before cut with no write and retains the terminal intent on retry', async () => {
    const selected = { consumerScope: test.source.consumerScope, integrationOperationId: test.source.integrationOperationId,
      preserveOperationId: test.source.preserveOperationId, targetWorkspaceId: test.workspace.id }
    const preview = await test.ctx.gitResources.previewApplication(selected)
    const request = { ...selected, operationId: GitOperationId('frozen-application-intent'), originalRequestJson: '{}',
      expectedPreviewFingerprint: preview.fingerprint }
    const cancellation = new AbortController(), fault = abortAfterIntent(test, request.operationId, cancellation)
    try {
      await expect(test.ctx.gitResources.apply(request, cancellation.signal, () => {})).rejects.toThrow('frozen after durable original intent')
    } finally { fault.mockRestore() }
    const before = test.ctx.gitResources.status(request.operationId)
    if (before === undefined) throw new Error('frozen application must retain its exact durable intent')
    expect(before.operation.externalWriteStarted).toBe(false); expect(before.operation.applicationEffect).toBeUndefined()
    const abandoned = await test.ctx.gitResources.abandonOperation(request.operationId, before.operation.fingerprint,
      'User stopped before target application', edgeSignal, () => {})
    expect(abandoned.operation.phase).toBe('abandoned')
    const run = vi.spyOn(ResourceGit.prototype, 'run')
    try { expect((await test.ctx.gitResources.apply(request, edgeSignal, () => {})).operation).toEqual(abandoned.operation) }
    finally { const calls = run.mock.calls.length; run.mockRestore(); expect(calls).toBe(0) }
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  })
  it('refuses abandonment once the actual patch started even when final confirmation was revoked', async () => {
    const selected = { consumerScope: test.source.consumerScope, integrationOperationId: test.source.integrationOperationId,
      preserveOperationId: test.source.preserveOperationId, targetWorkspaceId: test.workspace.id }
    const preview = await test.ctx.gitResources.previewApplication(selected)
    const request = { ...selected, operationId: GitOperationId('started-application-intent'), originalRequestJson: '{}',
      expectedPreviewFingerprint: preview.fingerprint }
    let written = false
    const run: ResourceGit['run'] = Reflect.get(ResourceGit.prototype, 'run')
    const fault = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, ...args) {
      const result = await run.call(this, ...args)
      if (args[0][0] === 'apply' && !args[0].includes('--check')) {
        written = true; await writeFile(join(test.project, 'file.txt'), 'User replaced the partially observed application\n')
      }
      return result
    })
    try { await expect(test.ctx.gitResources.apply(request, edgeSignal, () => {})).rejects.toMatchObject({ code: 'APPLICATION_EFFECT_UNCERTAIN' }) }
    finally { fault.mockRestore() }
    expect(written).toBe(true)
    const before = test.ctx.gitResources.status(request.operationId)
    if (before === undefined) throw new Error('started application must remain observable')
    expect(before.operation).toMatchObject({ externalWriteStarted: true, phase: 'needs_attention' })
    await expect(test.ctx.gitResources.abandonOperation(request.operationId, before.operation.fingerprint,
      'Cannot discard unknown effects', edgeSignal, () => {})).rejects.toMatchObject({ code: 'OPERATION_EFFECT_UNKNOWN' })
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('User replaced the partially observed application\n')
  })
})

describe('application observation failure windows', () => {
  let test: Awaited<ReturnType<typeof applicationEdgeFixture>>
  beforeEach(async () => { test = await applicationEdgeFixture() })
  it('refuses an index changed before application and an inconsistent persisted patch digest before Git apply', async () => {
    const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
    await expect(applyApplication(test.runner, { ...preview, patchHash: 'inconsistent-saved-digest' }, test.lease, edgeLimits))
      .rejects.toMatchObject({ code: 'APPLICATION_VERSION_CHANGED' })
    await writeFile(join(test.project, 'later-index.txt'), 'New user index work\n'); test.git(['add', '--', 'later-index.txt'])
    await expect(applyApplication(test.runner, preview, test.lease, edgeLimits)).rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED' })
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  })
  it('rejects a read-only preview whose second cut observes a later edit', async () => {
    await afterGitStep(test, args => args[0] === 'diff', async () => { await writeFile(join(test.project, 'file.txt'), 'Changed during preview\n') },
      async () => { await expect(inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits))
        .rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED' }) })
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('Changed during preview\n')
  })
  it('refuses a linked index rather than hashing content from a substituted metadata path', async () => {
    const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
    const index = join(test.project, '.git', 'index'), saved = join(test.root, 'owned-saved-index')
    await rename(index, saved); await symlink(saved, index)
    await expect(observeApplication(test.runner, preview, edgeSignal, edgeLimits)).rejects.toMatchObject({ code: 'SYMLINK_UNSUPPORTED' })
  })
  it('refuses HEAD metadata corrupted after a valid real rev-parse and before symbolic-ref', async () => {
    const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
    await afterGitStep(test, args => args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD',
      async () => { await writeFile(join(test.project, '.git', 'HEAD'), 'invalid-head\n') },
      async () => { await expect(observeApplication(test.runner, preview, edgeSignal, edgeLimits))
        .rejects.toMatchObject({ code: 'APPLICATION_TARGET_UNAVAILABLE' }) })
  })
  it('refuses a loose immutable object whose actual bytes changed after the bounded size read', async () => {
    const objectId = test.git(['rev-parse', `${test.base}:file.txt`]), objectPath = join(test.project, '.git', 'objects',
        objectId.slice(0, 2), objectId.slice(2)), original = await readFile(objectPath), info = await stat(objectPath)
    await chmod(objectPath, 0o600)
    try {
      await afterGitStep(test, args => args[0] === 'ls-tree' && args.includes(test.source.originalTargetBaseTree), async () => {
        const content = Buffer.from('Externally replaced immutable bytes\n')
        await writeFile(objectPath, deflateSync(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])))
      }, async () => { await expect(inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits))
        .rejects.toMatchObject({ code: 'APPLICATION_VERSION_CHANGED' }) })
    } finally { await writeFile(objectPath, original); await chmod(objectPath, info.mode) }
  })
  it('rejects an inverse cut that changes between its two read-only observations or after its private write-tree', async () => {
    const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
    const original = await applyApplication(test.runner, preview, test.lease, edgeLimits)
    await afterGitStep(test, args => args[0] === 'rev-parse' && args[1] === '--git-path' && args[2] === 'index',
      async () => { await writeFile(join(test.project, 'file.txt'), 'Changed between inverse observations\n') },
      async () => { await expect(inspectInverse(test.runner, original, GitOperationId('two-cuts-original'), edgeSignal, edgeLimits))
        .rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED' }) })
    const inverse = await inspectInverse(test.runner, original, GitOperationId('two-cuts-original'), edgeSignal, edgeLimits)
    await afterGitStep(test, args => args[0] === 'write-tree',
      async () => { await writeFile(join(test.project, 'file.txt'), 'Changed after private inverse snapshot\n') },
      async () => { await expect(prepareInverse(test.runner, inverse, GitOperationId('post-tree-inverse'),
        '2026-10-06T00:00:00.000Z', test.scratch, test.lease, edgeLimits)).rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED' }) })
    expect(await readdir(test.scratch)).toEqual([])
  })
  it('rejects corrupted hash-object response metadata after the actual Git object write', async () => {
    const preview = await inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits)
    const original = await applyApplication(test.runner, preview, test.lease, edgeLimits)
    const inverse = await inspectInverse(test.runner, original, GitOperationId('corrupted-response-original'), edgeSignal, edgeLimits)
    const run = test.runner.run.bind(test.runner); let actualObject: string | undefined
    // This negative control corrupts returned metadata only after real Git wrote the correct blob.
    // It does not claim that normal Git hashes identical bytes inconsistently.
    const fault = vi.spyOn(test.runner, 'run').mockImplementation(async (...args) => {
      const result = await run(...args)
      if (args[0][0] === 'hash-object' && args[0].includes('-w')) {
        actualObject = result.stdout.toString('utf8').trim()
        return { ...result, stdout: Buffer.from(`${test.base}\n`) }
      }
      return result
    })
    try {
      await expect(prepareInverse(test.runner, inverse, GitOperationId('corrupted-response-inverse'),
        '2026-10-06T00:00:00.000Z', test.scratch, test.lease, edgeLimits)).rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED' })
    } finally { fault.mockRestore() }
    if (actualObject === undefined) throw new Error('the real hash-object write must precede metadata corruption')
    expect(test.git(['cat-file', '-t', actualObject])).toBe('blob')
    expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('EDGE RESULT\n')
    expect(await readdir(test.scratch)).toEqual([])
  })
})

it('bounds the complete old/new union and rejects non-UTF-8 text patches from real Git', async () => {
  const test = await applicationEdgeFixture(async (path) => {
    await rm(join(path, 'file.txt')); await rm(join(path, 'removed.txt'))
    await writeFile(join(path, 'one.txt'), 'One\n'); await writeFile(join(path, 'two.txt'), Buffer.from([0x66, 0xff, 0x0a]))
  })
  await expect(inspectApplication(test.runner, test.identity, test.source, edgeSignal, { ...edgeLimits, maxFiles: 2 }))
    .rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
  await expect(inspectApplication(test.runner, test.identity, test.source, edgeSignal, edgeLimits))
    .rejects.toMatchObject({ code: 'APPLICATION_PATCH_UNSUPPORTED' })
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
})
