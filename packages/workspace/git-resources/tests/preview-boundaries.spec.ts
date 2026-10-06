/** Real local Git and filesystem refusal cases for read-only baseline observations. */
import { chmod, lstat, mkdir, open, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { ResourceGit } from '../src/git.ts'
import { assertIgnoreSources, inspectConfiguration, inspectRepository, inside, missing, pathIdentity,
  previewRepository, readRegularFile, selectedPath, treeEntries, validateContentPath, versionedFiles } from '../src/preview.ts'
import type { GitResourcePreviewRequest } from '../src/types.ts'
import { edgeLimits, edgeSignal } from './edge-harness.ts'
import { harness, repository } from './harness.ts'

// Scheduling wrappers keep the actual filesystem implementation and its measured bytes/stat values.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

afterEach(() => {
  vi.mocked(lstat).mockReset().mockImplementation(actualFs.lstat)
  vi.mocked(open).mockReset().mockImplementation(actualFs.open)
})

describe('addressed content names', () => {
  it.each(['', '/absolute', 'a\0b', 'a\\b', 'a//b', './a', 'a/../b', 'a/', 'C:outside-file', 'D:/outside-file', 'c:..', 'Z:'])
  ('rejects invalid relative name %j', (path) => {
    expect(() => { validateContentPath(path) }).toThrow(expect.objectContaining({ code: 'PATH_INVALID' }))
  })

  it.each(['.git/config', 'nested/.ENV.local', '.ssh/key', 'credentials.json', 'credential-backup', 'provider/file', 'providers/file'])
  ('rejects protected content name %j without opening it', (path) => {
    expect(() => { validateContentPath(path) }).toThrow(expect.objectContaining({ code: 'PROTECTED_PATH' }))
  })

  it('classifies complete filesystem error values and sibling paths', () => {
    const root = resolve('fixture-root')
    expect(inside(root, root)).toBe(true)
    expect(inside(root, join(root, 'nested', 'file'))).toBe(true)
    expect(inside(root, resolve('fixture-sibling'))).toBe(false)
    expect(inside(root, resolve('fixture-root-extra'))).toBe(false)
    expect(missing(null)).toBe(false)
    expect(missing('ENOENT')).toBe(false)
    expect(missing({})).toBe(false)
    expect(missing({ code: 'EACCES' })).toBe(false)
    expect(missing({ code: 'ENOENT' })).toBe(true)
  })
})

async function setup() {
  const test = await harness(), base = await repository(test)
  const initial = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  if (initial.repository === undefined) throw new Error('actual fixture repository was not identified')
  const runner = new ResourceGit(test.ctx.subprocess, 'git', join(test.root, 'git-home'), {
    timeoutMs: 10_000, graceMs: 100, maxOutputBytes: 1_000_000 })
  return { ...test, project: initial.repository.root.path, base, identity: initial.repository, runner,
    request: { workspaceId: test.workspace.id, baseline: { kind: 'commit' as const, commit: base } } }
}
type Fixture = Awaited<ReturnType<typeof setup>>

/** Replace only one malformed metadata response; every other command executes the real Git binary. */
function malformedText(test: Fixture, command: string, output: string) {
  const original = test.runner.text.bind(test.runner)
  const gate = vi.spyOn(test.runner, 'text').mockImplementation(async (...args) => {
    return args[0][0] === command ? output : await original(...args)
  })
  onTestFinished(() => { gate.mockRestore() })
  return gate
}

describe('regular-file observations', () => {
  let test: Fixture
  beforeEach(async () => { test = await setup() })

  it('keeps missing descendants distinct from non-directory ancestors and rejects oversized or nonregular files', async () => {
    expect(await selectedPath(test.project, 'missing/nested/file')).toBe(join(test.project, 'missing', 'nested', 'file'))
    await expect(selectedPath(test.project, 'file.txt/nested')).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(readRegularFile(test.project, 'file.txt', 4)).rejects.toMatchObject({ code: 'FILE_LIMIT' })
    await mkdir(join(test.project, 'directory'))
    await expect(readRegularFile(test.project, 'directory', 100)).rejects.toMatchObject({ code: 'FILE_LIMIT' })
    await symlink(join(test.project, 'file.txt'), join(test.project, 'link'))
    await expect(pathIdentity(join(test.project, 'link'))).rejects.toMatchObject({ code: 'SYMLINK_UNSUPPORTED' })
    await expect(readRegularFile(test.project, 'link', 100)).rejects.toMatchObject({ code: 'SYMLINK_UNSUPPORTED' })
  })

  it.skipIf(process.platform === 'win32')('observes executable mode from the opened descriptor', async () => {
    await chmod(join(test.project, 'file.txt'), 0o700)
    expect(await readRegularFile(test.project, 'file.txt', 5)).toEqual({ bytes: Buffer.from('BASE\n'), mode: '100755' })
  })

  it.each(['replace', 'grow', 'timestamp'] as const)('refuses a real %s between pathname stat and open', async (change) => {
    const path = join(test.project, 'file.txt'); let observations = 0
    vi.mocked(lstat).mockImplementation(async (...args) => {
      const observed = await actualFs.lstat(...args)
      if (args[0] === path && ++observations === 2) {
        if (change === 'replace') {
          await rename(path, join(test.project, 'previous-file'))
          await writeFile(path, 'BASE\n')
        } else if (change === 'grow') await writeFile(path, 'longer actual bytes\n')
        else await utimes(path, new Date(0), new Date(0))
      }
      return observed
    })
    await expect(readRegularFile(test.project, 'file.txt', 100)).rejects.toMatchObject({ code: 'FILE_CHANGED' })
    expect(observations).toBe(2)
  })

  it.skipIf(process.platform === 'win32')('refuses a directory substituted after the actual regular-file stat', async () => {
    const path = join(test.project, 'file.txt'); let observations = 0
    vi.mocked(lstat).mockImplementation(async (...args) => {
      const observed = await actualFs.lstat(...args)
      if (args[0] === path && ++observations === 2) { await rename(path, join(test.project, 'previous-file')); await mkdir(path) }
      return observed
    })
    await expect(readRegularFile(test.project, 'file.txt', 100)).rejects.toMatchObject({ code: 'FILE_CHANGED' })
    expect((await actualFs.lstat(path)).isDirectory()).toBe(true)
  })

  for (const change of ['over-limit', 'size', 'timestamp', 'mode'] as const) {
    it.skipIf(change === 'mode' && process.platform === 'win32')(`refuses an actual ${change} change during descriptor observation`, async () => {
      const path = join(test.project, 'file.txt')
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actualFs.open(...args)
        if (args[0] === path) {
          const stat = handle.stat.bind(handle); let observed = false
          const gate = vi.spyOn(handle, 'stat').mockImplementation(async () => {
            const value = await stat()
            if (!observed) {
              observed = true
              if (change === 'over-limit') await writeFile(path, 'longer actual bytes\n')
            }
            return value
          })
          const read = handle.readFile.bind(handle)
          const reading = vi.spyOn(handle, 'readFile').mockImplementation(async () => {
            const bytes = await read()
            if (change === 'size') await writeFile(path, 'longer actual bytes\n')
            else if (change === 'timestamp') await utimes(path, new Date(0), new Date(0))
            else if (change === 'mode' && process.platform !== 'win32') await chmod(path, 0o700)
            return bytes
          })
          onTestFinished(() => { gate.mockRestore(); reading.mockRestore() })
        }
        return handle
      })
      await expect(readRegularFile(test.project, 'file.txt', change === 'over-limit' ? 5 : 100))
        .rejects.toMatchObject({ code: 'FILE_CHANGED' })
      expect(await readFile(path)).toEqual(Buffer.from(change === 'over-limit' || change === 'size' ? 'longer actual bytes\n' : 'BASE\n'))
    })
  }
})

describe('local ignore and index metadata', () => {
  let test: Fixture
  beforeEach(async () => { test = await setup() })
  const ignored = () => assertIgnoreSources(test.runner, test.project, test.identity.commonDir.path, edgeSignal, edgeLimits)
  const files = (limits = edgeLimits) => versionedFiles(test.runner, test.project, test.identity.commonDir.path, edgeSignal, limits)

  it.each(['directory', 'link', 'oversized'] as const)('rejects a %s ignore rule before Git classifies descendants', async (kind) => {
    const path = join(test.project, '.gitignore')
    await writeFile(join(test.project, '.git', 'info', 'exclude'), '')
    if (kind === 'directory') await mkdir(path)
    else if (kind === 'link') await symlink(join(test.project, 'file.txt'), path)
    else await writeFile(path, Buffer.alloc(11))
    await expect(assertIgnoreSources(test.runner, test.project, test.identity.commonDir.path, edgeSignal,
      { ...edgeLimits, maxTotalBytes: 10 })).rejects.toMatchObject({ code: 'IGNORE_SOURCE_UNSAFE' })
  })

  it.each(['missing', 'file', 'link'] as const)('handles %s repository ignore directory without traversing another path', async (kind) => {
    const path = join(test.project, '.git', 'info')
    await rename(path, `${path}-original`)
    if (kind === 'file') await writeFile(path, 'not a directory')
    else if (kind === 'link') await symlink(`${path}-original`, path)
    if (kind === 'missing') await expect(ignored()).resolves.toBeUndefined()
    else await expect(ignored()).rejects.toMatchObject({ code: 'IGNORE_SOURCE_UNSAFE' })
  })

  it('checks nested visible directory names and refuses the complete directory limit', async () => {
    await mkdir(join(test.project, 'nested', 'deeper'), { recursive: true })
    await expect(ignored()).resolves.toBeUndefined()
    await expect(assertIgnoreSources(test.runner, test.project, test.identity.commonDir.path, edgeSignal,
      { ...edgeLimits, maxFiles: 2 })).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
  })

  it('refuses a real Git classification failure caused by damaged local configuration', async () => {
    await mkdir(join(test.project, 'nested'))
    await writeFile(join(test.project, '.git', 'config'), '[incomplete')
    await expect(ignored()).rejects.toMatchObject({ code: 'GIT_METADATA_INVALID' })
  })

  it('refuses tracked directories and complete code or ignored-path limits', async () => {
    await expect(files({ ...edgeLimits, maxFiles: 1 })).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
    await rm(join(test.project, 'file.txt')); await mkdir(join(test.project, 'file.txt'))
    await expect(files()).rejects.toMatchObject({ code: 'TREE_ENTRY_UNSUPPORTED' })
  })

  it('counts remaining ignored paths independently of tracked content', async () => {
    await writeFile(join(test.project, '.git', 'info', 'exclude'), 'ignored-*\n')
    for (const name of ['ignored-a', 'ignored-b', 'ignored-c']) await writeFile(join(test.project, name), 'not preserved')
    await expect(files({ ...edgeLimits, maxFiles: 2 })).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
  })

  it.each(['no-tab', 'no-object', 'bad-stage', 'link-mode', 'other-mode'] as const)('rejects malformed index metadata %s', async (kind) => {
    const objectId = test.git(['rev-parse', 'HEAD:file.txt'])
    const row = kind === 'no-tab' ? `100644 ${objectId} 0 file.txt`
      : kind === 'no-object' ? '\tfile.txt'
        : ` ${objectId} ${kind === 'bad-stage' ? '4' : '0'}\tfile.txt`
    malformedText(test, 'ls-files', kind === 'link-mode' ? `120000${row}` : kind === 'other-mode' ? `160000${row}`
      : kind === 'bad-stage' ? `100644${row}` : row)
    await expect(files()).rejects.toMatchObject({ code: 'TREE_ENTRY_UNSUPPORTED' })
  })
})

describe('repository identity and configuration', () => {
  let test: Fixture
  beforeEach(async () => { test = await setup() })
  const inspect = (root = test.project, protectedHome = test.home) => inspectRepository(test.runner, root, test.workspace.id,
    join(test.root, 'git-home'), protectedHome, edgeSignal)

  it('refuses both directions of a declared protected-home overlap before inspecting Git metadata', async () => {
    await expect(inspect(test.project, join(test.identity.root.path, 'private-runtime'))).rejects.toMatchObject({ code: 'PROTECTED_HOME' })
    await expect(inspect(test.project, await actualFs.realpath(test.root))).rejects.toMatchObject({ code: 'PROTECTED_HOME' })
  })

  it('distinguishes a missing repository from an invalid filesystem root', async () => {
    await rename(join(test.project, '.git'), join(test.root, 'saved-metadata'))
    await expect(inspect()).rejects.toMatchObject({ code: 'NOT_GIT' })
    await expect(inspect(join(test.project, 'file.txt'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it.each(['link', 'oversized', 'invalid'] as const)('refuses a %s Git directory marker', async (kind) => {
    const marker = join(test.project, '.git'), saved = join(test.root, 'saved-metadata')
    await rename(marker, saved)
    if (kind === 'link') await symlink(saved, marker)
    else await writeFile(marker, kind === 'oversized' ? Buffer.alloc(4097) : 'not a gitdir marker\n')
    await expect(inspect()).rejects.toMatchObject({ code: kind === 'link' ? 'SYMLINK_UNSUPPORTED' : 'GIT_METADATA_INVALID' })
  })

  it.skipIf(process.platform === 'win32')('refuses a FIFO Git marker without opening the FIFO', async () => {
    const marker = join(test.project, '.git')
    await rename(marker, join(test.root, 'saved-metadata'))
    const made = spawnSync('mkfifo', [marker], { env: { PATH: process.env.PATH }, encoding: 'utf8' })
    expect(made.error).toBeUndefined(); expect(made.status).toBe(0)
    await expect(inspect()).rejects.toMatchObject({ code: 'GIT_METADATA_INVALID' })
  })

  it('observes actual worktree markers and local regular attribute or empty alternate metadata', async () => {
    const workcopy = join(test.root, 'actual-worktree')
    test.git(['worktree', 'add', '--quiet', '--detach', workcopy, test.base])
    await writeFile(join(test.project, '.git', 'info', 'attributes'), '*.txt -text\n')
    await writeFile(join(test.project, '.git', 'objects', 'info', 'alternates'), '')
    const identity = await inspect(workcopy)
    expect(identity.root.path).toBe(await actualFs.realpath(workcopy))
    expect(identity.commonDir).toEqual(test.identity.commonDir)
    expect(identity.gitDir.path).not.toBe(identity.commonDir.path)
  })

  it.each(['directory', 'link', 'oversized'] as const)('refuses a %s worktree common-directory marker', async (kind) => {
    const workcopy = join(test.root, 'actual-worktree')
    test.git(['worktree', 'add', '--quiet', '--detach', workcopy, test.base])
    const text = await readFile(join(workcopy, '.git'), 'utf8'), gitDir = text.trim().slice(8), marker = join(gitDir, 'commondir')
    await rename(marker, `${marker}-original`)
    if (kind === 'directory') await mkdir(marker)
    else if (kind === 'link') await symlink(`${marker}-original`, marker)
    else await writeFile(marker, Buffer.alloc(4097))
    await expect(inspect(workcopy)).rejects.toMatchObject({ code: 'GIT_METADATA_INVALID' })
  })

  it('refuses missing common-directory targets and metadata inside the declared protected home', async () => {
    const workcopy = join(test.root, 'actual-worktree')
    test.git(['worktree', 'add', '--quiet', '--detach', workcopy, test.base])
    const gitDir = (await readFile(join(workcopy, '.git'), 'utf8')).trim().slice(8)
    await expect(inspect(workcopy, test.identity.commonDir.path)).rejects.toMatchObject({ code: 'PROTECTED_HOME' })
    await writeFile(join(gitDir, 'commondir'), 'absent-common-directory\n')
    await expect(inspect(workcopy)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not suppress damaged metadata or configuration files as if they were absent', async () => {
    const common = test.identity.commonDir.path, configuration = join(common, 'config')
    await rename(configuration, `${configuration}-original`)
    await expect(inspectConfiguration(test.runner, common, common, join(test.root, 'git-home'), edgeSignal)).resolves.toBeUndefined()
    await symlink(`${configuration}-original`, join(common, 'config.worktree'))
    await expect(inspectConfiguration(test.runner, common, common, join(test.root, 'git-home'), edgeSignal))
      .rejects.toMatchObject({ code: 'SYMLINK_UNSUPPORTED' })
  })

  it('refuses a metadata directory replaced by a file and nonregular local attributes', async () => {
    const common = test.identity.commonDir.path
    await mkdir(join(common, 'info', 'attributes'))
    await expect(inspectConfiguration(test.runner, common, common, join(test.root, 'git-home'), edgeSignal))
      .rejects.toMatchObject({ code: 'GIT_METADATA_INVALID' })
    await rm(join(common, 'info', 'attributes'), { recursive: true })
    await writeFile(join(common, 'worktrees'), 'not a directory\n')
    await expect(inspectConfiguration(test.runner, common, common, join(test.root, 'git-home'), edgeSignal))
      .rejects.toMatchObject({ code: 'GIT_METADATA_INVALID' })
  })

  it.each(['root', 'format'] as const)('rejects a malformed Git %s identity response', async (kind) => {
    const other = join(test.root, 'another-existing-directory'); await mkdir(other)
    const original = test.runner.text.bind(test.runner)
    const gate = vi.spyOn(test.runner, 'text').mockImplementation(async (...args) => {
      if (args[0].includes(kind === 'root' ? '--show-toplevel' : '--show-object-format')) return kind === 'root' ? other : 'sha512'
      return await original(...args)
    })
    onTestFinished(() => { gate.mockRestore() })
    await expect(inspect()).rejects.toMatchObject({ code: kind === 'root' ? 'REPOSITORY_SCOPE' : 'GIT_FORMAT_UNSUPPORTED' })
  })
})

describe('complete tree and selected baseline limits', () => {
  let test: Fixture
  beforeEach(async () => { test = await setup() })
  const preview = (request: GitResourcePreviewRequest = test.request, limits = edgeLimits) =>
    previewRepository(test.runner, test.identity, request, edgeSignal, limits)
  const selection = (paths: Extract<GitResourcePreviewRequest['baseline'], { kind: 'selected' }>['paths']): GitResourcePreviewRequest =>
    ({ workspaceId: test.workspace.id, baseline: { kind: 'selected', baseCommit: test.base, paths } })

  it.each(['', '-option', 'HEAD\0suffix', 'HEAD\nsuffix'])('rejects unsafe commit name %j before object resolution', async (commit) => {
    await expect(preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit } })).rejects.toMatchObject({ code: 'COMMIT_INVALID' })
  })

  it.skipIf(process.platform === 'win32')('refuses an actual POSIX drive-looking file before a portable selector can read its bytes', async () => {
    const path = join(test.project, 'C:outside-file'), index = await readFile(join(test.project, '.git', 'index'))
    await writeFile(path, 'owned POSIX fixture with a Windows drive-looking name\n')
    await expect(preview(selection([{ path: 'C:outside-file', source: 'untracked' }]))).rejects.toMatchObject({ code: 'PATH_INVALID' })
    expect(vi.mocked(lstat).mock.calls.some(([candidate]) => candidate === path)).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('owned POSIX fixture with a Windows drive-looking name\n')
    expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
  })

  it('refuses complete tree count, per-file and total-byte excesses', async () => {
    await expect(treeEntries(test.runner, test.identity, test.base, edgeSignal, { ...edgeLimits, maxFiles: 1 }))
      .rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
    await expect(treeEntries(test.runner, test.identity, test.base, edgeSignal, { ...edgeLimits, maxFileBytes: 4 }))
      .rejects.toMatchObject({ code: 'FILE_LIMIT' })
    await expect(treeEntries(test.runner, test.identity, test.base, edgeSignal, { ...edgeLimits, maxTotalBytes: 25 }))
      .rejects.toMatchObject({ code: 'FILE_LIMIT' })
  })

  it('refuses an actual missing blob rather than treating its reported size as content', async () => {
    const object = test.git(['rev-parse', 'HEAD:file.txt'])
    await rm(join(test.project, '.git', 'objects', object.slice(0, 2), object.slice(2)))
    await expect(treeEntries(test.runner, test.identity, test.base, edgeSignal, edgeLimits)).rejects.toMatchObject({ code: 'FILE_LIMIT' })
  })

  it.each(['no-tab', 'no-object', 'tree', 'negative-size', 'fractional-size'] as const)('rejects malformed tree metadata %s', async (kind) => {
    const object = test.git(['rev-parse', 'HEAD:file.txt'])
    const row = kind === 'no-tab' ? `100644 blob ${object} 5 file.txt` : kind === 'no-object' ? '100644\tfile.txt'
      : `100644 ${kind === 'tree' ? 'tree' : 'blob'} ${object} ${kind === 'negative-size' ? '-1' : kind === 'fractional-size' ? '1.5' : '5'}\tfile.txt`
    malformedText(test, 'ls-tree', row)
    await expect(treeEntries(test.runner, test.identity, test.base, edgeSignal, edgeLimits))
      .rejects.toMatchObject({ code: kind.endsWith('size') ? 'FILE_LIMIT' : 'TREE_ENTRY_UNSUPPORTED' })
  })

  it('observes detached HEAD and an absent index without writing either', async () => {
    test.git(['checkout', '--quiet', '--detach', test.base])
    await rm(join(test.project, '.git', 'index'))
    const actual = await preview()
    expect(actual.symbolicRef).toBeUndefined()
    expect(actual.dirty.staged).toEqual(['file.txt', 'removed.txt'])
    expect(actual.dirty.untracked).toEqual(['file.txt', 'removed.txt'])
    await expect(actualFs.lstat(join(test.project, '.git', 'index'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a linked repository index without following or rewriting its actual original bytes', async () => {
    const path = join(test.project, '.git', 'index'), original = `${path}-original`, bytes = await readFile(path)
    await rename(path, original); await symlink(original, path)
    await expect(preview()).rejects.toMatchObject({ code: 'SYMLINK_UNSUPPORTED' })
    expect((await actualFs.lstat(path)).isSymbolicLink()).toBe(true)
    expect(await readFile(original)).toEqual(bytes)
  })

  it('classifies actual staged rename and subsequent unstaged edits with both original and destination paths', async () => {
    test.git(['mv', '--', 'file.txt', 'renamed file.txt'])
    await writeFile(join(test.project, 'renamed file.txt'), 'edited after rename\n')
    const actual = await preview()
    expect(actual.dirty.staged).toEqual(['renamed file.txt', 'file.txt'])
    expect(actual.dirty.unstaged).toEqual(['renamed file.txt'])
  })

  it('refuses selection of real unmerged stages and records the complete conflict-stage facts', async () => {
    const object = test.git(['rev-parse', 'HEAD:file.txt'])
    test.git(['update-index', '--index-info'], `0 ${'0'.repeat(40)}\tfile.txt\n100644 ${object} 1\tfile.txt\n100644 ${object} 2\tfile.txt\n100644 ${object} 3\tfile.txt\n`)
    await expect(preview(selection([{ path: 'file.txt', source: 'index' }]))).rejects.toMatchObject({ code: 'INDEX_UNMERGED' })
    expect((await versionedFiles(test.runner, test.project, test.identity.commonDir.path, edgeSignal, edgeLimits)).conflictStages)
      .toEqual([1, 2, 3].map(stage => ({ path: 'file.txt', mode: '100644', objectId: object, stage })))
  })

  it('refuses an actual symbolic-link index entry before reading its contents', async () => {
    const object = test.git(['hash-object', '-w', '--stdin'], 'file.txt')
    test.git(['update-index', '--add', '--cacheinfo', `120000,${object},link`])
    await expect(preview()).rejects.toMatchObject({ code: 'TREE_ENTRY_UNSUPPORTED' })
  })

  it('refuses a dirty classification that exceeds the complete file limit', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) await writeFile(join(test.project, name), 'untracked\n')
    await expect(preview(test.request, { ...edgeLimits, maxFiles: 2 })).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
  })

  it('refuses duplicate and excessive selections before reading selected bytes', async () => {
    await expect(preview(selection([{ path: 'file.txt', source: 'worktree' }, { path: 'file.txt', source: 'index' }])))
      .rejects.toMatchObject({ code: 'SELECTION_INVALID' })
    await expect(preview(selection(['a', 'b', 'c'].map(path => ({ path, source: 'index' }))), { ...edgeLimits, maxFiles: 2 }))
      .rejects.toMatchObject({ code: 'SELECTION_INVALID' })
  })

  it('captures index and working-tree deletions and refuses a false untracked selection', async () => {
    const index = await preview(selection([{ path: 'missing-file', source: 'index' }]))
    expect(index.selected).toEqual([{ path: 'missing-file', source: 'index', mode: 'deleted', bytes: 0 }])
    await rm(join(test.project, 'file.txt'))
    const worktree = await preview(selection([{ path: 'file.txt', source: 'worktree' }]))
    expect(worktree.selected).toEqual([{ path: 'file.txt', source: 'worktree', mode: 'deleted', bytes: 0 }])
    await expect(preview(selection([{ path: 'removed.txt', source: 'untracked' }]))).rejects.toMatchObject({ code: 'SELECTION_INVALID' })
    await expect(preview(selection([{ path: 'missing-file', source: 'worktree' }]))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses staged bytes and aggregate selection bytes beyond configured limits', async () => {
    await writeFile(join(test.project, '.git', 'info', 'exclude'), '')
    const large = test.git(['hash-object', '-w', '--stdin'], Buffer.alloc(35))
    test.git(['update-index', '--add', '--cacheinfo', `100644,${large},selected-a`])
    await expect(preview(selection([{ path: 'selected-a', source: 'index' }]), { ...edgeLimits, maxFileBytes: 30 }))
      .rejects.toMatchObject({ code: 'FILE_LIMIT' })
    const medium = test.git(['hash-object', '-w', '--stdin'], Buffer.alloc(20))
    test.git(['update-index', '--add', '--cacheinfo', `100644,${medium},selected-a`])
    test.git(['update-index', '--add', '--cacheinfo', `100644,${medium},selected-b`])
    await expect(preview(selection(['selected-a', 'selected-b'].map(path => ({ path, source: 'index' }))),
      { ...edgeLimits, maxTotalBytes: 35 })).rejects.toMatchObject({ code: 'FILE_LIMIT' })
  })

  it('refuses a resulting baseline that exceeds file or byte limits even when the selected part fits', async () => {
    await writeFile(join(test.project, '.git', 'info', 'exclude'), '')
    await writeFile(join(test.project, 'extra'), Buffer.alloc(20))
    const request = selection([{ path: 'extra', source: 'untracked' }])
    await expect(preview(request, { ...edgeLimits, maxFiles: 2 })).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
    await expect(preview(request, { ...edgeLimits, maxTotalBytes: 40 })).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
  })

  it('refuses missing fields in malformed dirty classification', async () => {
    malformedText(test, 'status', 'invalid-row')
    await expect(preview()).rejects.toMatchObject({ code: 'GIT_METADATA_INVALID' })
  })

  it.each(['unknown-tag', 'ignored-tag', 'truncated-rename', 'invalid-xy', 'missing-path', 'empty-untracked'] as const)
  ('refuses %s corruption of actual Git dirty metadata without changing the index', async (kind) => {
    test.git(['mv', '--', 'file.txt', 'renamed.txt'])
    const index = await readFile(join(test.project, '.git', 'index')), original = test.runner.text.bind(test.runner)
    const gate = vi.spyOn(test.runner, 'text').mockImplementation(async (...args) => {
      const actual = await original(...args)
      if (args[0][0] !== 'status') return actual
      const rows = actual.split('\0'), first = rows[0]
      if (first === undefined || !first.startsWith('2 ')) throw new Error('actual fixture rename metadata is absent')
      if (kind === 'unknown-tag') return first.replace(/^2 /, 'x ')
      if (kind === 'ignored-tag') return `${actual}! ignored-metadata\0`
      if (kind === 'truncated-rename') return first
      if (kind === 'invalid-xy') return actual.replace(/^2 R\./, '2 R')
      if (kind === 'empty-untracked') return `${actual}? \0`
      rows[0] = first.split(' ').slice(0, 9).join(' ')
      return rows.join('\0')
    })
    onTestFinished(() => { gate.mockRestore() })
    await expect(preview()).rejects.toMatchObject({ code: 'GIT_METADATA_INVALID' })
    expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
    expect(await readFile(join(test.project, 'renamed.txt'), 'utf8')).toBe('BASE\n')
    expect(test.git(['rev-parse', 'HEAD'])).toBe(test.base)
  })
})
