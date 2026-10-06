/** Explicit user-target cuts, plain Git application and pure interrupted-effect observations. */
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
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
import { applicationPathSchema, gitObjectIdSchema, treeManifestHash } from './manifest.ts'
import type { GitApplicationPath, GitFileState } from './manifest.ts'

/** Exact owner-resolved version; no latest-resource lookup occurs inside application plumbing. */
export interface GitApplicationSource {
  readonly repository: GitRepositoryIdentity
  readonly integrationOperationId: GitOperationId
  readonly preserveOperationId: GitOperationId
  readonly resourceId: GitResourceId
  readonly consumerScope: GitConsumerScope
  readonly originalTargetBaseTree: string
  readonly resultCommit: string
  readonly resultTree: string
  readonly manifestHash: string
  readonly resolutionOperationId?: GitOperationId | undefined
}
/** Explicit target Workspace and immutable source IDs, never an arbitrary Host path. */
export interface GitApplicationPreviewRequest {
  readonly consumerScope: GitConsumerScope
  readonly integrationOperationId: GitOperationId
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
export const applicationPreviewRequestSchema = z.object({ consumerScope, integrationOperationId: operationId,
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
  const source = z.object({ repository, integrationOperationId: operationId, preserveOperationId: operationId,
    resourceId: id.transform(value => brandString<GitResourceId>(value)), consumerScope,
    originalTargetBaseTree: gitObjectIdSchema, resultCommit: gitObjectIdSchema, resultTree: gitObjectIdSchema,
    manifestHash: id, ...resolution }).strict()
  const target = z.object({ repository, head: gitObjectIdSchema, symbolicRef: id.optional(), indexHash: id,
    touched: z.array(applicationPathSchema).readonly(),
    ancestors: z.array(z.object({ path: z.string(), identity: witness.optional() }).strict()).readonly(),
    fingerprint: id }).strict()
  const preview = z.object({ source, target, patchHash: id, patch: z.string(), binary: z.boolean(), fingerprint: id }).strict()
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

async function patchBytes(git: ResourceGit, source: GitApplicationSource, target: GitRepositoryIdentity,
  signal: AbortSignal): Promise<Buffer> {
  return (await git.run(['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames',
    source.originalTargetBaseTree, source.resultTree, '--'], target.root.path, signal)).stdout
}

/** Preview exact before/after bytes without creating objects, refs, indices or temporary copies.
 * @param git - existing safe argv runner.
 * @param target - registered user target identity freshly checked by its owner.
 * @param source - exact ready version selected by the owner, including explicit resolution where required.
 * @param signal - read-only observation cancellation.
 * @param limits - complete tree/path/byte bounds.
 * @returns full target CAS and bounded patch digest; changed touched files refuse instead of merging silently.
 */
export async function inspectApplication(git: ResourceGit, target: GitRepositoryIdentity, source: GitApplicationSource,
  signal: AbortSignal, limits: PreviewLimits): Promise<GitApplicationPreview> {
  sameRepository(source.repository, target)
  const before = await treeEntries(git, target, source.originalTargetBaseTree, signal, limits)
  const after = await treeEntries(git, target, source.resultTree, signal, limits)
  const old = new Map(before.map(entry => [entry.path, entry])), next = new Map(after.map(entry => [entry.path, entry]))
  const paths = [...new Set([...old.keys(), ...next.keys()])]
    .filter(path => hash(old.get(path) ?? null) !== hash(next.get(path) ?? null)).sort()
  if (paths.length > limits.maxFiles) throw new GitResourceError('MANIFEST_LIMIT', 'Complete application path set exceeds its configured bound')
  const intended: GitApplicationPath[] = []
  for (const path of paths) intended.push({ path, before: await immutableState(git, target, old.get(path), signal),
    after: await immutableState(git, target, next.get(path), signal) })
  const first = await targetCut(git, target, intended, signal, limits)
  for (let index = 0; index < intended.length; index++) {
    if (hash(first.touched[index]?.before) !== hash(intended[index]?.before)) {
      throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Touched target content differs from the selected integration baseline; prepare a fresh candidate')
    }
  }
  const patch = await patchBytes(git, source, target, signal), second = await targetCut(git, target, intended, signal, limits)
  if (second.fingerprint !== first.fingerprint) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Application target changed during its read-only preview')
  const text = patch.toString('utf8')
  if (!Buffer.from(text).equals(patch)) throw new GitResourceError('APPLICATION_PATCH_UNSUPPORTED', 'Git patch cannot be represented losslessly in the UTF-8 user preview')
  const value = { source: structuredClone(source), target: second, patchHash: byteHash(patch), patch: text,
    binary: text.includes('GIT binary patch\n') }
  return { ...value, fingerprint: hash(value) }
}

/** Observe an original application intent without applying or repairing any content.
 * @param git - existing safe argv runner.
 * @param preview - exact original target and immutable before/after manifest.
 * @param signal - observation cancellation.
 * @param limits - bounded target reads.
 * @returns before/after/partial/unknown facts; no command writes Git or working files.
 */
export async function observeApplication(git: ResourceGit, preview: GitApplicationPreview, signal: AbortSignal,
  limits: PreviewLimits): Promise<GitApplicationObservation> {
  const target = preview.target, current = await targetCut(git, target.repository, target.touched, signal, limits)
  const headUnchanged = current.head === target.head && current.symbolicRef === target.symbolicRef
  const indexUnchanged = current.indexHash === target.indexHash
  const paths = target.touched.map((entry, index): GitApplicationObservation['paths'][number] => {
    const actual = current.touched[index]?.before
    return { path: entry.path, state: hash(actual) === hash(entry.after) ? 'after'
      : hash(actual) === hash(entry.before) ? 'before' : 'unknown' }
  })
  const parentsUnchanged = target.ancestors.every(before => before.identity === undefined
    || hash(current.ancestors.find(after => after.path === before.path)?.identity ?? null) === hash(before.identity))
  const state = !headUnchanged || !indexUnchanged || !parentsUnchanged || paths.some(path => path.state === 'unknown') ? 'unknown'
    : paths.every(path => path.state === 'after') ? 'after' : paths.every(path => path.state === 'before') ? 'before' : 'partial'
  return { state, paths, headUnchanged, indexUnchanged }
}

/** Apply only the selected plain patch after an exact fresh cut and retained Host authorization.
 * The caller records intent, pins both immutable trees and holds all known target writers/jobs quiet first.
 * @param git - existing safe argv runner.
 * @param preview - unchanged user-authorized diff and full target cut.
 * @param scope - authenticated range plus known-writer occupation, rechecked before the external write.
 * @param limits - complete target/path bounds.
 * @returns actual all-after effect; failures require pure observation, never blind replay or rollback.
 */
export async function applyApplication(git: ResourceGit, preview: GitApplicationPreview, scope: GitIntegrationWriteScope,
  limits: PreviewLimits): Promise<GitApplicationEffect> {
  const fresh = await inspectApplication(git, preview.target.repository, preview.source, scope.signal, limits)
  if (fresh.fingerprint !== preview.fingerprint) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Authorized application cut changed before its write')
  const patch = await patchBytes(git, preview.source, preview.target.repository, scope.signal)
  if (byteHash(patch) !== preview.patchHash) throw new GitResourceError('APPLICATION_VERSION_CHANGED', 'Authorized patch differs from its recorded digest')
  if (preview.target.touched.length > 0) {
    await git.run(['apply', '--check', '--binary', '--whitespace=nowarn', '-'], preview.target.repository.root.path, scope.signal, { input: patch })
    const last = await targetCut(git, preview.target.repository, preview.target.touched, scope.signal, limits)
    if (last.fingerprint !== preview.target.fingerprint) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Application target changed after patch preflight')
    scope.signal.throwIfAborted(); scope.assertCurrent()
    await git.run(['apply', '--binary', '--whitespace=nowarn', '-'], preview.target.repository.root.path, scope.signal, { input: patch })
  }
  const observation = await observeApplication(git, preview, scope.signal, limits)
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
 * @returns current touched cut; unrelated user changes are neither captured nor rewritten.
 */
export async function inspectInverse(git: ResourceGit, original: GitApplicationEffect, applicationOperationId: GitOperationId,
  signal: AbortSignal, limits: PreviewLimits): Promise<GitInversePreview> {
  if (original.observation.state !== 'after') throw new GitResourceError('INVERSE_SOURCE_UNCERTAIN', 'Inverse preparation requires the exact confirmed original application effect')
  const target = original.preview.target, first = await targetCut(git, target.repository, target.touched, signal, limits)
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
 * @param scratchRoot - private existing scratch directory owned by the resource service.
 * @param scope - retained authority and known-writer occupation, checked before every external write.
 * @param limits - complete resulting candidate bounds.
 * @returns independent prepared/conflicted inverse objects; user working files and index are never written.
 */
export async function prepareInverse(git: ResourceGit, preview: GitInversePreview, operationId: GitOperationId,
  createdAt: string, scratchRoot: string, scope: GitIntegrationWriteScope, limits: PreviewLimits): Promise<GitIntegrationEffect> {
  const fresh = await inspectInverse(git, preview.original, preview.applicationOperationId, scope.signal, limits)
  if (fresh.fingerprint !== preview.fingerprint) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Current inverse target changed before preparation')
  scope.signal.throwIfAborted(); scope.assertCurrent()
  const scratch = await mkdtemp(join(scratchRoot, 'inverse-'))
  try {
    const root = preview.currentTarget.repository.root.path, env = { GIT_INDEX_FILE: join(scratch, 'index') }
    const write = async (args: readonly string[], input?: Buffer) => {
      scope.signal.throwIfAborted(); scope.assertCurrent()
      return git.run(args, root, scope.signal, { env, ...input === undefined ? {} : { input } })
    }
    await write(['read-tree', preview.currentTarget.head])
    for (const entry of preview.currentTarget.touched) {
      if (entry.before.kind === 'absent') { await write(['update-index', '--force-remove', '--', entry.path]); continue }
      const actual = await readRegularFile(root, entry.path, limits.maxFileBytes)
      if (actual.mode !== entry.before.mode || byteHash(actual.bytes) !== entry.before.rawHash) {
        throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Current touched content changed while preparing inverse objects')
      }
      const object = await write(['hash-object', '-w', '--no-filters', '--stdin'], actual.bytes)
      const objectId = gitObjectIdSchema.parse(object.stdout.toString('utf8').trim())
      if (objectId !== entry.before.objectId) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Current inverse object differs from its original preview')
      await write(['update-index', '--add', '--cacheinfo', `${actual.mode},${objectId},${entry.path}`])
    }
    const snapshot = gitObjectIdSchema.parse((await write(['write-tree'])).stdout.toString('utf8').trim())
    await treeEntries(git, preview.currentTarget.repository, snapshot, scope.signal, limits)
    const last = await inspectInverse(git, preview.original, preview.applicationOperationId, scope.signal, limits)
    if (last.fingerprint !== preview.fingerprint) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Current inverse target changed before three-way preparation')
    scope.signal.throwIfAborted(); scope.assertCurrent()
    const source = preview.original.preview.source
    const response = await git.run(['merge-tree', '--write-tree', '-z', '--messages', `--merge-base=${source.resultTree}`,
      snapshot, source.originalTargetBaseTree], root, scope.signal, { allowFailure: true })
    const merged = decodeIntegrationMerge(response.stdout, response.status)
    const entries = await treeEntries(git, preview.currentTarget.repository, merged.tree, scope.signal, limits)
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
