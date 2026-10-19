/** Explicit user-target cuts, plain Git application and pure interrupted-effect observations. */
import type { Stats } from 'node:fs'
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ResourceGit } from './git.ts'
import { GitResourceError } from './error.ts'
import { hash } from './json-hash.ts'
import { byteHash, missing, pathIdentity, readRegularFile, selectedPath, treeEntries } from './preview.ts'
import type { PreviewLimits, TreeEntry } from './preview.ts'
import type { GitConsumerScope, GitOperationId, GitPathIdentity, GitRepositoryIdentity, GitResourceId } from './types.ts'
import type { GitIntegrationWriteScope } from './integration.ts'
import type { GitIntegrationEffect } from './integration.ts'
import { decodeIntegrationMerge } from './integration.ts'
import { applicationPathSchema, gitObjectIdSchema, indexInfo, treeManifestHash } from './manifest.ts'
import type { GitApplicationPath, GitFileState, GitIndexState } from './manifest.ts'
import { assertReadableNames, gitNameOf, nameRules, namedPaths, withCodePoints } from './names.ts'
import type { GitNameRules } from './names.ts'

/** Files an earlier confirmed application wrote, still its last writer in the target state this one starts from. */
export interface GitApplicationWritten {
  readonly applicationOperationId: GitOperationId
  readonly paths: readonly string[]
  /** Paths whose written content the selected version's own commits never held; empty when it descends from that application. */
  readonly missing: readonly string[]
}
/** Exact owner-resolved version; no latest-resource lookup occurs inside application plumbing. */
export interface GitApplicationSource {
  readonly repository: GitRepositoryIdentity
  /** The integration or inverse that made the sealed work copy; absent for a code result sealed on its own work copy. */
  readonly integrationOperationId?: GitOperationId | undefined
  readonly preserveOperationId: GitOperationId
  readonly resourceId: GitResourceId
  readonly consumerScope: GitConsumerScope
  /** Host-known target state: the version line's starting project tree, or the result its later applications left. */
  readonly originalTargetBaseTree: string
  readonly resultCommit: string
  readonly resultTree: string
  readonly manifestHash: string
  readonly resolutionOperationId?: GitOperationId | undefined
  /** Earlier confirmed applications in this consumer scope that wrote part of `originalTargetBaseTree`. */
  readonly written?: readonly GitApplicationWritten[] | undefined
}
/** Explicit target Workspace and immutable source IDs, never an arbitrary Host path. */
export interface GitApplicationPreviewRequest {
  readonly consumerScope: GitConsumerScope
  /** The integration or inverse that made the sealed work copy; omit it to apply a seal of a work copy no integration made. */
  readonly integrationOperationId?: GitOperationId | undefined
  readonly preserveOperationId: GitOperationId
  readonly targetWorkspaceId: WorkspaceId
  readonly resolutionOperationId?: GitOperationId | undefined
}
/** The owner records this user-selected intent before the first working-file write. */
export interface GitApplicationRequest extends GitApplicationPreviewRequest {
  readonly operationId: GitOperationId
  readonly originalRequestJson: string
  readonly expectedPreviewFingerprint: string
}
/** Directory witnesses include known absent parents needed for a newly added path. */
export interface GitApplicationAncestor {
  readonly path: string
  readonly identity?: GitPathIdentity | undefined
}
/** Full target CAS includes branch, index, touched bytes and every traversed directory. */
export interface GitApplicationTargetCut {
  readonly repository: GitRepositoryIdentity
  readonly head: string
  readonly symbolicRef?: string | undefined
  readonly indexHash: string
  readonly touched: readonly GitApplicationPath[]
  readonly ancestors: readonly GitApplicationAncestor[]
  readonly fingerprint: string
}
/** Read-only exact diff selection, with no implicit authorization to write its target. */
export interface GitApplicationPreview {
  readonly source: GitApplicationSource
  readonly target: GitApplicationTargetCut
  readonly patchHash: string
  /** Complete bounded Git diff; binary bodies remain Git's textual binary-patch representation. */
  readonly patch: string
  readonly binary: boolean
  /** Paths the target already holds exactly as this version has them; checked before the write, never written. */
  readonly alreadyCurrent?: readonly string[] | undefined
  /** Files an earlier application wrote that this version, not built on that application, replaces or deletes. */
  readonly replacesWritten?: { readonly replaced: readonly string[]; readonly deleted: readonly string[] } | undefined
  readonly fingerprint: string
}
/** Interrupted writes are reported per path; unknown or partial outcomes never replay automatically. */
export interface GitApplicationObservation {
  readonly state: 'before' | 'after' | 'partial' | 'unknown'
  readonly paths: readonly { readonly path: string; readonly state: 'before' | 'after' | 'unknown' }[]
  readonly headUnchanged: boolean
  readonly indexUnchanged: boolean
}
/** Only an exact all-after observation is a confirmed application effect. */
export interface GitApplicationEffect {
  readonly preview: GitApplicationPreview
  readonly observation: GitApplicationObservation
}
/** Reverse preparation names the actual old effect and current target, never the old source inputs. */
export interface GitInversePreviewRequest {
  readonly consumerScope: GitConsumerScope
  readonly applicationOperationId: GitOperationId
  readonly targetWorkspaceId: WorkspaceId
}
/** Intent for a new independent inverse candidate; this request does not apply it to the target. */
export interface GitInverseRequest extends GitInversePreviewRequest {
  readonly operationId: GitOperationId
  readonly originalRequestJson: string
  readonly expectedPreviewFingerprint: string
}
/** Read-only current touched cut before any inverse snapshot objects are created. */
export interface GitInversePreview {
  readonly applicationOperationId: GitOperationId
  readonly original: GitApplicationEffect
  readonly currentTarget: GitApplicationTargetCut
  readonly fingerprint: string
}
/** Same-host facts and owner storage the application plumbing uses besides Git and the target. */
export interface GitApplicationHost {
  /** This Host's operating system, which decides how Git reads file names on disk. */
  readonly platform: NodeJS.Platform
  /** Existing private owner directory for scratch indexes. */
  readonly scratchRoot: string
}
/** Owner-shared strict decoders reuse one repository identity definition. */
export interface GitApplicationSchemas {
  readonly source: z.ZodType<GitApplicationSource>
  readonly target: z.ZodType<GitApplicationTargetCut>
  readonly preview: z.ZodType<GitApplicationPreview>
  readonly effect: z.ZodType<GitApplicationEffect>
  readonly inversePreview: z.ZodType<GitInversePreview>
}

const id = z.string().min(1)
const operationId = id.transform(value => brandString<GitOperationId>(value))
const consumerScope = id.transform(value => brandString<GitConsumerScope>(value))
const resolution = { resolutionOperationId: operationId.optional() }
/** Strict source selectors contain no user-authored authority function or raw target directory. */
export const applicationPreviewRequestSchema = z.object({ consumerScope, integrationOperationId: operationId.optional(),
  preserveOperationId: operationId, targetWorkspaceId: id.transform(value => brandString<WorkspaceId>(value)), ...resolution,
}).strict()
/** Strict original application intent; authorization is retained by the Host outside JSON. */
export const applicationRequestSchema = applicationPreviewRequestSchema.extend({ operationId,
  originalRequestJson: z.string().refine((value) => {
    try { JSON.parse(value); return true } catch (_invalidJson) { return false }
  }, 'original consumer request must be JSON'), expectedPreviewFingerprint: id,
}).strict()
/** Strict observation never equates a failed subprocess with an untouched target. */
export const applicationObservationSchema = z.object({ state: z.enum(['before', 'after', 'partial', 'unknown']),
  paths: z.array(z.object({ path: id, state: z.enum(['before', 'after', 'unknown']) }).strict()).readonly(),
  headUnchanged: z.boolean(), indexUnchanged: z.boolean(),
}).strict()
/** Strict inverse selection contains no flag that could reapply the original code. */
export const inversePreviewRequestSchema = z.object({ consumerScope, applicationOperationId: operationId,
  targetWorkspaceId: id.transform(value => brandString<WorkspaceId>(value)),
}).strict()
/** Strict original inverse intent is independent from its eventual application authorization. */
export const inverseRequestSchema = inversePreviewRequestSchema.extend({ operationId,
  originalRequestJson: applicationRequestSchema.shape.originalRequestJson,
  expectedPreviewFingerprint: applicationRequestSchema.shape.expectedPreviewFingerprint,
}).strict()

/** Reuse the sole repository decoder when adding application data to the existing aggregate.
 * @param repository - existing repository identity schema owned by the resource journal.
 * @returns strict application source, preview and effect decoders.
 */
export function applicationSchemas(repository: z.ZodType<GitRepositoryIdentity>): GitApplicationSchemas {
  const witness = z.object({ path: id, device: id, inode: id }).strict()
  const source = z.object({ repository, integrationOperationId: operationId.optional(), preserveOperationId: operationId,
    resourceId: id.transform(value => brandString<GitResourceId>(value)), consumerScope,
    originalTargetBaseTree: gitObjectIdSchema, resultCommit: gitObjectIdSchema, resultTree: gitObjectIdSchema,
    manifestHash: id, ...resolution, written: z.array(z.object({ applicationOperationId: operationId,
      paths: z.array(id).readonly(), missing: z.array(id).readonly() }).strict()).readonly().optional() }).strict()
  const target = z.object({ repository, head: gitObjectIdSchema, symbolicRef: id.optional(), indexHash: id,
    touched: z.array(applicationPathSchema).readonly(),
    ancestors: z.array(z.object({ path: z.string(), identity: witness.optional() }).strict()).readonly(),
    fingerprint: id }).strict()
  const preview = z.object({ source, target, patchHash: id, patch: z.string(), binary: z.boolean(),
    alreadyCurrent: z.array(id).readonly().optional(),
    replacesWritten: z.object({ replaced: z.array(id).readonly(), deleted: z.array(id).readonly() }).strict().optional(),
    fingerprint: id }).strict()
  const effect = z.object({ preview, observation: applicationObservationSchema }).strict()
  return { source, target, preview, effect,
    inversePreview: z.object({ applicationOperationId: operationId, original: effect, currentTarget: target, fingerprint: id }).strict() }
}

function sameRepository(source: GitRepositoryIdentity, target: GitRepositoryIdentity): void {
  if (hash(source.commonDir) !== hash(target.commonDir) || source.objectFormat !== target.objectFormat) {
    throw new GitResourceError('APPLICATION_REPOSITORY_MISMATCH', 'Application source and target do not share the same observed object repository')
  }
}

async function fileState(git: ResourceGit, identity: GitRepositoryIdentity, path: string, signal: AbortSignal,
  maxBytes: number): Promise<{ state: GitFileState; bytes: number }> {
  signal.throwIfAborted()
  try {
    const actual = await readRegularFile(identity.root.path, path, maxBytes)
    const object = await git.run(['hash-object', '--no-filters', '--stdin'], identity.root.path, signal, { input: actual.bytes })
    return { state: { kind: 'file', mode: actual.mode, objectId: gitObjectIdSchema.parse(object.stdout.toString('utf8').trim()),
      rawHash: byteHash(actual.bytes) }, bytes: actual.bytes.length }
  } catch (error) { if (!missing(error)) throw error; return { state: { kind: 'absent' }, bytes: 0 } }
}

async function immutableState(git: ResourceGit, identity: GitRepositoryIdentity, entry: TreeEntry | undefined,
  signal: AbortSignal): Promise<GitFileState> {
  if (entry === undefined) return { kind: 'absent' }
  const bytes = (await git.run(['cat-file', 'blob', entry.objectId], identity.root.path, signal)).stdout
  if (bytes.length !== entry.bytes) throw new GitResourceError('APPLICATION_VERSION_CHANGED', 'Immutable application object differs from its bounded manifest')
  return { kind: 'file', mode: entry.mode, objectId: entry.objectId, rawHash: byteHash(bytes) }
}

async function indexHash(git: ResourceGit, identity: GitRepositoryIdentity, signal: AbortSignal): Promise<string> {
  const path = resolve(identity.root.path, await git.text(['rev-parse', '--git-path', 'index'], identity.root.path, signal))
  try { await pathIdentity(path); return byteHash(await readFile(path)) }
  catch (error) { if (!missing(error)) throw error; return hash({ absent: true }) }
}

async function targetCut(git: ResourceGit, identity: GitRepositoryIdentity, intended: readonly GitApplicationPath[],
  signal: AbortSignal, limits: PreviewLimits): Promise<GitApplicationTargetCut> {
  for (const expected of [identity.root, identity.gitDir, identity.commonDir]) {
    if (hash(await pathIdentity(expected.path)) !== hash(expected)) {
      throw new GitResourceError('APPLICATION_TARGET_REPLACED', 'Original target repository identity was moved or replaced')
    }
  }
  if ((await git.text(['ls-files', '--unmerged', '-z'], identity.root.path, signal)) !== '') {
    throw new GitResourceError('APPLICATION_INDEX_UNMERGED', 'User target has unresolved index entries; no application is prepared')
  }
  const head = gitObjectIdSchema.parse(await git.text(['rev-parse', '--verify', 'HEAD'], identity.root.path, signal))
  const symbolic = await git.run(['symbolic-ref', '--quiet', 'HEAD'], identity.root.path, signal, { allowFailure: true })
  if (symbolic.status !== 0 && symbolic.status !== 1) throw new GitResourceError('APPLICATION_TARGET_UNAVAILABLE', 'Target branch identity is unavailable')
  const touched: GitApplicationPath[] = [], parents = new Set<string>([''])
  let total = 0
  for (const entry of intended) {
    await selectedPath(identity.root.path, entry.path)
    const actual = await fileState(git, identity, entry.path, signal, Math.min(limits.maxFileBytes, limits.maxTotalBytes - total))
    total += actual.bytes
    touched.push({ path: entry.path, before: actual.state, after: entry.after })
    let parent = dirname(entry.path)
    while (parent !== '.') { parents.add(parent); parent = dirname(parent) }
  }
  const ancestors: GitApplicationAncestor[] = []
  for (const path of [...parents].sort()) {
    const absolute = join(identity.root.path, path)
    try {
      const info = await lstat(absolute)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new GitResourceError('APPLICATION_TARGET_UNAVAILABLE', 'Application parent is not a real directory')
      ancestors.push({ path, identity: await pathIdentity(absolute) })
    } catch (error) { if (!missing(error)) throw error; ancestors.push({ path }) }
  }
  const value = { repository: structuredClone(identity), head,
    ...symbolic.status === 0 ? { symbolicRef: symbolic.stdout.toString('utf8').trim() } : {},
    indexHash: await indexHash(git, identity, signal), touched, ancestors }
  signal.throwIfAborted()
  return { ...value, fingerprint: hash(value) }
}

/** Touched paths the application writes; a path already in its after state is only checked.
 * @param touched - the application's target cut.
 * @returns the paths whose before and after states differ.
 */
export function applicationWrites(touched: readonly GitApplicationPath[]): readonly GitApplicationPath[] {
  return touched.filter(entry => hash(entry.before) !== hash(entry.after))
}

/** Write the tree of a starting tree with some paths replaced or removed, through a private scratch index. Only tree
 * objects are added; no file, ref or project index changes.
 * @param git - existing safe argv runner.
 * @param identity - repository whose object store holds every named blob.
 * @param base - the starting tree.
 * @param files - each changed path and its state.
 * @param scratchRoot - existing private owner directory.
 * @param signal - cancellation.
 * @returns the tree id; an existing tree with the same content keeps its id.
 */
export async function scratchTree(git: ResourceGit, identity: GitRepositoryIdentity, base: string,
  files: Iterable<readonly [string, GitIndexState]>, scratchRoot: string, signal: AbortSignal): Promise<string> {
  const scratch = await mkdtemp(join(scratchRoot, 'tree-'))
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') }, root = identity.root.path
    await git.run(['read-tree', base], root, signal, { env })
    await git.run(['update-index', '-z', '--index-info'], root, signal, { env, input: indexInfo(files, identity.objectFormat) })
    return gitObjectIdSchema.parse(await git.text(['write-tree'], root, signal, env))
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

/** Patch options fixed on the command line, so the target repository's own diff and color settings change neither the
 * patch bytes nor the paths it names. */
const PATCH_OPTIONS = ['--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color',
  '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '--unified=3', '--inter-hunk-context=0', '--diff-algorithm=myers',
  '--indent-heuristic']
/** Patch settings that have no command-line option; the file order is fixed separately with an empty order file. */
const PATCH_SETTINGS = { 'diff.suppressBlankEmpty': 'false', 'core.quotePath': 'true' }
/** `git apply` strips exactly the `a/` or `b/` component every patch path carries, and the target repository's own
 * whitespace and line-ending settings neither change the context it accepts nor the bytes it writes. */
const APPLY = ['apply', '-p1', '--binary', '--whitespace=nowarn']
const APPLY_SETTINGS = { 'apply.ignoreWhitespace': 'no', 'core.autocrlf': 'false' }

async function patchBytes(git: ResourceGit, source: GitApplicationSource, target: GitRepositoryIdentity,
  signal: AbortSignal, touched: readonly GitApplicationPath[], scratchRoot: string): Promise<Buffer> {
  const writes = applicationWrites(touched)
  if (writes.length === 0) return Buffer.alloc(0)
  // Paths the target already holds in their after state count from that state, so the patch holds only the written paths
  // and no path is passed to Git as an argument.
  const current = touched.filter(entry => !writes.includes(entry))
  const from = current.length === 0 ? source.originalTargetBaseTree : await scratchTree(git, target,
    source.originalTargetBaseTree, current.map(entry => [entry.path, entry.after]), scratchRoot, signal)
  const scratch = await mkdtemp(join(scratchRoot, 'patch-'))
  try {
    const order = join(scratch, 'order')
    await writeFile(order, '')
    return (await git.run(['diff', ...PATCH_OPTIONS, `-O${order}`, from, source.resultTree], target.root.path, signal,
      { config: PATCH_SETTINGS })).stdout
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

/** How the target names one path. */
export interface TargetPathName {
  /** No directory or file of the path exists only under a name Git reads as another one. */
  readonly exact: boolean
  /** When not exact, the path through the first such directory or file, spelled as on disk; absent when that spelling
   * cannot be read. */
  readonly onDisk?: string
}

/** A name or path compared apart from case and Unicode form, as case-insensitive file systems compare names.
 * @param value - a name or path.
 * @returns the comparison key.
 */
function looseName(value: string): string { return value.normalize('NFC').toLowerCase() }

/** The listed entry that is the same file as one opened through another name; entries equal to that name apart from case
 * and Unicode form come before other links to the same file.
 * @param directory - listed directory.
 * @param names - its listing.
 * @param name - the name the file was opened through.
 * @param opened - the opened file.
 * @returns the entry, or `undefined` when none of the listed entries is that file any more.
 */
async function spellingOnDisk(directory: string, names: readonly string[], name: string, opened: Stats): Promise<string | undefined> {
  const key = looseName(name)
  for (const entry of names.toSorted((a, b) => Number(looseName(b) === key) - Number(looseName(a) === key))) {
    // An entry removed or unreadable since the listing is not the opened file.
    const info = await lstat(join(directory, entry)).catch(() => undefined)
    if (info?.dev === opened.dev && info.ino === opened.ino) return entry
  }
  return undefined
}

/** Check that no directory or file of a path exists in the target only under a name Git reads as another one: one that
 * matches it case-insensitively, in another Unicode form, or in a form Git would not settle. A missing component ends
 * the check, since nothing below it exists yet; one that cannot be read does not count as missing. Listings are read once
 * per call.
 * @param root - target root.
 * @param rules - how Git on this Host reads names on disk.
 * @returns a check of one relative path.
 */
export function exactPaths(root: string, rules: GitNameRules): (path: string) => Promise<TargetPathName> {
  const listings = new Map<string, Promise<{ names: string[]; read: Set<string> }>>()
  return async (path) => {
    const parts = path.split('/')
    for (const [depth, name] of parts.entries()) {
      const directory = parts.slice(0, depth).join('/')
      const listing = listings.get(directory) ?? readdir(join(root, directory))
        .then(names => ({ names, read: new Set(names.flatMap(entry => gitNameOf(entry, rules) ?? [])) }))
      listings.set(directory, listing)
      const { names, read } = await listing
      if (read.has(name)) continue
      // An unlisted component that still opens exists only under another name; one that is missing ends the check.
      const opened = await lstat(join(root, directory, name)).catch((error: unknown) => ({ missing: missing(error) }))
      if ('missing' in opened) return { exact: opened.missing }
      const entry = await spellingOnDisk(join(root, directory), names, name, opened)
      return entry === undefined ? { exact: false } : { exact: false, onDisk: [...parts.slice(0, depth), entry].join('/') }
    }
    return { exact: true }
  }
}

/** A touched path the target does not hold in its before or after state under exactly its name. */
export interface RefusedTargetPath {
  readonly path: string
  /** The target holds the path's before or after content, possibly read through another name. */
  readonly known: boolean
  readonly name: TargetPathName
}

/** The directory and file prefixes the touched paths spell in more than one way apart from case and Unicode form.
 * @param paths - touched paths.
 * @returns the keys, compared apart from case and Unicode form, of prefixes with two or more spellings.
 */
function prefixesSpelledTwice(paths: readonly string[]): Set<string> {
  const spellings = new Map<string, Set<string>>()
  for (const path of paths) {
    const parts = path.split('/')
    for (const depth of parts.keys()) {
      const prefix = parts.slice(0, depth + 1).join('/'), key = looseName(prefix)
      spellings.set(key, (spellings.get(key) ?? new Set<string>()).add(prefix))
    }
  }
  return new Set([...spellings].filter(([, spelled]) => spelled.size > 1).map(([key]) => key))
}

/** Refuse touched paths the target does not hold in their before or after state under exactly their names. Changed
 * content is reported as changed. A name that differs only in case or Unicode form is reported apart, with its spelling
 * as recorded and on disk: renaming it on disk lets the write-back proceed, unless the version itself records the name
 * in two such spellings, which the target holds as one.
 * @param refused - at least one refused path, in order.
 * @param paths - every touched path.
 * @returns `APPLICATION_TARGET_CHANGED` when any content changed, otherwise `APPLICATION_TARGET_NAME_MISMATCH`.
 */
export function targetRefusal(refused: readonly RefusedTargetPath[], paths: readonly string[]): GitResourceError {
  const changed: string[] = [], renamed: string[] = [], twice: string[] = [], spelledTwice = prefixesSpelledTwice(paths)
  for (const { path, known, name: { onDisk } } of refused) {
    if (onDisk === undefined) { changed.push(path); continue }
    const recorded = path.split('/').slice(0, onDisk.split('/').length).join('/')
    const shown = `${path} (recorded ${withCodePoints(recorded)}, on disk ${withCodePoints(onDisk)})`
    if (!known) changed.push(shown)
    else if (spelledTwice.has(looseName(recorded))) twice.push(shown)
    else renamed.push(shown)
  }
  const names = [
    ...renamed.length === 0 ? [] : [`Target names differ only in case or Unicode form from the names this version records: ${namedPaths(renamed)}; renaming each on disk to its recorded name lets the write-back proceed`],
    ...twice.length === 0 ? [] : [`This version records these names in two spellings that differ only in case or Unicode form, which this target holds as one name, so they are not written back here: ${namedPaths(twice)}`]]
  if (changed.length === 0) return new GitResourceError('APPLICATION_TARGET_NAME_MISMATCH', names.join('. '))
  return new GitResourceError('APPLICATION_TARGET_CHANGED',
    [`Target files changed from the state this version starts from and are not overwritten: ${namedPaths(changed)}`, ...names].join('. '))
}

/** Preview exact before/after bytes without creating refs, project index entries or temporary copies. When the target
 * already holds some touched paths in their after state, only the tree the patch starts from is written, through a
 * private scratch index.
 * @param git - existing safe argv runner.
 * @param target - registered user target identity freshly checked by its owner.
 * @param source - exact ready version selected by the owner, including explicit resolution where required.
 * @param signal - read-only observation cancellation.
 * @param limits - complete tree/path/byte bounds.
 * @param host - this Host's platform and the owner's scratch directory.
 * @returns full target CAS and bounded patch digest; changed touched files refuse instead of merging silently, and touched
 * names the target spells otherwise refuse apart from them.
 */
export async function inspectApplication(git: ResourceGit, target: GitRepositoryIdentity, source: GitApplicationSource,
  signal: AbortSignal, limits: PreviewLimits, host: GitApplicationHost): Promise<GitApplicationPreview> {
  sameRepository(source.repository, target)
  const before = await treeEntries(git, target, source.originalTargetBaseTree, signal, limits)
  const after = await treeEntries(git, target, source.resultTree, signal, limits)
  const old = new Map(before.map(entry => [entry.path, entry])), next = new Map(after.map(entry => [entry.path, entry]))
  const paths = [...new Set([...old.keys(), ...next.keys()])]
    .filter(path => hash(old.get(path) ?? null) !== hash(next.get(path) ?? null)).sort()
  if (paths.length > limits.maxFiles) throw new GitResourceError('MANIFEST_LIMIT', 'Complete application path set exceeds its configured bound')
  // A path Git on this Host reads under another name would be written there, and Git would list it as that other path.
  const rules = await nameRules(git, target.root.path, signal, host.platform)
  assertReadableNames(paths, rules)
  const intended: GitApplicationPath[] = []
  for (const path of paths) intended.push({ path, before: await immutableState(git, target, old.get(path), signal),
    after: await immutableState(git, target, next.get(path), signal) })
  const first = await targetCut(git, target, intended, signal, limits)
  // A path is written from its known before state, or left alone when it already holds the after state. A file or
  // directory read through a name Git reads as another one (another case on a case-insensitive target, another Unicode
  // form) is neither: it would pass as current, or be written or created through the alias, while the path it was asked
  // for does not exist.
  const exact = exactPaths(target.root.path, rules), refused: RefusedTargetPath[] = []
  for (const [index, entry] of intended.entries()) {
    const actual = first.touched[index]?.before, name = await exact(entry.path)
    const known = hash(actual) === hash(entry.before) || hash(actual) === hash(entry.after)
    if (!known || !name.exact) refused.push({ path: entry.path, known, name })
  }
  if (refused.length > 0) throw targetRefusal(refused, paths)
  const patch = await patchBytes(git, source, target, signal, first.touched, host.scratchRoot)
  const second = await targetCut(git, target, intended, signal, limits)
  if (second.fingerprint !== first.fingerprint) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Application target changed during its read-only preview')
  const text = patch.toString('utf8')
  if (!Buffer.from(text).equals(patch)) throw new GitResourceError('APPLICATION_PATCH_UNSUPPORTED', 'Git patch cannot be represented losslessly in the UTF-8 user preview')
  const writes = new Set(applicationWrites(second.touched).map(entry => entry.path))
  const current = second.touched.filter(entry => !writes.has(entry.path)).map(entry => entry.path)
  const replacing = new Set((source.written ?? []).flatMap(written => written.missing))
  const replaces = intended.filter(entry => replacing.has(entry.path) && writes.has(entry.path))
  const value = { source: structuredClone(source), target: second, patchHash: byteHash(patch), patch: text,
    binary: text.includes('GIT binary patch\n'), ...current.length === 0 ? {} : { alreadyCurrent: current },
    ...replaces.length === 0 ? {} : { replacesWritten: {
      replaced: replaces.filter(entry => entry.after.kind !== 'absent').map(entry => entry.path),
      deleted: replaces.filter(entry => entry.after.kind === 'absent').map(entry => entry.path) } } }
  return { ...value, fingerprint: hash(value) }
}

/** Observe an original application intent without applying or repairing any content.
 * @param git - existing safe argv runner.
 * @param preview - exact original target and immutable before/after manifest.
 * @param signal - observation cancellation.
 * @param limits - bounded target reads.
 * @param platform - this Host's operating system, which decides how Git reads file names on disk.
 * @returns before/after/partial/unknown facts; no command writes Git or working files.
 */
export async function observeApplication(git: ResourceGit, preview: GitApplicationPreview, signal: AbortSignal,
  limits: PreviewLimits, platform: NodeJS.Platform): Promise<GitApplicationObservation> {
  const target = preview.target, current = await targetCut(git, target.repository, target.touched, signal, limits)
  const headUnchanged = current.head === target.head && current.symbolicRef === target.symbolicRef
  const indexUnchanged = current.indexHash === target.indexHash
  // As in the preview, a path counts only under its exact name; one read through a name Git reads as another is unknown.
  const root = target.repository.root.path, exact = exactPaths(root, await nameRules(git, root, signal, platform))
  const paths: GitApplicationObservation['paths'][number][] = []
  for (const [index, entry] of target.touched.entries()) {
    const actual = current.touched[index]?.before
    paths.push({ path: entry.path, state: !(await exact(entry.path)).exact ? 'unknown' : hash(actual) === hash(entry.after) ? 'after'
      : hash(actual) === hash(entry.before) ? 'before' : 'unknown' })
  }
  const parentsUnchanged = target.ancestors.every(before => before.identity === undefined
    || hash(current.ancestors.find(after => after.path === before.path)?.identity ?? null) === hash(before.identity))
  // A path that was already in its after state counts on both sides; it only has to stay unchanged.
  const writes = new Set(applicationWrites(target.touched).map(entry => entry.path))
  const written = paths.filter(path => writes.has(path.path))
  const state = !headUnchanged || !indexUnchanged || !parentsUnchanged || paths.some(path => path.state === 'unknown') ? 'unknown'
    : written.every(path => path.state === 'after') ? 'after' : written.every(path => path.state === 'before') ? 'before' : 'partial'
  return { state, paths, headUnchanged, indexUnchanged }
}

/** Apply only the selected plain patch after an exact fresh cut and retained Host authorization.
 * The caller records intent, pins both immutable trees and holds all known target writers/jobs quiet first.
 * @param git - existing safe argv runner.
 * @param preview - unchanged user-authorized diff and full target cut.
 * @param scope - authenticated range plus known-writer occupation, rechecked before the external write.
 * @param limits - complete target/path bounds.
 * @param host - this Host's platform and the owner's scratch directory.
 * @returns actual all-after effect; failures require pure observation, never blind replay or rollback.
 */
export async function applyApplication(git: ResourceGit, preview: GitApplicationPreview, scope: GitIntegrationWriteScope,
  limits: PreviewLimits, host: GitApplicationHost): Promise<GitApplicationEffect> {
  const fresh = await inspectApplication(git, preview.target.repository, preview.source, scope.signal, limits, host)
  if (fresh.fingerprint !== preview.fingerprint) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Authorized application cut changed before its write')
  const patch = await patchBytes(git, preview.source, preview.target.repository, scope.signal, preview.target.touched, host.scratchRoot)
  if (byteHash(patch) !== preview.patchHash) throw new GitResourceError('APPLICATION_VERSION_CHANGED', 'Authorized patch differs from its recorded digest')
  if (applicationWrites(preview.target.touched).length > 0) {
    await git.run([...APPLY, '--check', '-'], preview.target.repository.root.path, scope.signal, { input: patch, config: APPLY_SETTINGS })
    const last = await targetCut(git, preview.target.repository, preview.target.touched, scope.signal, limits)
    if (last.fingerprint !== preview.target.fingerprint) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Application target changed after patch preflight')
    scope.signal.throwIfAborted(); scope.assertCurrent()
    await git.run([...APPLY, '-'], preview.target.repository.root.path, scope.signal, { input: patch, config: APPLY_SETTINGS })
  }
  const observation = await observeApplication(git, preview, scope.signal, limits, host.platform)
  scope.signal.throwIfAborted(); scope.assertCurrent()
  if (observation.state !== 'after') throw new GitResourceError('APPLICATION_EFFECT_UNCERTAIN', 'Application effects are partial or unknown; inspect the original intent without replay')
  return { preview: structuredClone(preview), observation }
}

/** Read a current target cut for reversal without reapplying the old source or creating objects.
 * @param git - existing safe argv runner.
 * @param original - exact old confirmed application effect decoded by its owner.
 * @param applicationOperationId - original operation whose before/after data remains immutable.
 * @param signal - observation cancellation.
 * @param limits - complete current touched-path bounds.
 * @param platform - this Host's operating system, which decides how Git reads file names on disk.
 * @returns current touched cut; unrelated user changes are neither captured nor rewritten.
 */
export async function inspectInverse(git: ResourceGit, original: GitApplicationEffect, applicationOperationId: GitOperationId,
  signal: AbortSignal, limits: PreviewLimits, platform: NodeJS.Platform): Promise<GitInversePreview> {
  if (original.observation.state !== 'after') throw new GitResourceError('INVERSE_SOURCE_UNCERTAIN', 'Inverse preparation requires the exact confirmed original application effect')
  const target = original.preview.target, first = await targetCut(git, target.repository, target.touched, signal, limits)
  // The candidate becomes a work copy holding the current target's files and the original starting files: Git on this
  // Host must read each of their paths under its own name.
  const held = [...await treeEntries(git, target.repository, first.head, signal, limits),
    ...await treeEntries(git, target.repository, original.preview.source.originalTargetBaseTree, signal, limits)]
  assertReadableNames(new Set(held.map(entry => entry.path)), await nameRules(git, target.repository.root.path, signal, platform))
  const second = await targetCut(git, target.repository, target.touched, signal, limits)
  if (first.fingerprint !== second.fingerprint) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Current inverse target changed during observation')
  const value = { applicationOperationId, original: structuredClone(original), currentTarget: second }
  return { ...value, fingerprint: hash(value) }
}

/** Create inverse candidate objects from the current target and the original before/after difference.
 * The owner records intent first, then materializes this result in a new managed copy for normal validation.
 * @param git - existing safe argv runner.
 * @param preview - unchanged read-only current target cut.
 * @param operationId - new original inverse operation identity.
 * @param createdAt - its persisted deterministic commit time.
 * @param host - this Host's platform and the resource service's private existing scratch directory.
 * @param scope - retained authority and known-writer occupation, checked before every external write.
 * @param limits - complete resulting candidate bounds.
 * @returns independent prepared/conflicted inverse objects; user working files and index are never written.
 */
export async function prepareInverse(git: ResourceGit, preview: GitInversePreview, operationId: GitOperationId,
  createdAt: string, host: GitApplicationHost, scope: GitIntegrationWriteScope, limits: PreviewLimits): Promise<GitIntegrationEffect> {
  const fresh = await inspectInverse(git, preview.original, preview.applicationOperationId, scope.signal, limits, host.platform)
  if (fresh.fingerprint !== preview.fingerprint) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Current inverse target changed before preparation')
  scope.signal.throwIfAborted(); scope.assertCurrent()
  const scratch = await mkdtemp(join(host.scratchRoot, 'inverse-'))
  try {
    const repository = preview.currentTarget.repository, root = repository.root.path, env = { GIT_INDEX_FILE: join(scratch, 'index') }
    const write = async (args: readonly string[], input?: Buffer, index = env) => {
      scope.signal.throwIfAborted(); scope.assertCurrent()
      return git.run(args, root, scope.signal, { env: index, ...input === undefined ? {} : { input } })
    }
    await write(['read-tree', preview.currentTarget.head])
    const current: [string, GitIndexState][] = []
    for (const entry of preview.currentTarget.touched) {
      if (entry.before.kind === 'absent') { current.push([entry.path, entry.before]); continue }
      const actual = await readRegularFile(root, entry.path, limits.maxFileBytes)
      if (actual.mode !== entry.before.mode || byteHash(actual.bytes) !== entry.before.rawHash) {
        throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Current touched content changed while preparing inverse objects')
      }
      const object = await write(['hash-object', '-w', '--no-filters', '--stdin'], actual.bytes)
      const objectId = gitObjectIdSchema.parse(object.stdout.toString('utf8').trim())
      if (objectId !== entry.before.objectId) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Current inverse object differs from its original preview')
      current.push([entry.path, { mode: actual.mode, objectId }])
    }
    await write(['update-index', '-z', '--index-info'], indexInfo(current, repository.objectFormat))
    const snapshot = gitObjectIdSchema.parse((await write(['write-tree'])).stdout.toString('utf8').trim())
    await treeEntries(git, repository, snapshot, scope.signal, limits)
    const last = await inspectInverse(git, preview.original, preview.applicationOperationId, scope.signal, limits, host.platform)
    if (last.fingerprint !== preview.fingerprint) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Current inverse target changed before three-way preparation')
    scope.signal.throwIfAborted(); scope.assertCurrent()
    const source = preview.original.preview.source
    // Paths the original application found already current were never written, so the reverse leaves them as they are.
    const kept = preview.original.preview.target.touched.filter(entry => hash(entry.before) === hash(entry.after))
    let restore = source.originalTargetBaseTree
    if (kept.length > 0) {
      const index = { GIT_INDEX_FILE: join(scratch, 'restore-index') }
      await write(['read-tree', restore], undefined, index)
      await write(['update-index', '-z', '--index-info'], indexInfo(kept.map(entry => [entry.path, entry.after]), repository.objectFormat), index)
      restore = gitObjectIdSchema.parse((await write(['write-tree'], undefined, index)).stdout.toString('utf8').trim())
    }
    const response = await git.run(['merge-tree', '--write-tree', '-z', '--messages', `--merge-base=${source.resultTree}`,
      snapshot, restore], root, scope.signal, { allowFailure: true })
    const merged = decodeIntegrationMerge(response.stdout, response.status)
    const entries = await treeEntries(git, repository, merged.tree, scope.signal, limits)
    scope.signal.throwIfAborted(); scope.assertCurrent()
    const committed = await git.run(['commit-tree', merged.tree, '-p', preview.currentTarget.head,
      '-m', `DSH inverse ${operationId}`], root, scope.signal, { env: {
      GIT_AUTHOR_NAME: 'DSH resource owner', GIT_AUTHOR_EMAIL: 'resource@dsh.invalid',
      GIT_COMMITTER_NAME: 'DSH resource owner', GIT_COMMITTER_EMAIL: 'resource@dsh.invalid',
      GIT_AUTHOR_DATE: createdAt, GIT_COMMITTER_DATE: createdAt,
    } })
    scope.signal.throwIfAborted(); scope.assertCurrent()
    return { originalTargetBaseTree: snapshot, commit: gitObjectIdSchema.parse(committed.stdout.toString('utf8').trim()),
      tree: merged.tree, manifestHash: treeManifestHash(entries), result: merged.conflicted ? 'conflicted' : 'prepared',
      attemptedInputCount: 1, remainingSourceOperationIds: [], conflictStages: merged.stages, conflictMessages: merged.messages }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
