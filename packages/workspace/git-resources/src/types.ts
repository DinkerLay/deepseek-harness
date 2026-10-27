/** Host resource facts; no collaboration roles or task vocabulary. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { GitIntegrationConflictStage, GitIntegrationEffect, GitIntegrationPreview, GitIntegrationRequest,
  GitIntegrationResolutionEffect, GitIntegrationResolutionPreview, GitIntegrationResolutionRequest } from './integration.ts'
import type { GitApplicationEffect, GitApplicationObservation, GitApplicationPreview, GitApplicationRequest,
  GitInversePreview, GitInverseRequest } from './application.ts'
import type { GitResourceCleanupObservation, GitResourceCleanupPreview, GitResourceCleanupRequest } from './cleanup.ts'
export type { GitIntegrationPreviewRequest, GitIntegrationRequest, GitIntegrationInput, GitIntegrationPreview,
  GitIntegrationConflictStage, GitIntegrationConflictMessage, GitIntegrationEffect, GitIntegrationResolutionSelection,
  GitIntegrationResolutionRequest, GitIntegrationResolutionEffect, GitIntegrationResolutionPreview } from './integration.ts'
export type { GitApplicationSource, GitApplicationWritten, GitApplicationPreviewRequest, GitApplicationRequest, GitApplicationTargetCut,
  GitApplicationPreview, GitApplicationObservation, GitApplicationEffect, GitInversePreviewRequest,
  GitInverseRequest, GitInversePreview } from './application.ts'
export type { GitResourceCleanupObservation, GitResourceCleanupPreview, GitResourceCleanupRequest } from './cleanup.ts'

/** One observed canonical local repository. */
export type GitRepositoryId = Branded<'GitRepositoryId'>
/** One managed local work copy, independent of its current user. */
export type GitResourceId = Branded<'GitResourceId'>
/** One caller-reserved durable operation identity. */
export type GitOperationId = Branded<'GitOperationId'>
/** Opaque consumer-owned grouping; the resource owner does not interpret its business identity. */
export type GitConsumerScope = Branded<'GitConsumerScope'>

/** Exact filesystem witness, meaningful only on the current host. */
export interface GitPathIdentity { readonly path: string; readonly device: string; readonly inode: string }
/** Repository identity does not confuse a moved branch with a replaced repository. */
export interface GitRepositoryIdentity {
  readonly repositoryId: GitRepositoryId
  readonly workspaceId: WorkspaceId
  readonly root: GitPathIdentity
  readonly gitDir: GitPathIdentity
  readonly commonDir: GitPathIdentity
  readonly objectFormat: 'sha1' | 'sha256'
}
/** One caller's explicit source for a path relative to the repository root. */
export interface GitPathSelection { readonly path: string; readonly source: 'index' | 'worktree' | 'untracked' }
/** A selected baseline always starts from an explicitly named commit. */
export type GitBaselineSelection = { readonly kind: 'commit'; readonly commit: string }
  | { readonly kind: 'selected'; readonly baseCommit: string; readonly paths: readonly GitPathSelection[] }
/** Baseline request for an already registered project directory. */
export interface GitResourcePreviewRequest { readonly workspaceId: WorkspaceId; readonly baseline: GitBaselineSelection }
/** Paths are returned without file contents; deletion is an explicit selected entry. */
export interface GitBaselineEntry {
  readonly path: string
  readonly source: GitPathSelection['source']
  readonly mode: '100644' | '100755' | 'deleted'
  readonly objectId?: string
  readonly rawHash?: string
  readonly bytes: number
}
/** Complete dirty classification is bounded; truncation rejects instead of dropping paths. */
export interface GitDirtyState {
  readonly staged: readonly string[]
  readonly unstaged: readonly string[]
  readonly untracked: readonly string[]
  readonly unmerged: readonly string[]
}
/** A detached, non-writing repository cut used by the later create CAS. */
export interface GitResourcePreview {
  readonly request: GitResourcePreviewRequest
  readonly permitted: boolean
  readonly diagnostic?: string
  readonly risks: readonly string[]
  readonly repository?: GitRepositoryIdentity
  readonly head?: string
  readonly symbolicRef?: string
  readonly indexHash?: string
  readonly baseCommit?: string
  readonly baseTree?: string
  readonly dirty: GitDirtyState
  readonly selected: readonly GitBaselineEntry[]
  readonly fingerprint: string
}
/** The caller supplies only its own immutable use identity, not a task or role. */
export interface GitResourceUseIdentity { readonly useId: string; readonly ownerId: string; readonly epoch: string }
/** An interrupted use stays held until its owner explicitly confirms quiet handback. */
export interface GitResourceUse extends GitResourceUseIdentity { readonly phase: 'held' | 'needs_attention' | 'released' }
/** One work copy and its independently preserved version. */
export interface GitResourceRecord {
  readonly resourceId: GitResourceId
  readonly repositoryId: GitRepositoryId
  readonly consumerScope: GitConsumerScope
  readonly revision: number
  readonly path: string
  readonly reservedAbsent: true
  readonly pathIdentity?: GitPathIdentity
  readonly privateRef: string
  readonly baselineCommit?: string
  readonly baselineTree?: string
  readonly state: 'reserved' | 'available' | 'conflicted' | 'preserved' | 'needs_attention' | 'abandoned' | 'cleaned'
  readonly preservedCommit?: string
  readonly preservedTree?: string
  readonly preservedManifestHash?: string
  readonly preservedRef?: string
  /** Real detached HEAD used as the preservation commit's parent; immutable baseline remains unchanged. */
  readonly preservedHead?: string
  /** Only a versioned seal is a code result; all-content preserves regular-file bytes, not index or directory state. */
  readonly preservedContent?: 'versioned' | 'all'
  readonly preservedConflictStages?: readonly GitIntegrationConflictStage[]
  readonly preservedIntegrationOperationId?: GitOperationId
  readonly unresolvedConflictIds?: readonly string[]
  readonly resolutionOperationId?: GitOperationId
  readonly resolvedPreserveOperationId?: GitOperationId
  /** Ignored paths or directory prefixes not read or preserved by the latest seal. */
  readonly unpreservedPaths?: readonly string[]
  readonly use?: GitResourceUse
  readonly useHistory: readonly GitResourceUse[]
}
/** Durable intent and observed effect are separate from the resource's state. */
export interface GitResourceOperation {
  readonly operationId: GitOperationId
  readonly fingerprint: string
  readonly kind: 'create' | 'preserve' | 'integrate' | 'resolve' | 'apply' | 'inverse' | 'cleanup'
  readonly resourceId: GitResourceId
  readonly repositoryId: GitRepositoryId
  readonly consumerScope: GitConsumerScope
  readonly phase: 'intended' | 'acting' | 'needs_attention' | 'confirmed' | 'failed' | 'abandoned'
  readonly request: GitResourceCreateRequest | GitResourcePreserveRequest | GitIntegrationRequest
    | GitIntegrationResolutionRequest | GitApplicationRequest | GitInverseRequest | GitResourceCleanupRequest
  readonly createdAt: string
  readonly preview?: GitResourcePreview
  readonly integrationPreview?: GitIntegrationPreview
  readonly integrationEffect?: GitIntegrationEffect
  readonly resolutionPreview?: GitIntegrationResolutionPreview
  readonly resolutionEffect?: GitIntegrationResolutionEffect
  readonly applicationPreview?: GitApplicationPreview
  readonly applicationObservation?: GitApplicationObservation
  readonly applicationEffect?: GitApplicationEffect
  readonly inversePreview?: GitInversePreview
  readonly cleanupPreview?: GitResourceCleanupPreview
  readonly cleanupObservation?: GitResourceCleanupObservation
  readonly effectCommit?: string
  readonly effectTree?: string
  readonly effectManifestHash?: string
  readonly effectRef?: string
  readonly effectHead?: string
  /** Immutable mode and remaining paths for this operation, independent of a later preservation. */
  readonly effectContent?: 'versioned' | 'all'
  /** Exact unresolved index stages; nonempty means a snapshot, not an integrated code result. */
  readonly effectConflictStages?: readonly GitIntegrationConflictStage[]
  readonly effectIntegrationOperationId?: GitOperationId
  /** Known conflicts of the original integration remain unresolved for this exact seal without an explicit resolution receipt. */
  readonly effectUnresolvedConflictIds?: readonly string[]
  readonly unpreservedPaths?: readonly string[]
  readonly worktreeCreateStarted?: true
  /** False is a durable no-write witness; missing is unknown, never a safe abandonment claim. */
  readonly externalWriteStarted?: boolean
  readonly diagnostic?: string
}
/** Creation names the exact non-writing preview rather than silently adopting fresh dirty files. */
export interface GitResourceCreateRequest extends GitResourcePreviewRequest {
  readonly operationId: GitOperationId
  readonly consumerScope: GitConsumerScope
  readonly originalRequestJson: string
  readonly expectedPreviewFingerprint: string
}
/** Preservation never checks out, resets, or modifies the user's project. */
export interface GitResourcePreserveRequest {
  readonly operationId: GitOperationId
  readonly resourceId: GitResourceId
  readonly expectedRevision: number
  /** Defaults to versioned: tracked plus nonignored untracked working bytes, never ignored dependencies. */
  readonly content?: 'versioned' | 'all'
  /**
   * Versioned only: record in the work copy's own index, from the bytes this seal captures, each conflicted path the
   * worker changed since the integration wrote it and that holds no conflict hunk (a line opening with seven or more `<`
   * and one opening with seven or more `>`): its bytes as resolved, or its removal when the file is gone. Paths Git
   * reports as one conflict settle together: once the worker changed one, the others without a hunk are recorded as this
   * seal holds them. A conflicted path the integration did not write and the seal does not hold is recorded as removed.
   * Otherwise a path left as the integration wrote it keeps its conflict stages, and a path still holding a hunk always
   * does. The record is Git bookkeeping a sandboxed worker cannot write; it does not prove the conflict was handled well.
   */
  readonly resolveMarkerFreeConflicts?: boolean
  /** Optional bounded original consumer JSON for cold correlation; never interpreted as authority. */
  readonly originalRequestJson?: string
}
/** Read-only files of one confirmed versioned seal, for reading without a work copy. */
export interface GitResourceSnapshotRequest {
  /** A confirmed versioned preserve operation whose version has no conflict stages. */
  readonly preserveOperationId: GitOperationId
  /** The consumer scope that owns that operation. */
  readonly consumerScope: GitConsumerScope
}
/** A directory named by the sealed tree, holding exactly its regular files without write permission. */
export interface GitResourceSnapshot { readonly path: string; readonly tree: string }
/**
 * The nearest directory above the owner's home holding a package.json or node_modules. Commands run in a work copy or snapshot
 * can still resolve packages from its node_modules; the owner's package boundary keeps out only its module type, imports and
 * exports.
 */
export interface GitEnclosingPackage {
  readonly directory: string
  readonly entries: readonly ('package.json' | 'node_modules')[]
}
/** Query result carries resource facts without performing confirmation or repair. */
export interface GitResourceOperationView { readonly operation: GitResourceOperation; readonly resource: GitResourceRecord }
/** A live write-use scope can be asserted synchronously inside another owner's CAS. */
export interface GitResourceWriteScope {
  readonly resource: GitResourceRecord
  readonly signal: AbortSignal
  /** Recheck the exact persisted use and resource revision; no IO or mutation. */
  assertCurrent(): void
}
/** Pure observed version facts, even during a caller-owned write use; not a quiescence or verification assertion. */
export interface GitWorkCopyInspection {
  readonly resourceId: GitResourceId
  readonly resourceRevision: number
  readonly pathIdentity: GitPathIdentity
  readonly head: string
  readonly indexHash: string
  readonly manifestHash: string
  readonly conflictStages: readonly GitIntegrationConflictStage[]
  readonly unpreservedPaths: readonly string[]
}
