/** A confirmed versioned seal can be read as a read-only directory, apart from every work copy. */
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { edgeFixture, edgeScope } from './edge-harness.ts'
import { harness, repository } from './harness.ts'

const scope = GitConsumerScope('snapshot-fixture')
/** Restore write permission under a directory so the fixture's own removal can delete it. */
async function writable(path: string): Promise<void> {
  await chmod(path, 0o700)
  for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(path, entry.name))
}
async function sealed() {
  const test = await harness(), base = await repository(test)
  // Registered after the fixture's removal, so it runs before it.
  onTestFinished(async () => { await writable(join(test.home, 'git-resources', 'snapshots')) })
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await test.ctx.gitResources.create({ ...preview.request, consumerScope: scope, originalRequestJson: '{}',
    operationId: GitOperationId('snapshot-copy'), expectedPreviewFingerprint: preview.fingerprint })
  await writeFile(join(made.resource.path, 'file.txt'), 'SEALED\n')
  await mkdir(join(made.resource.path, 'bin'))
  await writeFile(join(made.resource.path, 'bin', 'run.sh'), '#!/bin/sh\necho run\n', { mode: 0o755 })
  await mkdir(join(made.resource.path, 'bin', 'lib'))
  await writeFile(join(made.resource.path, 'bin', 'lib', 'helper.sh'), 'helper\n')
  const seal = await test.ctx.gitResources.preserve({ operationId: GitOperationId('snapshot-seal'), resourceId: made.resource.resourceId,
    expectedRevision: made.resource.revision })
  return { ...test, made, seal }
}

it('writes the sealed files once into a directory named by the tree, without write permission', async () => {
  const test = await sealed()
  const snapshot = await test.ctx.gitResources.snapshot({ preserveOperationId: test.seal.operation.operationId, consumerScope: scope })
  expect(snapshot.tree).toBe(test.seal.operation.effectTree)
  expect(snapshot.path.endsWith(join('git-resources', 'snapshots', snapshot.tree))).toBe(true)
  expect((await readdir(snapshot.path)).sort()).toEqual(['bin', 'file.txt', 'removed.txt'])
  expect(await readFile(join(snapshot.path, 'file.txt'), 'utf8')).toBe('SEALED\n')
  expect(await readFile(join(snapshot.path, 'bin', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho run\n')
  if (process.platform !== 'win32') {
    expect((await stat(join(snapshot.path, 'file.txt'))).mode & 0o777).toBe(0o444)
    expect((await stat(join(snapshot.path, 'bin', 'run.sh'))).mode & 0o777).toBe(0o555)
    expect((await stat(join(snapshot.path, 'bin'))).mode & 0o777).toBe(0o555)
    expect((await stat(join(snapshot.path, 'bin', 'lib'))).mode & 0o777).toBe(0o555)
    expect((await stat(snapshot.path)).mode & 0o777).toBe(0o555)
    await expect(writeFile(join(snapshot.path, 'file.txt'), 'CHANGED\n')).rejects.toMatchObject({ code: 'EACCES' })
    await expect(writeFile(join(snapshot.path, 'new.txt'), 'NEW\n')).rejects.toMatchObject({ code: 'EACCES' })
  }
  // The work copy, its refs and the user's project are left as they were.
  expect(await readFile(join(test.made.resource.path, 'file.txt'), 'utf8')).toBe('SEALED\n')
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('BASE\n')
  const commands = vi.spyOn(ResourceGit.prototype, 'run')
  const again = await test.ctx.gitResources.snapshot({ preserveOperationId: test.seal.operation.operationId, consumerScope: scope })
  expect(again).toEqual(snapshot)
  expect(commands.mock.calls.some(([args]) => args[0] === 'cat-file')).toBe(false)
  commands.mockRestore()
})

it('refuses a source that is not a confirmed versioned seal of the same consumer scope', async () => {
  const test = await sealed()
  await expect(test.ctx.gitResources.snapshot({ preserveOperationId: test.seal.operation.operationId,
    consumerScope: GitConsumerScope('another-consumer') })).rejects.toMatchObject({ code: 'SNAPSHOT_SOURCE_INVALID' })
  await expect(test.ctx.gitResources.snapshot({ preserveOperationId: test.made.operation.operationId, consumerScope: scope }))
    .rejects.toMatchObject({ code: 'SNAPSHOT_SOURCE_INVALID' })
  await expect(test.ctx.gitResources.snapshot({ preserveOperationId: GitOperationId('unknown-seal'), consumerScope: scope }))
    .rejects.toMatchObject({ code: 'SNAPSHOT_SOURCE_INVALID' })
  const all = await test.ctx.gitResources.preserve({ operationId: GitOperationId('snapshot-all'), resourceId: test.made.resource.resourceId,
    expectedRevision: test.ctx.gitResources.read(test.made.resource.resourceId)!.revision, content: 'all' })
  await expect(test.ctx.gitResources.snapshot({ preserveOperationId: all.operation.operationId, consumerScope: scope }))
    .rejects.toMatchObject({ code: 'SNAPSHOT_SOURCE_INVALID' })
})

it('refuses a seal that still holds conflict stages, and a snapshot path that is not a directory', async () => {
  const test = await edgeFixture()
  onTestFinished(async () => { await writable(join(test.home, 'git-resources', 'snapshots')) })
  await writeFile(join(test.made.resource.path, 'file.txt'), 'OTHER RESULT\n')
  const current = test.ctx.gitResources.read(test.made.resource.resourceId)!
  const other = await test.ctx.gitResources.preserve({ operationId: GitOperationId('snapshot-other'), resourceId: current.resourceId,
    expectedRevision: current.revision, content: 'versioned' })
  const inputs = { ...test.selection, basePreserveOperationId: test.version.operation.operationId,
    sourcePreserveOperationIds: [other.operation.operationId] }
  const preview = await test.ctx.gitResources.previewIntegration(inputs)
  const integrated = await test.ctx.gitResources.integrate({ ...inputs, operationId: GitOperationId('snapshot-conflict'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  expect(integrated.operation.integrationEffect?.result).toBe('conflicted')
  const unresolved = await test.ctx.gitResources.preserve({ operationId: GitOperationId('snapshot-unresolved'),
    resourceId: integrated.resource.resourceId, expectedRevision: integrated.resource.revision, content: 'versioned' })
  expect(unresolved.operation.effectConflictStages?.length).toBeGreaterThan(0)
  await expect(test.ctx.gitResources.snapshot({ preserveOperationId: unresolved.operation.operationId, consumerScope: edgeScope }))
    .rejects.toMatchObject({ code: 'SNAPSHOT_SOURCE_INVALID' })
  // Something other than a finished snapshot under the tree's name is never taken for one.
  await writeFile(join(test.home, 'git-resources', 'snapshots', other.operation.effectTree!), 'not a snapshot\n')
  await expect(test.ctx.gitResources.snapshot({ preserveOperationId: other.operation.operationId, consumerScope: edgeScope }))
    .rejects.toMatchObject({ code: 'RESOURCE_HOME_INVALID' })
})

it('refuses blob bytes that differ from the tree listing and leaves nothing behind', async () => {
  const test = await sealed(), snapshots = join(test.home, 'git-resources', 'snapshots')
  // oxlint-disable-next-line typescript/unbound-method -- Delegate to actual Git, then shorten its blob output.
  const run = ResourceGit.prototype.run
  const short = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(async function (this: ResourceGit, ...args: Parameters<ResourceGit['run']>) {
    const result = await run.apply(this, args)
    return args[0][0] === 'cat-file' ? { ...result, stdout: result.stdout.subarray(1) } : result
  })
  await expect(test.ctx.gitResources.snapshot({ preserveOperationId: test.seal.operation.operationId, consumerScope: scope }))
    .rejects.toMatchObject({ code: 'RESOURCE_CHANGED' })
  short.mockRestore()
  // Only the owner's package boundary stays beside the snapshots.
  expect(await readdir(snapshots)).toEqual(['package.json'])
})

it('removes a snapshot cut short before its rename when the owner starts again, keeps finished ones and writes it anew', async () => {
  const test = await sealed(), snapshots = join(test.home, 'git-resources', 'snapshots')
  const finished = await test.ctx.gitResources.snapshot({ preserveOperationId: test.seal.operation.operationId, consumerScope: scope })
  await writable(finished.path); await rm(finished.path, { recursive: true })
  const kept = join(snapshots, 'kept-finished-snapshot')
  await mkdir(kept); await writeFile(join(kept, 'file.txt'), 'kept\n'); await chmod(kept, 0o555)
  // A process that stopped mid-write leaves its temporary directory, read-only parts included.
  const partial = join(snapshots, '.partial-cut-short')
  await mkdir(join(partial, 'bin'), { recursive: true })
  await writeFile(join(partial, 'bin', 'run.sh'), 'partial\n')
  await chmod(join(partial, 'bin', 'run.sh'), 0o555); await chmod(join(partial, 'bin'), 0o555); await chmod(partial, 0o555)
  await test.ctx.fiber.dispose()
  const cold = await harness({}, test.resources)
  await expect(lstat(partial)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(kept, 'file.txt'), 'utf8')).toBe('kept\n')
  const snapshot = await cold.ctx.gitResources.snapshot({ preserveOperationId: test.seal.operation.operationId, consumerScope: scope })
  expect(await readFile(join(snapshot.path, 'bin', 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho run\n')
  expect((await readdir(snapshots)).filter(name => name.startsWith('.partial-'))).toEqual([])
})

it('leaves no temporary directory behind when writing a snapshot fails', async () => {
  const test = await sealed(), snapshots = join(test.home, 'git-resources', 'snapshots')
  // oxlint-disable-next-line typescript/unbound-method -- Delegate to actual Git except the blob reads that fail.
  const run = ResourceGit.prototype.run
  const fault = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(function (this: ResourceGit, ...args: Parameters<ResourceGit['run']>) {
    if (args[0][0] === 'cat-file') return Promise.reject(new Error('blob read failed'))
    return run.apply(this, args)
  })
  await expect(test.ctx.gitResources.snapshot({ preserveOperationId: test.seal.operation.operationId, consumerScope: scope }))
    .rejects.toThrow('blob read failed')
  fault.mockRestore()
  // Only the owner's package boundary stays beside the snapshots.
  expect(await readdir(snapshots)).toEqual(['package.json'])
})
