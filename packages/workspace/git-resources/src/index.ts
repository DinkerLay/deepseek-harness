/** Host-owned local Git resources over Workspace identity, durable domains and a whole-home kernel lease. */
import { lstatSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { acquireFileLease } from '@deepseek-ai/dsh-util-file-lease'
import type { FileLease } from '@deepseek-ai/dsh-util-file-lease'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subprocess'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-workspace'
import { ResourceGit } from './git.ts'
import { inspectIntegration, integrationPreviewRequestSchema, integrationRequestSchema, materializeIntegrationIndex,
  mergeIntegration, verifyIntegrationIndex, integrationConflictIds, integrationResolutionSelectionSchema,
  integrationResolutionRequestSchema } from './integration.ts'
import type { GitIntegrationConflictStage, GitIntegrationPreviewRequest, GitIntegrationPreview, GitIntegrationRequest,
  GitIntegrationResolutionObservation, GitIntegrationResolutionPreview, GitIntegrationResolutionRequest,
  GitIntegrationResolutionSelection } from './integration.ts'
import { applicationPreviewRequestSchema, applicationRequestSchema, applyApplication, inspectApplication,
  inspectInverse, inversePreviewRequestSchema, inverseRequestSchema, observeApplication, prepareInverse as prepareInverseObjects } from './application.ts'
import type { GitApplicationPreviewRequest, GitApplicationPreview, GitApplicationRequest, GitApplicationSource,
  GitInversePreviewRequest, GitInversePreview, GitInverseRequest } from './application.ts'
import { cleanupRequestSchema } from './cleanup.ts'
import type { GitResourceCleanupObservation, GitResourceCleanupPreview, GitResourceCleanupRequest } from './cleanup.ts'
import { GitResourceError } from './error.ts'
import { gitResourceDomain, hash } from './records.ts'
import type { RepositoryRecord } from './records.ts'
import { byteHash, inspectConfiguration, inspectRepository, missing, pathIdentity, previewRepository, readRegularFile, selectedPath, treeEntries, versionedFiles } from './preview.ts'
import type { GitOperationId, GitRepositoryId, GitResourceId, GitConsumerScope, GitResourceCreateRequest, GitResourceOperation,
  GitResourceOperationView, GitResourcePreserveRequest, GitResourcePreview, GitResourcePreviewRequest,
  GitResourceRecord, GitResourceUseIdentity, GitResourceWriteScope, GitRepositoryIdentity, GitWorkCopyInspection } from './types.ts'

export type * from './types.ts'
export { GitResourceError } from './error.ts'
/** Brand a caller-reserved operation identity without changing its value.
 * @param value - caller-reserved operation name.
 * @returns compile-time branded operation identity.
 */
export function GitOperationId(value: string): GitOperationId { return brandString<GitOperationId>(value) }
/** Brand a stored resource identity without changing its value.
 * @param value - stored resource identity.
 * @returns compile-time branded resource identity.
 */
export function GitResourceId(value: string): GitResourceId { return brandString<GitResourceId>(value) }
/** Brand a stored repository identity without changing its value.
 * @param value - stored repository identity.
 * @returns compile-time branded repository identity.
 */
export function GitRepositoryId(value: string): GitRepositoryId { return brandString<GitRepositoryId>(value) }
/** Brand an uninterpreted consumer grouping identity.
 * @param value - consumer-owned opaque scope, not an interpreted role or task key.
 * @returns the branded grouping identity.
 */
export function GitConsumerScope(value: string): GitConsumerScope { return brandString<GitConsumerScope>(value) }

/** Deployment bounds and the explicit Harness home, never a caller-selected arbitrary resource directory. */
export interface Config {
  /** Explicit Harness home containing the managed resource owner directory. */
  home?: string
  /** Local Git executable resolved lazily when an operation needs Git. */
  gitExecutable?: string
  /** Maximum elapsed time for one Git subprocess. */
  timeoutMs?: number
  /** Termination grace period after Git subprocess cancellation. */
  graceMs?: number
  /** Maximum captured bytes from a Git subprocess. */
  maxOutputBytes?: number
  /** Maximum files in one observed or preserved content selection. */
  maxFiles?: number
  /** Maximum bytes in one regular file, also bounded by subprocess output capacity. */
  maxFileBytes?: number
  /** Maximum total regular-file bytes in one observed or preserved selection. */
  maxTotalBytes?: number
  /** Maximum shutdown wait before retaining ownership for unfinished work. */
  closeTimeoutMs?: number
  /** Maximum UTF-8 bytes in the uninterpreted original consumer request JSON. */
  maxConsumerRequestBytes?: number
}
/** Plugin configuration resolves bounds at load; default mounting remains opt-in. */
export const Config: z<Config> = z.object({ home: z.string(), gitExecutable: z.string(), timeoutMs: z.number().default(30_000),
  graceMs: z.number().default(2_000), maxOutputBytes: z.number().default(8 * 1024 * 1024), maxFiles: z.number().default(1_000),
  maxFileBytes: z.number().default(32 * 1024 * 1024), maxTotalBytes: z.number().default(128 * 1024 * 1024),
  closeTimeoutMs: z.number().default(10_000), maxConsumerRequestBytes: z.number().default(128 * 1024) })
declare module '@deepseek-ai/cordis' { interface Context { gitResources: GitResources } }

/** Sole same-host owner of managed work copies; no task, agent role or model tool policy. */
export class GitResources extends Service {
  static Config = Config
  static inject = ['workspaceRegistry', 'storageDomain', 'subprocess']
  private readonly lifetime = new AbortController()
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly lanes = new Map<string, Promise<void>>()
  private readonly liveUses = new Set<GitResourceId>()
  private readonly managedDirectories = new Map<string, import('./types.ts').GitPathIdentity>()
  private domain: Domain<typeof gitResourceDomain> | undefined
  private table: KvTable<GitRepositoryId, RepositoryRecord> | undefined
  private homeLease: FileLease | undefined
  private git: ResourceGit | undefined
  private resolvingGit: Promise<ResourceGit> | undefined
  private root = ''
  private isolation = ''
  private home = ''
  private readonly limits: {
    timeoutMs: number
    graceMs: number
    maxOutputBytes: number
    maxFiles: number
    maxFileBytes: number
    maxTotalBytes: number
  }

  /** @param ctx - registered Workspace, durable domain and same-world subprocess services.
   * @param config - opt-in owner location and bounds.
   */
  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'gitResources')
    this.limits = { timeoutMs: config.timeoutMs ?? 30_000, graceMs: config.graceMs ?? 2_000,
      maxOutputBytes: config.maxOutputBytes ?? 8 * 1024 * 1024, maxFiles: config.maxFiles ?? 1_000,
      maxFileBytes: Math.min(config.maxFileBytes ?? 32 * 1024 * 1024, config.maxOutputBytes ?? 8 * 1024 * 1024),
      maxTotalBytes: config.maxTotalBytes ?? 128 * 1024 * 1024 }
    for (const value of [...Object.values(this.limits), config.maxFileBytes ?? 32 * 1024 * 1024,
      config.closeTimeoutMs ?? 10_000, config.maxConsumerRequestBytes ?? 128 * 1024]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new GitResourceError('CONFIG_INVALID', 'Git resource limits must be positive integers')
    }
    if (config.gitExecutable !== undefined && !config.gitExecutable.trim()
      || config.home !== undefined && !config.home.trim()) throw new GitResourceError('CONFIG_INVALID', 'Configured Git executable and home must be nonempty')
    ctx.effect(() => () => this.close(), 'gitResources.owner')
  }

  /** Acquire the stable kernel lease before opening authoritative mutable storage. */
  protected async [Service.init](): Promise<void> {
    this.home = await canonicalizeWatchPath(resolveDshHome(this.config.home))
    this.root = join(this.home, 'git-resources')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    this.root = (await pathIdentity(this.root)).path
    this.homeLease = await acquireFileLease(join(this.root, 'owner.lock'))
    try {
      for (const name of ['workcopies', 'scratch', 'isolated']) {
        const path = join(this.root, name)
        await mkdir(path, { recursive: true, mode: 0o700 })
        if (!(await lstat(path)).isDirectory()) throw new GitResourceError('RESOURCE_HOME_INVALID', 'Managed resource directories must be local directories')
        this.managedDirectories.set(name, await pathIdentity(path))
      }
      this.isolation = join(this.root, 'isolated')
      try { await writeFile(join(this.isolation, 'empty-config'), '', { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error }
      const empty = await lstat(join(this.isolation, 'empty-config'))
      if (!empty.isFile() || empty.isSymbolicLink() || empty.size !== 0) throw new GitResourceError('RESOURCE_HOME_INVALID', 'Owner configuration isolation must be an empty local regular file')
      this.domain = await this.ctx.storageDomain.open(gitResourceDomain)
      this.table = this.domain.table('repositories')
      for (const [id, repository] of this.table.entries()) {
        if (repository.resources.some(resource => resource.use?.phase === 'held')) await this.table.update(id, current => ({ ...current,
          revision: current.revision + 1, resources: current.resources.map(resource => resource.use?.phase !== 'held' ? resource
            : { ...resource, revision: resource.revision + 1, use: { ...resource.use, phase: 'needs_attention' } }) }))
      }
    } catch (error) {
      await this.domain?.close()
      this.domain = undefined; this.table = undefined
      await this.homeLease.release(); this.homeLease = undefined
      throw error
    }
  }

  /** Observe a registered repository and an explicit immutable or selected baseline.
   * @param request - registered project and explicit commit/layered baseline.
   * @param signal - caller cancellation.
   * @returns bounded detached observation; no Git object, ref, index, domain or user-file writes.
   */
  async preview(request: GitResourcePreviewRequest, signal: AbortSignal = this.lifetime.signal): Promise<GitResourcePreview> {
    return this.owned(async () => {
      const combined = AbortSignal.any([signal, this.lifetime.signal])
      const workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) throw new GitResourceError('WORKSPACE_NOT_FOUND', 'Project Workspace is not registered')
      try {
        await this.ensureGit(combined)
        const identity = await inspectRepository(this.runner(), workspace.path, workspace.id, this.isolation, this.home, combined)
        return await previewRepository(this.runner(), identity, structuredClone(request), combined, this.limits)
      } catch (error) {
        if (!(error instanceof GitResourceError)) throw error
        const value = { request: structuredClone(request), permitted: false, diagnostic: error.message, risks: [error.code],
          dirty: { staged: [], unstaged: [], untracked: [], unmerged: [] }, selected: [] }
        return { ...value, fingerprint: hash(value) }
      }
    })
  }

  /** Create the work copy reserved by an exact original request, or resume that same operation.
   * @param request - exact earlier preview and stable caller-reserved operation id.
   * @param signal - cancellation; intent and completed effects survive it.
   * @returns confirmed resource or recoverable original operation, never a second work copy.
   */
  async create(request: GitResourceCreateRequest, signal: AbortSignal = this.lifetime.signal): Promise<GitResourceOperationView> {
    const captured = structuredClone(request)
    this.validateId(captured.operationId)
    if (!captured.consumerScope || Buffer.byteLength(captured.consumerScope, 'utf8') > 256 || captured.consumerScope.includes('\0')
      || Buffer.byteLength(captured.originalRequestJson, 'utf8') > (this.config.maxConsumerRequestBytes ?? 128 * 1024)) {
      throw new GitResourceError('CONSUMER_REQUEST_INVALID', 'Consumer scope or original request exceeds its configured bound')
    }
    try { JSON.parse(captured.originalRequestJson) } catch (_invalidConsumerJson) {
      throw new GitResourceError('CONSUMER_REQUEST_INVALID', 'Original consumer request must be valid JSON')
    }
    const fingerprint = hash(captured)
    return this.owned(() => this.lane('operations', async () => {
      const old = this.findOperation(captured.operationId)
      if (old !== undefined) {
        if (old.operation.fingerprint !== fingerprint) throw new GitResourceError('OPERATION_CONFLICT', 'Operation identity belongs to another request')
        if (old.operation.phase === 'abandoned') return structuredClone(old)
        return this.finishCreate(old.operation, signal)
      }
      const preview = await this.preview({ workspaceId: captured.workspaceId, baseline: captured.baseline }, signal)
      if (!preview.permitted || preview.repository === undefined || preview.fingerprint !== captured.expectedPreviewFingerprint) {
        throw new GitResourceError('PREVIEW_CHANGED', preview.diagnostic ?? 'Repository changed after preview; inspect a fresh cut')
      }
      const identity = preview.repository, resourceId = GitResourceId(hash([identity.repositoryId, captured.operationId]))
      await this.assertManagedDirectory('workcopies')
      const resource: GitResourceRecord = { resourceId, repositoryId: identity.repositoryId, revision: 1,
        consumerScope: captured.consumerScope,
        path: join(this.root, 'workcopies', resourceId), reservedAbsent: true,
        privateRef: `refs/dsh-resources/${resourceId}/baseline`, state: 'reserved', useHistory: [] }
      try { await lstat(resource.path); throw new GitResourceError('RESOURCE_UNKNOWN', 'Reserved resource path already exists and was not adopted') }
      catch (error) { if (!missing(error)) throw error }
      const operation: GitResourceOperation = { operationId: captured.operationId, fingerprint, kind: 'create',
        resourceId, repositoryId: identity.repositoryId, consumerScope: captured.consumerScope,
        phase: 'intended', request: captured, createdAt: new Date().toISOString(), preview, externalWriteStarted: false }
      const table = this.records(), previous = table.get(identity.repositoryId)
      if (previous === undefined) {
        await table.put(identity.repositoryId, { revision: 1, identity, resources: [resource], operations: [operation] })
      }
      else await table.update(identity.repositoryId, current => ({ ...current, revision: current.revision + 1,
        resources: [...current.resources, resource], operations: [...current.operations, operation] }))
      return this.finishCreate(operation, signal)
    }, signal))
  }

  /** Observe exact immutable versions; no merge objects, refs or new work copies are created.
   * @param request - opaque scope, starting resource and ordered versioned preservation identities.
   * @param signal - read-only observation cancellation.
   * @returns immutable source facts and an integration creation fingerprint.
   */
  async previewIntegration(request: GitIntegrationPreviewRequest,
    signal: AbortSignal = this.lifetime.signal): Promise<GitIntegrationPreview> {
    const captured = integrationPreviewRequestSchema.parse(request)
    return this.owned(async () => {
      const combined = AbortSignal.any([signal, this.lifetime.signal]), base = this.requireResource(captured.baseResourceId)
      if (base.resource.state === 'cleaned') throw new GitResourceError('INTEGRATION_BASE_UNAVAILABLE', 'Removed work copy is not a live base; explicitly create a new resource from its preserved commit')
      await this.assertRepository(base.repository.identity, combined)
      const prior = base.repository.operations.find(value => value.resourceId === captured.baseResourceId
        && (value.kind === 'integrate' || value.kind === 'inverse'))
      if (prior?.integrationEffect?.result === 'conflicted' && captured.basePreserveOperationId === undefined) {
        throw new GitResourceError('INTEGRATION_UNRESOLVED', 'An unresolved integration requires a new explicitly resolved versioned preservation')
      }
      const sources = captured.sourcePreserveOperationIds.map(id => this.requireOperation(id))
      const version = captured.basePreserveOperationId === undefined ? undefined : this.requireOperation(captured.basePreserveOperationId)
      const resolutions = (captured.resolutionOperationIds ?? []).map((id): GitIntegrationResolutionObservation => {
        const operation = this.requireOperation(id).operation
        if (operation.kind !== 'resolve' || operation.phase !== 'confirmed' || operation.resolutionEffect === undefined
          || operation.consumerScope !== captured.consumerScope) throw new GitResourceError('INTEGRATION_UNRESOLVED', 'Selected resolution receipt is unavailable in this consumer scope')
        return { operationId: operation.operationId, consumerScope: operation.consumerScope, phase: 'confirmed',
          effect: operation.resolutionEffect }
      })
      return inspectIntegration(this.runner(), base.repository.identity, base.resource, sources, captured, combined,
        this.limits, version, prior?.integrationEffect?.originalTargetBaseTree, resolutions)
    })
  }

  /** Persist an integration intent, then create a separate work copy without applying anything to the project.
   * @param request - exact earlier preview, original request JSON and stable operation identity.
   * @param signal - caller cancellation; committed effects remain observable.
   * @param assertCurrent - trusted synchronous Host recheck before each external write and final acknowledgement.
   * @returns the original prepared or conflicted work copy and immutable Git conflict evidence.
   */
  async integrate(request: GitIntegrationRequest, signal: AbortSignal = this.lifetime.signal,
    assertCurrent: () => void = () => {}): Promise<GitResourceOperationView> {
    const captured = integrationRequestSchema.parse(request), fingerprint = hash(captured)
    this.validateId(captured.operationId); this.validateConsumer(captured.consumerScope, captured.originalRequestJson)
    return this.owned(() => this.lane('operations', async () => {
      const old = this.findOperation(captured.operationId)
      if (old !== undefined) {
        if (old.operation.fingerprint !== fingerprint) throw new GitResourceError('OPERATION_CONFLICT', 'Operation identity belongs to another request')
        if (old.operation.phase === 'abandoned') return structuredClone(old)
        return this.finishIntegration(old.operation, signal, assertCurrent)
      }
      const preview = await this.previewIntegration({ consumerScope: captured.consumerScope, baseResourceId: captured.baseResourceId,
        ...captured.basePreserveOperationId === undefined ? {} : { basePreserveOperationId: captured.basePreserveOperationId },
        ...captured.resolutionOperationIds === undefined ? {} : { resolutionOperationIds: captured.resolutionOperationIds },
        sourcePreserveOperationIds: captured.sourcePreserveOperationIds }, signal)
      if (preview.fingerprint !== captured.expectedPreviewFingerprint) throw new GitResourceError('PREVIEW_CHANGED', 'Integration inputs changed after preview')
      const identity = preview.repository, resourceId = GitResourceId(hash([identity.repositoryId, captured.operationId]))
      await this.assertManagedDirectory('workcopies')
      const resource: GitResourceRecord = { resourceId, repositoryId: identity.repositoryId, consumerScope: captured.consumerScope,
        revision: 1, path: join(this.root, 'workcopies', resourceId), reservedAbsent: true,
        privateRef: `refs/dsh-resources/${resourceId}/baseline`, state: 'reserved', useHistory: [] }
      try { await lstat(resource.path); throw new GitResourceError('RESOURCE_UNKNOWN', 'Reserved integration path already exists and was not adopted') }
      catch (error) { if (!missing(error)) throw error }
      signal.throwIfAborted(); this.lifetime.signal.throwIfAborted(); assertCurrent()
      const operation: GitResourceOperation = { operationId: captured.operationId, fingerprint, kind: 'integrate',
        repositoryId: identity.repositoryId, resourceId, consumerScope: captured.consumerScope,
        phase: 'intended', request: captured, createdAt: new Date().toISOString(), integrationPreview: preview, externalWriteStarted: false }
      await this.records().update(identity.repositoryId, current => ({ ...current, revision: current.revision + 1,
        resources: [...current.resources, resource], operations: [...current.operations, operation] }))
      return this.finishIntegration(operation, signal, assertCurrent)
    }, signal))
  }

  /** Observe an exact version and all known conflicts without inferring resolution from marker absence.
   * @param selection - original integration, versioned seal and explicit complete conflict set.
   * @param signal - observation cancellation.
   * @returns a current quiet working/index cut; no Git objects or refs are written.
   */
  async previewResolution(selection: GitIntegrationResolutionSelection,
    signal: AbortSignal = this.lifetime.signal): Promise<GitIntegrationResolutionPreview> {
    const captured = integrationResolutionSelectionSchema.parse(selection)
    return this.owned(() => this.readResolution(captured, AbortSignal.any([signal, this.lifetime.signal])))
  }

  /** Record independent Host-proven resolution of one exact immutable version; original records never change.
   * @param request - stable operation and exact preview plus original consumer JSON.
   * @param signal - admitted operation cancellation.
   * @param assertProof - required synchronous Host authority/normal-verification proof, not a request-authored claim.
   * @returns exact confirmed resolution receipt; new versions need their own explicit confirmation.
   */
  async resolveIntegration(request: GitIntegrationResolutionRequest, signal: AbortSignal,
    assertProof: () => void): Promise<GitResourceOperationView> {
    const captured = integrationResolutionRequestSchema.parse(request), fingerprint = hash(captured)
    this.validateId(captured.operationId); this.validateConsumer(captured.consumerScope, captured.originalRequestJson)
    const selection: GitIntegrationResolutionSelection = { consumerScope: captured.consumerScope,
      integrationOperationId: captured.integrationOperationId, preserveOperationId: captured.preserveOperationId,
      confirmedConflictIds: captured.confirmedConflictIds }
    return this.owned(() => this.lane('operations', async () => {
      const old = this.findOperation(captured.operationId)
      if (old !== undefined && old.operation.fingerprint !== fingerprint) throw new GitResourceError('OPERATION_CONFLICT', 'Operation identity belongs to another request')
      const original = this.requireOperation(captured.integrationOperationId)
      return this.lane(original.resource.resourceId, async () => {
        const combined = AbortSignal.any([signal, this.lifetime.signal]), check = () => { combined.throwIfAborted(); assertProof() }
        check()
        if (old?.operation.phase === 'confirmed' || old?.operation.phase === 'abandoned') {
          return structuredClone(this.requireOperation(captured.operationId))
        }
        let operation = old?.operation
        if (operation === undefined) {
          const preview = await this.readResolution(selection, combined)
          if (preview.fingerprint !== captured.expectedPreviewFingerprint) throw new GitResourceError('PREVIEW_CHANGED', 'Resolution version changed after preview')
          check()
          operation = { operationId: captured.operationId, fingerprint, kind: 'resolve', phase: 'intended', request: captured,
            repositoryId: original.operation.repositoryId, resourceId: original.resource.resourceId, consumerScope: captured.consumerScope,
            createdAt: new Date().toISOString(), resolutionPreview: preview, externalWriteStarted: false }
          const intended = operation
          await this.records().update(original.operation.repositoryId, current => ({ ...current, revision: current.revision + 1,
            operations: [...current.operations, intended] }))
        }
        try {
          const current = await this.readResolution(selection, combined)
          if (current.fingerprint !== operation.resolutionPreview?.fingerprint) throw new GitResourceError('PREVIEW_CHANGED', 'Original resolution cut changed; no new version was adopted')
          check()
          await this.save(operation.repositoryId, operation.resourceId, operation.operationId,
            (resource) => {
              check()
              // Observation and this transform share the resource lane; the fingerprint above rechecks external changes.
              return { ...resource, revision: resource.revision + 1, state: 'preserved', resolutionOperationId: captured.operationId,
                resolvedPreserveOperationId: captured.preserveOperationId, unresolvedConflictIds: [] }
            },
            value => ({ ...value, phase: 'confirmed', resolutionEffect: current.effect }))
          check(); return structuredClone(this.requireOperation(captured.operationId))
        } catch (error) { await this.attention(operation, error); throw error }
      }, signal)
    }, signal))
  }

  /** Observe an exact ready version and registered target; no file, index, ref or Git object writes.
   * @param request - immutable version, optional exact resolution receipt and target Workspace identity.
   * @param signal - read-only preview cancellation.
   * @returns complete target HEAD/index/touched-path CAS and plain patch digest.
   */
  async previewApplication(request: GitApplicationPreviewRequest,
    signal: AbortSignal = this.lifetime.signal): Promise<GitApplicationPreview> {
    const captured = applicationPreviewRequestSchema.parse(request)
    return this.owned(async () => {
      const combined = AbortSignal.any([signal, this.lifetime.signal])
      const source = await this.applicationSource(captured, combined)
      const workspace = this.ctx.workspaceRegistry.get(captured.targetWorkspaceId)
      if (workspace === undefined) throw new GitResourceError('WORKSPACE_NOT_FOUND', 'Application target Workspace is not registered')
      const target = await inspectRepository(this.runner(), workspace.path, workspace.id, this.isolation, this.home, combined)
      return inspectApplication(this.runner(), target, source, combined, this.limits)
    })
  }

  /** Explicit authenticated application, without moving the target HEAD/index or blindly replaying partial writes.
   * @param request - stable original operation and exact target preview.
   * @param signal - retained Host occupation cancellation.
   * @param assertAuthorized - required current user authority and known-target-writer quiet proof, outside request JSON.
   * @returns confirmed all-after observation; partial or unknown target effects remain attention-required.
   */
  async apply(request: GitApplicationRequest, signal: AbortSignal,
    assertAuthorized: () => void): Promise<GitResourceOperationView> {
    const captured = applicationRequestSchema.parse(request), fingerprint = hash(captured)
    this.validateId(captured.operationId); this.validateConsumer(captured.consumerScope, captured.originalRequestJson)
    return this.owned(() => this.lane('operations', async () => {
      const old = this.findOperation(captured.operationId)
      if (old !== undefined) {
        if (old.operation.fingerprint !== fingerprint) throw new GitResourceError('OPERATION_CONFLICT', 'Operation identity belongs to another request')
        if (old.operation.phase === 'abandoned') return structuredClone(old)
        return this.finishApplication(old.operation, signal, assertAuthorized)
      }
      const preview = await this.previewApplication({ consumerScope: captured.consumerScope,
        integrationOperationId: captured.integrationOperationId, preserveOperationId: captured.preserveOperationId,
        targetWorkspaceId: captured.targetWorkspaceId,
        ...captured.resolutionOperationId === undefined ? {} : { resolutionOperationId: captured.resolutionOperationId } }, signal)
      if (preview.fingerprint !== captured.expectedPreviewFingerprint) throw new GitResourceError('PREVIEW_CHANGED', 'Application target changed after preview')
      signal.throwIfAborted(); this.lifetime.signal.throwIfAborted(); assertAuthorized()
      const operation: GitResourceOperation = { operationId: captured.operationId, fingerprint, kind: 'apply', phase: 'intended',
        resourceId: preview.source.resourceId, repositoryId: preview.source.repository.repositoryId, consumerScope: captured.consumerScope,
        request: captured, createdAt: new Date().toISOString(), applicationPreview: preview, externalWriteStarted: false }
      await this.records().update(operation.repositoryId, current => ({ ...current, revision: current.revision + 1,
        operations: [...current.operations, operation] }))
      return this.finishApplication(operation, signal, assertAuthorized)
    }, signal))
  }

  /** Observe a reverse candidate's CURRENT target without reapplying original inputs.
   * @param request - exact old confirmed application and its registered target.
   * @param signal - read-only cancellation.
   * @returns fresh current touched-path cut, preserving unrelated target changes.
   */
  async previewInverse(request: GitInversePreviewRequest, signal: AbortSignal = this.lifetime.signal): Promise<GitInversePreview> {
    const captured = inversePreviewRequestSchema.parse(request)
    return this.owned(async () => {
      const original = this.requireOperation(captured.applicationOperationId).operation
      const combined = AbortSignal.any([signal, this.lifetime.signal])
      if (original.kind !== 'apply' || original.phase !== 'confirmed' || original.applicationEffect === undefined
        || original.consumerScope !== captured.consumerScope
        || original.applicationEffect.preview.target.repository.workspaceId !== captured.targetWorkspaceId) {
        throw new GitResourceError('INVERSE_SOURCE_UNAVAILABLE', 'Inverse requires an exact confirmed application in this scope and original target')
      }
      await this.assertRepository(original.applicationEffect.preview.target.repository, combined)
      return inspectInverse(this.runner(), original.applicationEffect, captured.applicationOperationId, combined, this.limits)
    })
  }

  /** Prepare a separate reverse work copy from the current target, not a rollback or automatic target write.
   * @param request - original reverse intention and exact current preview.
   * @param signal - caller cancellation.
   * @param assertCurrent - trusted synchronous Host freshness/occupation recheck before each write.
   * @returns prepared/conflicted independent work copy requiring normal verification and a new application.
   */
  async prepareInverse(request: GitInverseRequest, signal: AbortSignal = this.lifetime.signal,
    assertCurrent: () => void = () => {}): Promise<GitResourceOperationView> {
    const captured = inverseRequestSchema.parse(request), fingerprint = hash(captured)
    this.validateId(captured.operationId); this.validateConsumer(captured.consumerScope, captured.originalRequestJson)
    return this.owned(() => this.lane('operations', async () => {
      const old = this.findOperation(captured.operationId)
      if (old !== undefined) {
        if (old.operation.fingerprint !== fingerprint) throw new GitResourceError('OPERATION_CONFLICT', 'Operation identity belongs to another request')
        if (old.operation.phase === 'abandoned') return structuredClone(old)
        return this.finishIntegration(old.operation, signal, assertCurrent)
      }
      const preview = await this.previewInverse({ consumerScope: captured.consumerScope,
        applicationOperationId: captured.applicationOperationId, targetWorkspaceId: captured.targetWorkspaceId }, signal)
      if (preview.fingerprint !== captured.expectedPreviewFingerprint) throw new GitResourceError('PREVIEW_CHANGED', 'Current reverse target changed after preview')
      const identity = preview.currentTarget.repository, resourceId = GitResourceId(hash([identity.repositoryId, captured.operationId]))
      await this.assertManagedDirectory('workcopies')
      const resource: GitResourceRecord = { resourceId, repositoryId: identity.repositoryId, consumerScope: captured.consumerScope,
        revision: 1, path: join(this.root, 'workcopies', resourceId), reservedAbsent: true,
        privateRef: `refs/dsh-resources/${resourceId}/baseline`, state: 'reserved', useHistory: [] }
      try { await lstat(resource.path); throw new GitResourceError('RESOURCE_UNKNOWN', 'Reserved inverse path already exists and was not adopted') }
      catch (error) { if (!missing(error)) throw error }
      signal.throwIfAborted(); this.lifetime.signal.throwIfAborted(); assertCurrent()
      const operation: GitResourceOperation = { operationId: captured.operationId, fingerprint, kind: 'inverse', phase: 'intended',
        resourceId, repositoryId: identity.repositoryId, consumerScope: captured.consumerScope, request: captured,
        createdAt: new Date().toISOString(), inversePreview: preview, externalWriteStarted: false }
      const current = this.records().get(identity.repositoryId)
      if (current === undefined) await this.records().put(identity.repositoryId,
        { revision: 1, identity, resources: [resource], operations: [operation] })
      else await this.records().update(identity.repositoryId, value => ({ ...value, revision: value.revision + 1,
        resources: [...value.resources, resource], operations: [...value.operations, operation] }))
      return this.finishIntegration(operation, signal, assertCurrent)
    }, signal))
  }

  /** Observe already-created effects and confirm only the exact original resource evidence.
   * @param operationId - earlier persisted identity.
   * @param signal - reconciliation cancellation.
   * @returns actual resource/ref identity or a retained attention diagnostic; unknown paths are not removed or adopted.
   */
  async reconcile(operationId: GitOperationId, signal: AbortSignal = this.lifetime.signal): Promise<GitResourceOperationView> {
    return this.owned(() => this.lane('operations', async () => {
      const current = this.findOperation(operationId)
      if (current === undefined) throw new GitResourceError('OPERATION_NOT_FOUND', 'Resource operation does not exist')
      if (current.operation.phase === 'abandoned') return structuredClone(current)
      return this.lane(current.resource.resourceId, () => this.reconcileObserved(current, signal), signal)
    }, signal))
  }

  /** Terminally abandon an original creation only after proving that no external write ever began.
   * This neither rolls back nor deletes Git objects, directories, refs or any partial effect.
   * @param operationId - original immutable creation identity; never reusable after abandonment.
   * @param expectedFingerprint - exact original request CAS.
   * @param reason - bounded caller-owned diagnostic, not an authorization claim.
   * @param signal - cancellation while waiting for the actual operation/resource lanes to drain.
   * @param assertCurrent - trusted synchronous Host recheck immediately before the durable transform.
   * @returns terminal receipt only when all ownership evidence is definitely absent.
   */
  async abandonOperation(operationId: GitOperationId, expectedFingerprint: string, reason: string,
    signal: AbortSignal = this.lifetime.signal, assertCurrent: () => void = () => {}): Promise<GitResourceOperationView> {
    this.validateId(operationId)
    if (!reason.trim() || Buffer.byteLength(reason, 'utf8') > (this.config.maxConsumerRequestBytes ?? 128 * 1024)) {
      throw new GitResourceError('DIAGNOSTIC_INVALID', 'Abandonment requires a bounded nonempty reason')
    }
    return this.owned(() => this.lane('operations', async () => {
      const found = this.requireOperation(operationId)
      if (found.operation.fingerprint !== expectedFingerprint) throw new GitResourceError('OPERATION_CONFLICT', 'Original abandonment request no longer matches')
      if (found.operation.phase === 'abandoned') return structuredClone(found)
      return this.lane(found.resource.resourceId, async () => {
        const current = this.requireOperation(operationId), combined = AbortSignal.any([signal, this.lifetime.signal])
        const check = () => { combined.throwIfAborted(); assertCurrent() }
        if (current.operation.externalWriteStarted !== false || current.operation.phase === 'confirmed'
          || current.operation.effectCommit !== undefined || current.operation.effectTree !== undefined
          || current.operation.integrationEffect !== undefined || current.operation.worktreeCreateStarted === true
          || current.operation.applicationEffect !== undefined || current.operation.resolutionEffect !== undefined) {
          throw new GitResourceError('OPERATION_EFFECT_UNKNOWN', 'Existing or unknown external effects cannot be abandoned; reconcile or explicitly resume the original request')
        }
        if (current.operation.kind === 'apply' || current.operation.kind === 'resolve' || current.operation.kind === 'cleanup') {
          if (current.resource.use !== undefined || this.liveUses.has(current.resource.resourceId)) {
            throw new GitResourceError('OPERATION_EFFECT_UNKNOWN', 'Current or uncertain use prevents no-effect settlement')
          }
          if (current.operation.kind === 'apply') {
            const preview = current.operation.applicationPreview
            if (preview === undefined) throw new GitResourceError('RECORD_INVALID', 'Application has no original target cut')
            await this.assertRepository(preview.target.repository, combined)
            const observation = await observeApplication(this.runner(), preview, combined, this.limits)
            if (observation.state !== 'before' && preview.target.touched.length > 0) {
              throw new GitResourceError('OPERATION_EFFECT_UNKNOWN', 'Original target is not definitely before the unstarted application')
            }
            const request = current.operation.request
            if (!('integrationOperationId' in request && 'targetWorkspaceId' in request)) throw new GitResourceError('RECORD_INVALID', 'Application request has no exact source/target selection')
            const fresh = await this.previewApplication({ consumerScope: current.operation.consumerScope,
              integrationOperationId: request.integrationOperationId, preserveOperationId: request.preserveOperationId,
              targetWorkspaceId: request.targetWorkspaceId,
              ...request.resolutionOperationId === undefined ? {} : { resolutionOperationId: request.resolutionOperationId } }, combined)
            if (fresh.fingerprint !== preview.fingerprint) throw new GitResourceError('OPERATION_EFFECT_UNKNOWN', 'Original complete application cut changed before safe abandonment')
          } else if (current.operation.kind === 'cleanup') {
            const preview = current.operation.cleanupPreview
            if (preview === undefined
              || (await this.readCleanup(current.resource.resourceId, combined)).fingerprint !== preview.fingerprint) {
              throw new GitResourceError('OPERATION_EFFECT_UNKNOWN', 'Unstarted cleanup no longer has its original preserved owned cut')
            }
          }
          check()
          await this.save(current.operation.repositoryId, current.resource.resourceId, operationId,
            (resource) => { check(); return resource }, operation => ({ ...operation, phase: 'abandoned', diagnostic: reason }))
          check(); return structuredClone(this.requireOperation(operationId))
        }
        if (current.operation.kind !== 'create' && current.operation.kind !== 'integrate' && current.operation.kind !== 'inverse'
          || current.resource.baselineCommit !== undefined || current.resource.pathIdentity !== undefined
          || current.resource.use !== undefined || this.liveUses.has(current.resource.resourceId)) {
          throw new GitResourceError('OPERATION_EFFECT_UNKNOWN', 'Existing or unknown owned resource effects cannot be abandoned')
        }
        await this.assertRepository(this.requireResource(current.resource.resourceId).repository.identity, combined)
        await this.assertManagedDirectory('workcopies')
        try { await lstat(current.resource.path); throw new GitResourceError('OPERATION_EFFECT_UNKNOWN', 'Reserved path has an existing effect and was not removed') }
        catch (error) { if (!missing(error)) throw error }
        const repository = this.requireResource(current.resource.resourceId).repository.identity
        const prefix = `refs/dsh-resources/${current.resource.resourceId}/`
        if (await this.runner().text(['for-each-ref', '--format=%(refname)', prefix], repository.root.path, combined)) {
          throw new GitResourceError('OPERATION_EFFECT_UNKNOWN', 'Owned references exist and were not removed')
        }
        const admin = join(repository.commonDir.path, 'worktrees')
        try {
          await pathIdentity(admin)
          if ((await readdir(admin)).some(name => name.startsWith(current.resource.resourceId))) {
            throw new GitResourceError('OPERATION_EFFECT_UNKNOWN', 'Possible work-copy administrative effects remain registered')
          }
        } catch (error) { if (!missing(error)) throw error }
        const worktrees = await this.runner().text(['worktree', 'list', '--porcelain', '-z'], repository.root.path, combined)
        if (worktrees.split('\0').some(row => row === `worktree ${current.resource.path}`)) {
          throw new GitResourceError('OPERATION_EFFECT_UNKNOWN', 'Reserved work-copy metadata exists and was not removed')
        }
        check()
        await this.save(current.operation.repositoryId, current.resource.resourceId, operationId,
          (resource) => { check(); return { ...resource, revision: resource.revision + 1, state: 'abandoned' } },
          operation => ({ ...operation, phase: 'abandoned', diagnostic: reason }))
        check(); return structuredClone(this.requireOperation(operationId))
      }, signal)
    }, signal))
  }
  /** Read detached resource metadata without repairing or confirming effects.
   * @param resourceId - stored work-copy identity.
   * @returns detached authoritative domain facts without IO, repair or confirmation.
   */
  read(resourceId: GitResourceId): GitResourceRecord | undefined { return structuredClone(this.findResource(resourceId)?.resource) }
  /** Read the original operation and its resource as a detached observation.
   * @param operationId - stored operation identity.
   * @returns detached observation without executing a recovery step.
   */
  status(operationId: GitOperationId): GitResourceOperationView | undefined { return structuredClone(this.findOperation(operationId)) }
  /** List only operations belonging to the exact opaque consumer scope.
   * @param scope - exact opaque consumer grouping.
   * @returns detached operation/resource views; this query never confirms or replays effects.
   */
  listOperations(scope: GitConsumerScope): readonly GitResourceOperationView[] {
    const result: GitResourceOperationView[] = []
    for (const [, repository] of this.records().entries()) for (const operation of repository.operations) {
      if (operation.consumerScope === scope) result.push(this.requireOperation(operation.operationId))
    }
    return structuredClone(result)
  }

  /** Observe current versioned working bytes without acquiring a write lane or mutating Git/domain facts.
   * @param resourceId - caller-selected managed copy, including one already held by this execution.
   * @param signal - observation cancellation.
   * @returns exact observed hashes and unresolved stages; never a quiet or successful-test claim.
   */
  async inspectWorkCopy(resourceId: GitResourceId, signal: AbortSignal = this.lifetime.signal): Promise<GitWorkCopyInspection> {
    return this.owned(async () => {
      const combined = AbortSignal.any([signal, this.lifetime.signal]), found = this.requireResource(resourceId)
      await this.assertRepository(found.repository.identity, combined)
      const before = await this.verifyResource(found.repository.identity, found.resource, combined)
      const witness = await pathIdentity(found.resource.path), index = join(before.gitDir, 'index')
      await pathIdentity(index)
      const indexHash = byteHash(await readFile(index))
      const inventory = await versionedFiles(this.runner(), found.resource.path, found.repository.identity.commonDir.path,
        combined, this.limits)
      const entries: import('./preview.ts').TreeEntry[] = []
      const captured: { path: string; digest: string; mode: string }[] = []; let total = 0
      for (const path of inventory.files) {
        const observed = await readRegularFile(found.resource.path, path, this.limits.maxFileBytes)
        if ((total += observed.bytes.length) > this.limits.maxTotalBytes) throw new GitResourceError('FILE_LIMIT', 'Work-copy observation exceeds configured total bytes')
        const objectId = (await this.runner().run(['hash-object', '--no-filters', '--stdin'], found.repository.identity.root.path,
          combined, { input: observed.bytes })).stdout.toString('utf8').trim()
        entries.push({ path, mode: observed.mode, objectId, bytes: observed.bytes.length })
        captured.push({ path, digest: byteHash(observed.bytes), mode: observed.mode })
      }
      for (const item of captured) {
        const actual = await readRegularFile(found.resource.path, item.path, this.limits.maxFileBytes)
        if (byteHash(actual.bytes) !== item.digest || actual.mode !== item.mode) throw new GitResourceError('RESOURCE_CHANGED', 'Work-copy bytes or mode changed during pure observation')
      }
      const finalInventory = await versionedFiles(this.runner(), found.resource.path, found.repository.identity.commonDir.path,
        combined, this.limits)
      const final = await this.verifyResource(found.repository.identity, found.resource, combined)
      await pathIdentity(index)
      if (final.head !== before.head || byteHash(await readFile(index)) !== indexHash || hash(finalInventory) !== hash(inventory)
        || hash(await pathIdentity(found.resource.path)) !== hash(witness)
        || this.requireResource(resourceId).resource.revision !== found.resource.revision) {
        throw new GitResourceError('RESOURCE_CHANGED', 'Work-copy identity, HEAD, index or revision changed during pure observation')
      }
      combined.throwIfAborted()
      return { resourceId, resourceRevision: found.resource.revision, pathIdentity: witness, head: before.head, indexHash,
        manifestHash: hash(entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))),
        conflictStages: inventory.conflictStages, unpreservedPaths: inventory.unpreservedPaths }
    })
  }

  /** Preview removal only after full regular-file preservation, without claiming an index/directory backup.
   * @param resourceId - exact owned copy, not a caller-provided filesystem path.
   * @param signal - read-only cancellation.
   * @returns all-content private-ref and directory/index cut; unpreserved content refuses explicitly.
   */
  async previewCleanup(resourceId: GitResourceId, signal: AbortSignal = this.lifetime.signal): Promise<GitResourceCleanupPreview> {
    return this.owned(() => this.readCleanup(resourceId, AbortSignal.any([signal, this.lifetime.signal])))
  }

  /** Remove only this exact preserved owned directory after the Host proves it is no current cwd or known writer.
   * @param request - stable original request and exact earlier full-content preview.
   * @param signal - retained Host occupation cancellation.
   * @param assertUnused - required trusted current-cwd/job/source-detachment proof, never request-authored.
   * @returns actual both-halves-absent receipt; refs/history are retained and partial deletion never blindly repeats.
   */
  async cleanup(request: GitResourceCleanupRequest, signal: AbortSignal,
    assertUnused: () => void): Promise<GitResourceOperationView> {
    const captured = cleanupRequestSchema.parse(request), fingerprint = hash(captured)
    this.validateId(captured.operationId)
    const owned = this.requireResource(captured.resourceId)
    if (captured.originalRequestJson !== undefined) this.validateConsumer(owned.resource.consumerScope, captured.originalRequestJson)
    return this.owned(() => this.lane('operations', async () => this.lane(captured.resourceId, async () => {
      const old = this.findOperation(captured.operationId)
      if (old !== undefined && old.operation.fingerprint !== fingerprint) throw new GitResourceError('OPERATION_CONFLICT', 'Operation identity belongs to another request')
      const combined = AbortSignal.any([signal, this.lifetime.signal]), check = () => { combined.throwIfAborted(); assertUnused() }
      check()
      if (old?.operation.phase === 'confirmed' || old?.operation.phase === 'abandoned') return structuredClone(old)
      let operation = old?.operation
      if (operation === undefined) {
        const preview = await this.readCleanup(captured.resourceId, combined)
        if (preview.fingerprint !== captured.expectedPreviewFingerprint) throw new GitResourceError('PREVIEW_CHANGED', 'Cleanup content or ownership changed after preview')
        check()
        operation = { operationId: captured.operationId, fingerprint, kind: 'cleanup', phase: 'intended', request: captured,
          resourceId: captured.resourceId, repositoryId: owned.repository.identity.repositoryId,
          consumerScope: owned.resource.consumerScope,
          createdAt: new Date().toISOString(), cleanupPreview: preview, externalWriteStarted: false }
        const intent = operation
        await this.records().update(operation.repositoryId, current => ({ ...current, revision: current.revision + 1,
          operations: [...current.operations, intent] }))
      }
      try {
        const preview = operation.cleanupPreview
        if (operation.kind !== 'cleanup' || preview === undefined) throw new GitResourceError('RECORD_INVALID', 'Cleanup has no exact original owned cut')
        if (operation.externalWriteStarted === true) {
          const observation = await this.observeCleanup(operation, combined)
          if (!observation.pathAbsent || !observation.metadataAbsent) {
            throw new GitResourceError('CLEANUP_EFFECT_UNCERTAIN', 'Original directory removal is partial or unknown; it was not repeated')
          }
        } else {
          const fresh = await this.readCleanup(captured.resourceId, combined)
          if (fresh.fingerprint !== preview.fingerprint) throw new GitResourceError('PREVIEW_CHANGED', 'Original cleanup cut changed; no new identity was adopted')
          check()
          await this.save(operation.repositoryId, operation.resourceId, operation.operationId, resource => resource,
            value => ({ ...value, phase: 'acting', externalWriteStarted: true }))
          check()
          // Force is legal only here: every current file is pinned in the exact all-content version and index data is covered.
          await this.runner().run(['worktree', 'remove', '--force', '--', preview.pathIdentity.path], owned.repository.identity.root.path, combined)
        }
        const observation = await this.observeCleanup(operation, combined)
        if (!observation.pathAbsent || !observation.metadataAbsent) throw new GitResourceError('CLEANUP_EFFECT_UNCERTAIN', 'Owned directory or administrative metadata remains; cleanup was not acknowledged')
        check()
        await this.save(operation.repositoryId, operation.resourceId, operation.operationId,
          (resource) => { check(); return { ...resource, revision: resource.revision + 1, state: 'cleaned' } },
          value => ({ ...value, phase: 'confirmed', cleanupObservation: observation }))
        check(); return structuredClone(this.requireOperation(captured.operationId))
      } catch (error) { await this.attention(operation, error); throw error }
    }, signal), signal))
  }

  /** Hold the resource's serial write use until the callback and durable handback settle.
   * @param resourceId - known available work copy.
   * @param identity - caller-owned use id and execution incarnation.
   * @param signal - cancellation propagated to the callback.
   * @param callback - work holding this resource lane; assertCurrent is synchronous for an external CAS.
   * @returns callback result only after successful durable handback; rejected work keeps an explicit attention use.
   */
  async withWriteUse<T>(resourceId: GitResourceId, identity: GitResourceUseIdentity, signal: AbortSignal,
    callback: (scope: GitResourceWriteScope) => Promise<T>): Promise<T> {
    for (const value of [identity.useId, identity.ownerId, identity.epoch]) this.validateId(value)
    return this.owned(() => this.lane(resourceId, async () => {
      const found = this.requireResource(resourceId), resource = found.resource
      if (resource.state !== 'available' && resource.state !== 'preserved' && resource.state !== 'conflicted' || resource.use !== undefined) {
        throw new GitResourceError('RESOURCE_IN_USE', 'Resource has an active or uncertain use; confirm original handback first')
      }
      await this.assertRepository(found.repository.identity, signal)
      await this.verifyResource(found.repository.identity, resource, signal)
      const use = { ...identity, phase: 'held' as const }
      await this.save(found.repository.identity.repositoryId, resourceId, undefined, current => ({ ...current,
        revision: current.revision + 1, use, useHistory: [...current.useHistory, use] }))
      const expected = this.requireResource(resourceId).resource
      this.liveUses.add(resourceId)
      const combined = AbortSignal.any([signal, this.lifetime.signal])
      const assertCurrent = () => {
        combined.throwIfAborted()
        const current = this.requireResource(resourceId).resource
        const witness = lstatSync(current.path)
        for (const expected of [found.repository.identity.root, found.repository.identity.gitDir, found.repository.identity.commonDir]) {
          const actual = lstatSync(expected.path)
          if (actual.isSymbolicLink() || String(actual.dev) !== expected.device || String(actual.ino) !== expected.inode) {
            throw new GitResourceError('REPOSITORY_REPLACED', 'Original repository path identity changed during resource use')
          }
        }
        if (!this.liveUses.has(resourceId) || current.revision !== expected.revision || hash(current.use) !== hash(use)
          || witness.isSymbolicLink() || String(witness.dev) !== current.pathIdentity?.device
          || String(witness.ino) !== current.pathIdentity.inode) {
          throw new GitResourceError('USE_CHANGED', 'Resource use or directory identity changed')
        }
      }
      try {
        assertCurrent()
        const result = await callback({ resource: structuredClone(expected), signal: combined, assertCurrent })
        assertCurrent()
        await this.handbackUse(resourceId, identity, expected.revision, assertCurrent)
        return result
      } catch (error) {
        const current = this.requireResource(resourceId)
        await this.save(current.repository.identity.repositoryId, resourceId, undefined,
          value => ({ ...value, revision: value.revision + 1, use: { ...use, phase: 'needs_attention' } }))
        throw error
      } finally { this.liveUses.delete(resourceId) }
    }, signal))
  }
  /** Explicit Host handback of a live or cold uncertain use; no model-authored quiet claim is accepted.
   * @param resourceId - held work copy.
   * @param identity - exact original owner/use/epoch.
   * @param expectedRevision - current resource CAS.
   * @param assertQuiescent - synchronous trusted caller proof checked at the durable transform.
   */
  async confirmQuietUse(resourceId: GitResourceId, identity: GitResourceUseIdentity, expectedRevision: number,
    assertQuiescent: () => void): Promise<void> {
    if (this.liveUses.has(resourceId)) throw new GitResourceError('RESOURCE_IN_USE', 'Original live callback still owns this resource use')
    return this.owned(() => this.lane(resourceId, () => this.handbackUse(resourceId, identity, expectedRevision, assertQuiescent)))
  }
  private async handbackUse(resourceId: GitResourceId, identity: GitResourceUseIdentity, expectedRevision: number,
    assertQuiescent: () => void): Promise<void> {
    const found = this.requireResource(resourceId)
    await this.save(found.repository.identity.repositoryId, resourceId, undefined, (current) => {
      assertQuiescent()
      if (current.revision !== expectedRevision || current.use?.useId !== identity.useId || current.use.ownerId !== identity.ownerId
        || current.use.epoch !== identity.epoch) throw new GitResourceError('USE_CHANGED', 'Original resource use no longer matches')
      const { use, ...rest } = current
      return { ...rest, revision: current.revision + 1, useHistory: [...current.useHistory, { ...use, phase: 'released' }] }
    })
  }

  /** Preserve one exact resource version as immutable file-content and Git-ref facts.
   * @param request - exact available resource revision and stable operation identity.
   * @param signal - operation cancellation.
   * @returns immutable versioned code seal by default; explicit all-content mode is directory preservation, not a code result.
   */
  async preserve(request: GitResourcePreserveRequest, signal: AbortSignal = this.lifetime.signal): Promise<GitResourceOperationView> {
    this.validateId(request.operationId)
    if (request.originalRequestJson !== undefined) this.validateConsumer(this.requireResource(request.resourceId).resource.consumerScope,
      request.originalRequestJson)
    const content = request.content ?? 'versioned'
    const captured: GitResourcePreserveRequest & { readonly content: 'versioned' | 'all' } = { ...structuredClone(request), content }
    const fingerprint = hash(captured)
    if (this.requireResource(request.resourceId).resource.use !== undefined) throw new GitResourceError('RESOURCE_IN_USE', 'Preservation cannot race an active or uncertain use')
    return this.owned(() => this.lane('operations', async () => {
      const old = this.findOperation(request.operationId)
      if (old !== undefined) {
        if (old.operation.fingerprint !== fingerprint) throw new GitResourceError('OPERATION_CONFLICT', 'Operation identity belongs to another request')
        return this.finishPreserve(old.operation, signal)
      }
      const found = this.requireResource(request.resourceId)
      if (found.resource.revision !== request.expectedRevision || found.resource.use !== undefined) throw new GitResourceError('RESOURCE_IN_USE', 'Resource changed or retains an unsettled use')
      const operation: GitResourceOperation = { operationId: request.operationId, fingerprint, resourceId: request.resourceId,
        repositoryId: found.repository.identity.repositoryId, consumerScope: found.resource.consumerScope,
        kind: 'preserve', phase: 'intended', request: captured, createdAt: new Date().toISOString() }
      await this.records().update(operation.repositoryId, current => ({ ...current, revision: current.revision + 1,
        operations: [...current.operations, operation] }))
      return this.finishPreserve(operation, signal)
    }, signal))
  }

  private async readResolution(selection: GitIntegrationResolutionSelection,
    signal: AbortSignal): Promise<GitIntegrationResolutionPreview> {
    const integrated = this.requireOperation(selection.integrationOperationId)
    const sealed = this.requireOperation(selection.preserveOperationId), integration = integrated.operation.integrationEffect
    const seal = sealed.operation, resource = this.requireResource(integrated.resource.resourceId)
    if (integrated.operation.kind !== 'integrate' && integrated.operation.kind !== 'inverse'
      || integrated.operation.phase !== 'confirmed' || integration?.result !== 'conflicted'
      || integrated.operation.consumerScope !== selection.consumerScope || sealed.operation.consumerScope !== selection.consumerScope
      || seal.kind !== 'preserve' || seal.phase !== 'confirmed' || seal.effectContent !== 'versioned'
      || seal.resourceId !== integrated.resource.resourceId || seal.effectIntegrationOperationId !== selection.integrationOperationId
      || seal.effectTree === undefined || seal.effectCommit === undefined
      || seal.effectManifestHash === undefined || seal.effectRef === undefined
      || seal.effectHead === undefined || (seal.effectConflictStages?.length ?? 0) > 0 || resource.resource.use !== undefined) {
      throw new GitResourceError('RESOLUTION_VERSION_UNAVAILABLE', 'Resolution requires the exact quiet versioned seal of this original conflicted integration')
    }
    const conflictIds = integrationConflictIds(integration)
    if (new Set(selection.confirmedConflictIds).size !== selection.confirmedConflictIds.length
      || hash([...selection.confirmedConflictIds].sort()) !== hash(conflictIds)
      || hash([...(seal.effectUnresolvedConflictIds ?? [])].sort()) !== hash(conflictIds)) {
      throw new GitResourceError('RESOLUTION_CONFLICT_SELECTION', 'Resolution must explicitly cover every known conflict of this exact integration')
    }
    const observed = await this.inspectWorkCopy(resource.resource.resourceId, signal)
    if (observed.head !== seal.effectHead) throw new GitResourceError('RESOLUTION_VERSION_CHANGED', 'Working HEAD changed after the selected seal; seal a fresh version')
    const ref = await this.runner().text(['rev-parse', '--verify', seal.effectRef], resource.repository.identity.root.path, signal)
    const tree = await this.runner().text(['rev-parse', `${ref}^{tree}`], resource.repository.identity.root.path, signal)
    const entries = await treeEntries(this.runner(), resource.repository.identity, tree, signal, this.limits)
    if (ref !== seal.effectCommit || tree !== seal.effectTree || hash(entries) !== seal.effectManifestHash) {
      throw new GitResourceError('RESOLUTION_VERSION_CHANGED', 'Selected immutable seal differs from its observed reference or manifest')
    }
    if (observed.manifestHash !== seal.effectManifestHash || observed.conflictStages.length > 0
      || observed.resourceRevision !== resource.resource.revision
      || this.requireResource(resource.resource.resourceId).resource.use !== undefined) {
      throw new GitResourceError('RESOLUTION_VERSION_CHANGED', 'Current quiet working version or index differs from the selected immutable seal')
    }
    signal.throwIfAborted()
    const value = { request: structuredClone(selection), effect: { integrationOperationId: selection.integrationOperationId,
      preserveOperationId: selection.preserveOperationId, resourceId: resource.resource.resourceId,
      tree: seal.effectTree, manifestHash: seal.effectManifestHash, conflictIds },
    resourceRevision: observed.resourceRevision, head: observed.head, indexHash: observed.indexHash }
    return { ...value, fingerprint: hash(value) }
  }

  private async applicationSource(selection: GitApplicationPreviewRequest, signal: AbortSignal): Promise<GitApplicationSource> {
    const origin = this.requireOperation(selection.integrationOperationId), version = this.requireOperation(selection.preserveOperationId)
    const effect = origin.operation.integrationEffect, seal = version.operation
    if (origin.operation.kind !== 'integrate' && origin.operation.kind !== 'inverse'
      || origin.operation.phase !== 'confirmed' || effect === undefined || effect.remainingSourceOperationIds.length !== 0
      || origin.operation.consumerScope !== selection.consumerScope || seal.consumerScope !== selection.consumerScope
      || seal.kind !== 'preserve' || seal.phase !== 'confirmed' || seal.resourceId !== origin.resource.resourceId
      || seal.effectIntegrationOperationId !== origin.operation.operationId || seal.effectContent !== 'versioned'
      || (seal.effectConflictStages?.length ?? 0) > 0 || seal.effectCommit === undefined || seal.effectTree === undefined
      || seal.effectManifestHash === undefined || seal.effectRef === undefined) {
      throw new GitResourceError('APPLICATION_SOURCE_UNAVAILABLE', 'Application requires a complete exact versioned integration/inverse seal in this consumer scope')
    }
    const conflicts = integrationConflictIds(effect)
    if (hash(conflicts) !== hash([...(seal.effectUnresolvedConflictIds ?? [])].sort())) {
      throw new GitResourceError('APPLICATION_SOURCE_UNAVAILABLE', 'Selected seal does not describe the original integration conflicts exactly')
    }
    if (selection.resolutionOperationId !== undefined || conflicts.length > 0) {
      const resolution = selection.resolutionOperationId === undefined ? undefined
        : this.requireOperation(selection.resolutionOperationId).operation
      const proof = resolution?.resolutionEffect
      if (resolution?.kind !== 'resolve' || resolution.phase !== 'confirmed' || resolution.consumerScope !== selection.consumerScope
        || proof === undefined || proof.integrationOperationId !== origin.operation.operationId
        || proof.preserveOperationId !== seal.operationId || proof.resourceId !== seal.resourceId
        || proof.tree !== seal.effectTree || proof.manifestHash !== seal.effectManifestHash
        || hash([...proof.conflictIds].sort()) !== hash(conflicts)) {
        throw new GitResourceError('APPLICATION_SOURCE_UNRESOLVED', 'Conflicted application requires an explicitly selected exact Host resolution receipt')
      }
    }
    const repository = this.requireResource(origin.resource.resourceId).repository.identity
    await this.assertRepository(repository, signal)
    const ref = await this.runner().text(['rev-parse', '--verify', seal.effectRef], repository.root.path, signal)
    const tree = await this.runner().text(['rev-parse', `${ref}^{tree}`], repository.root.path, signal)
    if (ref !== seal.effectCommit || tree !== seal.effectTree
      || hash(await treeEntries(this.runner(), repository, tree, signal, this.limits)) !== seal.effectManifestHash) {
      throw new GitResourceError('APPLICATION_VERSION_CHANGED', 'Exact application seal no longer matches its immutable reference/manifest')
    }
    return { repository, integrationOperationId: origin.operation.operationId, preserveOperationId: seal.operationId,
      resourceId: seal.resourceId, consumerScope: seal.consumerScope, originalTargetBaseTree: effect.originalTargetBaseTree,
      resultCommit: seal.effectCommit, resultTree: seal.effectTree, manifestHash: seal.effectManifestHash,
      ...selection.resolutionOperationId === undefined ? {} : { resolutionOperationId: selection.resolutionOperationId } }
  }

  private async readCleanup(resourceId: GitResourceId, signal: AbortSignal): Promise<GitResourceCleanupPreview> {
    const found = this.requireResource(resourceId), resource = found.resource
    if (resource.state === 'cleaned' || resource.state === 'abandoned' || resource.use !== undefined || this.liveUses.has(resourceId)) {
      throw new GitResourceError('RESOURCE_IN_USE', 'Missing/retired/current or uncertain resource use cannot be cleaned')
    }
    const preserved = found.repository.operations.find(value => value.resourceId === resourceId && value.kind === 'preserve'
      && value.phase === 'confirmed' && value.effectContent === 'all' && value.effectRef === resource.preservedRef)
    if (preserved?.effectTree === undefined || preserved.effectCommit === undefined || preserved.effectRef === undefined
      || preserved.effectManifestHash === undefined || preserved.effectHead === undefined
      || (preserved.unpreservedPaths?.length ?? 0) > 0 || (preserved.effectConflictStages?.length ?? 0) > 0) {
      throw new GitResourceError('CLEANUP_UNPRESERVED', 'Cleanup requires an exact all-file preservation without remaining directories or unresolved index data')
    }
    await this.assertRepository(found.repository.identity, signal)
    await this.assertManagedDirectory('workcopies')
    const metadata = await this.verifyResource(found.repository.identity, resource, signal)
    if (metadata.head !== preserved.effectHead) throw new GitResourceError('CLEANUP_UNPRESERVED', 'Current detached HEAD is not the preserved version')
    const root = found.repository.identity.root.path
    const ref = await this.runner().text(['rev-parse', '--verify', preserved.effectRef], root, signal)
    const tree = await this.runner().text(['rev-parse', `${ref}^{tree}`], root, signal)
    const parent = await this.runner().text(['rev-parse', `${ref}^`], root, signal)
    const entries = await treeEntries(this.runner(), found.repository.identity, tree, signal, this.limits)
    if (ref !== preserved.effectCommit || tree !== preserved.effectTree || parent !== metadata.head
      || hash(entries) !== preserved.effectManifestHash) throw new GitResourceError('CLEANUP_UNPRESERVED', 'Preservation reference or parent changed; no full-content backup was proved')
    const inventory = await this.preservationFiles(found.repository.identity, resource, 'all', signal)
    if (inventory.unpreservedPaths.length > 0 || inventory.conflictStages.length > 0
      || hash(inventory.files) !== hash(entries.map(entry => entry.path).sort())) {
      throw new GitResourceError('CLEANUP_UNPRESERVED', 'Current files, empty directories or unresolved index data are not fully preserved')
    }
    const captured: { path: string; digest: string; mode: string }[] = []
    for (const entry of entries) {
      const actual = await readRegularFile(resource.path, entry.path, this.limits.maxFileBytes)
      const bytes = (await this.runner().run(['cat-file', 'blob', entry.objectId], root, signal)).stdout
      if (!actual.bytes.equals(bytes) || actual.mode !== entry.mode) throw new GitResourceError('CLEANUP_UNPRESERVED', 'Current file content or mode differs from its preservation')
      captured.push({ path: entry.path, digest: byteHash(actual.bytes), mode: actual.mode })
    }
    const index = join(metadata.gitDir, 'index'); await pathIdentity(index)
    const indexHash = byteHash(await readFile(index))
    const headEntries = await treeEntries(this.runner(), found.repository.identity, metadata.head, signal, this.limits)
    const pinned = new Set([...entries, ...headEntries].map(entry => `${entry.mode}\0${entry.objectId}`))
    for (const row of (await this.runner().text(['ls-files', '--stage', '-z'], resource.path, signal)).split('\0').filter(Boolean)) {
      const [mode, objectId, stage] = row.slice(0, row.indexOf('\t')).split(' ')
      if (stage !== '0' || !pinned.has(`${mode}\0${objectId}`)) {
        throw new GitResourceError('CLEANUP_INDEX_UNPRESERVED', 'Index contains unresolved or distinct staged content not covered by pinned file versions')
      }
    }
    for (const item of captured) {
      const actual = await readRegularFile(resource.path, item.path, this.limits.maxFileBytes)
      if (byteHash(actual.bytes) !== item.digest || actual.mode !== item.mode) throw new GitResourceError('CLEANUP_UNPRESERVED', 'File changed while checking full preservation')
    }
    const final = await this.verifyResource(found.repository.identity, resource, signal)
    await pathIdentity(index)
    if (final.head !== metadata.head || byteHash(await readFile(index)) !== indexHash
      || hash(await this.preservationFiles(found.repository.identity, resource, 'all', signal)) !== hash(inventory)
      || this.requireResource(resourceId).resource.revision !== resource.revision) {
      throw new GitResourceError('CLEANUP_UNPRESERVED', 'Full content/index/identity cut changed during cleanup preview')
    }
    signal.throwIfAborted()
    const value = { resourceId, resourceRevision: resource.revision, pathIdentity: await pathIdentity(resource.path),
      gitDirIdentity: await pathIdentity(metadata.gitDir), preserveOperationId: preserved.operationId,
      commit: preserved.effectCommit, tree: preserved.effectTree, manifestHash: preserved.effectManifestHash,
      ref: preserved.effectRef, head: metadata.head, indexHash }
    return { ...value, fingerprint: hash(value) }
  }

  private async observeCleanup(operation: GitResourceOperation, signal: AbortSignal): Promise<GitResourceCleanupObservation> {
    const preview = operation.cleanupPreview, found = this.requireResource(operation.resourceId)
    if (preview === undefined) throw new GitResourceError('RECORD_INVALID', 'Original cleanup has no exact path/admin identities')
    await this.assertRepository(found.repository.identity, signal)
    if (found.resource.use !== undefined || this.liveUses.has(operation.resourceId)) throw new GitResourceError('RESOURCE_IN_USE', 'Cleanup cannot settle current or uncertain use')
    const absent = async (expected: import('./types.ts').GitPathIdentity) => {
      try {
        if (hash(await pathIdentity(expected.path)) !== hash(expected)) throw new GitResourceError('RESOURCE_REPLACED', 'Original removal path or metadata identity was replaced; nothing was deleted')
        return false
      } catch (error) { if (!missing(error)) throw error; return true }
    }
    const pathAbsent = await absent(preview.pathIdentity), metadataAbsent = await absent(preview.gitDirIdentity)
    if (metadataAbsent) {
      const records = await this.runner().text(['worktree', 'list', '--porcelain', '-z'], found.repository.identity.root.path, signal)
      if (records.split('\0').includes(`worktree ${preview.pathIdentity.path}`)) throw new GitResourceError('CLEANUP_EFFECT_UNCERTAIN', 'Different administrative metadata still names the original path')
    }
    return { pathAbsent, metadataAbsent }
  }

  private async finishApplication(operation: GitResourceOperation, signal: AbortSignal,
    assertAuthorized: () => void): Promise<GitResourceOperationView> {
    return this.lane(operation.resourceId, async () => {
      const combined = AbortSignal.any([signal, this.lifetime.signal]), check = () => { combined.throwIfAborted(); assertAuthorized() }
      const preview = operation.applicationPreview
      if (operation.kind !== 'apply' || preview === undefined) throw new GitResourceError('RECORD_INVALID', 'Application intent has no exact target/version cut')
      try {
        await this.assertRepository(preview.target.repository, combined)
        check()
        if (operation.phase === 'confirmed') return structuredClone(this.requireOperation(operation.operationId))
        const observed = await observeApplication(this.runner(), preview, combined, this.limits)
        if (observed.state === 'partial' || observed.state === 'unknown'
          || observed.state === 'after' && operation.externalWriteStarted !== true && preview.target.touched.length > 0) {
          throw new GitResourceError('APPLICATION_EFFECT_UNCERTAIN', 'Partial, unknown or unattributed target effects are not replayed; inspect and prepare a fresh explicit plan')
        }
        let effect: import('./application.ts').GitApplicationEffect
        if (observed.state === 'after') effect = { preview, observation: observed }
        else {
          const request = operation.request
          if (!('targetWorkspaceId' in request && 'integrationOperationId' in request)) throw new GitResourceError('RECORD_INVALID', 'Application intent request is invalid')
          const fresh = await this.previewApplication({ consumerScope: operation.consumerScope,
            integrationOperationId: request.integrationOperationId, preserveOperationId: request.preserveOperationId,
            targetWorkspaceId: request.targetWorkspaceId,
            ...request.resolutionOperationId === undefined ? {} : { resolutionOperationId: request.resolutionOperationId } }, combined)
          if (fresh.fingerprint !== preview.fingerprint) throw new GitResourceError('APPLICATION_TARGET_CHANGED', 'Original application cut changed; no fresh target was adopted')
          check()
          await this.save(operation.repositoryId, operation.resourceId, operation.operationId, resource => resource,
            current => ({ ...current, phase: 'acting', externalWriteStarted: true }))
          const repository = preview.source.repository, prefix = `refs/dsh-resources/${operation.resourceId}/applications/${hash(operation.operationId)}`
          await this.writeRef(repository.root.path, `${prefix}/before`, preview.source.originalTargetBaseTree,
            repository.objectFormat, combined, check)
          await this.writeRef(repository.root.path, `${prefix}/after`, preview.source.resultCommit, repository.objectFormat, combined, check)
          effect = await applyApplication(this.runner(), preview, { signal: combined, assertCurrent: check }, this.limits)
        }
        check()
        const completedEffect = effect
        await this.save(operation.repositoryId, operation.resourceId, operation.operationId,
          (resource) => { check(); return resource },
          current => ({ ...current, phase: 'confirmed', applicationEffect: completedEffect, applicationObservation: completedEffect.observation }))
        check(); return structuredClone(this.requireOperation(operation.operationId))
      } catch (error) {
        await this.attention(operation, error)
        throw error
      }
    }, signal)
  }

  private async finishCreate(operation: GitResourceOperation, signal: AbortSignal): Promise<GitResourceOperationView> {
    return this.lane(operation.resourceId, () => this.finishCreateLocked(operation, signal), signal)
  }
  private async finishCreateLocked(operation: GitResourceOperation, signal: AbortSignal): Promise<GitResourceOperationView> {
    const found = this.requireResource(operation.resourceId), preview = operation.preview
    if (preview?.repository === undefined || preview.baseCommit === undefined || preview.baseTree === undefined) throw new GitResourceError('RECORD_INVALID', 'Creation intent has no complete baseline observation')
    const combined = AbortSignal.any([signal, this.lifetime.signal]), root = found.repository.identity.root.path
    try {
      await this.assertRepository(found.repository.identity, combined)
      const git = this.runner()
      if (operation.phase === 'confirmed') {
        await this.verifyResource(found.repository.identity, found.resource, combined)
        return structuredClone(this.requireOperation(operation.operationId))
      }
      if (found.resource.use !== undefined) throw new GitResourceError('RESOURCE_IN_USE', 'Creation reconciliation cannot race an existing use')
      await this.save(operation.repositoryId, operation.resourceId, operation.operationId, resource => resource,
        current => ({ ...current, phase: 'acting' }))
      let commit = operation.effectCommit, tree = operation.effectTree
      if (commit === undefined || tree === undefined) {
        const priorRef = await git.run(['rev-parse', '--verify', found.resource.privateRef], root, combined, { allowFailure: true })
        const alreadyPinned = priorRef.status === 0
        if (!alreadyPinned) {
          const refreshed = await this.preview(preview.request, combined)
          if (refreshed.fingerprint !== preview.fingerprint) throw new GitResourceError('PREVIEW_CHANGED', 'Baseline source changed before its first external effect')
        }
        await this.assertManagedDirectory('scratch')
        await this.save(operation.repositoryId, operation.resourceId, operation.operationId, resource => resource,
          current => ({ ...current, externalWriteStarted: true }))
        combined.throwIfAborted()
        const scratch = await mkdtemp(join(this.root, 'scratch', 'baseline-'))
        try {
          const env = { GIT_INDEX_FILE: join(scratch, 'index') }
          await git.run(['read-tree', preview.baseCommit], root, combined, { env })
          for (const entry of preview.selected) {
            if (entry.mode === 'deleted') await git.run(['update-index', '--force-remove', '--', entry.path], root, combined, { env })
            else {
              let objectId = entry.objectId
              if (entry.source !== 'index' && !alreadyPinned) {
                const { bytes, mode } = await readRegularFile(root, entry.path, this.limits.maxFileBytes)
                if (byteHash(bytes) !== entry.rawHash || mode !== entry.mode) {
                  throw new GitResourceError('PREVIEW_CHANGED', 'Selected source bytes or mode changed before object creation')
                }
                objectId = (await git.run(['hash-object', '-w', '--no-filters', '--stdin'], root, combined, { input: bytes })).stdout.toString('utf8').trim()
              }
              if (objectId === undefined) throw new GitResourceError('RECORD_INVALID', 'Selected input has no immutable object identity')
              await git.run(['update-index', '--add', '--cacheinfo', `${entry.mode},${objectId},${entry.path}`], root, combined, { env })
            }
          }
          tree = await git.text(['write-tree'], root, combined, env)
          commit = preview.request.baseline.kind === 'commit' ? preview.baseCommit : await this.commitTree(root, tree, preview.baseCommit, operation, combined)
          await this.writeRef(root, found.resource.privateRef, commit, found.repository.identity.objectFormat, combined)
          const effectCommit = commit, effectTree = tree
          await this.save(operation.repositoryId, operation.resourceId, operation.operationId,
            resource => ({ ...resource, revision: resource.revision + 1, baselineCommit: effectCommit, baselineTree: effectTree }),
            current => ({ ...current, effectCommit, effectTree }))
        } finally { await rm(scratch, { recursive: true, force: true }) }
      }
      const latest = this.requireResource(operation.resourceId).resource
      try {
        await lstat(latest.path)
        if (this.status(operation.operationId)?.operation.worktreeCreateStarted !== true) throw new GitResourceError('RESOURCE_UNKNOWN', 'Reserved path appeared before this operation started creation')
      } catch (error) {
        if (!missing(error)) throw error
        if (latest.pathIdentity !== undefined) throw new GitResourceError('RESOURCE_MISSING', 'Previously observed work-copy path disappeared; it was not recreated')
        await this.save(operation.repositoryId, operation.resourceId, operation.operationId, resource => resource,
          current => ({ ...current, worktreeCreateStarted: true }))
        await this.assertManagedDirectory('workcopies')
        await git.run(['worktree', 'add', '--detach', '--no-checkout', latest.path, commit], root, combined)
      }
      await this.verifyResource(found.repository.identity, this.requireResource(operation.resourceId).resource, combined, true)
      const createdIdentity = await pathIdentity(latest.path)
      await this.save(operation.repositoryId, operation.resourceId, undefined,
        resource => ({ ...resource, revision: resource.revision + 1, pathIdentity: createdIdentity }))
      await this.initializeResourceIndex(found.repository.identity, this.requireResource(operation.resourceId).resource, combined)
      await this.materialize(found.repository.identity, this.requireResource(operation.resourceId).resource, combined)
      const witness = await pathIdentity(latest.path)
      await this.save(operation.repositoryId, operation.resourceId, operation.operationId,
        resource => ({ ...resource, revision: resource.revision + 1, state: 'available', pathIdentity: witness }),
        current => ({ ...current, phase: 'confirmed' }))
      return structuredClone(this.requireOperation(operation.operationId))
    } catch (error) { await this.attention(operation, error); throw error }
  }
  private async finishPreserve(operation: GitResourceOperation, signal: AbortSignal): Promise<GitResourceOperationView> {
    return this.lane(operation.resourceId, () => this.finishPreserveLocked(operation, signal), signal)
  }
  private async finishIntegration(operation: GitResourceOperation, signal: AbortSignal,
    assertCurrent: () => void): Promise<GitResourceOperationView> {
    return this.lane(operation.resourceId, async () => {
      const combined = AbortSignal.any([signal, this.lifetime.signal]), check = () => { combined.throwIfAborted(); assertCurrent() }
      const found = this.requireResource(operation.resourceId), preview = operation.integrationPreview, inverse = operation.inversePreview
      if (operation.kind !== 'integrate' && operation.kind !== 'inverse'
        || preview === undefined && inverse === undefined) throw new GitResourceError('RECORD_INVALID', 'Integration/inverse intent has no immutable input observation')
      try {
        await this.assertRepository(found.repository.identity, combined)
        if (operation.phase === 'confirmed') {
          await this.verifyResource(found.repository.identity, found.resource, combined)
          check(); return structuredClone(this.requireOperation(operation.operationId))
        }
        if (found.resource.use !== undefined) throw new GitResourceError('RESOURCE_IN_USE', 'Integration creation cannot race an unsettled use')
        check()
        await this.save(operation.repositoryId, operation.resourceId, operation.operationId, resource => resource,
          current => ({ ...current, phase: 'acting' }))
        let effect = operation.integrationEffect
        if (effect === undefined) {
          if (operation.kind === 'inverse' && inverse !== undefined) {
            const fresh = await this.previewInverse({ consumerScope: operation.consumerScope,
              applicationOperationId: inverse.applicationOperationId,
              targetWorkspaceId: inverse.currentTarget.repository.workspaceId }, combined)
            if (fresh.fingerprint !== inverse.fingerprint) throw new GitResourceError('PREVIEW_CHANGED', 'Current inverse target changed before preparation')
            await this.assertManagedDirectory('scratch'); check()
            await this.save(operation.repositoryId, operation.resourceId, operation.operationId, resource => resource,
              current => ({ ...current, externalWriteStarted: true }))
            effect = await prepareInverseObjects(this.runner(), inverse, operation.operationId, operation.createdAt,
              join(this.root, 'scratch'), { signal: combined, assertCurrent: check }, this.limits)
          } else if (preview !== undefined) {
            const fresh = await this.previewIntegration(preview.request, combined)
            if (fresh.fingerprint !== preview.fingerprint) throw new GitResourceError('PREVIEW_CHANGED', 'Immutable integration inputs changed before merge')
            check()
            await this.save(operation.repositoryId, operation.resourceId, operation.operationId, resource => resource,
              current => ({ ...current, externalWriteStarted: true }))
            effect = await mergeIntegration(this.runner(), preview, operation.operationId, operation.createdAt,
              { signal: combined, assertCurrent: check }, this.limits)
          } else throw new GitResourceError('RECORD_INVALID', 'Preparation intent has no complete input cut')
          check()
          const observedEffect = effect
          await this.save(operation.repositoryId, operation.resourceId, operation.operationId,
            resource => ({ ...resource, revision: resource.revision + 1, baselineCommit: observedEffect.commit,
              baselineTree: observedEffect.tree }),
            current => ({ ...current, integrationEffect: observedEffect, effectCommit: observedEffect.commit,
              effectTree: observedEffect.tree, effectManifestHash: observedEffect.manifestHash }))
        }
        check()
        await this.writeRef(found.repository.identity.root.path, found.resource.privateRef, effect.commit,
          found.repository.identity.objectFormat, combined, check)
        const latest = this.requireResource(operation.resourceId).resource
        try {
          await lstat(latest.path)
          if (this.status(operation.operationId)?.operation.worktreeCreateStarted !== true) throw new GitResourceError('RESOURCE_UNKNOWN', 'Reserved integration path appeared before original creation began')
        } catch (error) {
          if (!missing(error)) throw error
          if (latest.pathIdentity !== undefined) throw new GitResourceError('RESOURCE_MISSING', 'Original integration path disappeared and was not recreated')
          check()
          await this.save(operation.repositoryId, operation.resourceId, operation.operationId, resource => resource,
            current => ({ ...current, worktreeCreateStarted: true }))
          await this.assertManagedDirectory('workcopies')
          check()
          await this.runner().run(['worktree', 'add', '--detach', '--no-checkout', latest.path, effect.commit], found.repository.identity.root.path, combined)
        }
        await this.verifyResource(found.repository.identity, this.requireResource(operation.resourceId).resource, combined, true)
        const witness = await pathIdentity(latest.path)
        check()
        await this.save(operation.repositoryId, operation.resourceId, undefined,
          resource => ({ ...resource, revision: resource.revision + 1, pathIdentity: witness }))
        await this.initializeResourceIndex(found.repository.identity, this.requireResource(operation.resourceId).resource,
          combined, check, effect)
        await this.materialize(found.repository.identity, this.requireResource(operation.resourceId).resource, combined, check)
        await materializeIntegrationIndex(this.runner(), found.repository.identity, this.requireResource(operation.resourceId).resource,
          effect, { signal: combined, assertCurrent: check }, this.limits)
        check()
        await this.save(operation.repositoryId, operation.resourceId, operation.operationId,
          (resource) => {
            check()
            return { ...resource, revision: resource.revision + 1, state: effect.result === 'conflicted' ? 'conflicted' : 'available' }
          },
          current => ({ ...current, phase: 'confirmed', effectRef: found.resource.privateRef }))
        check(); return structuredClone(this.requireOperation(operation.operationId))
      } catch (error) { await this.attention(operation, error); throw error }
    }, signal)
  }
  private async finishPreserveLocked(operation: GitResourceOperation, signal: AbortSignal): Promise<GitResourceOperationView> {
    if (operation.phase === 'confirmed') return structuredClone(this.requireOperation(operation.operationId))
    const found = this.requireResource(operation.resourceId), combined = AbortSignal.any([signal, this.lifetime.signal])
    if (found.resource.use !== undefined) throw new GitResourceError('RESOURCE_IN_USE', 'Preservation cannot settle an active or uncertain resource use')
    try {
      await this.assertRepository(found.repository.identity, combined)
      const observed = await this.verifyResource(found.repository.identity, found.resource, combined)
      await this.save(operation.repositoryId, operation.resourceId, operation.operationId, resource => resource,
        current => ({ ...current, phase: 'acting' }))
      const content = 'expectedRevision' in operation.request ? operation.request.content : undefined
      if (content === undefined) throw new GitResourceError('RECORD_INVALID', 'Preservation intent has no content mode')
      const integration = found.repository.operations.find(value => value.resourceId === operation.resourceId
        && (value.kind === 'integrate' || value.kind === 'inverse'))
      const effectIntegrationOperationId = operation.effectIntegrationOperationId ?? integration?.operationId
      const unresolved = operation.effectUnresolvedConflictIds
        ?? (integration?.integrationEffect === undefined ? [] : integrationConflictIds(integration.integrationEffect))
      let tree = operation.effectTree, commit = operation.effectCommit, unpreservedPaths = operation.unpreservedPaths ?? []
      let conflictStages = operation.effectConflictStages ?? []
      const head = operation.effectHead ?? observed.head
      const root = found.repository.identity.root.path
      if (tree === undefined || commit === undefined) {
        const prior = await this.runner().run(['rev-parse', '--verify', this.preservedRef(operation)], root, combined, { allowFailure: true })
        if (prior.status === 0) throw new GitResourceError('PRESERVATION_UNKNOWN', 'Preserved reference exists without its original observed effect; no new seal was created')
        await this.assertManagedDirectory('scratch')
        const scratch = await mkdtemp(join(this.root, 'scratch', 'preserve-'))
        try {
          const env = { GIT_INDEX_FILE: join(scratch, 'index') }
          await this.runner().run(['read-tree', '--empty'], root, combined, { env })
          const inventory = await this.preservationFiles(found.repository.identity, found.resource, content, combined)
          const { files } = inventory; unpreservedPaths = inventory.unpreservedPaths
          conflictStages = inventory.conflictStages
          const captured: { path: string; digest: string; mode: string }[] = []
          let total = 0
          for (const path of files) {
            const { bytes, mode } = await readRegularFile(found.resource.path, path, this.limits.maxFileBytes)
            if ((total += bytes.length) > this.limits.maxTotalBytes) throw new GitResourceError('FILE_LIMIT', 'Preservation exceeds configured byte bounds')
            const objectId = (await this.runner().run(['hash-object', '-w', '--no-filters', '--stdin'], root, combined, { input: bytes })).stdout.toString('utf8').trim()
            await this.runner().run(['update-index', '--add', '--cacheinfo', `${mode},${objectId},${path}`], root, combined, { env })
            captured.push({ path, digest: byteHash(bytes), mode })
          }
          if (hash(inventory) !== hash(await this.preservationFiles(found.repository.identity, found.resource, content, combined))) {
            throw new GitResourceError('RESOURCE_CHANGED', 'Work-copy code or remaining-path inventory changed during preservation')
          }
          for (const item of captured) {
            const observed = await readRegularFile(found.resource.path, item.path, this.limits.maxFileBytes)
            if (byteHash(observed.bytes) !== item.digest || observed.mode !== item.mode) {
              throw new GitResourceError('RESOURCE_CHANGED', 'Work-copy content or mode changed during preservation')
            }
          }
          tree = await this.runner().text(['write-tree'], root, combined, env)
          const finalObserved = await this.verifyResource(found.repository.identity, found.resource, combined)
          if (finalObserved.head !== head) throw new GitResourceError('RESOURCE_CHANGED', 'Detached HEAD changed during preservation')
          commit = await this.commitTree(root, tree, head, operation, combined)
          const effectTree = tree, effectCommit = commit
          await this.save(operation.repositoryId, operation.resourceId, operation.operationId, resource => resource,
            current => ({ ...current, effectTree, effectCommit, effectHead: head, effectContent: content,
              effectConflictStages: conflictStages, effectUnresolvedConflictIds: unresolved, unpreservedPaths,
              ...effectIntegrationOperationId === undefined ? {} : { effectIntegrationOperationId } }))
        } finally { await rm(scratch, { recursive: true, force: true }) }
      }
      const preservedRef = this.preservedRef(operation)
      await this.writeRef(root, preservedRef, commit, found.repository.identity.objectFormat, combined)
      const manifestHash = hash(await treeEntries(this.runner(), found.repository.identity, tree, combined, this.limits))
      await this.save(operation.repositoryId, operation.resourceId, operation.operationId,
        (resource) => {
          const { resolutionOperationId: _oldResolution, resolvedPreserveOperationId: _oldVersion, ...rest } = resource
          return { ...rest, revision: resource.revision + 1,
            state: conflictStages.length === 0 && unresolved.length === 0 ? 'preserved' : 'conflicted',
            preservedCommit: commit, preservedTree: tree, preservedManifestHash: manifestHash, preservedRef,
            preservedHead: head, preservedContent: content, preservedConflictStages: conflictStages,
            unresolvedConflictIds: unresolved, unpreservedPaths,
            ...effectIntegrationOperationId === undefined ? {} : { preservedIntegrationOperationId: effectIntegrationOperationId } }
        },
        current => ({ ...current, phase: 'confirmed', effectManifestHash: manifestHash, effectRef: preservedRef,
          effectContent: content, effectConflictStages: conflictStages, effectUnresolvedConflictIds: unresolved, unpreservedPaths,
          ...effectIntegrationOperationId === undefined ? {} : { effectIntegrationOperationId } }))
      return structuredClone(this.requireOperation(operation.operationId))
    } catch (error) { await this.attention(operation, error); throw error }
  }

  private preservedRef(operation: GitResourceOperation): string {
    return `refs/dsh-resources/${operation.resourceId}/preserved/${hash(operation.operationId)}`
  }
  /** Observe original reserved evidence only; this method never creates objects, refs, directories or working bytes. */
  private async reconcileObserved(view: GitResourceOperationView, signal: AbortSignal): Promise<GitResourceOperationView> {
    const operation = view.operation, found = this.requireResource(operation.resourceId)
    if (operation.kind === 'integrate' || operation.kind === 'inverse') return this.reconcileIntegration(operation, signal)
    if (operation.kind === 'apply') return this.reconcileApplication(operation, signal)
    if (operation.kind === 'cleanup') return this.reconcileCleanup(operation, signal)
    if (operation.kind === 'resolve') return structuredClone(this.requireOperation(operation.operationId))
    const combined = AbortSignal.any([signal, this.lifetime.signal]), identity = found.repository.identity, root = identity.root.path
    try {
      await this.assertRepository(identity, combined)
      const ref = operation.kind === 'create' ? found.resource.privateRef : this.preservedRef(operation)
      const observed = await this.runner().run(['rev-parse', '--verify', ref], root, combined, { allowFailure: true })
      if (observed.status !== 0) throw new GitResourceError('EFFECT_NOT_OBSERVED', 'Original external effect is not present; explicit retry is required')
      const commit = observed.stdout.toString('utf8').trim()
      const tree = await this.runner().text(['rev-parse', `${commit}^{tree}`], root, combined)
      if (operation.effectCommit !== undefined && operation.effectCommit !== commit
        || operation.effectTree !== undefined && operation.effectTree !== tree) {
        throw new GitResourceError('PRIVATE_REF_CONFLICT', 'Observed private reference differs from the original effect')
      }
      if (operation.kind === 'create' && operation.effectCommit === undefined) {
        const preview = operation.preview
        if (preview?.baseCommit === undefined) throw new GitResourceError('RECORD_INVALID', 'Original creation has no immutable baseline cut')
        if (preview.request.baseline.kind === 'commit' && commit !== preview.baseCommit) throw new GitResourceError('PRIVATE_REF_CONFLICT', 'Original baseline commit does not match')
        const originalEntries = await treeEntries(this.runner(), identity, preview.baseCommit, combined, this.limits)
        const expected = new Map(originalEntries.map(entry => [entry.path, entry]))
        for (const entry of preview.selected) {
          if (entry.mode === 'deleted') expected.delete(entry.path)
          else if (entry.objectId !== undefined) expected.set(entry.path,
            { path: entry.path, mode: entry.mode, objectId: entry.objectId, bytes: entry.bytes })
          else throw new GitResourceError('RECORD_INVALID', 'Original selected content has no immutable object identity')
        }
        const actual = await treeEntries(this.runner(), identity, tree, combined, this.limits)
        const observedHash = hash(actual.toSorted((a, b) => a.path.localeCompare(b.path)))
        if (observedHash !== hash([...expected.values()].sort((a, b) => a.path.localeCompare(b.path)))) {
          throw new GitResourceError('PRIVATE_REF_CONFLICT', 'Observed tree differs from the original selected baseline')
        }
      } else if (operation.kind === 'preserve' && operation.effectCommit === undefined) {
        throw new GitResourceError('PRESERVATION_UNKNOWN', 'Original preserved effect was never recorded; no fresh seal was attempted')
      }
      const resource = { ...found.resource, baselineCommit: found.resource.baselineCommit ?? commit,
        baselineTree: found.resource.baselineTree ?? tree }
      await this.verifyResource(identity, resource, combined, operation.kind === 'create' && operation.phase !== 'confirmed')
      if (operation.phase === 'confirmed') return structuredClone(this.requireOperation(operation.operationId))
      if (operation.kind === 'create') {
        if (operation.worktreeCreateStarted !== true) throw new GitResourceError('RESOURCE_UNKNOWN', 'Original operation did not start work-copy creation')
        const entries = await treeEntries(this.runner(), identity, tree, combined, this.limits), files = await this.files(resource.path)
        if (hash(files) !== hash(entries.map(entry => entry.path).sort())) throw new GitResourceError('EFFECT_PARTIAL', 'Original work-copy materialization is incomplete; reconciliation did not write files')
        for (const entry of entries) {
          const { bytes, mode } = await readRegularFile(resource.path, entry.path, this.limits.maxFileBytes)
          const blob = (await this.runner().run(['cat-file', 'blob', entry.objectId], root, combined)).stdout
          if (!bytes.equals(blob) || mode !== entry.mode) throw new GitResourceError('RESOURCE_CHANGED', 'Observed work-copy bytes or modes do not match the original baseline')
        }
      }
      const pathWitness = await pathIdentity(resource.path)
      const manifestHash = hash(await treeEntries(this.runner(), identity, tree, combined, this.limits))
      combined.throwIfAborted()
      await this.save(operation.repositoryId, operation.resourceId, operation.operationId,
        (value) => {
          if (operation.kind === 'create') return { ...value, revision: value.revision + 1, baselineCommit: commit, baselineTree: tree,
            pathIdentity: pathWitness, state: value.state === 'preserved' ? 'preserved' : 'available' }
          const { resolutionOperationId: _oldResolution, resolvedPreserveOperationId: _oldVersion,
            preservedIntegrationOperationId: _oldIntegration, ...rest } = value
          return { ...rest, revision: value.revision + 1, preservedCommit: commit, preservedTree: tree,
            preservedManifestHash: manifestHash, preservedRef: ref,
            ...operation.effectContent === undefined ? {} : { preservedContent: operation.effectContent },
            ...operation.effectHead === undefined ? {} : { preservedHead: operation.effectHead },
            ...operation.unpreservedPaths === undefined ? {} : { unpreservedPaths: operation.unpreservedPaths },
            ...operation.effectConflictStages === undefined ? {} : { preservedConflictStages: operation.effectConflictStages },
            ...operation.effectIntegrationOperationId === undefined ? {}
              : { preservedIntegrationOperationId: operation.effectIntegrationOperationId },
            unresolvedConflictIds: operation.effectUnresolvedConflictIds ?? [],
            state: operation.effectConflictStages?.length || operation.effectUnresolvedConflictIds?.length ? 'conflicted' : 'preserved' }
        },
        value => ({ ...value, phase: 'confirmed', effectCommit: commit, effectTree: tree,
          ...operation.kind === 'preserve' ? { effectManifestHash: manifestHash, effectRef: ref } : {} }))
      return structuredClone(this.requireOperation(operation.operationId))
    } catch (error) {
      await this.attention(operation, error)
      return structuredClone(this.requireOperation(operation.operationId))
    }
  }

  private async reconcileIntegration(operation: GitResourceOperation, signal: AbortSignal): Promise<GitResourceOperationView> {
    const found = this.requireResource(operation.resourceId), effect = operation.integrationEffect
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    try {
      if (effect === undefined) throw new GitResourceError('EFFECT_NOT_OBSERVED', 'Original integration effect was not recorded; explicit retry is required')
      await this.assertRepository(found.repository.identity, combined)
      const ref = await this.runner().text(['rev-parse', '--verify', found.resource.privateRef], found.repository.identity.root.path, combined)
      const tree = await this.runner().text(['rev-parse', `${ref}^{tree}`], found.repository.identity.root.path, combined)
      const manifestHash = hash(await treeEntries(this.runner(), found.repository.identity, tree, combined, this.limits))
      if (ref !== effect.commit || tree !== effect.tree || manifestHash !== effect.manifestHash) {
        throw new GitResourceError('PRIVATE_REF_CONFLICT', 'Observed integration reference differs from its exact recorded version')
      }
      await this.verifyResource(found.repository.identity, found.resource, combined, operation.phase !== 'confirmed')
      if (operation.phase === 'confirmed') return structuredClone(this.requireOperation(operation.operationId))
      if (found.resource.use !== undefined || operation.worktreeCreateStarted !== true) {
        throw new GitResourceError('RESOURCE_UNKNOWN', 'Integration has an unsettled use or no original work-copy creation witness')
      }
      const entries = await treeEntries(this.runner(), found.repository.identity, effect.tree, combined, this.limits)
      if (hash(await this.files(found.resource.path)) !== hash(entries.map(entry => entry.path).sort())) {
        throw new GitResourceError('EFFECT_PARTIAL', 'Original integration materialization is incomplete; reconciliation did not write files')
      }
      for (const entry of entries) {
        const observed = await readRegularFile(found.resource.path, entry.path, this.limits.maxFileBytes)
        const bytes = (await this.runner().run(['cat-file', 'blob', entry.objectId], found.repository.identity.root.path, combined)).stdout
        if (!observed.bytes.equals(bytes) || observed.mode !== entry.mode) throw new GitResourceError('RESOURCE_CHANGED', 'Integration working bytes or mode differ from the original observed effect')
      }
      await verifyIntegrationIndex(this.runner(), found.repository.identity, found.resource, effect, combined, this.limits)
      combined.throwIfAborted()
      const witness = await pathIdentity(found.resource.path)
      await this.save(operation.repositoryId, operation.resourceId, operation.operationId,
        resource => ({ ...resource, revision: resource.revision + 1, pathIdentity: witness,
          state: effect.result === 'conflicted' ? 'conflicted' : 'available' }),
        current => ({ ...current, phase: 'confirmed', effectRef: found.resource.privateRef }))
      return structuredClone(this.requireOperation(operation.operationId))
    } catch (error) {
      await this.attention(operation, error)
      return structuredClone(this.requireOperation(operation.operationId))
    }
  }

  private async reconcileApplication(operation: GitResourceOperation, signal: AbortSignal): Promise<GitResourceOperationView> {
    const preview = operation.applicationPreview, combined = AbortSignal.any([signal, this.lifetime.signal])
    try {
      if (preview === undefined) throw new GitResourceError('RECORD_INVALID', 'Application intent has no original target cut')
      await this.assertRepository(preview.target.repository, combined)
      const observation = await observeApplication(this.runner(), preview, combined, this.limits)
      if (operation.phase === 'confirmed') return structuredClone(this.requireOperation(operation.operationId))
      combined.throwIfAborted()
      const completed = observation.state === 'after' && (operation.externalWriteStarted === true || preview.target.touched.length === 0)
      await this.save(operation.repositoryId, operation.resourceId, operation.operationId, resource => resource,
        current => ({ ...current, phase: completed ? 'confirmed' : 'needs_attention', applicationObservation: observation,
          ...completed ? { applicationEffect: { preview, observation } }
            : { diagnostic: 'Observed original target without replay; before/partial/unknown outcomes require explicit action' } }))
      return structuredClone(this.requireOperation(operation.operationId))
    } catch (error) {
      await this.attention(operation, error)
      return structuredClone(this.requireOperation(operation.operationId))
    }
  }

  private async reconcileCleanup(operation: GitResourceOperation, signal: AbortSignal): Promise<GitResourceOperationView> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    try {
      const observation = await this.observeCleanup(operation, combined)
      if (operation.phase === 'confirmed') return structuredClone(this.requireOperation(operation.operationId))
      const completed = operation.externalWriteStarted === true && observation.pathAbsent && observation.metadataAbsent
      combined.throwIfAborted()
      await this.save(operation.repositoryId, operation.resourceId, operation.operationId,
        resource => completed ? { ...resource, revision: resource.revision + 1, state: 'cleaned' } : resource,
        value => ({ ...value, phase: completed ? 'confirmed' : 'needs_attention', cleanupObservation: observation,
          ...completed ? {} : { diagnostic: 'Cleanup is unstarted, partial or unknown; reconciliation did not delete anything' } }))
      return structuredClone(this.requireOperation(operation.operationId))
    } catch (error) {
      await this.attention(operation, error)
      return structuredClone(this.requireOperation(operation.operationId))
    }
  }

  private async assertRepository(identity: GitRepositoryIdentity, signal: AbortSignal): Promise<void> {
    await this.ensureGit(signal)
    const workspace = this.ctx.workspaceRegistry.get(identity.workspaceId)
    if (workspace === undefined) throw new GitResourceError('WORKSPACE_NOT_FOUND', 'Original project Workspace is no longer registered')
    const actual = await inspectRepository(this.runner(), workspace.path, workspace.id, this.isolation, this.home, signal)
    if (hash(actual) !== hash(identity)) throw new GitResourceError('REPOSITORY_REPLACED', 'Original repository identity was moved or replaced')
  }
  private async verifyResource(identity: GitRepositoryIdentity, resource: GitResourceRecord, signal: AbortSignal,
    requireBaseline = false): Promise<{ head: string; gitDir: string }> {
    await this.ensureGit(signal)
    const witness = await pathIdentity(resource.path)
    if (resource.pathIdentity !== undefined && hash(witness) !== hash(resource.pathIdentity)) throw new GitResourceError('RESOURCE_REPLACED', 'Managed work-copy directory was replaced')
    const marker = join(resource.path, '.git'), info = await lstat(marker)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new GitResourceError('RESOURCE_UNKNOWN', 'Existing reserved path is not its managed Git work copy')
    const named = (await readFile(marker, 'utf8')).trim()
    if (!named.startsWith('gitdir: ')) throw new GitResourceError('RESOURCE_UNKNOWN', 'Reserved work-copy marker is invalid')
    const gitDir = await pathIdentity(resolve(resource.path, named.slice(8)))
    if (!gitDir.path.startsWith(`${identity.commonDir.path}/worktrees/`)) throw new GitResourceError('RESOURCE_UNKNOWN', 'Work-copy metadata belongs to another repository')
    for (const file of ['commondir', 'gitdir']) {
      const metadata = join(gitDir.path, file), info = await lstat(metadata)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new GitResourceError('RESOURCE_UNKNOWN', 'Work-copy reciprocal metadata is not a bounded local file')
    }
    const commonDir = await pathIdentity(resolve(gitDir.path, (await readFile(join(gitDir.path, 'commondir'), 'utf8')).trim()))
    if (hash(commonDir) !== hash(identity.commonDir)) throw new GitResourceError('RESOURCE_UNKNOWN', 'Work-copy common directory differs from its original repository')
    const reciprocal = await readFile(join(gitDir.path, 'gitdir'), 'utf8')
    if (resolve(gitDir.path, reciprocal.trim()) !== resolve(marker)) throw new GitResourceError('RESOURCE_UNKNOWN', 'Work-copy metadata does not point to the reserved directory')
    await inspectConfiguration(this.runner(), identity.commonDir.path, gitDir.path, this.isolation, signal)
    const branch = await this.runner().run(['symbolic-ref', '--quiet', 'HEAD'], resource.path, signal, { allowFailure: true })
    if (branch.status !== 1) throw new GitResourceError('RESOURCE_ATTACHED', 'Managed work-copy HEAD is not detached; its branch was not changed')
    const head = await this.runner().text(['rev-parse', '--verify', 'HEAD^{commit}'], resource.path, signal)
    if (requireBaseline && head !== resource.baselineCommit) throw new GitResourceError('RESOURCE_CHANGED', 'Creation work-copy HEAD no longer matches its reserved baseline')
    return { head, gitDir: gitDir.path }
  }
  private async materialize(identity: GitRepositoryIdentity, resource: GitResourceRecord, signal: AbortSignal,
    assertCurrent: () => void = () => {}): Promise<void> {
    const entries = await treeEntries(this.runner(), identity, this.requireBaseline(resource).tree, signal, this.limits)
    const known = new Set(entries.map(entry => entry.path)), existing = await this.files(resource.path)
    if (existing.some(path => !known.has(path))) throw new GitResourceError('RESOURCE_UNKNOWN', 'Reserved work copy contains unknown files; none were deleted')
    for (const entry of entries) {
      signal.throwIfAborted()
      const bytes = (await this.runner().run(['cat-file', 'blob', entry.objectId], identity.root.path, signal)).stdout
      if (bytes.length !== entry.bytes) throw new GitResourceError('RESOURCE_CHANGED', 'Baseline blob bytes differ from the bounded immutable manifest')
      const path = await selectedPath(resource.path, entry.path)
      try {
        const present = await readRegularFile(resource.path, entry.path, this.limits.maxFileBytes)
        if (!present.bytes.equals(bytes) || present.mode !== entry.mode) {
          throw new GitResourceError('RESOURCE_CHANGED', 'Existing work-copy bytes or modes differ from the reserved baseline')
        }
      } catch (error) {
        if (!missing(error)) throw error
        signal.throwIfAborted(); assertCurrent()
        await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
        signal.throwIfAborted(); assertCurrent()
        const handle = await open(path, 'wx', entry.mode === '100755' ? 0o755 : 0o644)
        try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        await chmod(path, entry.mode === '100755' ? 0o755 : 0o644)
      }
    }
  }
  private async initializeResourceIndex(identity: GitRepositoryIdentity, resource: GitResourceRecord, signal: AbortSignal,
    assertCurrent: () => void = () => {}, integrationEffect?: import('./integration.ts').GitIntegrationEffect): Promise<void> {
    const index = resolve(resource.path, await this.runner().text(['rev-parse', '--git-path', 'index'], resource.path, signal))
    try {
      await pathIdentity(index)
      const actual = await this.runner().text(['ls-files', '--stage', '-z'], resource.path, signal)
      if (integrationEffect !== undefined && actual.split('\0').some(row => /^[^\t]+ [123]\t/u.test(row))) {
        await materializeIntegrationIndex(this.runner(), identity, resource, integrationEffect, { signal, assertCurrent }, this.limits)
        return
      }
      const expected = (await treeEntries(this.runner(), identity, this.requireBaseline(resource).tree, signal, this.limits))
        .map(entry => `${entry.mode} ${entry.objectId} 0\t${entry.path}`).sort()
      if (hash(actual.split('\0').filter(Boolean).sort()) !== hash(expected)) {
        throw new GitResourceError('RESOURCE_INDEX_CHANGED', 'Managed work-copy index does not match the original creation baseline; it was not reset')
      }
    } catch (error) {
      if (!missing(error)) throw error
      signal.throwIfAborted(); assertCurrent()
      await this.runner().run(['read-tree', this.requireBaseline(resource).commit], resource.path, signal)
    }
  }
  private async preservationFiles(identity: GitRepositoryIdentity, resource: GitResourceRecord,
    content: 'versioned' | 'all', signal: AbortSignal): Promise<{ files: string[]; unpreservedPaths: string[]; conflictStages: readonly GitIntegrationConflictStage[] }> {
    const versioned = await versionedFiles(this.runner(), resource.path, identity.commonDir.path, signal, this.limits)
    if (content === 'versioned') return versioned
    const emptyDirectories: string[] = [], files = await this.files(resource.path, '', emptyDirectories)
    return { files, unpreservedPaths: emptyDirectories.sort(), conflictStages: versioned.conflictStages }
  }
  private async files(root: string, prefix = '', emptyDirectories?: string[]): Promise<string[]> {
    const result: string[] = []
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      if (prefix === '' && entry.name === '.git') continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      await selectedPath(root, path)
      if (entry.isDirectory()) {
        const nested = await this.files(root, path, emptyDirectories)
        if (nested.length === 0) emptyDirectories?.push(`${path}/`)
        result.push(...nested)
      }
      else if (entry.isFile()) result.push(path)
      else throw new GitResourceError('TREE_ENTRY_UNSUPPORTED', 'Work copy contains a symbolic link or unsupported file')
      if (result.length > this.limits.maxFiles || (emptyDirectories?.length ?? 0) > this.limits.maxFiles) {
        throw new GitResourceError('MANIFEST_LIMIT', 'Work-copy file/directory count exceeds its configured limit')
      }
    }
    return result.sort()
  }
  private async commitTree(root: string, tree: string, parent: string, operation: GitResourceOperation,
    signal: AbortSignal): Promise<string> {
    const result = await this.runner().run(['commit-tree', tree, '-p', parent, '-m', `DSH resource ${operation.operationId}`], root, signal,
      { env: { GIT_AUTHOR_NAME: 'DSH resource owner', GIT_AUTHOR_EMAIL: 'resource@dsh.invalid', GIT_COMMITTER_NAME: 'DSH resource owner',
        GIT_COMMITTER_EMAIL: 'resource@dsh.invalid', GIT_AUTHOR_DATE: operation.createdAt, GIT_COMMITTER_DATE: operation.createdAt } })
    return result.stdout.toString('utf8').trim()
  }
  private async writeRef(root: string, ref: string, commit: string, format: 'sha1' | 'sha256', signal: AbortSignal,
    assertCurrent: () => void = () => {}): Promise<void> {
    const old = await this.runner().run(['rev-parse', '--verify', ref], root, signal, { allowFailure: true })
    if (old.status === 0) {
      if (old.stdout.toString('utf8').trim() !== commit) throw new GitResourceError('PRIVATE_REF_CONFLICT', 'Managed preservation reference has an unknown version')
      return
    }
    signal.throwIfAborted(); assertCurrent()
    await this.runner().run(['update-ref', ref, commit, '0'.repeat(format === 'sha1' ? 40 : 64)], root, signal)
  }
  private async attention(operation: GitResourceOperation, error: unknown): Promise<void> {
    if (this.requireOperation(operation.operationId).operation.phase === 'confirmed') return
    await this.save(operation.repositoryId, operation.resourceId, operation.operationId,
      resource => operation.kind === 'apply' || operation.kind === 'resolve'
        || this.requireOperation(operation.operationId).operation.externalWriteStarted === false ? resource
        : { ...resource, revision: resource.revision + 1, state: 'needs_attention' },
      current => ({ ...current, phase: 'needs_attention', diagnostic: error instanceof GitResourceError ? error.message : 'Resource action needs explicit observation' }))
  }
  private async save(repositoryId: GitRepositoryId, resourceId: GitResourceId, operationId: GitOperationId | undefined,
    resource: (value: GitResourceRecord) => GitResourceRecord,
    operation?: (value: GitResourceOperation) => GitResourceOperation): Promise<void> {
    await this.records().update(repositoryId, current => ({ ...current, revision: current.revision + 1,
      resources: current.resources.map(value => value.resourceId === resourceId ? resource(value) : value),
      operations: current.operations.map(value => value.operationId === operationId && operation !== undefined
        ? operation(value) : value) }))
  }
  private findResource(id: GitResourceId): { repository: RepositoryRecord; resource: GitResourceRecord } | undefined {
    for (const [, repository] of this.records().entries()) {
      const resource = repository.resources.find(resource => resource.resourceId === id)
      if (resource !== undefined) return { repository, resource }
    }
    return undefined
  }
  private requireResource(id: GitResourceId) {
    const found = this.findResource(id)
    if (found === undefined) throw new GitResourceError('RESOURCE_NOT_FOUND', 'Managed Git resource does not exist')
    return found
  }
  private findOperation(id: GitOperationId): GitResourceOperationView | undefined {
    for (const [, repository] of this.records().entries()) {
      // The domain decoder rejects an operation without its matching resource before publishing this aggregate.
      for (const resource of repository.resources) {
        const operation = repository.operations.find(value => value.operationId === id && value.resourceId === resource.resourceId)
        if (operation !== undefined) return { operation, resource }
      }
    }
    return undefined
  }
  private requireOperation(id: GitOperationId): GitResourceOperationView {
    const found = this.findOperation(id)
    if (found === undefined) throw new GitResourceError('OPERATION_NOT_FOUND', 'Resource operation does not exist')
    return found
  }
  private requireBaseline(resource: GitResourceRecord): { commit: string; tree: string } {
    if (resource.baselineCommit === undefined || resource.baselineTree === undefined) {
      throw new GitResourceError('RECORD_INVALID', 'Managed resource has no confirmed baseline version')
    }
    return { commit: resource.baselineCommit, tree: resource.baselineTree }
  }
  private records() {
    if (this.table === undefined) throw new GitResourceError('OWNER_CLOSED', 'Git resource owner is unavailable')
    return this.table
  }
  private runner() {
    // Every caller has awaited ensureGit directly or through assertRepository/verifyResource; close never clears this capability.
    return this.git as ResourceGit
  }
  private async ensureGit(signal: AbortSignal): Promise<ResourceGit> {
    signal.throwIfAborted()
    await this.assertManagedDirectory('isolated')
    const empty = await lstat(join(this.isolation, 'empty-config'))
    if (!empty.isFile() || empty.isSymbolicLink() || empty.size !== 0) throw new GitResourceError('RESOURCE_HOME_INVALID', 'Git configuration isolation was replaced')
    if (this.git !== undefined) return this.git
    const resolve = this.resolvingGit ??= (async () => {
      try {
        const executable = await this.ctx.subprocess.resolveExecutable(this.config.gitExecutable ?? 'git', undefined, this.lifetime.signal)
        this.lifetime.signal.throwIfAborted()
        return this.git = new ResourceGit(this.ctx.subprocess, executable, this.isolation, this.limits)
      } catch (error) {
        if (error instanceof SubprocessExecutableNotFoundError) {
          throw new GitResourceError('GIT_UNAVAILABLE', 'Git executable is unavailable; isolated Git mode was not started')
        }
        throw error
      }
    })()
    try { const runner = await resolve; signal.throwIfAborted(); return runner }
    finally { if (this.resolvingGit === resolve) this.resolvingGit = undefined }
  }
  private validateId(value: string): void {
    if (!/^[a-zA-Z0-9:_-]+$/.test(value) || Buffer.byteLength(value, 'utf8') > 128) throw new GitResourceError('IDENTITY_INVALID', 'Resource operation/use identities require bounded simple characters')
  }
  private async assertManagedDirectory(name: string): Promise<void> {
    const expected = this.managedDirectories.get(name)
    if (expected === undefined || hash(await pathIdentity(join(this.root, name))) !== hash(expected)) {
      throw new GitResourceError('RESOURCE_HOME_INVALID', 'Managed resource directory was replaced or moved')
    }
  }
  private validateConsumer(scope: GitConsumerScope, originalRequestJson: string): void {
    if (!scope || Buffer.byteLength(scope, 'utf8') > 256 || scope.includes('\0')
      || Buffer.byteLength(originalRequestJson, 'utf8') > (this.config.maxConsumerRequestBytes ?? 128 * 1024)) {
      throw new GitResourceError('CONSUMER_REQUEST_INVALID', 'Consumer scope or original request exceeds its configured bound')
    }
    try { JSON.parse(originalRequestJson) } catch (_invalidConsumerJson) {
      throw new GitResourceError('CONSUMER_REQUEST_INVALID', 'Original consumer request must be valid JSON')
    }
  }
  private owned<T>(action: () => Promise<T>): Promise<T> {
    this.lifetime.signal.throwIfAborted()
    const job = Promise.resolve().then(action)
    this.jobs.add(job)
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job))
    return job
  }
  private async lane<T>(key: string, action: () => Promise<T>, signal: AbortSignal = this.lifetime.signal): Promise<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal]), entered = Promise.withResolvers<undefined>()
    const previous = this.lanes.get(key) ?? Promise.resolve(), job = previous.then(() => {
      combined.throwIfAborted(); entered.resolve(undefined)
      return action()
    })
    const tail = job.then(() => {}, () => {})
    this.lanes.set(key, tail)
    const aborted = Promise.withResolvers<never>(), stop = () => { aborted.reject(combined.reason) }
    combined.addEventListener('abort', stop, { once: true })
    try {
      combined.throwIfAborted()
      await Promise.race([entered.promise, aborted.promise])
      combined.removeEventListener('abort', stop)
      return await job
    } finally {
      combined.removeEventListener('abort', stop)
      if (this.lanes.get(key) === tail) void tail.then(() => { if (this.lanes.get(key) === tail) this.lanes.delete(key) })
    }
  }
  private async close(): Promise<void> {
    this.lifetime.abort(new GitResourceError('OWNER_CLOSED', 'Git resource owner closed'))
    const drained = (async () => {
      await Promise.allSettled([...this.jobs])
      await this.domain?.close()
      await this.homeLease?.release()
    })()
    const timeout = this.config.closeTimeoutMs ?? 10_000
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([drained, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new GitResourceError('OWNER_DRAIN_TIMEOUT', 'Owner did not quiesce; its kernel lease remains held until admitted work settles'))
        }, timeout)
      })])
    } finally { clearTimeout(timer) }
  }
}
export default GitResources
