/** Copies and write-backs take a path only under the name Git on this Host reads for it. */
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import { fixture, scope, signal } from './repeat-harness.ts'

type Fixture = Awaited<ReturnType<typeof fixture>>

/** Only Git for macOS composes the names it reads from disk, and only when the repository sets core.precomposeunicode. */
const composes = (setting: string) => process.platform === 'darwin' && setting === 'true'

/** Commit a file under exactly this name, as Git on another platform records it, without writing it to disk. */
function commitAsRecorded(test: Fixture, path: string, text: string): string {
  const object = test.git(['hash-object', '-w', '--stdin'], text)
  test.git(['update-index', '-z', '--index-info'], `100644 ${object}\t${path}\0`)
  test.git(['commit', '--quiet', '-m', `commit ${path} as recorded elsewhere`])
  return test.git(['rev-parse', 'HEAD'])
}

it.each(['true', 'false'])('copies a commit holding a decomposed name only where Git reads it as recorded (setting %s)', async (setting) => {
  const test = await fixture()
  test.git(['config', 'core.precomposeunicode', setting])
  const name = 'docs/cafe\u0301.txt', head = commitAsRecorded(test, name, 'recorded elsewhere\n')
  const preview = await test.owner.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: head } })
  if (composes(setting)) {
    expect(preview).toMatchObject({ permitted: false, risks: ['PATH_NAME_UNREPRESENTABLE'] })
    expect(preview.diagnostic).toMatch(/^Git on this Mac reads these file names in another Unicode form than they are recorded in/u)
    expect(preview.diagnostic).toMatch(/: docs\/cafe\u0301\.txt \[U\+0301\]\. They stay refused until each is recorded in composed form/u)
    await expect(test.owner.create({ ...preview.request, consumerScope: scope, operationId: GitOperationId('decomposed-copy'),
      originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })).rejects.toMatchObject({ code: 'PREVIEW_CHANGED',
      message: preview.diagnostic })
    expect(test.owner.listOperations(scope)).toEqual([])
    expect(test.git(['for-each-ref', 'refs/dsh-resources/'])).toBe('')
  } else {
    // Git reads the name as recorded, so the copy and its seal keep it byte-exact: an edit stays an edit, not a rename.
    const sealed = await test.work('decomposed', await test.copy('decomposed', head), { [name]: 'edited\n' })
    expect(test.git(['diff', '--name-status', '-z', head, test.commitOf(sealed)]).split('\0')).toEqual(['M', name, ''])
  }
})

it.runIf(process.platform === 'darwin')('copies the project once its decomposed name is recorded composed with the step the refusal names', async () => {
  const test = await fixture()
  test.git(['config', 'core.precomposeunicode', 'true'])
  const decomposed = 'docs/cafe\u0301.txt', composed = 'docs/caf\u00e9.txt'
  commitAsRecorded(test, decomposed, 'recorded elsewhere\n')
  // Checked out as Git on another platform writes it: under the decomposed name.
  await mkdir(join(test.project, 'docs')); await writeFile(join(test.project, decomposed), 'recorded elsewhere\n')
  const baseline = () => ({ workspaceId: test.workspace.id, baseline: { kind: 'commit' as const, commit: test.git(['rev-parse', 'HEAD']) } })
  const refused = await test.owner.preview(baseline())
  expect(refused).toMatchObject({ permitted: false, risks: ['PATH_NAME_UNREPRESENTABLE'] })
  expect(refused.diagnostic).toContain('rename it with `git -c core.precomposeunicode=false mv -f <name> <composed name>` in the repository that records it, then commit')
  test.git(['-c', 'core.precomposeunicode=false', 'mv', '-f', decomposed, composed])
  test.git(['commit', '--quiet', '-m', 'record the name composed'])
  expect(test.git(['ls-files', '-z', 'docs']).split('\0').filter(Boolean)).toEqual([composed])
  expect((await test.owner.preview(baseline())).permitted).toBe(true)
  const head = test.git(['rev-parse', 'HEAD'])
  const sealed = await test.work('composed', await test.copy('composed', head), { [composed]: 'edited\n' })
  expect(test.git(['diff', '--name-status', '-z', head, test.commitOf(sealed)]).split('\0')).toEqual(['M', composed, ''])
})

it.each(['true', 'false'])('copies a selected decomposed path only where Git reads it as recorded (setting %s)', async (setting) => {
  const test = await fixture()
  test.git(['config', 'core.precomposeunicode', setting])
  const tracked = 'cafe\u0301.txt', staged = 'Re\u0301sume\u0301.txt', head = commitAsRecorded(test, tracked, 'tracked\n')
  // The user deleted the tracked file and staged a new one under a decomposed name.
  const object = test.git(['hash-object', '-w', '--stdin'], 'staged\n')
  test.git(['update-index', '-z', '--index-info'], `100644 ${object}\t${staged}\0`)
  const baseline = { kind: 'selected' as const, baseCommit: head,
    paths: [{ path: tracked, source: 'worktree' as const }, { path: staged, source: 'index' as const }] }
  const preview = await test.owner.preview({ workspaceId: test.workspace.id, baseline })
  if (composes(setting)) {
    expect(preview).toMatchObject({ permitted: false, risks: ['PATH_NAME_UNREPRESENTABLE'] })
    expect(preview.diagnostic).toMatch(/: cafe\u0301\.txt \[U\+0301\], Re\u0301sume\u0301\.txt \[U\+0301 U\+0301\]\. They stay/u)
    // A decomposed name that is only selected, not in the commit, refuses the same way.
    const only = await test.owner.preview({ workspaceId: test.workspace.id, baseline: { kind: 'selected', baseCommit: test.base,
      paths: [{ path: staged, source: 'index' }] } })
    expect(only).toMatchObject({ permitted: false, risks: ['PATH_NAME_UNREPRESENTABLE'] })
    expect(only.diagnostic).toMatch(/\): Re\u0301sume\u0301\.txt \[U\+0301 U\+0301\]\. They stay/u)
  } else {
    expect(preview.selected).toMatchObject([{ path: tracked, mode: 'deleted' }, { path: staged, mode: '100644' }])
    const made = await test.owner.create({ ...preview.request, consumerScope: scope, operationId: GitOperationId('selected-copy'),
      originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
    // The selected deletion removes the recorded name and the staged file keeps its name.
    expect(test.git(['ls-tree', '-r', '-z', '--name-only', made.resource.baselineTree ?? '']).split('\0').filter(Boolean).toSorted())
      .toEqual(['file.txt', 'removed.txt', staged].toSorted())
  }
})

it.each(['\u212b.txt', '\uf900.txt'])('writes back a tracked %s, whose name Git keeps as it is on disk', async (name) => {
  // The repository keeps the setting git init writes: on macOS core.precomposeunicode is true.
  const test = await fixture()
  await writeFile(join(test.project, name), 'BASE\n')
  test.git(['add', '--', name]); test.git(['commit', '--quiet', '-m', 'user file'])
  expect(test.git(['ls-files', '-z']).split('\0')).toContain(name)
  const work = await test.work('edit', await test.copy('edit', test.git(['rev-parse', 'HEAD'])), { [name]: 'TEAM\n' })
  expect((await test.apply('edit', test.direct(work))).operation.phase).toBe('confirmed')
  expect(await test.read(name)).toBe('TEAM\n')
  expect(test.git(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean)).toEqual([` M ${name}`])
})

it.runIf(process.platform === 'darwin').each(['false', 'unset'])(
  'never takes a tracked composed name stored decomposed on disk as that file when Git reads names as stored (%s)', async (setting) => {
    const test = await fixture()
    test.git(['config', 'core.precomposeunicode', 'false'])
    if (setting === 'unset') test.git(['config', '--unset', 'core.precomposeunicode'])
    const composed = 'caf\u00e9.txt', decomposed = 'cafe\u0301.txt'
    await writeFile(join(test.project, composed), 'BASE\n')
    test.git(['add', '--', composed]); test.git(['commit', '--quiet', '-m', 'user file'])
    const work = await test.work('edit', await test.copy('edit', test.git(['rev-parse', 'HEAD'])), { [composed]: 'TEAM\n' })
    // The same bytes now sit under the decomposed name, which Git lists as another, untracked file.
    await rm(join(test.project, composed)); await writeFile(join(test.project, decomposed), 'BASE\n')
    await expect(test.owner.previewApplication(test.direct(work))).rejects.toMatchObject({ code: 'APPLICATION_TARGET_NAME_MISMATCH',
      message: `Target names differ only in case or Unicode form from the names this version records: ${composed} (recorded ${composed} [U+00E9], on disk ${decomposed} [U+0301]); renaming each on disk to its recorded name lets the write-back proceed` })
    expect(await readFile(join(test.project, decomposed), 'utf8')).toBe('BASE\n')
    // Renamed as the refusal says, the file is written back under the name Git tracks.
    await rename(join(test.project, decomposed), join(test.project, composed))
    expect((await test.apply('edit', test.direct(work))).operation.phase).toBe('confirmed')
    expect(await readdir(test.project)).toContain(composed)
    expect(await test.read(composed)).toBe('TEAM\n')
    expect(test.git(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean)).toEqual([` M ${composed}`])
  })

it('writes back a version holding a decomposed name only where Git reads it as recorded', async () => {
  const test = await fixture()
  test.git(['config', 'core.precomposeunicode', 'false'])
  const name = 'cafe\u0301.txt'
  const work = await test.work('decomposed', await test.copy('decomposed', test.base), { [name]: 'new\n' })
  expect(test.git(['ls-tree', '-r', '-z', '--name-only', test.commitOf(work)]).split('\0')).toContain(name)
  // The user then lets Git compose names, as git init does on macOS.
  test.git(['config', 'core.precomposeunicode', 'true'])
  if (composes('true')) {
    await expect(test.owner.previewApplication(test.direct(work))).rejects.toMatchObject({ code: 'PATH_NAME_UNREPRESENTABLE' })
    await expect(test.owner.previewApplication(test.direct(work))).rejects.toThrow(/\): cafe\u0301\.txt \[U\+0301\]\. They stay/u)
    expect((await readdir(test.project)).toSorted()).toEqual(['.git', 'file.txt', 'removed.txt'])
  } else {
    expect((await test.apply('decomposed', test.direct(work))).operation.phase).toBe('confirmed')
    expect(await readdir(test.project)).toContain(name)
    expect(await test.read(name)).toBe('new\n')
  }
})

it('never creates a file through a directory the user renamed only in case', async () => {
  const test = await fixture()
  await mkdir(join(test.project, 'docs'))
  await writeFile(join(test.project, 'docs', 'file.txt'), 'BASE\n')
  test.git(['add', '--', 'docs/file.txt']); test.git(['commit', '--quiet', '-m', 'docs'])
  const work = await test.work('add', await test.copy('add', test.git(['rev-parse', 'HEAD'])), { 'docs/new.txt': 'NEW\n' })
  const authorized = await test.owner.previewApplication(test.direct(work))
  await rename(join(test.project, 'docs'), join(test.project, 'Docs'))
  if (await lstat(join(test.project, 'docs')).then(() => true, () => false)) {
    // Git reports the project clean and would list a new file there as Docs/new.txt: the refusal names both spellings.
    const message = 'Target names differ only in case or Unicode form from the names this version records: docs/new.txt (recorded docs, on disk Docs); renaming each on disk to its recorded name lets the write-back proceed'
    await expect(test.owner.previewApplication(test.direct(work))).rejects.toMatchObject({ code: 'APPLICATION_TARGET_NAME_MISMATCH', message })
    // A write-back authorized before the rename refuses the same way, before it records or writes anything.
    await expect(test.owner.apply({ ...test.direct(work), operationId: GitOperationId('renamed-apply'), originalRequestJson: '{}',
      expectedPreviewFingerprint: authorized.fingerprint }, signal, () => {})).rejects.toMatchObject({ code: 'APPLICATION_TARGET_NAME_MISMATCH', message })
    expect(test.owner.status(GitOperationId('renamed-apply'))).toBeUndefined()
    expect(await readdir(join(test.project, 'Docs'))).toEqual(['file.txt'])
    // Renamed as the refusal says, the file is created under the recorded name.
    await rename(join(test.project, 'Docs'), join(test.project, 'docs'))
    expect((await test.apply('add', test.direct(work))).operation.phase).toBe('confirmed')
    expect((await readdir(test.project)).toSorted()).toEqual(['.git', 'docs', 'file.txt', 'removed.txt'])
    expect(test.git(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean)).toEqual(['?? docs/new.txt'])
  } else {
    // On a case-sensitive target the asked-for directory is simply missing and is created.
    expect((await test.apply('add', test.direct(work))).operation.phase).toBe('confirmed')
    expect(await test.read('docs/new.txt')).toBe('NEW\n')
    expect(await readdir(join(test.project, 'Docs'))).toEqual(['file.txt'])
  }
})

it('never confirms an interrupted application from a file read through another name', async () => {
  const test = await fixture()
  await mkdir(join(test.project, 'docs'))
  await writeFile(join(test.project, 'docs', 'file.txt'), 'BASE\n')
  test.git(['add', '--', 'docs/file.txt']); test.git(['commit', '--quiet', '-m', 'docs'])
  const work = await test.work('edit', await test.copy('edit', test.git(['rev-parse', 'HEAD'])), { 'docs/file.txt': 'TEAM\n' })
  // The user already holds the new content, so the application has nothing to write; it stops before confirming.
  await writeFile(join(test.project, 'docs', 'file.txt'), 'TEAM\n')
  const preview = await test.owner.previewApplication(test.direct(work))
  expect(preview.alreadyCurrent).toEqual(['docs/file.txt'])
  const request = { ...test.direct(work), operationId: GitOperationId('interrupted-alias'), originalRequestJson: '{}',
    expectedPreviewFingerprint: preview.fingerprint }
  let checks = 0
  await expect(test.owner.apply(request, signal, () => { if (++checks > 1) throw new Error('authority withdrawn') }))
    .rejects.toThrow('authority withdrawn')
  // The file then exists only under another case; on a case-sensitive target the asked-for path is gone.
  await rename(join(test.project, 'docs', 'file.txt'), join(test.project, 'docs', 'FILE.txt'))
  const reconciled = await test.owner.reconcile(request.operationId)
  expect(reconciled.operation).toMatchObject({ phase: 'needs_attention',
    applicationObservation: { state: 'unknown', paths: [{ path: 'docs/file.txt', state: 'unknown' }] } })
  expect(reconciled.operation.applicationEffect).toBeUndefined()
})

it.each(['true', 'false'])('prepares a reverse candidate only where Git reads the project names as recorded (setting %s)', async (setting) => {
  const test = await fixture()
  const work = await test.work('first', await test.copy('first', test.base), { 'app.js': 'v1\n' })
  const applied = await test.apply('first', test.direct(work))
  test.git(['config', 'core.precomposeunicode', setting])
  const name = 'cafe\u0301.txt'
  commitAsRecorded(test, name, 'recorded elsewhere\n')
  const request = { consumerScope: scope, applicationOperationId: applied.operation.operationId, targetWorkspaceId: test.workspace.id }
  if (composes(setting)) {
    await expect(test.owner.previewInverse(request)).rejects.toMatchObject({ code: 'PATH_NAME_UNREPRESENTABLE' })
    await expect(test.owner.previewInverse(request)).rejects.toThrow(/\): cafe\u0301\.txt \[U\+0301\]\. They stay/u)
  } else {
    const cut = await test.owner.previewInverse(request)
    const inverse = await test.owner.prepareInverse({ ...request, operationId: GitOperationId('first-inverse'), originalRequestJson: '{}',
      expectedPreviewFingerprint: cut.fingerprint })
    const files = test.git(['ls-tree', '-r', '-z', '--name-only', inverse.operation.integrationEffect?.tree ?? '']).split('\0')
    expect(files).toContain(name)
    expect(files).not.toContain('app.js')
  }
})

it('passes no file name to Git as an argument while copying, sealing, writing back and reversing', async () => {
  const test = await fixture()
  for (const name of ['kept-file.txt', 'current-file.txt']) await writeFile(join(test.project, name), 'BASE\n')
  test.git(['add', '--', 'kept-file.txt', 'current-file.txt']); test.git(['commit', '--quiet', '-m', 'user files'])
  await writeFile(join(test.project, 'chosen-file.txt'), 'chosen\n')
  const names = ['kept-file.txt', 'current-file.txt', 'chosen-file.txt', 'added-file.txt']
  const run: ResourceGit['run'] = Reflect.get(ResourceGit.prototype, 'run'), calls: (readonly string[])[] = []
  const spy = vi.spyOn(ResourceGit.prototype, 'run').mockImplementation(function (this: ResourceGit, ...args) {
    calls.push(args[0])
    return run.call(this, ...args)
  })
  try {
    const preview = await test.owner.preview({ workspaceId: test.workspace.id, baseline: { kind: 'selected',
      baseCommit: test.git(['rev-parse', 'HEAD']), paths: [{ path: 'chosen-file.txt', source: 'untracked' }] } })
    const made = await test.owner.create({ ...preview.request, consumerScope: scope, operationId: GitOperationId('names-copy'),
      originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
    const work = await test.work('names', made.resource, { 'kept-file.txt': 'TEAM\n', 'current-file.txt': 'SAME\n', 'added-file.txt': 'ADDED\n' })
    await writeFile(join(test.project, 'current-file.txt'), 'SAME\n')
    const applied = await test.apply('names', test.direct(work))
    expect(applied.operation).toMatchObject({ phase: 'confirmed', applicationEffect: { preview: { alreadyCurrent: ['current-file.txt'] } } })
    expect(applied.operation.applicationEffect?.preview.patch).not.toContain('current-file.txt')
    expect(await test.read('kept-file.txt')).toBe('TEAM\n')
    expect(await test.read('added-file.txt')).toBe('ADDED\n')
    const request = { consumerScope: scope, applicationOperationId: applied.operation.operationId, targetWorkspaceId: test.workspace.id }
    const cut = await test.owner.previewInverse(request)
    const inverse = await test.owner.prepareInverse({ ...request, operationId: GitOperationId('names-inverse'), originalRequestJson: '{}',
      expectedPreviewFingerprint: cut.fingerprint })
    expect(inverse.operation.phase).toBe('confirmed')
  } finally { spy.mockRestore() }
  expect(calls.filter(args => args.some(arg => names.some(name => arg.includes(name))))).toEqual([])
})
