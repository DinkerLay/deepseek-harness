/** Schema-validated single-repository aggregate and stable request hashing. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { GitRepositoryId, GitResourceId, GitOperationId, GitConsumerScope, GitRepositoryIdentity, GitResourceRecord, GitResourceOperation } from './types.ts'
import { integrationConflictStageSchema, integrationEffectSchema, integrationPreviewSchema, integrationRequestSchema,
  integrationResolutionEffectSchema, integrationResolutionPreviewSchema, integrationResolutionRequestSchema } from './integration.ts'
import { applicationObservationSchema, applicationRequestSchema, applicationSchemas, inverseRequestSchema } from './application.ts'
import { cleanupObservationSchema, cleanupPreviewSchema, cleanupRequestSchema } from './cleanup.ts'
export { hash } from './json-hash.ts'

/** One repository's serially updated resource/use/operation facts. */
export interface RepositoryRecord {
  readonly revision: number
  readonly identity: GitRepositoryIdentity
  readonly resources: readonly GitResourceRecord[]
  readonly operations: readonly GitResourceOperation[]
}
const id = z.string().min(1)
const repositoryId = id.transform(value => brandString<GitRepositoryId>(value))
const resourceId = id.transform(value => brandString<GitResourceId>(value))
const operationId = id.transform(value => brandString<GitOperationId>(value))
const workspaceId = id.transform(value => brandString<WorkspaceId>(value))
const consumerScope = id.transform(value => brandString<GitConsumerScope>(value))
const originalJson = z.string().refine((value) => {
  try { JSON.parse(value); return true } catch (_invalidJson) { return false }
}, 'original consumer request is not JSON')
const pathIdentity = z.object({ path: id, device: id, inode: id }).strict()
const repository = z.object({ repositoryId, workspaceId, root: pathIdentity, gitDir: pathIdentity,
  commonDir: pathIdentity, objectFormat: z.enum(['sha1', 'sha256']) }).strict()
const baseline = z.discriminatedUnion('kind', [z.object({ kind: z.literal('commit'), commit: id }).strict(),
  z.object({ kind: z.literal('selected'), baseCommit: id, paths: z.array(z.object({ path: id,
    source: z.enum(['index', 'worktree', 'untracked']) }).strict()) }).strict()])
const create = z.object({ operationId, consumerScope, originalRequestJson: originalJson, workspaceId,
  baseline, expectedPreviewFingerprint: id }).strict()
const preserve = z.object({ operationId, resourceId, expectedRevision: z.number().int().positive(),
  content: z.enum(['versioned', 'all']), originalRequestJson: originalJson.optional() }).strict()
const use = z.object({ useId: id, ownerId: id, epoch: id, phase: z.enum(['held', 'needs_attention', 'released']) }).strict()
const resource = z.object({ resourceId, repositoryId, consumerScope, revision: z.number().int().positive(),
  path: id, reservedAbsent: z.literal(true),
  pathIdentity: pathIdentity.optional(), privateRef: id, baselineCommit: id.optional(), baselineTree: id.optional(),
  state: z.enum(['reserved', 'available', 'conflicted', 'preserved', 'needs_attention', 'abandoned', 'cleaned']), preservedCommit: id.optional(),
  preservedTree: id.optional(), preservedManifestHash: id.optional(), preservedRef: id.optional(),
  preservedHead: id.optional(),
  preservedContent: z.enum(['versioned', 'all']).optional(),
  preservedConflictStages: z.array(z.lazy(() => integrationConflictStageSchema)).optional(), unpreservedPaths: z.array(id).optional(),
  preservedIntegrationOperationId: operationId.optional(), unresolvedConflictIds: z.array(id).optional(),
  resolutionOperationId: operationId.optional(), resolvedPreserveOperationId: operationId.optional(),
  use: use.optional(), useHistory: z.array(use) }).strict()
const preview = z.object({ request: z.object({ workspaceId, baseline }).strict(), permitted: z.boolean(),
  diagnostic: z.string().optional(), risks: z.array(z.string()), repository: repository.optional(), head: id.optional(),
  symbolicRef: id.optional(), indexHash: id.optional(), baseCommit: id.optional(), baseTree: id.optional(),
  dirty: z.object({ staged: z.array(id), unstaged: z.array(id), untracked: z.array(id), unmerged: z.array(id) }).strict(),
  selected: z.array(z.object({ path: id, source: z.enum(['index', 'worktree', 'untracked']),
    mode: z.enum(['100644', '100755', 'deleted']), objectId: id.optional(), rawHash: id.optional(),
    bytes: z.number().int().nonnegative() }).strict()), fingerprint: id }).strict()
const operation = z.object({ operationId, fingerprint: id,
  kind: z.enum(['create', 'preserve', 'integrate', 'resolve', 'apply', 'inverse', 'cleanup']),
  resourceId, repositoryId, consumerScope, phase: z.enum(['intended', 'acting', 'needs_attention', 'confirmed', 'failed', 'abandoned']),
  request: z.union([create, preserve, z.lazy(() => integrationRequestSchema), z.lazy(() => integrationResolutionRequestSchema),
    z.lazy(() => applicationRequestSchema), z.lazy(() => inverseRequestSchema), z.lazy(() => cleanupRequestSchema)]),
  createdAt: id, preview: preview.optional(),
  integrationPreview: z.lazy(() => integrationPreviewSchema(repository)).optional(),
  integrationEffect: z.lazy(() => integrationEffectSchema).optional(), effectCommit: id.optional(),
  resolutionPreview: z.lazy(() => integrationResolutionPreviewSchema).optional(),
  resolutionEffect: z.lazy(() => integrationResolutionEffectSchema).optional(),
  applicationPreview: z.lazy(() => applicationSchemas(repository).preview).optional(),
  applicationEffect: z.lazy(() => applicationSchemas(repository).effect).optional(),
  applicationObservation: applicationObservationSchema.optional(),
  inversePreview: z.lazy(() => applicationSchemas(repository).inversePreview).optional(),
  cleanupPreview: z.lazy(() => cleanupPreviewSchema).optional(), cleanupObservation: cleanupObservationSchema.optional(),
  effectTree: id.optional(), effectManifestHash: id.optional(), effectRef: id.optional(), worktreeCreateStarted: z.literal(true).optional(),
  externalWriteStarted: z.boolean().optional(),
  effectContent: z.enum(['versioned', 'all']).optional(), effectHead: id.optional(), unpreservedPaths: z.array(id).optional(),
  effectConflictStages: z.array(z.lazy(() => integrationConflictStageSchema)).optional(),
  effectIntegrationOperationId: operationId.optional(), effectUnresolvedConflictIds: z.array(id).optional(),
  diagnostic: z.string().optional() }).strict()
/** Authoritative malformed records reject the entire domain; none are silently skipped. */
export const repositorySchema = z.object({ revision: z.number().int().positive(), identity: repository,
  resources: z.array(resource), operations: z.array(operation) }).strict().superRefine((record, context) => {
  const resources = new Map(record.resources.map(value => [value.resourceId, value]))
  const operationCount = new Set(record.operations.map(value => value.operationId)).size
  if (resources.size !== record.resources.length || operationCount !== record.operations.length) {
    context.addIssue({ code: 'custom', message: 'resource operation identity is duplicated' })
  }
  for (const value of record.resources) if (value.repositoryId !== record.identity.repositoryId) {
    context.addIssue({ code: 'custom', message: 'resource belongs to another repository' })
  }
  for (const value of record.operations) {
    const owned = resources.get(value.resourceId)
    if (owned === undefined || owned.consumerScope !== value.consumerScope || value.repositoryId !== record.identity.repositoryId) {
      context.addIssue({ code: 'custom', message: 'operation resource ownership does not match' })
    }
  }
}) as z.ZodType<RepositoryRecord>
/** Durable resource owner domain, independent of Session logs. */
export const gitResourceDomain = defineDomain({ name: 'git_resources', version: 1,
  tables: { repositories: domainTable<GitRepositoryId, RepositoryRecord>(repositorySchema) } })
