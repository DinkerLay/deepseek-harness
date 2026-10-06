/** Immutable integration observations and Git merge/index plumbing owned by the resource service. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ResourceGit } from './git.ts'
import { GitResourceError } from './error.ts'
import { hash } from './json-hash.ts'
import { treeManifestHash } from './manifest.ts'
import { selectedPath, treeEntries } from './preview.ts'
import type { PreviewLimits } from './preview.ts'
import type { GitConsumerScope, GitOperationId, GitRepositoryId, GitRepositoryIdentity,
  GitResourceId, GitResourceOperationView, GitResourceRecord } from './types.ts'

/** Explicit immutable inputs; a prior preserved version can be selected as the starting tree. */
export interface GitIntegrationPreviewRequest {
  readonly consumerScope: GitConsumerScope
  readonly baseResourceId: GitResourceId
  readonly basePreserveOperationId?: GitOperationId | undefined
  readonly sourcePreserveOperationIds: readonly GitOperationId[]
  readonly resolutionOperationIds?: readonly GitOperationId[] | undefined
}
/** A resource owner records this request before writing objects or creating the new copy. */
export interface GitIntegrationRequest extends GitIntegrationPreviewRequest {
  readonly operationId: GitOperationId
  readonly originalRequestJson: string
  readonly expectedPreviewFingerprint: string
}
/** One historical operation, never the resource's latest mutable preservation fields. */
export interface GitIntegrationInput {
  readonly operationId: GitOperationId
  readonly resourceId: GitResourceId
  readonly repositoryId: GitRepositoryId
  readonly consumerScope: GitConsumerScope
  readonly commit: string
  readonly tree: string
  readonly manifestHash: string
  readonly ref: string
  readonly resolutionOperationId?: GitOperationId | undefined
}
/** Complete read-only input cut; merge conflicts are not computed by preview. */
export interface GitIntegrationPreview {
  readonly request: GitIntegrationPreviewRequest
  readonly repository: GitRepositoryIdentity
  readonly baseCommit: string
  readonly baseTree: string
  readonly originalTargetBaseTree: string
  readonly baseInput?: GitIntegrationInput | undefined
  readonly sources: readonly GitIntegrationInput[]
  readonly fingerprint: string
}
/** Git's higher-order index entry; text markers alone cannot identify every conflict. */
export interface GitIntegrationConflictStage {
  readonly path: string
  readonly mode: '100644' | '100755'
  readonly objectId: string
  readonly stage: 1 | 2 | 3
}
/** Informational paths are not filesystem authorization or a parsed human message. */
export interface GitIntegrationConflictMessage {
  readonly paths: readonly string[]
  readonly kind: string
  readonly message: string
}
/** Observed merge objects; remaining inputs are never silently folded through an unresolved tree. */
export interface GitIntegrationEffect {
  readonly originalTargetBaseTree: string
  readonly commit: string
  readonly tree: string
  readonly manifestHash: string
  readonly result: 'prepared' | 'conflicted'
  readonly attemptedInputCount: number
  readonly remainingSourceOperationIds: readonly GitOperationId[]
  readonly conflictStages: readonly GitIntegrationConflictStage[]
  readonly conflictMessages: readonly GitIntegrationConflictMessage[]
}
/** Every external write checks the resource owner's still-live authorization immediately beforehand. */
export interface GitIntegrationWriteScope {
  readonly signal: AbortSignal
  assertCurrent(): void
}

/** Exact conflict/version choices, separate from the later Host proof and operation identity. */
export interface GitIntegrationResolutionSelection {
  readonly consumerScope: GitConsumerScope
  readonly integrationOperationId: GitOperationId
  readonly preserveOperationId: GitOperationId
  readonly confirmedConflictIds: readonly string[]
}
/** Independent resolution intent; original integration and preservation records stay unchanged. */
export interface GitIntegrationResolutionRequest extends GitIntegrationResolutionSelection {
  readonly operationId: GitOperationId
  readonly originalRequestJson: string
  readonly expectedPreviewFingerprint: string
}
/** Resource facts only; normal verification and caller authority are supplied by the Host proof. */
export interface GitIntegrationResolutionEffect {
  readonly integrationOperationId: GitOperationId
  readonly preserveOperationId: GitOperationId
  readonly resourceId: GitResourceId
  readonly tree: string
  readonly manifestHash: string
  readonly conflictIds: readonly string[]
}
/** Current quiet version and index cut used by the later resolution CAS. */
export interface GitIntegrationResolutionPreview {
  readonly request: GitIntegrationResolutionSelection
  readonly effect: GitIntegrationResolutionEffect
  readonly resourceRevision: number
  readonly head: string
  readonly indexHash: string
  readonly fingerprint: string
}
/** Owner-decoded exact confirmed receipt, never a latest-resource readiness guess. */
export interface GitIntegrationResolutionObservation {
  readonly operationId: GitOperationId
  readonly consumerScope: GitConsumerScope
  readonly phase: 'confirmed'
  readonly effect: GitIntegrationResolutionEffect
}

const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)
const id = z.string().min(1)
const operationId = id.transform(value => brandString<GitOperationId>(value))
const resourceId = id.transform(value => brandString<GitResourceId>(value))
const consumerScope = id.transform(value => brandString<GitConsumerScope>(value))
/** Strict durable preview-selection fields; item and byte bounds belong to the configured owner. */
export const integrationPreviewRequestSchema = z.object({ consumerScope, baseResourceId: resourceId,
  basePreserveOperationId: operationId.optional(), sourcePreserveOperationIds: z.array(operationId).min(1).readonly(),
  resolutionOperationIds: z.array(operationId).readonly().optional(),
}).strict()
/** Strict durable integration intent without user-target write authority. */
export const integrationRequestSchema = integrationPreviewRequestSchema.extend({ operationId,
  originalRequestJson: z.string().refine((value) => {
    try { JSON.parse(value); return true } catch (_invalidJson) { return false }
  }, 'original consumer request must be JSON'), expectedPreviewFingerprint: id,
}).strict()
/** Strict immutable source facts, suitable for the existing operation aggregate. */
export const integrationInputSchema = z.object({ operationId, resourceId,
  repositoryId: id.transform(value => brandString<GitRepositoryId>(value)), consumerScope,
  commit: objectId, tree: objectId, manifestHash: id, ref: id, resolutionOperationId: operationId.optional(),
}).strict()
/** Higher-order entries retain exact paths and stages, including non-text conflicts. */
export const integrationConflictStageSchema = z.object({ path: id, mode: z.enum(['100644', '100755']), objectId,
  stage: z.union([z.literal(1), z.literal(2), z.literal(3)]),
}).strict()
/** Git's structured conflict type is stored separately from its explanatory text. */
export const integrationConflictMessageSchema = z.object({ paths: z.array(id).readonly(), kind: id, message: z.string() }).strict()
/** Strict merge-effect fields; confirmation remains with the resource journal owner. */
export const integrationEffectSchema = z.object({ originalTargetBaseTree: objectId, commit: objectId, tree: objectId,
  manifestHash: id, result: z.enum(['prepared', 'conflicted']), attemptedInputCount: z.number().int().positive(),
  remainingSourceOperationIds: z.array(operationId).readonly(), conflictStages: z.array(integrationConflictStageSchema).readonly(),
  conflictMessages: z.array(integrationConflictMessageSchema).readonly(),
}).strict().superRefine((effect, context) => {
  if (effect.result === 'prepared' && (effect.remainingSourceOperationIds.length > 0 || effect.conflictStages.length > 0)) {
    context.addIssue({ code: 'custom', message: 'prepared integration retains unresolved inputs or conflict stages' })
  }
})
/** Strict durable exact-conflict selection without a Host authority assertion. */
export const integrationResolutionSelectionSchema = z.object({ consumerScope, integrationOperationId: operationId,
  preserveOperationId: operationId, confirmedConflictIds: z.array(id).min(1).readonly(),
}).strict()
/** Strict independent resolution intent reusing the existing immutable request fields. */
export const integrationResolutionRequestSchema = integrationResolutionSelectionSchema.extend({
  operationId: integrationRequestSchema.shape.operationId, originalRequestJson: integrationRequestSchema.shape.originalRequestJson,
  expectedPreviewFingerprint: integrationRequestSchema.shape.expectedPreviewFingerprint,
}).strict()
/** Strict receipt binds every conflict to one exact preserved tree, not to a future resource state. */
export const integrationResolutionEffectSchema = z.object({ integrationOperationId: operationId, preserveOperationId: operationId,
  resourceId, tree: objectId, manifestHash: id, conflictIds: z.array(id).min(1).readonly(),
}).strict()
/** Strict resolution cut is immutable after the caller selects it. */
export const integrationResolutionPreviewSchema = z.object({ request: integrationResolutionSelectionSchema,
  effect: integrationResolutionEffectSchema, resourceRevision: z.number().int().positive(), head: objectId, indexHash: id, fingerprint: id,
}).strict()

const knownConflictKinds = new Set([
  'CONFLICT (contents)', 'CONFLICT (binary)', 'CONFLICT (file/directory)', 'CONFLICT (distinct modes)',
  'CONFLICT (modify/delete)', 'CONFLICT (rename/rename)', 'CONFLICT (rename involved in collision)', 'CONFLICT (rename/delete)',
  'CONFLICT (directory rename suggested)', 'CONFLICT (file in way of directory rename)',
  'CONFLICT(directory rename collision)', 'CONFLICT(directory rename unclear split)',
])
const knownInformationKinds = new Set(['Auto-merging', 'Path updated due to directory rename',
  'Directory rename skipped since directory was renamed on both sides'])

/** Identify every known unresolved Git conflict independently of marker text or stage presence.
 * @param effect - original immutable integration result.
 * @returns stable conflict IDs derived from that exact tree, paths, kinds and stage objects.
 */
export function integrationConflictIds(effect: GitIntegrationEffect): readonly string[] {
  if (effect.result === 'prepared') return []
  const ids: string[] = []
  for (const message of effect.conflictMessages) {
    if (knownInformationKinds.has(message.kind)) continue
    if (!knownConflictKinds.has(message.kind)) {
      throw new GitResourceError('INTEGRATION_CONFLICT_UNSUPPORTED', 'Git reported a conflict type without a supported explicit resolution')
    }
    ids.push(hash({ tree: effect.tree, kind: message.kind, paths: message.paths }))
  }
  const paths = [...new Set(effect.conflictStages.map(stage => stage.path))]
  for (const path of paths) ids.push(hash({ tree: effect.tree, kind: 'index-stages', path,
    stages: effect.conflictStages.filter(stage => stage.path === path).toSorted((a, b) => a.stage - b.stage) }))
  if (ids.length === 0) throw new GitResourceError('INTEGRATION_CONFLICT_UNSUPPORTED', 'Conflicted integration has no identifiable resolution facts')
  return [...new Set(ids)].sort()
}

/** Build the strict preview schema with the resource owner's existing repository decoder.
 * @param repository - sole existing repository-identity schema, not a copied decoder.
 * @returns strict stored preview fields.
 */
export function integrationPreviewSchema(repository: z.ZodType<GitRepositoryIdentity>): z.ZodType<GitIntegrationPreview> {
  return z.object({ request: integrationPreviewRequestSchema, repository, baseCommit: objectId, baseTree: objectId,
    originalTargetBaseTree: objectId, baseInput: integrationInputSchema.optional(),
    sources: z.array(integrationInputSchema).min(1).readonly(),
    fingerprint: id,
  }).strict()
}

async function verifiedVersion(git: ResourceGit, identity: GitRepositoryIdentity, commit: string, tree: string,
  ref: string, signal: AbortSignal, limits: PreviewLimits): Promise<string> {
  const actual = await git.text(['rev-parse', '--verify', ref], identity.root.path, signal)
  const actualTree = await git.text(['rev-parse', `${commit}^{tree}`], identity.root.path, signal)
  if (actual !== commit || actualTree !== tree) throw new GitResourceError('INTEGRATION_VERSION_CHANGED', 'Immutable integration reference differs from its recorded version')
  return treeManifestHash(await treeEntries(git, identity, tree, signal, limits))
}

async function preservedInput(git: ResourceGit, identity: GitRepositoryIdentity, view: GitResourceOperationView,
  expected: GitOperationId, scope: GitConsumerScope, signal: AbortSignal, limits: PreviewLimits,
  resolutionIds: readonly GitOperationId[], resolutions: readonly GitIntegrationResolutionObservation[]): Promise<GitIntegrationInput> {
  const { operation, resource } = view
  if (operation.operationId !== expected || operation.kind !== 'preserve' || operation.phase !== 'confirmed'
    || operation.effectContent !== 'versioned' || (operation.effectConflictStages?.length ?? 0) > 0
    || operation.consumerScope !== scope || resource.consumerScope !== scope
    || operation.repositoryId !== identity.repositoryId || resource.repositoryId !== identity.repositoryId
    || operation.resourceId !== resource.resourceId || operation.effectCommit === undefined || operation.effectTree === undefined
    || operation.effectManifestHash === undefined || operation.effectRef === undefined) {
    throw new GitResourceError('INTEGRATION_SOURCE_UNAVAILABLE', 'Integration requires an exact confirmed versioned preservation in this repository and consumer scope')
  }
  const manifestHash = await verifiedVersion(git, identity, operation.effectCommit, operation.effectTree,
    operation.effectRef, signal, limits)
  if (manifestHash !== operation.effectManifestHash) {
    throw new GitResourceError('INTEGRATION_VERSION_CHANGED', 'Preserved integration manifest differs from its recorded version')
  }
  const unresolved = operation.effectUnresolvedConflictIds ?? []
  let resolutionOperationId: GitOperationId | undefined
  if (unresolved.length > 0) {
    const resolution = resolutions.find(value => resolutionIds.includes(value.operationId)
      && value.effect.preserveOperationId === operation.operationId)
    if (resolution === undefined || resolution.consumerScope !== scope
      || resolution.effect.integrationOperationId !== operation.effectIntegrationOperationId
      || resolution.effect.resourceId !== operation.resourceId || resolution.effect.tree !== operation.effectTree
      || resolution.effect.manifestHash !== operation.effectManifestHash
      || hash([...resolution.effect.conflictIds].sort()) !== hash([...unresolved].sort())) {
      throw new GitResourceError('INTEGRATION_UNRESOLVED', 'Preserved integration conflicts require an explicit exact confirmed resolution receipt')
    }
    resolutionOperationId = resolution.operationId
  }
  return { operationId: operation.operationId, resourceId: operation.resourceId, repositoryId: operation.repositoryId,
    consumerScope: operation.consumerScope, commit: operation.effectCommit, tree: operation.effectTree,
    manifestHash, ref: operation.effectRef, ...resolutionOperationId === undefined ? {} : { resolutionOperationId } }
}

/** Observe existing immutable versions without creating objects, refs, index files or directories.
 * @param git - existing safe argv runner.
 * @param identity - current repository checked by its sole owner.
 * @param base - selected resource's recorded immutable baseline.
 * @param sources - exact ordered operation views resolved by the owner.
 * @param request - selected scope and operation identities.
 * @param signal - observation cancellation.
 * @param limits - complete tree and input bounds.
 * @param baseVersion - selected historical preservation, when explicitly requested.
 * @param inheritedTargetBaseTree - original base inherited only from an owner-validated integration record.
 * @param resolutions - owner-decoded receipts explicitly selected by the request.
 * @returns complete immutable input cut and fingerprint; no merge computation occurs.
 */
export async function inspectIntegration(git: ResourceGit, identity: GitRepositoryIdentity, base: GitResourceRecord,
  sources: readonly GitResourceOperationView[], request: GitIntegrationPreviewRequest, signal: AbortSignal,
  limits: PreviewLimits, baseVersion?: GitResourceOperationView, inheritedTargetBaseTree?: string,
  resolutions: readonly GitIntegrationResolutionObservation[] = []): Promise<GitIntegrationPreview> {
  signal.throwIfAborted()
  if (base.resourceId !== request.baseResourceId || base.repositoryId !== identity.repositoryId
    || base.consumerScope !== request.consumerScope
    || base.baselineCommit === undefined || base.baselineTree === undefined) {
    throw new GitResourceError('INTEGRATION_BASE_UNAVAILABLE', 'Integration baseline does not belong to the requested repository and consumer scope')
  }
  if (request.sourcePreserveOperationIds.length === 0 || request.sourcePreserveOperationIds.length > limits.maxFiles
    || new Set(request.sourcePreserveOperationIds).size !== request.sourcePreserveOperationIds.length
    || sources.length !== request.sourcePreserveOperationIds.length) {
    throw new GitResourceError('INTEGRATION_SELECTION_INVALID', 'Integration source selection is empty, duplicated or exceeds its configured bound')
  }
  await verifiedVersion(git, identity, base.baselineCommit, base.baselineTree, base.privateRef, signal, limits)
  let baseInput: GitIntegrationInput | undefined
  if (request.basePreserveOperationId !== undefined) {
    if (baseVersion === undefined || baseVersion.resource.resourceId !== base.resourceId) {
      throw new GitResourceError('INTEGRATION_BASE_UNAVAILABLE', 'Selected base preservation does not belong to the selected resource')
    }
    baseInput = await preservedInput(git, identity, baseVersion, request.basePreserveOperationId, request.consumerScope, signal, limits,
      request.resolutionOperationIds ?? [], resolutions)
  }
  const inputs: GitIntegrationInput[] = []
  for (const expected of request.sourcePreserveOperationIds) {
    const view = sources.find(view => view.operation.operationId === expected)
    if (view === undefined) throw new GitResourceError('INTEGRATION_SOURCE_UNAVAILABLE', 'Selected preservation operation is unavailable')
    inputs.push(await preservedInput(git, identity, view, expected, request.consumerScope, signal, limits,
      request.resolutionOperationIds ?? [], resolutions))
  }
  const originalTargetBaseTree = inheritedTargetBaseTree ?? base.baselineTree
  await treeEntries(git, identity, originalTargetBaseTree, signal, limits)
  const value = { request: structuredClone(request), repository: structuredClone(identity),
    baseCommit: baseInput?.commit ?? base.baselineCommit, baseTree: baseInput?.tree ?? base.baselineTree,
    originalTargetBaseTree, ...baseInput === undefined ? {} : { baseInput }, sources: inputs }
  signal.throwIfAborted()
  return { ...value, fingerprint: hash(value) }
}

/** Parsed merge output keeps known conflicts even when they have no higher-order file entries. */
export interface GitIntegrationMergeOutput {
  readonly tree: string
  readonly conflicted: boolean
  readonly stages: readonly GitIntegrationConflictStage[]
  readonly messages: readonly GitIntegrationConflictMessage[]
}

/** Parse the actual NUL-delimited Git process response, never conflict-marker text.
 * @param bytes - bounded raw stdout from merge-tree --write-tree -z --messages.
 * @param status - settled Git exit status; 0 is clean and 1 is conflicted.
 * @returns exact tree, higher-order entries and structured informational records.
 */
export function decodeIntegrationMerge(bytes: Buffer, status: number | null): GitIntegrationMergeOutput {
  if (status !== 0 && status !== 1) throw new GitResourceError('INTEGRATION_MERGE_FAILED', 'Git could not compute the integration merge')
  const text = bytes.toString('utf8')
  if (!Buffer.from(text).equals(bytes)) throw new GitResourceError('GIT_METADATA_INVALID', 'Integration paths must be losslessly representable as UTF-8')
  const values = text.split('\0'), tree = objectId.parse(values[0]), stages: GitIntegrationConflictStage[] = []
  let cursor = 1
  while (cursor < values.length && values[cursor] !== '') {
    const row = /^(100644|100755) ([a-f0-9]+) ([123])\t([\s\S]+)$/u.exec(z.string().parse(values[cursor]))
    if (row === null) throw new GitResourceError('GIT_METADATA_INVALID', 'Integration conflict stages are incomplete or unsupported')
    stages.push(integrationConflictStageSchema.parse({ mode: row[1], objectId: row[2], stage: Number(row[3]), path: row[4] }))
    cursor++
  }
  if (new Set(stages.map(value => `${value.path}\0${value.stage}`)).size !== stages.length || status === 0 && stages.length > 0) {
    throw new GitResourceError('GIT_METADATA_INVALID', 'Integration conflict stages contradict the settled merge status')
  }
  cursor++
  const messages: GitIntegrationConflictMessage[] = []
  while (cursor < values.length - 1) {
    const raw = z.string().parse(values[cursor++]), count = Number(raw)
    if (!/^(?:0|[1-9]\d*)$/u.test(raw) || !Number.isSafeInteger(count) || count > values.length - cursor - 2) {
      throw new GitResourceError('GIT_METADATA_INVALID', 'Integration conflict information is incomplete')
    }
    const paths = values.slice(cursor, cursor + count); cursor += count
    const kind = values[cursor++], message = values[cursor++]
    messages.push(integrationConflictMessageSchema.parse({ paths, kind, message }))
  }
  return { tree, conflicted: status === 1, stages, messages }
}

/** Compute merge objects only after the caller has durably recorded its original intent.
 * @param git - existing safe argv runner.
 * @param preview - exact immutable cut retained in that intent.
 * @param operationId - original operation identity used in deterministic commit metadata.
 * @param createdAt - original persisted author/committer time.
 * @param scope - retained resource ownership and synchronous external authority recheck.
 * @param limits - complete resulting tree bounds.
 * @returns observed objects and unresolved inputs; this function creates no work copy or journal acknowledgement.
 */
export async function mergeIntegration(git: ResourceGit, preview: GitIntegrationPreview, operationId: GitOperationId,
  createdAt: string, scope: GitIntegrationWriteScope, limits: PreviewLimits): Promise<GitIntegrationEffect> {
  let commit = preview.baseCommit, tree = preview.baseTree, stages: readonly GitIntegrationConflictStage[] = [],
    messages: readonly GitIntegrationConflictMessage[] = [], count = 0, conflicted = false
  const root = preview.repository.root.path
  for (const input of preview.sources) {
    scope.signal.throwIfAborted(); scope.assertCurrent()
    const result = await git.run(['merge-tree', '--write-tree', '-z', '--messages', commit, input.commit], root, scope.signal,
      { allowFailure: true })
    const merged = decodeIntegrationMerge(result.stdout, result.status)
    tree = merged.tree; stages = merged.stages; messages = merged.messages; conflicted = merged.conflicted
    await treeEntries(git, preview.repository, tree, scope.signal, limits)
    for (const stage of stages) await selectedPath(root, stage.path)
    scope.signal.throwIfAborted(); scope.assertCurrent()
    const created = await git.run(['commit-tree', tree, '-p', commit, '-p', input.commit,
      '-m', `DSH integration ${operationId}`], root, scope.signal, { env: {
      GIT_AUTHOR_NAME: 'DSH resource owner', GIT_AUTHOR_EMAIL: 'resource@dsh.invalid',
      GIT_COMMITTER_NAME: 'DSH resource owner', GIT_COMMITTER_EMAIL: 'resource@dsh.invalid',
      GIT_AUTHOR_DATE: createdAt, GIT_COMMITTER_DATE: createdAt,
    } })
    commit = objectId.parse(created.stdout.toString('utf8').trim())
    count++
    if (conflicted) break
  }
  scope.signal.throwIfAborted(); scope.assertCurrent()
  return { originalTargetBaseTree: preview.originalTargetBaseTree, commit, tree,
    manifestHash: treeManifestHash(await treeEntries(git, preview.repository, tree, scope.signal, limits)),
    result: conflicted ? 'conflicted' : 'prepared', attemptedInputCount: count,
    remainingSourceOperationIds: preview.sources.slice(count).map(input => input.operationId), conflictStages: stages,
    conflictMessages: messages }
}

/** Install actual conflict stages in an already verified, raw-materialized managed copy.
 * The owner initializes its own index first; an existing exact installation is a read-only retry.
 * @param git - existing safe argv runner.
 * @param identity - actual repository containing the effect objects.
 * @param resource - reserved managed work copy verified by its owner, never the user project.
 * @param effect - exact recorded merge effect whose marker tree was materialized without filters.
 * @param scope - current retained resource ownership and authorization.
 * @param limits - complete effect and index bounds.
 * @returns only after the actual index matches the full intended stage set.
 */
export async function materializeIntegrationIndex(git: ResourceGit, identity: GitRepositoryIdentity, resource: GitResourceRecord,
  effect: GitIntegrationEffect, scope: GitIntegrationWriteScope, limits: PreviewLimits): Promise<void> {
  scope.signal.throwIfAborted(); scope.assertCurrent()
  const { paths, expected, initial } = await integrationIndexRows(git, identity, effect, scope.signal, limits)
  const rows = (await git.text(['ls-files', '--stage', '-z'], resource.path, scope.signal)).split('\0').filter(Boolean)
  if (hash(rows.toSorted()) === hash(expected)) {
    scope.signal.throwIfAborted(); scope.assertCurrent()
    return
  }
  if (hash(rows.toSorted()) !== hash(initial)) throw new GitResourceError('INTEGRATION_INDEX_CHANGED', 'Managed integration index differs from both the original tree and intended conflict stages')
  for (const path of paths) await selectedPath(resource.path, path)
  const zero = '0'.repeat(identity.objectFormat === 'sha1' ? 40 : 64)
  const remove = [...paths].map(path => `0 ${zero}\t${path}\0`).join('')
  const add = effect.conflictStages.map(stage => `${stage.mode} ${stage.objectId} ${stage.stage}\t${stage.path}\0`).join('')
  scope.signal.throwIfAborted(); scope.assertCurrent()
  await git.run(['update-index', '-z', '--index-info'], resource.path, scope.signal, { input: Buffer.from(remove + add) })
  await verifyIntegrationIndex(git, identity, resource, effect, scope.signal, limits)
  scope.signal.throwIfAborted(); scope.assertCurrent()
}

async function integrationIndexRows(git: ResourceGit, identity: GitRepositoryIdentity, effect: GitIntegrationEffect,
  signal: AbortSignal, limits: PreviewLimits) {
  const entries = await treeEntries(git, identity, effect.tree, signal, limits)
  const paths = new Set(effect.conflictStages.map(stage => stage.path))
  const ordinary = entries.filter(entry => !paths.has(entry.path)).map(entry => `${entry.mode} ${entry.objectId} 0\t${entry.path}`)
  const expected = [...ordinary, ...effect.conflictStages.map(stage => `${stage.mode} ${stage.objectId} ${stage.stage}\t${stage.path}`)].sort()
  return { paths, expected, initial: entries.map(entry => `${entry.mode} ${entry.objectId} 0\t${entry.path}`).sort() }
}

/** Verify a recorded integration index without initializing it or repairing any stages.
 * @param git - existing safe argv runner.
 * @param identity - current repository checked by the sole owner.
 * @param resource - exact original managed work copy.
 * @param effect - original recorded tree and stages.
 * @param signal - observation cancellation.
 * @param limits - complete expected tree bounds.
 * @returns only after every actual stage matches; no Git or filesystem writes occur.
 */
export async function verifyIntegrationIndex(git: ResourceGit, identity: GitRepositoryIdentity, resource: GitResourceRecord,
  effect: GitIntegrationEffect, signal: AbortSignal, limits: PreviewLimits): Promise<void> {
  const { expected } = await integrationIndexRows(git, identity, effect, signal, limits)
  const actual = (await git.text(['ls-files', '--stage', '-z'], resource.path, signal)).split('\0').filter(Boolean)
  signal.throwIfAborted()
  if (hash(actual.toSorted()) !== hash(expected)) {
    throw new GitResourceError('INTEGRATION_INDEX_CHANGED', 'Managed integration index did not retain its exact conflict stages')
  }
}
