/** Read-only repository safety and explicit layered baseline observations. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ResourceGit } from './git.ts'
import { GitResourceError } from './error.ts'
import { hash } from './json-hash.ts'
import type { GitBaselineEntry, GitDirtyState, GitPathIdentity, GitRepositoryIdentity, GitRepositoryId,
  GitResourcePreview, GitResourcePreviewRequest } from './types.ts'
import type { GitIntegrationConflictStage } from './integration.ts'

/** Owner-configured file and manifest limits apply before reading file bytes. */
export interface PreviewLimits { readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number }
/** One tree entry has only regular-file modes; links and nested repositories refuse explicitly. */
export interface TreeEntry {
  readonly path: string
  readonly mode: '100644' | '100755'
  readonly objectId: string
  readonly bytes: number
}
/** Test whether a canonical candidate belongs to an addressed directory.
 * @param root - canonical directory.
 * @param path - canonical candidate.
 * @returns whether the candidate is the root or below it.
 */
export function inside(root: string, path: string): boolean {
  const item = relative(root, path)
  return item === '' || item !== '..' && !item.startsWith(`..${sep}`) && !isAbsolute(item)
}
/** Observe canonical device and inode identity without accepting a symlink.
 * @param path - existing path whose symlink identity cannot stand in for an owned directory.
 * @returns canonical filesystem witness.
 */
export async function pathIdentity(path: string): Promise<GitPathIdentity> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new GitResourceError('SYMLINK_UNSUPPORTED', 'Symbolic-link resource metadata is not supported')
  return { path: await realpath(path), device: String(info.dev), inode: String(info.ino) }
}
/** Address an explicit relative content path while rejecting symbolic-link traversal.
 * @param root - repository directory.
 * @param path - slash-separated relative path.
 * @returns an addressed safe path without traversing a link.
 */
export async function selectedPath(root: string, path: string): Promise<string> {
  validateContentPath(path)
  const target = resolve(root, path)
  // Strict slash-separated selectors contain no absolute, drive-qualified or parent segment on any supported host.
  // Resolve therefore stays under root; physical traversal still rejects each symbolic-link component below.
  let cursor = root
  for (const part of path.split('/')) {
    cursor = join(cursor, part)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new GitResourceError('SYMLINK_UNSUPPORTED', 'Symbolic-link content is not supported')
    } catch (error) {
      if (error instanceof GitResourceError || !missing(error)) throw error
      break
    }
  }
  return target
}
/** Validate immutable tree names without consulting an unrelated mutable work-copy path.
 * @param path - exact slash-separated tree or working-file name.
 */
export function validateContentPath(path: string): void {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path) || /^[A-Za-z]:/u.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new GitResourceError('PATH_INVALID', 'Selected paths must be explicit relative repository paths')
  }
  const protectedPart = /^(?:\.git|\.env(?:\..*)?|\.ssh|\.gnupg|\.aws|\.azure|\.dsh|\.kube|\.netrc|\.npmrc|\.pypirc|\.git-credentials)$/i
  if (path.split('/').some(part => protectedPart.test(part) || /^(?:credentials?(?:[.-].*)?|providers?)$/i.test(part))) {
    throw new GitResourceError('PROTECTED_PATH', 'Selected content intersects protected metadata or credential-shaped paths')
  }
}
/** Classify a definite filesystem path absence from an error.
 * @param error - filesystem failure.
 * @returns true only for a definite missing path.
 */
export function missing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}
/** Hash raw bytes without invoking Git transformations.
 * @param bytes - exact bytes.
 * @returns SHA-256 independent of Git filters and object format.
 */
export function byteHash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
/** Read only a verified regular-file descriptor; links and changed identities reject before bytes are read.
 * @param root - canonical addressed directory.
 * @param path - safe relative path.
 * @param maxBytes - configured file bound.
 * @returns exact bytes and executable mode from the same stable descriptor.
 */
export async function readRegularFile(root: string, path: string, maxBytes: number): Promise<{
  bytes: Buffer
  mode: '100644' | '100755'
}> {
  const target = await selectedPath(root, path), before = await lstat(target)
  if (!before.isFile() || before.size > maxBytes) throw new GitResourceError('FILE_LIMIT', 'Regular content exceeds its configured bound')
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs) throw new GitResourceError('FILE_CHANGED', 'File identity changed before observation')
    await selectedPath(root, path)
    const bytes = await handle.readFile(), after = await handle.stat()
    if (bytes.length > maxBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.mode !== opened.mode) {
      throw new GitResourceError('FILE_CHANGED', 'Regular content or mode changed during observation')
    }
    return { bytes, mode: (opened.mode & 0o111) !== 0 ? '100755' : '100644' }
  } finally { await handle.close() }
}

/** Validate only local ignore-rule metadata before Git evaluates it. Ignored directories are not traversed.
 * @param git - runner overriding external core.excludesFile with the owner's empty file.
 * @param root - addressed project or managed work copy.
 * @param commonDir - verified repository common directory.
 * @param signal - caller cancellation.
 * @param limits - bounds for rule files and visible directory metadata.
 */
export async function assertIgnoreSources(git: ResourceGit, root: string, commonDir: string,
  signal: AbortSignal, limits: PreviewLimits): Promise<void> {
  const regularRule = async (path: string) => {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile() || info.size > limits.maxTotalBytes) {
        throw new GitResourceError('IGNORE_SOURCE_UNSAFE', 'Ignore rules must be bounded local regular files, not links')
      }
    } catch (error) { if (!missing(error)) throw error }
  }
  const infoPath = join(commonDir, 'info')
  try {
    const info = await lstat(infoPath)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new GitResourceError('IGNORE_SOURCE_UNSAFE', 'Repository ignore metadata is not a local directory')
    await regularRule(join(infoPath, 'exclude'))
  } catch (error) { if (!missing(error)) throw error }
  let directories = 0
  const visit = async (prefix: string): Promise<void> => {
    signal.throwIfAborted()
    if (++directories > limits.maxFiles) throw new GitResourceError('MANIFEST_LIMIT', 'Visible work-copy directory count exceeds its configured bound')
    await regularRule(join(root, prefix, '.gitignore'))
    const children = (await readdir(join(root, prefix), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !(prefix === '' && entry.name === '.git'))
      .map(entry => prefix ? `${prefix}/${entry.name}` : entry.name)
    if (children.length === 0) return
    // Directory paths load only the already checked ancestor rules, never their own descendants' rules.
    const ignored = await git.run(['check-ignore', '--no-index', '--stdin', '-z'], root, signal,
      { input: Buffer.from(children.map(path => `${path}/\0`).join('')), allowFailure: true })
    if (ignored.status !== 0 && ignored.status !== 1) throw new GitResourceError('GIT_METADATA_INVALID', 'Ignore classification could not be verified')
    const excluded = new Set(ignored.stdout.toString('utf8').split('\0').filter(Boolean))
    for (const child of children) if (!excluded.has(`${child}/`)) await visit(child)
  }
  await visit('')
}

/** Enumerate a code seal without reading ignored files or traversing ignored directories.
 * @param git - safe runner with external excludes disabled.
 * @param root - verified managed work copy with its own baseline index.
 * @param commonDir - verified repository metadata.
 * @param signal - cancellation.
 * @param limits - complete manifest bounds.
 * @returns actual regular working paths and metadata-only remaining ignored paths/directory prefixes.
 */
export async function versionedFiles(git: ResourceGit, root: string, commonDir: string,
  signal: AbortSignal, limits: PreviewLimits): Promise<{
  files: string[]
  unpreservedPaths: string[]
  conflictStages: GitIntegrationConflictStage[]
}> {
  await assertIgnoreSources(git, root, commonDir, signal, limits)
  const tracked = new Set<string>()
  const conflictStages: GitIntegrationConflictStage[] = []
  for (const row of (await git.text(['ls-files', '--stage', '-z'], root, signal)).split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t'), [mode, objectId, stage] = row.slice(0, tab).split(' ')
    if (tab < 0 || objectId === undefined || stage !== '0' && stage !== '1' && stage !== '2' && stage !== '3'
      || mode !== '100644' && mode !== '100755') {
      throw new GitResourceError('TREE_ENTRY_UNSUPPORTED', 'Code seal index contains unknown stages, symbolic links or submodules')
    }
    const path = row.slice(tab + 1)
    tracked.add(path)
    if (stage !== '0') conflictStages.push({ path, mode, objectId, stage: stage === '1' ? 1 : stage === '2' ? 2 : 3 })
  }
  const untracked = (await git.text(['ls-files', '--others', '--exclude-standard', '-z'], root, signal)).split('\0').filter(Boolean)
  const unpreservedPaths = (await git.text(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], root, signal))
    .split('\0').filter(Boolean).sort()
  if (tracked.size + untracked.length > limits.maxFiles || unpreservedPaths.length > limits.maxFiles) {
    throw new GitResourceError('MANIFEST_LIMIT', 'Code or remaining-path classification exceeds its configured bound')
  }
  const files: string[] = []
  for (const path of new Set([...tracked, ...untracked])) {
    try {
      const target = await selectedPath(root, path)
      if (!(await lstat(target)).isFile()) throw new GitResourceError('TREE_ENTRY_UNSUPPORTED', 'Code seal contains nonregular content')
      files.push(path)
    } catch (error) { if (!missing(error) || !tracked.has(path)) throw error }
  }
  return { files: files.sort(), unpreservedPaths, conflictStages }
}

/** Locate metadata without invoking repository include files; ordinary Git commands run only after the gate.
 * @param git - safe argv runner.
 * @param root - registered project directory.
 * @param workspaceId - actual registered identity.
 * @param isolation - empty owner directory used while reading local configuration keys.
 * @param protectedHome - known Harness home, never scanned.
 * @param signal - cancellation.
 * @returns canonical repository identity.
 */
export async function inspectRepository(git: ResourceGit, root: string, workspaceId: WorkspaceId,
  isolation: string, protectedHome: string, signal: AbortSignal): Promise<GitRepositoryIdentity> {
  const canonical = await realpath(root)
  if (inside(canonical, protectedHome) || inside(protectedHome, canonical)) {
    throw new GitResourceError('PROTECTED_HOME', 'Project directory overlaps the protected Harness home')
  }
  const marker = join(canonical, '.git'), markerInfo = await lstat(marker).catch((error: unknown) => {
    if (!missing(error)) throw error
    throw new GitResourceError('NOT_GIT', 'The registered Workspace is not a local Git repository')
  })
  if (markerInfo.isSymbolicLink()) throw new GitResourceError('SYMLINK_UNSUPPORTED', 'Linked Git metadata is not supported')
  let gitPath = marker
  if (markerInfo.isFile()) {
    if (markerInfo.size > 4096) throw new GitResourceError('GIT_METADATA_INVALID', 'Git directory marker is invalid')
    const markerText = (await readFile(marker, 'utf8')).trim()
    if (!markerText.startsWith('gitdir: ')) throw new GitResourceError('GIT_METADATA_INVALID', 'Git directory marker is invalid')
    gitPath = resolve(canonical, markerText.slice(8))
  } else if (!markerInfo.isDirectory()) throw new GitResourceError('GIT_METADATA_INVALID', 'Git metadata is not a directory')
  const gitDir = await pathIdentity(gitPath)
  let commonPath = gitDir.path
  const commonFile = join(gitDir.path, 'commondir')
  try {
    const commonInfo = await lstat(commonFile)
    if (!commonInfo.isFile() || commonInfo.isSymbolicLink() || commonInfo.size > 4096) throw new GitResourceError('GIT_METADATA_INVALID', 'Git common-directory marker is invalid')
    commonPath = resolve(gitDir.path, (await readFile(commonFile, 'utf8')).trim())
  } catch (error) { if (!missing(error)) throw error }
  const commonDir = await pathIdentity(commonPath)
  if (inside(protectedHome, gitDir.path) || inside(protectedHome, commonDir.path)) throw new GitResourceError('PROTECTED_HOME', 'Git metadata intersects protected Harness data')
  await inspectConfiguration(git, commonDir.path, gitDir.path, isolation, signal)
  const actualRoot = await git.text(['rev-parse', '--show-toplevel'], canonical, signal)
  if (await realpath(actualRoot) !== canonical) throw new GitResourceError('REPOSITORY_SCOPE', 'Select the registered repository-root Workspace rather than an enclosing project')
  const objectFormat = await git.text(['rev-parse', '--show-object-format'], canonical, signal)
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new GitResourceError('GIT_FORMAT_UNSUPPORTED', 'Repository object format is unsupported')
  const rootIdentity = await pathIdentity(canonical)
  const repositoryId = brandString<GitRepositoryId>(hash({ root: rootIdentity, gitDir, commonDir, objectFormat }))
  return { repositoryId, workspaceId, root: rootIdentity, gitDir, commonDir, objectFormat }
}
/** Inspect names only, without expanding includes or executing transforms, in either project or work-copy metadata.
 * @param git - safe runner.
 * @param commonDir - canonical shared metadata.
 * @param gitDir - canonical per-worktree metadata.
 * @param isolation - owner-owned empty configuration directory.
 * @param signal - cancellation.
 */
export async function inspectConfiguration(git: ResourceGit, commonDir: string, gitDir: string,
  isolation: string, signal: AbortSignal): Promise<void> {
  for (const path of [join(commonDir, 'objects'), join(commonDir, 'objects', 'info'), join(commonDir, 'info'), join(commonDir, 'worktrees')]) {
    try {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new GitResourceError('GIT_METADATA_INVALID', 'Git metadata directories must be local, not links')
    } catch (error) { if (!missing(error)) throw error }
  }
  for (const path of [join(commonDir, 'objects', 'info', 'alternates'), join(commonDir, 'objects', 'info', 'http-alternates')]) {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile() || info.size !== 0) {
        throw new GitResourceError('GIT_ALTERNATES_UNSUPPORTED', 'External Git object stores are outside the registered local repository scope')
      }
    } catch (error) { if (!missing(error)) throw error }
  }
  try {
    const info = await lstat(join(commonDir, 'info', 'attributes'))
    if (info.isSymbolicLink() || !info.isFile()) throw new GitResourceError('GIT_METADATA_INVALID', 'Repository attributes metadata is not a local regular file')
  } catch (error) { if (!missing(error)) throw error }
  for (const file of [join(commonDir, 'config'), join(gitDir, 'config.worktree')]) {
    try { await pathIdentity(file) } catch (error) { if (missing(error)) continue; throw error }
    const keys = (await git.text(['config', '--file', file, '--no-includes', '--name-only', '--null', '--list'], isolation, signal))
      .split('\0').filter(Boolean).map(key => key.toLowerCase())
    const executableConfig = /^(?:include\.|includeif\.|filter\.|submodule\.|merge\..*\.driver$|diff\..*\.textconv$|diff\.external$)/
    if (keys.some(key => executableConfig.test(key) || /^core\.(?:fsmonitor|hookspath|sparsecheckout|worktree)$/.test(key))) {
      throw new GitResourceError('GIT_CONFIG_UNSAFE', 'Repository configuration declares includes, transforms, hooks, monitors, worktree overrides or submodules')
    }
  }
}
/** Read the complete bounded regular-file manifest of an immutable Git tree.
 * @param git - safe Git runner.
 * @param identity - checked repository.
 * @param commit - resolved commit or tree object.
 * @param signal - cancellation.
 * @param limits - complete manifest bounds.
 * @returns every regular file in the addressed version, never a truncated subset.
 */
export async function treeEntries(git: ResourceGit, identity: GitRepositoryIdentity, commit: string,
  signal: AbortSignal, limits: PreviewLimits): Promise<TreeEntry[]> {
  const records = (await git.text(['ls-tree', '-r', '-l', '-z', commit], identity.root.path, signal)).split('\0').filter(Boolean)
  if (records.length > limits.maxFiles) throw new GitResourceError('MANIFEST_LIMIT', 'Version exceeds the configured file-count limit')
  const entries: TreeEntry[] = []; let total = 0
  for (const row of records) {
    const tab = row.indexOf('\t'), [mode, kind, objectId, rawSize] = row.slice(0, tab).split(/\s+/), path = row.slice(tab + 1)
    if (tab < 0 || objectId === undefined || kind !== 'blob' || mode !== '100644' && mode !== '100755') {
      throw new GitResourceError('TREE_ENTRY_UNSUPPORTED', 'Symbolic links, submodules or unknown tree entries are not supported')
    }
    const bytes = Number(rawSize)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limits.maxFileBytes || (total += bytes) > limits.maxTotalBytes) {
      throw new GitResourceError('FILE_LIMIT', 'Named baseline exceeds its configured file or total byte bound')
    }
    validateContentPath(path)
    entries.push({ path, mode, objectId, bytes })
  }
  return entries
}
/** Observe an explicit Git baseline and current dirty state without mutating repository data.
 * @param git - safe Git runner.
 * @param identity - repository identity already checked.
 * @param request - explicit commit or layered selection.
 * @param signal - cancellation.
 * @param limits - complete observation bounds.
 * @returns detached metadata and a deterministic creation cut; no object/index/ref writes.
 */
export async function previewRepository(git: ResourceGit, identity: GitRepositoryIdentity, request: GitResourcePreviewRequest,
  signal: AbortSignal, limits: PreviewLimits): Promise<GitResourcePreview> {
  await assertIgnoreSources(git, identity.root.path, identity.commonDir.path, signal, limits)
  const root = identity.root.path, named = request.baseline.kind === 'commit' ? request.baseline.commit : request.baseline.baseCommit
  if (!named || named.startsWith('-') || named.includes('\0') || named.includes('\n')) throw new GitResourceError('COMMIT_INVALID', 'Baseline must name an explicit commit')
  const baseCommit = await git.text(['rev-parse', '--verify', `${named}^{commit}`], root, signal)
  const baseTree = await git.text(['rev-parse', `${baseCommit}^{tree}`], root, signal)
  const originalEntries = await treeEntries(git, identity, baseCommit, signal, limits)
  const head = await git.text(['rev-parse', '--verify', 'HEAD'], root, signal)
  await treeEntries(git, identity, head, signal, limits)
  const symbolic = await git.run(['symbolic-ref', '--quiet', 'HEAD'], root, signal, { allowFailure: true })
  const symbolicRef = symbolic.status === 0 ? symbolic.stdout.toString('utf8').trim() : undefined
  const indexPath = resolve(root, await git.text(['rev-parse', '--git-path', 'index'], root, signal))
  let indexHash: string
  try { await pathIdentity(indexPath); indexHash = byteHash(await readFile(indexPath)) }
  catch (error) { if (!missing(error)) throw error; indexHash = hash({ absent: true }) }
  const dirty: { staged: string[]; unstaged: string[]; untracked: string[]; unmerged: string[] } = {
    staged: [], unstaged: [], untracked: [], unmerged: [] }
  const status = (await git.text(['status', '--porcelain=v2', '-z', '--untracked-files=all'], root, signal)).split('\0').filter(Boolean)
  let renameSourceIndex = -1
  status.forEach((row, index) => {
    if (index === renameSourceIndex) return
    if (row.startsWith('? ')) {
      const path = row.slice(2)
      if (!path) throw new GitResourceError('GIT_METADATA_INVALID', 'Git untracked classification has no path')
      dirty.untracked.push(path); return
    }
    const fields = row.split(' '), tag = fields[0], xy = fields[1]
    const path = fields.slice(tag === '1' ? 8 : tag === '2' ? 9 : 10).join(' ')
    if (tag !== '1' && tag !== '2' && tag !== 'u' || xy === undefined || !/^[.MADRCUT]{2}$/u.test(xy) || !path) {
      throw new GitResourceError('GIT_METADATA_INVALID', 'Git dirty classification has an unknown or incomplete record')
    }
    if (tag === 'u') dirty.unmerged.push(path)
    else {
      if (xy[0] !== '.') dirty.staged.push(path)
      if (xy[1] !== '.') dirty.unstaged.push(path)
    }
    if (tag === '2') {
      renameSourceIndex = index + 1
      const previous = status[renameSourceIndex]
      if (previous === undefined) throw new GitResourceError('GIT_METADATA_INVALID', 'Git rename classification has no original path')
      dirty.staged.push(previous)
    }
  })
  if (status.length > limits.maxFiles * 2) throw new GitResourceError('MANIFEST_LIMIT', 'Dirty classification exceeds the configured file-count limit')
  const staged = new Map<string, { mode: '100644' | '100755'; objectId: string }>()
  for (const row of (await git.text(['ls-files', '--stage', '-z'], root, signal)).split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t'), [mode, objectId, stage] = row.slice(0, tab).split(' '), path = row.slice(tab + 1)
    if (stage !== '0') continue
    if (objectId === undefined || mode !== '100644' && mode !== '100755') throw new GitResourceError('TREE_ENTRY_UNSUPPORTED', 'Index contains symbolic links or submodules')
    staged.set(path, { mode, objectId })
  }
  const selected: GitBaselineEntry[] = [], chosen = request.baseline.kind === 'selected' ? request.baseline.paths : []
  if (chosen.length > limits.maxFiles || new Set(chosen.map(item => item.path)).size !== chosen.length) throw new GitResourceError('SELECTION_INVALID', 'Selection is duplicated or exceeds its configured limit')
  let total = 0
  for (const item of chosen) {
    await selectedPath(root, item.path)
    if (dirty.unmerged.includes(item.path)) throw new GitResourceError('INDEX_UNMERGED', 'Selected index path has unresolved stages')
    let captured: GitBaselineEntry
    if (item.source === 'index') {
      const entry = staged.get(item.path)
      captured = entry === undefined ? { ...item, mode: 'deleted', bytes: 0 } : { ...item, ...entry,
        bytes: Number(await git.text(['cat-file', '-s', entry.objectId], root, signal)) }
    } else {
      if (item.source === 'untracked' && (!dirty.untracked.includes(item.path) || staged.has(item.path))) throw new GitResourceError('SELECTION_INVALID', 'Selected untracked path is not actually untracked')
      try {
        const { bytes, mode } = await readRegularFile(root, item.path, limits.maxFileBytes)
        const objectId = (await git.run(['hash-object', '--no-filters', '--stdin'], root, signal, { input: bytes })).stdout.toString('utf8').trim()
        captured = { ...item, mode, bytes: bytes.length, rawHash: byteHash(bytes), objectId }
      } catch (error) {
        if (!missing(error) || item.source === 'untracked' || !staged.has(item.path)) throw error
        captured = { ...item, mode: 'deleted', bytes: 0 }
      }
    }
    selected.push(captured)
    total += captured.bytes
    if (captured.bytes > limits.maxFileBytes || total > limits.maxTotalBytes) {
      throw new GitResourceError('FILE_LIMIT', 'Selected baseline exceeds configured byte bounds')
    }
  }
  const resultingEntries = new Map(originalEntries.map(entry => [entry.path, entry.bytes]))
  for (const item of selected) {
    if (item.mode === 'deleted') resultingEntries.delete(item.path)
    else resultingEntries.set(item.path, item.bytes)
  }
  const resultingBytes = [...resultingEntries.values()].reduce((sum, bytes) => sum + bytes, 0)
  if (resultingEntries.size > limits.maxFiles || resultingBytes > limits.maxTotalBytes) {
    throw new GitResourceError('MANIFEST_LIMIT', 'Complete selected baseline exceeds its configured manifest bound')
  }
  const value = { request, permitted: true, risks: [], repository: identity, head,
    ...symbolicRef === undefined ? {} : { symbolicRef }, indexHash, baseCommit, baseTree, dirty: dirty as GitDirtyState, selected }
  return { ...value, fingerprint: hash(value) }
}
