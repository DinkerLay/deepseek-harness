/** Applications leave already-current files alone, and a code result sealed on its own work copy applies directly. */
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { fixture, scope, signal } from './repeat-harness.ts'

it('leaves a file the target already holds in the new state alone and writes the rest', async () => {
  const test = await fixture()
  const work = await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n', 'labels.csv': 'id,label\n' })
  // The user puts the same input file into the project the member copied into its work.
  await writeFile(join(test.project, 'labels.csv'), 'id,label\n')
  const preview = await test.owner.previewApplication(test.direct(work))
  expect(preview.alreadyCurrent).toEqual(['labels.csv'])
  expect(preview.patch).toContain('app.js')
  expect(preview.patch).not.toContain('labels.csv')
  expect(preview.target.touched.find(path => path.path === 'labels.csv')?.before).toEqual(
    preview.target.touched.find(path => path.path === 'labels.csv')?.after)
  const applied = await test.apply('first', test.direct(work))
  expect(applied.operation).toMatchObject({ phase: 'confirmed', applicationObservation: { state: 'after' } })
  expect(await test.read('app.js')).toBe('v1\n')
  expect(await test.read('labels.csv')).toBe('id,label\n')

  // The observed file was never written, so a later version gains no right to change or delete it.
  const changed = await test.work('changed', await test.copy('changed', test.commitOf(work)), { 'labels.csv': 'id,label,new\n' })
  await expect(test.owner.previewApplication(test.direct(changed))).rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED',
    message: 'Target files changed from the state this version starts from and are not overwritten: labels.csv' })
  const dropped = await test.work('dropped', await test.copy('dropped', test.commitOf(work)), { 'app.js': 'v2\n', 'labels.csv': null })
  const preview2 = await test.owner.previewApplication(test.direct(dropped))
  expect(preview2.target.touched.map(path => path.path)).toEqual(['app.js'])
  expect(preview2.replacesWritten).toBeUndefined()
  await test.apply('dropped', test.direct(dropped))
  expect(await test.read('labels.csv')).toBe('id,label\n')
})

it('refuses an authorized preview once an already-current file changed', async () => {
  const test = await fixture()
  const work = await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n', 'labels.csv': 'id,label\n' })
  await writeFile(join(test.project, 'labels.csv'), 'id,label\n')
  const preview = await test.owner.previewApplication(test.direct(work))
  await writeFile(join(test.project, 'labels.csv'), 'id,label,edited\n')
  await expect(test.owner.apply({ ...test.direct(work), operationId: GitOperationId('stale-apply'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }, signal, () => {})).rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED' })
  await expect(test.read('app.js')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('confirms without writing when the target already holds the whole version', async () => {
  const test = await fixture()
  const work = await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n' })
  await writeFile(join(test.project, 'app.js'), 'v1\n')
  const preview = await test.owner.previewApplication(test.direct(work))
  expect(preview).toMatchObject({ patch: '', alreadyCurrent: ['app.js'] })
  const applied = await test.apply('first', test.direct(work))
  expect(applied.operation).toMatchObject({ phase: 'confirmed', applicationObservation: { state: 'after' } })
  // Nothing was written, so the known state is still the project start.
  const next = await test.work('next', await test.copy('next', test.commitOf(work)), { 'other.txt': 'more\n' })
  const later = await test.owner.previewApplication(test.direct(next))
  expect(later.source).toMatchObject({ originalTargetBaseTree: test.baseTree })
  expect(later.source.written).toBeUndefined()
  expect(later.alreadyCurrent).toEqual(['app.js'])
})

it('keeps already-current files when an application is reversed', async () => {
  const test = await fixture()
  const work = await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n', 'labels.csv': 'id,label\n' })
  await writeFile(join(test.project, 'labels.csv'), 'id,label\n')
  test.git(['add', '--', 'labels.csv']); test.git(['commit', '--quiet', '-m', 'user commits the same input'])
  const applied = await test.apply('first', test.direct(work))
  const cut = await test.owner.previewInverse({ consumerScope: scope, applicationOperationId: applied.operation.operationId,
    targetWorkspaceId: test.workspace.id })
  const inverse = await test.owner.prepareInverse({ consumerScope: scope, applicationOperationId: applied.operation.operationId,
    targetWorkspaceId: test.workspace.id, operationId: GitOperationId('first-inverse'), originalRequestJson: '{}',
    expectedPreviewFingerprint: cut.fingerprint })
  const files = test.git(['ls-tree', '-r', '--name-only', inverse.operation.integrationEffect?.tree ?? '']).split('\n')
  expect(files).toContain('labels.csv')
  expect(files).not.toContain('app.js')
})

it('applies a code result sealed on its own work copy directly, and the next one built on it', async () => {
  const test = await fixture()
  const first = await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n' })
  const preview = await test.owner.previewApplication(test.direct(first))
  expect(preview.source.integrationOperationId).toBeUndefined()
  expect(preview.source.originalTargetBaseTree).toBe(test.baseTree)
  const applied = await test.apply('first', test.direct(first))
  expect(applied.operation.phase).toBe('confirmed')
  const second = await test.work('second', await test.copy('second', test.commitOf(first)), { 'app.js': 'v2\n' })
  const next = await test.owner.previewApplication(test.direct(second))
  expect(next.source).toMatchObject({ originalTargetBaseTree: first.operation.effectTree,
    written: [{ applicationOperationId: applied.operation.operationId, paths: ['app.js'], missing: [] }] })
  expect(next.replacesWritten).toBeUndefined()
  expect((await test.apply('second', test.direct(second))).operation.phase).toBe('confirmed')
  expect(await test.read('app.js')).toBe('v2\n')
})

it('refuses a direct application of a seal an integration made or with a resolution receipt', async () => {
  const test = await fixture()
  const work = await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n' })
  const version = await test.version('first', work)
  await expect(test.owner.previewApplication(test.direct(version.result))).rejects.toMatchObject({ code: 'APPLICATION_SOURCE_UNAVAILABLE' })
  await expect(test.owner.previewApplication({ ...test.direct(work), resolutionOperationId: GitOperationId('any-receipt') }))
    .rejects.toMatchObject({ code: 'APPLICATION_SOURCE_UNAVAILABLE' })
})

it('treats a file the version deletes and the target already lacks as current, also when reversed', async () => {
  const test = await fixture()
  const work = await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n', 'removed.txt': null })
  test.git(['rm', '--quiet', '--', 'removed.txt']); test.git(['commit', '--quiet', '-m', 'user removes the file too'])
  const applied = await test.apply('first', test.direct(work))
  expect(applied.operation.applicationEffect?.preview.alreadyCurrent).toEqual(['removed.txt'])
  const cut = await test.owner.previewInverse({ consumerScope: scope, applicationOperationId: applied.operation.operationId,
    targetWorkspaceId: test.workspace.id })
  const inverse = await test.owner.prepareInverse({ consumerScope: scope, applicationOperationId: applied.operation.operationId,
    targetWorkspaceId: test.workspace.id, operationId: GitOperationId('first-inverse'), originalRequestJson: '{}',
    expectedPreviewFingerprint: cut.fingerprint })
  const files = test.git(['ls-tree', '-r', '--name-only', inverse.operation.integrationEffect?.tree ?? '']).split('\n')
  expect(files).not.toContain('removed.txt')
  expect(files).not.toContain('app.js')
})

it('abandons a direct application stopped before it wrote anything', async () => {
  const test = await fixture()
  const work = await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n' })
  const preview = await test.owner.previewApplication(test.direct(work))
  const request = { ...test.direct(work), operationId: GitOperationId('stopped-direct'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  let checks = 0
  await expect(test.owner.apply(request, signal, () => { if (++checks > 1) throw new Error('authority withdrawn') }))
    .rejects.toThrow('authority withdrawn')
  const pending = test.owner.status(request.operationId)
  if (pending === undefined) throw new Error('the stopped intent is recorded')
  expect((await test.owner.abandonOperation(request.operationId, pending.operation.fingerprint, 'Stop the unstarted write-back',
    signal, () => {})).operation.phase).toBe('abandoned')
})

it('never takes a differently cased file as current, so a case-only rename cannot delete the user\'s only copy', async () => {
  const test = await fixture()
  await writeFile(join(test.project, 'Readme.md'), 'read me\n')
  test.git(['add', '--', 'Readme.md']); test.git(['commit', '--quiet', '-m', 'user readme'])
  const head = test.git(['rev-parse', 'HEAD'])
  const copy = await test.copy('rename', head)
  await test.owner.withWriteUse(copy.resourceId, { useId: 'rename', ownerId: 'rename', epoch: '1' }, signal, async (lease) => {
    test.git(['-C', lease.resource.path, 'mv', 'Readme.md', 'README.md'])
  })
  const current = test.owner.read(copy.resourceId)
  if (current === undefined) throw new Error('work copy remains registered')
  const sealed = await test.owner.preserve({ operationId: GitOperationId('rename-seal'), resourceId: current.resourceId,
    expectedRevision: current.revision, content: 'versioned' })
  if (test.git(['config', '--bool', 'core.ignorecase']) === 'true') {
    await expect(test.owner.previewApplication(test.direct(sealed))).rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED',
      message: 'Target files changed from the state this version starts from and are not overwritten: README.md' })
    expect(await readdir(test.project)).toContain('Readme.md')
  } else {
    const preview = await test.owner.previewApplication(test.direct(sealed))
    expect(preview.alreadyCurrent).toBeUndefined()
    expect((await test.apply('rename', test.direct(sealed))).operation.phase).toBe('confirmed')
    expect(await readdir(test.project)).toContain('README.md')
  }
})

it('lets later previews through after an application with an already-current file stopped before writing', async () => {
  const test = await fixture()
  const work = await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n', 'labels.csv': 'id,label\n' })
  await writeFile(join(test.project, 'labels.csv'), 'id,label\n')
  const preview = await test.owner.previewApplication(test.direct(work))
  const request = { ...test.direct(work), operationId: GitOperationId('ref-failed'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  const run: ResourceGit['run'] = Reflect.get(ResourceGit.prototype, 'run')
  const refs = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(function (this: ResourceGit, ...args) {
    if (args[0][0] === 'update-ref') return Promise.reject(new Error('reference write failed'))
    return run.call(this, ...args)
  })
  await expect(test.owner.apply(request, signal, () => {})).rejects.toThrow('reference write failed')
  refs.mockRestore()
  expect(test.owner.status(request.operationId)?.operation).toMatchObject({ phase: 'needs_attention', externalWriteStarted: true })
  const other = await test.work('other', await test.copy('other', test.base), { 'b.txt': 'B\n' })
  expect((await test.owner.previewApplication(test.direct(other))).target.touched.map(path => path.path)).toEqual(['b.txt'])
})

it('confirms an interrupted application with nothing to write when it is reconciled', async () => {
  const test = await fixture()
  const work = await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n' })
  await writeFile(join(test.project, 'app.js'), 'v1\n')
  const preview = await test.owner.previewApplication(test.direct(work))
  const request = { ...test.direct(work), operationId: GitOperationId('interrupted-current'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  let checks = 0
  await expect(test.owner.apply(request, signal, () => { if (++checks > 1) throw new Error('authority withdrawn') }))
    .rejects.toThrow('authority withdrawn')
  expect((await test.owner.reconcile(request.operationId)).operation).toMatchObject({ phase: 'confirmed',
    applicationObservation: { state: 'after' } })
})

it.each([['Docs/file.txt', 'docs/file.txt'], ['a/B/c.txt', 'a/b/c.txt']])(
  'never takes %s reached as %s through a differently cased directory as current or written', async (from, to) => {
    const test = await fixture()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(test.project, from.slice(0, from.lastIndexOf('/'))), { recursive: true })
    await writeFile(join(test.project, from), 'only copy\n')
    test.git(['add', '--', from]); test.git(['commit', '--quiet', '-m', 'user file'])
    const copy = await test.copy('rename', test.git(['rev-parse', 'HEAD']))
    await test.owner.withWriteUse(copy.resourceId, { useId: 'rename', ownerId: 'rename', epoch: '1' }, signal, async (lease) => {
      await mkdir(join(lease.resource.path, 'moved'), { recursive: true })
      test.git(['-C', lease.resource.path, 'mv', from, 'moved/file'])
      await mkdir(join(lease.resource.path, to.slice(0, to.lastIndexOf('/'))), { recursive: true })
      test.git(['-C', lease.resource.path, 'mv', 'moved/file', to])
    })
    const current = test.owner.read(copy.resourceId)
    if (current === undefined) throw new Error('work copy remains registered')
    const sealed = await test.owner.preserve({ operationId: GitOperationId('rename-seal'), resourceId: current.resourceId,
      expectedRevision: current.revision, content: 'versioned' })
    if (test.git(['config', '--bool', 'core.ignorecase']) === 'true') {
      await expect(test.owner.previewApplication(test.direct(sealed))).rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED',
        message: `Target files changed from the state this version starts from and are not overwritten: ${to}` })
      expect(test.git(['ls-files', '--', from])).toBe(from)
      expect(await test.read(from)).toBe('only copy\n')
    } else {
      expect((await test.apply('rename', test.direct(sealed))).operation.phase).toBe('confirmed')
      expect(await test.read(to)).toBe('only copy\n')
    }
  })

it('refuses to write a known file through a directory the user renamed only in case', async () => {
  const test = await fixture()
  const { mkdir, rename } = await import('node:fs/promises')
  await mkdir(join(test.project, 'docs'))
  await writeFile(join(test.project, 'docs', 'file.txt'), 'BASE\n')
  test.git(['add', '--', 'docs/file.txt']); test.git(['commit', '--quiet', '-m', 'docs'])
  const work = await test.work('edit', await test.copy('edit', test.git(['rev-parse', 'HEAD'])), { 'docs/file.txt': 'TEAM\n' })
  await rename(join(test.project, 'docs'), join(test.project, 'Docs'))
  await expect(test.owner.previewApplication(test.direct(work))).rejects.toMatchObject({ code: 'APPLICATION_TARGET_CHANGED',
    message: 'Target files changed from the state this version starts from and are not overwritten: docs/file.txt' })
  expect(await test.read('Docs/file.txt')).toBe('BASE\n')
})

it('keeps file names holding a line break intact in the known state and in a reverse candidate', async () => {
  const test = await fixture()
  const odd = 'line\nbreak.txt', kept = 'also\nodd.txt'
  const work = await test.work('first', await test.copy('first', test.base), { [odd]: 'odd\n', [kept]: 'kept\n' })
  await writeFile(join(test.project, kept), 'kept\n')
  const applied = await test.apply('first', test.direct(work))
  expect(applied.operation.applicationEffect?.preview.alreadyCurrent).toEqual([kept])
  // The next version composes the known state from the written odd name; the kept one shows as current again.
  const next = await test.work('next', await test.copy('next', test.commitOf(work)), { [odd]: 'odd v2\n' })
  const preview = await test.owner.previewApplication(test.direct(next))
  expect(preview.target.touched.map(path => path.path)).toEqual([kept, odd])
  expect(preview.alreadyCurrent).toEqual([kept])
  expect(preview.patch).toContain('odd v2')
  // Reversing the first application keeps the already-current odd name and removes the one it wrote.
  const cut = await test.owner.previewInverse({ consumerScope: scope, applicationOperationId: applied.operation.operationId,
    targetWorkspaceId: test.workspace.id })
  const inverse = await test.owner.prepareInverse({ consumerScope: scope, applicationOperationId: applied.operation.operationId,
    targetWorkspaceId: test.workspace.id, operationId: GitOperationId('first-inverse'), originalRequestJson: '{}',
    expectedPreviewFingerprint: cut.fingerprint })
  const files = test.git(['ls-tree', '-r', '-z', '--name-only', inverse.operation.integrationEffect?.tree ?? '']).split('\0')
  expect(files).toContain(kept)
  expect(files).not.toContain(odd)
})

it.each(['true', 'false'])('writes a tracked file with a decomposed name on disk when core.precomposeunicode is %s', async (compose) => {
  const test = await fixture()
  const { mkdir } = await import('node:fs/promises')
  test.git(['config', 'core.precomposeunicode', compose])
  const decomposed = 'Ré', file = 'café.txt', composed = 'Ré/café.txt'
  await mkdir(join(test.project, decomposed))
  await writeFile(join(test.project, decomposed, file), 'BASE\n')
  test.git(['add', '-A']); test.git(['commit', '--quiet', '-m', 'user file with a decomposed name'])
  const tracked = test.git(['ls-files', '-z']).split('\0').find(path => path.normalize('NFC') === composed)
  if (tracked === undefined) throw new Error('the file is tracked')
  const work = await test.work('edit', await test.copy('edit', test.git(['rev-parse', 'HEAD'])), { [tracked]: 'TEAM\n' })
  expect((await test.apply('edit', test.direct(work))).operation.phase).toBe('confirmed')
  expect(await test.read(join(decomposed, file))).toBe('TEAM\n')
})
