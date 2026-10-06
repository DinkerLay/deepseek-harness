# Workspaces

English | [中文](workspace.zh.md)

A workspace is the persistent record of a directory the user works in: a stable id over a canonical path, a display title, and the ordered account of sessions that belong to it. The registry package ([dsh-workspace](../../packages/workspace/workspace), `ctx.workspaceRegistry`) is an optional host-side capability, not part of the agent-loop spine, and invisible to models (no tools, no prompt text, no session events). It stores its records through the [storage domain form](storage.md) and validates session membership against [`SessionHeader.cwd`](persistence.md#sessionheader--metadata-beside-the-log), so `storageDomain` and `sessionPersistence` are mandatory startup dependencies: an unavailable persistence peer leaves the plugin pending rather than being mistaken for an empty history. Design record: [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md); bootstrap and GUI ordering: [Workspace UI product-flow Agent Note](../../.agents/notes/archived/feature/2026-07-25-workspace-ui-product-flow.md).

Source: [`packages/workspace/workspace/src/types.ts`](../../packages/workspace/workspace/src/types.ts)

## Identity

```ts type-equiv
/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
type WorkspaceId = Branded<'WorkspaceId'>
```

`WorkspaceId` is a [branded id](core.md#branded-ids). Path identity is separate: `realpathNormalize` (`fs.realpath`; trailing slashes, `..`, and symlinks resolved) is the one uniqueness canon — workspace paths are stored canonicalized, uniqueness is string equality of canonical paths (a symlink to an owned directory collides), and attach-time session cwd checks go through the same canon.

## The workspace entity

Consumers see only the `Workspace` interface; the implementation stays package-private.

```ts type-equiv
/**
 * One workspace: a stable id over an existing directory, a display title, and
 * an ordered candidate account of sessions. Membership requires both an id in
 * that account and a session header whose canonical cwd equals the workspace
 * path. Consumers only see this interface; the implementation stays private.
 */
interface Workspace {
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Canonical directory path: the `fs.realpath` of the path given at create
   * time (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to the final path segment, or a filesystem root's own spelling; duplicates are allowed. */
  readonly title: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string

  /**
   * Header-validated sessions in manually owned order: a new session is
   * prepended at attach, explicit reordering goes through
   * `insertSessionBefore`, and activity never reorders. The durable candidate
   * account is filtered synchronously: missing headers, invalid cwd values,
   * and canonical cwd mismatches are never returned. A subsequent workspace
   * mutation prunes those filtered candidates durably.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Prepend a session to this workspace's candidate account. An already
   * accounted id resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs. A new id's
   * live or persisted
   * header cwd must resolve to an existing directory equal to {@link path};
   * unknown ids, missing or invalid cwd values, and mismatches reject without
   * writing.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Move an accounted session within the manual order, DOM-insertBefore-like:
   * with an anchor the session lands before it, without one it appends to the
   * end. Only the moved id changes position. A session or anchor absent from
   * the account rejects without writing; a move to the current position
   * resolves without writing, aside from the durable filtered-candidate
   * prune every accepted mutation performs; decided on the domain write
   * chain.
   * @param sessionId - The accounted session to move.
   * @param beforeSessionId - Accounted anchor to insert before; omitted appends.
   * @returns resolution after durability.
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. Idempotent: an id not on
   * the account resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs; decided on
   * the domain write chain like attach. Never touches the session's own stored log.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether {@link path} currently exists and
   * is a directory. A missing directory never mutates the record — the
   * directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
```

Ownership truth is the record's ordered `sessionIds`, never derived from session cwd — but membership requires both: an id on the account and a header whose canonical cwd equals the workspace path, so one session structurally belongs to at most one workspace. Failed writes reject (`insertSessionBefore` account errors as `WorkspaceMoveInvalidError`, storage failures as plain errors); every accepted mutation stamps `updatedAt` and durably prunes candidates that no longer pass the membership check.

## The registry: `ctx.workspaceRegistry`

`WorkspaceRegistry` ([signatures](#ctxworkspaceregistry--workspaceregistry)) owns registration and resolution. `create(path, title?)` requires a fully qualified path, canonicalizes it, rejects a nonexistent path (the original `ENOENT`) or a non-directory, returns the existing entity unchanged when the canonical path is already owned, and otherwise creates a record with `title ?? defaultWorkspaceTitle(path)` prepended to the durable registry order (different canonical paths may share a display title, and a path with no final segment uses its root spelling). `get(id)` and the ordered `list()` are synchronous cache reads; `resolveByPath(path)` applies the same fully qualified realpath canon without creating. `delete(id)` removes only the registration, order entry, and session account — the directory, user files, live sessions, and persisted logs are never touched, so those sessions become Ungrouped ([decision](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.md)); unknown ids return `false`. Create and delete persist a pending-mutation marker before their two writes (record + order) can diverge; startup resolves exactly the marked mutation — by deleting the marked table row, which completes an interrupted delete and rolls back an interrupted create (the registration is re-creatable, so rollback is the safe direction) — and an unmarked order/table mismatch fails loud as corruption.

Sessions get their cwd at create time from whoever creates them, not from this registry — the API gateway resolves a new session's cwd from the chosen workspace's `path` (falling back to an explicit or default cwd), creates the session so the cwd lands in its immutable [`SessionHeader`](persistence.md#sessionheader--metadata-beside-the-log), then calls `attachSession`, which re-validates that stored header cwd against the workspace path. On the first successful start, the registry bootstraps history from persisted headers alone (`id`, `cwd`, `createdAt` — never event bodies), grouping sessions with a valid canonical cwd into per-directory workspaces, newest first; the initialized marker is written last so an interrupted bootstrap resumes safely. The bootstrap is one-time: cwd-less legacy sessions stay Ungrouped, and sessions created afterwards join a workspace only through `attachSession`.

The optional `bootstrapChildSessions` configuration defaults to true. Setting it to false excludes headers with `parentSession` only from the one-time historical grouping; existing registrations and the complete header index remain available.

## Default Workspace initialization

The controller's `initializeDefault` takes no request: it owns the fixed `default-workspace` directory name, resolves the Documents location, and asks the registry to initialize once. The registry accepts a directory resolver, derives the initial title from the requested directory's final segment rather than the canonical one, and commits the registration with its durable identity. No language reaches the Host — browser consumers label a Workspace still carrying that automatic title through the controller's `workspaceDisplayTitle`, so only the on-screen name follows the reader's language. [First-use behavior and configuration](../../packages/api/workspace-controller/README.md#first-use-workspace) describe reuse and failure handling.

## Session pinning

The controller's [transport types](../../packages/api/workspace-controller/src/types.ts) define `WorkspacePinSessionRequest` and `WorkspaceUnpinSessionRequest`, each carrying one `sessionId`. Both operations return `WorkspacePinValue`: the complete `pinnedSessionIds` array of Session ids, most recently pinned first. Pinning requires a known, unarchived Session; unpinning an id that is not pinned succeeds without changing the set. Archiving removes the Session's pin in the same durable write, and unarchiving does not restore it.

## Archive admission

Archiving is a registry-global durable set, and the registry refuses to hide running work behind it. The rule is a capability seam over two Host events the package declares and dispatches ([events](#workspace-events)): `workspace/session-activity` (waterfall) asks the composed providers what still runs for a Session, and `workspace/session-stop` (parallel) asks them to stop it. Each provider registers on the root like any listener, so the package knows no agent, job, or schedule vocabulary; the families are keys of a merge-extensible map.

```ts type-equiv
/**
 * Activity families a `workspace/session-activity` listener may report. This
 * package declares none: each provider merges its own key from a module both
 * its Host and Client faces import, so a consumer that renders the families
 * sees exactly the keys its program compiled and falls through to a generic
 * description for any other. The shipped providers merge `turn` (the Agent
 * registry), `job` (the job registry seam), `subagent` (the Subagent
 * runtime), and `schedule` (the Schedule plugin).
 */
interface SessionActivityKindMap {}
```

`SessionActivityKind` is `keyof SessionActivityKindMap`, so a program that compiled no provider sees no key at all. The shipped keys live in client-importable type modules: `turn` in the Agent registry's `types.ts`, `job` in the job registry seam's `view.ts`, `subagent` in the Subagent runtime's `control-types.ts`, `schedule` in the Schedule plugin's `types.ts`; a consumer that renders the families imports those modules for its cases and keeps a generic line for any other key. A provider answers the waterfall by prepending its `SessionActivity` entries to the result of `next()`; the registry's innermost callback returns an empty list, so a composition without providers archives freely.

```ts type-equiv
/**
 * One reason a session counts as active for archive admission. Families with
 * per-item identity list their items so a caller can name what must stop.
 */
interface SessionActivity {
  readonly kind: SessionActivityKind
  /** Active items of the family; absent for a family without per-item identity (`turn`). */
  readonly items?: readonly SessionActivityItem[]
}
```

`SessionActivityItem` carries the family-specific `id` (a session, job, or schedule id) and an optional display `label`. `archiveSession(sessionId)` asks the waterfall once, after the existence check, and rejects a non-empty answer with `WorkspaceActiveSessionError` (`sessionId`, `activity`) without writing; the controller maps it to the `workspace/session-active` error, whose details carry the same two fields. `archiveSession(sessionId, { stopActivity: true })` — the `ArchiveSessionOptions` field the transport request exposes as `stopActivity` — skips the check, writes the archive, then dispatches `workspace/session-stop`; a rejecting provider is logged and the archive stays, and the stopped work is never awaited to settlement. An already archived id neither asks nor stops. The shipped providers, what they stop, and the `agent/pre-step` gate that keeps an archived Session from running a model step are documented with the [registry package](../../packages/workspace/workspace/README.md#api-behavior); the decision record is the [archive-stops-running-work Agent Note](../../.agents/notes/implemented/feature/2026-09-21-archive-stops-running-session-work.md).

## Managed Git resources

The optional [`dsh-git-resources`](../../packages/workspace/git-resources/README.md) owner exposes `ctx.gitResources` for registered local Git projects. Its private work copies, immutable versions, use identities and operation receipts remain separate from Workspace registrations. The package README owns baseline selection, authority, recovery and cleanup semantics; the public declarations below define the detached requests and resource facts.

### Resource identities and lifecycle

Source: [`packages/workspace/git-resources/src/types.ts`](../../packages/workspace/git-resources/src/types.ts)

```ts type-equiv
/** One observed canonical local repository. */
type GitRepositoryId = Branded<'GitRepositoryId'>
```

```ts type-equiv
/** One managed local work copy, independent of its current user. */
type GitResourceId = Branded<'GitResourceId'>
```

```ts type-equiv
/** One caller-reserved durable operation identity. */
type GitOperationId = Branded<'GitOperationId'>
```

```ts type-equiv
/** Opaque consumer-owned grouping; the resource owner does not interpret its business identity. */
type GitConsumerScope = Branded<'GitConsumerScope'>
```

```ts type-equiv
/** Exact filesystem witness, meaningful only on the current host. */
interface GitPathIdentity { readonly path: string; readonly device: string; readonly inode: string }
```

```ts type-equiv
/** Repository identity does not confuse a moved branch with a replaced repository. */
interface GitRepositoryIdentity {
  readonly repositoryId: GitRepositoryId
  readonly workspaceId: WorkspaceId
  readonly root: GitPathIdentity
  readonly gitDir: GitPathIdentity
  readonly commonDir: GitPathIdentity
  readonly objectFormat: 'sha1' | 'sha256'
}
```

```ts type-equiv
/** One caller's explicit source for a path relative to the repository root. */
interface GitPathSelection { readonly path: string; readonly source: 'index' | 'worktree' | 'untracked' }
```

```ts type-equiv
/** A selected baseline always starts from an explicitly named commit. */
type GitBaselineSelection = { readonly kind: 'commit'; readonly commit: string }
  | { readonly kind: 'selected'; readonly baseCommit: string; readonly paths: readonly GitPathSelection[] }
```

```ts type-equiv
/** Baseline request for an already registered project directory. */
interface GitResourcePreviewRequest { readonly workspaceId: WorkspaceId; readonly baseline: GitBaselineSelection }
```

```ts type-equiv
/** Paths are returned without file contents; deletion is an explicit selected entry. */
interface GitBaselineEntry {
  readonly path: string
  readonly source: GitPathSelection['source']
  readonly mode: '100644' | '100755' | 'deleted'
  readonly objectId?: string
  readonly rawHash?: string
  readonly bytes: number
}
```

```ts type-equiv
/** Complete dirty classification is bounded; truncation rejects instead of dropping paths. */
interface GitDirtyState {
  readonly staged: readonly string[]
  readonly unstaged: readonly string[]
  readonly untracked: readonly string[]
  readonly unmerged: readonly string[]
}
```

```ts type-equiv
/** A detached, non-writing repository cut used by the later create CAS. */
interface GitResourcePreview {
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
```

```ts type-equiv
/** The caller supplies only its own immutable use identity, not a task or role. */
interface GitResourceUseIdentity { readonly useId: string; readonly ownerId: string; readonly epoch: string }
```

```ts type-equiv
/** An interrupted use stays held until its owner explicitly confirms quiet handback. */
interface GitResourceUse extends GitResourceUseIdentity { readonly phase: 'held' | 'needs_attention' | 'released' }
```

```ts type-equiv
/** One work copy and its independently preserved version. */
interface GitResourceRecord {
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
```

```ts type-equiv
/** Durable intent and observed effect are separate from the resource's state. */
interface GitResourceOperation {
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
```

```ts type-equiv
/** Creation names the exact non-writing preview rather than silently adopting fresh dirty files. */
interface GitResourceCreateRequest extends GitResourcePreviewRequest {
  readonly operationId: GitOperationId
  readonly consumerScope: GitConsumerScope
  readonly originalRequestJson: string
  readonly expectedPreviewFingerprint: string
}
```

```ts type-equiv
/** Preservation never checks out, resets, or modifies the user's project. */
interface GitResourcePreserveRequest {
  readonly operationId: GitOperationId
  readonly resourceId: GitResourceId
  readonly expectedRevision: number
  /** Defaults to versioned: tracked plus nonignored untracked working bytes, never ignored dependencies. */
  readonly content?: 'versioned' | 'all'
  /** Optional bounded original consumer JSON for cold correlation; never interpreted as authority. */
  readonly originalRequestJson?: string
}
```

```ts type-equiv
/** Query result carries resource facts without performing confirmation or repair. */
interface GitResourceOperationView { readonly operation: GitResourceOperation; readonly resource: GitResourceRecord }
```

```ts type-equiv
/** A live write-use scope can be asserted synchronously inside another owner's CAS. */
interface GitResourceWriteScope {
  readonly resource: GitResourceRecord
  readonly signal: AbortSignal
  /** Recheck the exact persisted use and resource revision; no IO or mutation. */
  assertCurrent(): void
}
```

```ts type-equiv
/** Pure observed version facts, even during a caller-owned write use; not a quiescence or verification assertion. */
interface GitWorkCopyInspection {
  readonly resourceId: GitResourceId
  readonly resourceRevision: number
  readonly pathIdentity: GitPathIdentity
  readonly head: string
  readonly indexHash: string
  readonly manifestHash: string
  readonly conflictStages: readonly GitIntegrationConflictStage[]
  readonly unpreservedPaths: readonly string[]
}
```

### Integration and resolution

Source: [`packages/workspace/git-resources/src/integration.ts`](../../packages/workspace/git-resources/src/integration.ts)

```ts type-equiv
/** Explicit immutable inputs; a prior preserved version can be selected as the starting tree. */
interface GitIntegrationPreviewRequest {
  readonly consumerScope: GitConsumerScope
  readonly baseResourceId: GitResourceId
  readonly basePreserveOperationId?: GitOperationId | undefined
  readonly sourcePreserveOperationIds: readonly GitOperationId[]
  readonly resolutionOperationIds?: readonly GitOperationId[] | undefined
}
```

```ts type-equiv
/** A resource owner records this request before writing objects or creating the new copy. */
interface GitIntegrationRequest extends GitIntegrationPreviewRequest {
  readonly operationId: GitOperationId
  readonly originalRequestJson: string
  readonly expectedPreviewFingerprint: string
}
```

```ts type-equiv
/** One historical operation, never the resource's latest mutable preservation fields. */
interface GitIntegrationInput {
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
```

```ts type-equiv
/** Complete read-only input cut; merge conflicts are not computed by preview. */
interface GitIntegrationPreview {
  readonly request: GitIntegrationPreviewRequest
  readonly repository: GitRepositoryIdentity
  readonly baseCommit: string
  readonly baseTree: string
  readonly originalTargetBaseTree: string
  readonly baseInput?: GitIntegrationInput | undefined
  readonly sources: readonly GitIntegrationInput[]
  readonly fingerprint: string
}
```

```ts type-equiv
/** Git's higher-order index entry; text markers alone cannot identify every conflict. */
interface GitIntegrationConflictStage {
  readonly path: string
  readonly mode: '100644' | '100755'
  readonly objectId: string
  readonly stage: 1 | 2 | 3
}
```

```ts type-equiv
/** Informational paths are not filesystem authorization or a parsed human message. */
interface GitIntegrationConflictMessage {
  readonly paths: readonly string[]
  readonly kind: string
  readonly message: string
}
```

```ts type-equiv
/** Observed merge objects; remaining inputs are never silently folded through an unresolved tree. */
interface GitIntegrationEffect {
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
```

```ts type-equiv
/** Exact conflict/version choices, separate from the later Host proof and operation identity. */
interface GitIntegrationResolutionSelection {
  readonly consumerScope: GitConsumerScope
  readonly integrationOperationId: GitOperationId
  readonly preserveOperationId: GitOperationId
  readonly confirmedConflictIds: readonly string[]
}
```

```ts type-equiv
/** Independent resolution intent; original integration and preservation records stay unchanged. */
interface GitIntegrationResolutionRequest extends GitIntegrationResolutionSelection {
  readonly operationId: GitOperationId
  readonly originalRequestJson: string
  readonly expectedPreviewFingerprint: string
}
```

```ts type-equiv
/** Resource facts only; normal verification and caller authority are supplied by the Host proof. */
interface GitIntegrationResolutionEffect {
  readonly integrationOperationId: GitOperationId
  readonly preserveOperationId: GitOperationId
  readonly resourceId: GitResourceId
  readonly tree: string
  readonly manifestHash: string
  readonly conflictIds: readonly string[]
}
```

```ts type-equiv
/** Current quiet version and index cut used by the later resolution CAS. */
interface GitIntegrationResolutionPreview {
  readonly request: GitIntegrationResolutionSelection
  readonly effect: GitIntegrationResolutionEffect
  readonly resourceRevision: number
  readonly head: string
  readonly indexHash: string
  readonly fingerprint: string
}
```

### Target application and inverse candidates

Source: [`packages/workspace/git-resources/src/application.ts`](../../packages/workspace/git-resources/src/application.ts)

```ts type-equiv
/** Exact owner-resolved version; no latest-resource lookup occurs inside application plumbing. */
interface GitApplicationSource {
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
```

```ts type-equiv
/** Explicit target Workspace and immutable source IDs, never an arbitrary Host path. */
interface GitApplicationPreviewRequest {
  readonly consumerScope: GitConsumerScope
  readonly integrationOperationId: GitOperationId
  readonly preserveOperationId: GitOperationId
  readonly targetWorkspaceId: WorkspaceId
  readonly resolutionOperationId?: GitOperationId | undefined
}
```

```ts type-equiv
/** The owner records this user-selected intent before the first working-file write. */
interface GitApplicationRequest extends GitApplicationPreviewRequest {
  readonly operationId: GitOperationId
  readonly originalRequestJson: string
  readonly expectedPreviewFingerprint: string
}
```

```ts type-equiv
/** Full target CAS includes branch, index, touched bytes and every traversed directory. */
interface GitApplicationTargetCut {
  readonly repository: GitRepositoryIdentity
  readonly head: string
  readonly symbolicRef?: string | undefined
  readonly indexHash: string
  readonly touched: readonly GitApplicationPath[]
  readonly ancestors: readonly GitApplicationAncestor[]
  readonly fingerprint: string
}
```

```ts type-equiv
/** Read-only exact diff selection, with no implicit authorization to write its target. */
interface GitApplicationPreview {
  readonly source: GitApplicationSource
  readonly target: GitApplicationTargetCut
  readonly patchHash: string
  /** Complete bounded Git diff; binary bodies remain Git's textual binary-patch representation. */
  readonly patch: string
  readonly binary: boolean
  readonly fingerprint: string
}
```

```ts type-equiv
/** Interrupted writes are reported per path; unknown or partial outcomes never replay automatically. */
interface GitApplicationObservation {
  readonly state: 'before' | 'after' | 'partial' | 'unknown'
  readonly paths: readonly { readonly path: string; readonly state: 'before' | 'after' | 'unknown' }[]
  readonly headUnchanged: boolean
  readonly indexUnchanged: boolean
}
```

```ts type-equiv
/** Only an exact all-after observation is a confirmed application effect. */
interface GitApplicationEffect {
  readonly preview: GitApplicationPreview
  readonly observation: GitApplicationObservation
}
```

```ts type-equiv
/** Reverse preparation names the actual old effect and current target, never the old source inputs. */
interface GitInversePreviewRequest {
  readonly consumerScope: GitConsumerScope
  readonly applicationOperationId: GitOperationId
  readonly targetWorkspaceId: WorkspaceId
}
```

```ts type-equiv
/** Intent for a new independent inverse candidate; this request does not apply it to the target. */
interface GitInverseRequest extends GitInversePreviewRequest {
  readonly operationId: GitOperationId
  readonly originalRequestJson: string
  readonly expectedPreviewFingerprint: string
}
```

```ts type-equiv
/** Read-only current touched cut before any inverse snapshot objects are created. */
interface GitInversePreview {
  readonly applicationOperationId: GitOperationId
  readonly original: GitApplicationEffect
  readonly currentTarget: GitApplicationTargetCut
  readonly fingerprint: string
}
```

```ts type-equiv
/** Directory witnesses include known absent parents needed for a newly added path. */
interface GitApplicationAncestor {
  readonly path: string
  readonly identity?: GitPathIdentity | undefined
}
```

```ts type-equiv
/** Exact regular content or definite absence; unsupported types never become empty files. */
type GitFileState = { readonly kind: 'absent' }
  | { readonly kind: 'file'; readonly mode: '100644' | '100755'; readonly objectId: string; readonly rawHash: string }
```

```ts type-equiv
/** One complete application path has both original and intended immutable bytes. */
interface GitApplicationPath {
  readonly path: string
  readonly before: GitFileState
  readonly after: GitFileState
}
```

### Cleanup observations

Source: [`packages/workspace/git-resources/src/cleanup.ts`](../../packages/workspace/git-resources/src/cleanup.ts)

```ts type-equiv
/** Read-only full file-content and metadata cut; empty directories and unpreserved index objects refuse. */
interface GitResourceCleanupPreview {
  readonly resourceId: GitResourceId
  readonly resourceRevision: number
  readonly pathIdentity: GitPathIdentity
  readonly gitDirIdentity: GitPathIdentity
  readonly preserveOperationId: GitOperationId
  readonly commit: string
  readonly tree: string
  readonly manifestHash: string
  readonly ref: string
  readonly head: string
  readonly indexHash: string
  readonly fingerprint: string
}
```

```ts type-equiv
/** Stable explicit cleanup intent; no model-authored assertion can replace the Host unused-cwd proof. */
interface GitResourceCleanupRequest {
  readonly operationId: GitOperationId
  readonly resourceId: GitResourceId
  readonly expectedPreviewFingerprint: string
  readonly originalRequestJson?: string | undefined
}
```

```ts type-equiv
/** Partial directory/admin removal is observable but never considered successful or blindly replayed. */
interface GitResourceCleanupObservation { readonly pathAbsent: boolean; readonly metadataAbsent: boolean }
```

## Consumers

[`dsh-workspace-controller`](../../packages/api/workspace-controller) serves workspace CRUD to GUI clients over `ctx.workspaceRegistry`, and [`dsh-session-controller`](../../packages/api/session-controller) performs the create-session-then-attach flow above. [dsh-agent-instructions](../../packages/context/agent-instructions) is **not** a consumer despite the name: it discovers AGENTS.md-style instruction files under an agent's own cwd and never touches `ctx.workspaceRegistry` — the shared word refers to the user's working directory, not to this registry's entities.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdirectorypicker--directorypicker-abstract-seam"></a>

### `ctx.directoryPicker` — `DirectoryPicker` (abstract seam)

Abstract directory-picking service. Subclass, implement `capability()`, and load the subclass as a plugin — it registers as `ctx.directoryPicker` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior). The capability object must be stable for the service lifetime: consumers may capture it across calls.

```ts cordis-catalog
/**
 * The backend's interaction capability.
 * @returns the discriminated capability consumers switch on.
 */
abstract capability(): DirectoryPickerCapability
```

Source: [`packages/host/directory-picker/src/index.ts`](../../packages/host/directory-picker/src/index.ts)

<a id="ctxdirectorypickercontroller--directorypickercontroller"></a>

### `ctx.directoryPickerController` — `DirectoryPickerController`

Host service backing the generated `ctx.remote.directoryPicker` namespace. The seam it exports is abstract and therefore never a Loader entry of its own, so this controller carries the wire verbs: one composed backend serves either the native chooser or the browse primitives, and a verb the composition cannot serve is refused rather than approximated.

```ts cordis-catalog
/**
 * Open the host's OS chooser for a Remote caller.
 * @param signal - caller lifetime; abort terminates the chooser.
 * @returns the chosen absolute path, or null when the operator cancels.
 */
@Remote('pick') async pick(signal: AbortSignal): Promise<string | null>

/**
 * List one directory level for a Remote caller's in-app browser.
 * @param path - absolute directory to list; absent lists the home directory.
 * @param signal - caller lifetime; abort stops the backend's scan instead of
 *   letting it outlive a disconnected caller.
 * @returns the level's listing with its ancestry.
 */
@Remote('list') async list(path: string | undefined, signal: AbortSignal): Promise<DirectoryListing>

/**
 * Create one child directory for a Remote caller's in-app browser.
 * @param path - absolute existing parent directory.
 * @param name - single non-blank path segment.
 * @returns the created directory's absolute path.
 */
@Remote('createDirectory') async createDirectory(path: string, name: string): Promise<string>
```

Source: [`packages/api/workspace-controller/src/directory-picker.ts`](../../packages/api/workspace-controller/src/directory-picker.ts)

<a id="ctxgitresources--gitresources"></a>

### `ctx.gitResources` — `GitResources`

Sole same-host owner of managed work copies; no task, agent role or model tool policy.

```ts cordis-catalog
/** Observe a registered repository and an explicit immutable or selected baseline.
 * @param request - registered project and explicit commit/layered baseline.
 * @param signal - caller cancellation.
 * @returns bounded detached observation; no Git object, ref, index, domain or user-file writes.
 */
async preview(request: GitResourcePreviewRequest, signal: AbortSignal = this.lifetime.signal): Promise<GitResourcePreview>

/** Create the work copy reserved by an exact original request, or resume that same operation.
 * @param request - exact earlier preview and stable caller-reserved operation id.
 * @param signal - cancellation; intent and completed effects survive it.
 * @returns confirmed resource or recoverable original operation, never a second work copy.
 */
async create(request: GitResourceCreateRequest, signal: AbortSignal = this.lifetime.signal): Promise<GitResourceOperationView>

/** Observe exact immutable versions; no merge objects, refs or new work copies are created.
 * @param request - opaque scope, starting resource and ordered versioned preservation identities.
 * @param signal - read-only observation cancellation.
 * @returns immutable source facts and an integration creation fingerprint.
 */
async previewIntegration(request: GitIntegrationPreviewRequest, signal: AbortSignal = this.lifetime.signal): Promise<GitIntegrationPreview>

/** Persist an integration intent, then create a separate work copy without applying anything to the project.
 * @param request - exact earlier preview, original request JSON and stable operation identity.
 * @param signal - caller cancellation; committed effects remain observable.
 * @param assertCurrent - trusted synchronous Host recheck before each external write and final acknowledgement.
 * @returns the original prepared or conflicted work copy and immutable Git conflict evidence.
 */
async integrate(request: GitIntegrationRequest, signal: AbortSignal = this.lifetime.signal, assertCurrent: () => void = () => {}): Promise<GitResourceOperationView>

/** Observe an exact version and all known conflicts without inferring resolution from marker absence.
 * @param selection - original integration, versioned seal and explicit complete conflict set.
 * @param signal - observation cancellation.
 * @returns a current quiet working/index cut; no Git objects or refs are written.
 */
async previewResolution(selection: GitIntegrationResolutionSelection, signal: AbortSignal = this.lifetime.signal): Promise<GitIntegrationResolutionPreview>

/** Record independent Host-proven resolution of one exact immutable version; original records never change.
 * @param request - stable operation and exact preview plus original consumer JSON.
 * @param signal - admitted operation cancellation.
 * @param assertProof - required synchronous Host authority/normal-verification proof, not a request-authored claim.
 * @returns exact confirmed resolution receipt; new versions need their own explicit confirmation.
 */
async resolveIntegration(request: GitIntegrationResolutionRequest, signal: AbortSignal, assertProof: () => void): Promise<GitResourceOperationView>

/** Observe an exact ready version and registered target; no file, index, ref or Git object writes.
 * @param request - immutable version, optional exact resolution receipt and target Workspace identity.
 * @param signal - read-only preview cancellation.
 * @returns complete target HEAD/index/touched-path CAS and plain patch digest.
 */
async previewApplication(request: GitApplicationPreviewRequest, signal: AbortSignal = this.lifetime.signal): Promise<GitApplicationPreview>

/** Explicit authenticated application, without moving the target HEAD/index or blindly replaying partial writes.
 * @param request - stable original operation and exact target preview.
 * @param signal - retained Host occupation cancellation.
 * @param assertAuthorized - required current user authority and known-target-writer quiet proof, outside request JSON.
 * @returns confirmed all-after observation; partial or unknown target effects remain attention-required.
 */
async apply(request: GitApplicationRequest, signal: AbortSignal, assertAuthorized: () => void): Promise<GitResourceOperationView>

/** Observe a reverse candidate's CURRENT target without reapplying original inputs.
 * @param request - exact old confirmed application and its registered target.
 * @param signal - read-only cancellation.
 * @returns fresh current touched-path cut, preserving unrelated target changes.
 */
async previewInverse(request: GitInversePreviewRequest, signal: AbortSignal = this.lifetime.signal): Promise<GitInversePreview>

/** Prepare a separate reverse work copy from the current target, not a rollback or automatic target write.
 * @param request - original reverse intention and exact current preview.
 * @param signal - caller cancellation.
 * @param assertCurrent - trusted synchronous Host freshness/occupation recheck before each write.
 * @returns prepared/conflicted independent work copy requiring normal verification and a new application.
 */
async prepareInverse(request: GitInverseRequest, signal: AbortSignal = this.lifetime.signal, assertCurrent: () => void = () => {}): Promise<GitResourceOperationView>

/** Observe already-created effects and confirm only the exact original resource evidence.
 * @param operationId - earlier persisted identity.
 * @param signal - reconciliation cancellation.
 * @returns actual resource/ref identity or a retained attention diagnostic; unknown paths are not removed or adopted.
 */
async reconcile(operationId: GitOperationId, signal: AbortSignal = this.lifetime.signal): Promise<GitResourceOperationView>

/** Terminally abandon an original creation only after proving that no external write ever began.
 * This neither rolls back nor deletes Git objects, directories, refs or any partial effect.
 * @param operationId - original immutable creation identity; never reusable after abandonment.
 * @param expectedFingerprint - exact original request CAS.
 * @param reason - bounded caller-owned diagnostic, not an authorization claim.
 * @param signal - cancellation while waiting for the actual operation/resource lanes to drain.
 * @param assertCurrent - trusted synchronous Host recheck immediately before the durable transform.
 * @returns terminal receipt only when all ownership evidence is definitely absent.
 */
async abandonOperation(operationId: GitOperationId, expectedFingerprint: string, reason: string, signal: AbortSignal = this.lifetime.signal, assertCurrent: () => void = () => {}): Promise<GitResourceOperationView>

/** Read detached resource metadata without repairing or confirming effects.
 * @param resourceId - stored work-copy identity.
 * @returns detached authoritative domain facts without IO, repair or confirmation.
 */
read(resourceId: GitResourceId): GitResourceRecord | undefined

/** Read the original operation and its resource as a detached observation.
 * @param operationId - stored operation identity.
 * @returns detached observation without executing a recovery step.
 */
status(operationId: GitOperationId): GitResourceOperationView | undefined

/** List only operations belonging to the exact opaque consumer scope.
 * @param scope - exact opaque consumer grouping.
 * @returns detached operation/resource views; this query never confirms or replays effects.
 */
listOperations(scope: GitConsumerScope): readonly GitResourceOperationView[]

/** Observe current versioned working bytes without acquiring a write lane or mutating Git/domain facts.
 * @param resourceId - caller-selected managed copy, including one already held by this execution.
 * @param signal - observation cancellation.
 * @returns exact observed hashes and unresolved stages; never a quiet or successful-test claim.
 */
async inspectWorkCopy(resourceId: GitResourceId, signal: AbortSignal = this.lifetime.signal): Promise<GitWorkCopyInspection>

/** Preview removal only after full regular-file preservation, without claiming an index/directory backup.
 * @param resourceId - exact owned copy, not a caller-provided filesystem path.
 * @param signal - read-only cancellation.
 * @returns all-content private-ref and directory/index cut; unpreserved content refuses explicitly.
 */
async previewCleanup(resourceId: GitResourceId, signal: AbortSignal = this.lifetime.signal): Promise<GitResourceCleanupPreview>

/** Remove only this exact preserved owned directory after the Host proves it is no current cwd or known writer.
 * @param request - stable original request and exact earlier full-content preview.
 * @param signal - retained Host occupation cancellation.
 * @param assertUnused - required trusted current-cwd/job/source-detachment proof, never request-authored.
 * @returns actual both-halves-absent receipt; refs/history are retained and partial deletion never blindly repeats.
 */
async cleanup(request: GitResourceCleanupRequest, signal: AbortSignal, assertUnused: () => void): Promise<GitResourceOperationView>

/** Hold the resource's serial write use until the callback and durable handback settle.
 * @param resourceId - known available work copy.
 * @param identity - caller-owned use id and execution incarnation.
 * @param signal - cancellation propagated to the callback.
 * @param callback - work holding this resource lane; assertCurrent is synchronous for an external CAS.
 * @returns callback result only after successful durable handback; rejected work keeps an explicit attention use.
 */
async withWriteUse<T>(resourceId: GitResourceId, identity: GitResourceUseIdentity, signal: AbortSignal, callback: (scope: GitResourceWriteScope) => Promise<T>): Promise<T>

/** Explicit Host handback of a live or cold uncertain use; no model-authored quiet claim is accepted.
 * @param resourceId - held work copy.
 * @param identity - exact original owner/use/epoch.
 * @param expectedRevision - current resource CAS.
 * @param assertQuiescent - synchronous trusted caller proof checked at the durable transform.
 */
async confirmQuietUse(resourceId: GitResourceId, identity: GitResourceUseIdentity, expectedRevision: number, assertQuiescent: () => void): Promise<void>

/** Preserve one exact resource version as immutable file-content and Git-ref facts.
 * @param request - exact available resource revision and stable operation identity.
 * @param signal - operation cancellation.
 * @returns immutable versioned code seal by default; explicit all-content mode is directory preservation, not a code result.
 */
async preserve(request: GitResourcePreserveRequest, signal: AbortSignal = this.lifetime.signal): Promise<GitResourceOperationView>
```

Source: [`packages/workspace/git-resources/src/index.ts`](../../packages/workspace/git-resources/src/index.ts)

<a id="ctxterminalcontroller--terminalcontroller"></a>

### `ctx.terminalController` — `TerminalController`

Typed Remote control of transient Session-owned terminal processes.

```ts cordis-catalog
/**
 * Read the Session working directory and terminal limits without resolving a shell.
 * @param agent - Session owner supplied by the Gateway.
 * @param signal - request cancellation.
 * @returns the Session workspace directory and terminal limits.
 */
@Remote environment(agent: Agent, signal: AbortSignal): TerminalEnvironment

/**
 * Discover installed shells in the Session's execution environment.
 * @param agent - Session owner supplied by the Gateway.
 * @param signal - request cancellation.
 * @returns verified profiles, with the configured or system default first.
 */
@Remote shells(agent: Agent, signal: AbortSignal): Promise<TerminalShell[]>

/**
 * List retained terminals without resolving or activating an Agent.
 * @param sessionId - displayed Session identity, including offline history.
 * @returns terminals retained for this Host lifetime.
 */
@Remote list(sessionId: SessionId): WebTerminalInfo[]

/**
 * Allocate a user shell once for a caller-generated identity, without Agent sandbox or approval restrictions.
 * @param agent - Session owner supplied by the Gateway.
 * @param request - initial dimensions and idempotency identity.
 * @param signal - allocation cancellation; committed terminals survive disconnection.
 * @returns the existing or newly committed terminal.
 */
@Remote async create(agent: Agent, request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo>

/**
 * Retain an existing terminal for a window without activating its Agent or taking input control.
 * @param sessionId - owning Session identity, including an inactive saved layout.
 * @param id - retained Host terminal identity.
 * @param signal - physical Remote stream cancellation.
 * @returns a hold acknowledgement followed by an open lifetime stream.
 */
@Remote({ mode: 'stream' }) retain(sessionId: SessionId, id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame>

/**
 * Attach to a terminal without binding its process lifetime to the transport.
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @param attachmentId - new exclusive input attachment.
 * @param signal - physical stream cancellation.
 * @returns screen recovery followed by output and metadata changes.
 */
@Remote({ mode: 'stream' }) follow(agent: Agent, id: WebTerminalId, attachmentId: TerminalAttachmentId, signal: AbortSignal): AsyncIterable<TerminalFrame>

/**
 * Deliver raw input, including Tab completion and control characters.
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @param attachmentId - current writable attachment.
 * @param data - input bytes represented as UTF-8 text.
 * @returns after provider input acceptance.
 */
@Remote async write(agent: Agent, id: WebTerminalId, attachmentId: TerminalAttachmentId, data: string): Promise<void>

/**
 * Update the dimensions of the PTY and recovery screen.
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @param attachmentId - current writable attachment.
 * @param cols - column count.
 * @param rows - row count.
 * @returns after the resize completes.
 */
@Remote async resize(agent: Agent, id: WebTerminalId, attachmentId: TerminalAttachmentId, cols: number, rows: number): Promise<void>

/**
 * Rename a terminal without changing its shell.
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @param title - nonempty display title, at most 120 characters.
 */
@Remote rename(agent: Agent, id: WebTerminalId, title: string): void

/**
 * Close an identity to future creation and kill its process range; repeated closes succeed.
 * @param agent - Session owner supplied by the Gateway.
 * @param id - terminal identity.
 * @returns after provider cleanup succeeds. A failure retains the terminal for retry.
 */
@Remote async close(agent: Agent, id: WebTerminalId): Promise<void>
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/api/terminal-controller/src/index.ts`](../../packages/api/terminal-controller/src/index.ts)

<a id="ctxworkspacecontroller--workspacecontroller"></a>

### `ctx.workspaceController` — `WorkspaceController`

Host service backing the generated `ctx.remote.workspace` namespace.

```ts cordis-catalog
/**
 * Create or idempotently resolve one Workspace over an existing directory.
 * @param request - directory path to register.
 * @returns the Workspace and whether this call created it.
 */
@Remote('create') create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue>

/**
 * Initialize or reuse the default Workspace during first-use startup. The
 * directory name is fixed, so the Host never renames or relocates an
 * existing default; its initial title is that same name, which browser
 * consumers label in the reader's language.
 * @param signal - caller lifetime; cancels native directory lookup.
 * @returns the durable Workspace, or undefined when first-use initialization is ineligible; creates no Session or message.
 */
@Remote('initializeDefault') async initializeDefault(signal: AbortSignal): Promise<WorkspaceValue | undefined>

/**
 * Rename one Workspace to a unique non-blank title.
 * @param request - Workspace identity and proposed title.
 * @returns the updated Workspace projection.
 */
@Remote('rename') rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue>

/**
 * Remove one Workspace registration while retaining files and Sessions.
 * @param request - Workspace identity to remove.
 * @returns deletion confirmation.
 */
@Remote('delete') delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue>

/**
 * Move one Workspace within the registry display order.
 * @param request - moved Workspace and optional anchor.
 * @returns the complete resulting Workspace order.
 */
@Remote('insertBefore') insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue>

/**
 * Move one accounted Session within a Workspace.
 * @param request - Workspace, Session, and optional anchor identities.
 * @returns the updated Workspace projection.
 */
@Remote('insertSessionBefore') insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue>

/**
 * Hide one known Session from Workspace grouping surfaces.
 * @param request - Session identity to archive.
 * @returns the complete resulting archive set.
 */
@Remote('archiveSession') archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue>

/**
 * Restore one archived Session to Workspace grouping surfaces.
 * @param request - Session identity to unarchive.
 * @returns the complete resulting archive set.
 */
@Remote('unarchiveSession') unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue>

/**
 * Surface one known unarchived Session ahead of unpinned Sessions.
 * @param request - Session identity to pin.
 * @returns the complete resulting pin set, most recently pinned first.
 */
@Remote('pinSession') pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue>

/**
 * Remove one Session's pin without changing its saved Session order.
 * @param request - Session identity to unpin.
 * @returns the complete resulting pin set, most recently pinned first.
 */
@Remote('unpinSession') unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue>

/**
 * Stream a complete Workspace baseline followed by ordered increments.
 * @param signal - generation cancellation.
 * @returns baseline followed by ordered Workspace increments.
 */
@Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame>
```

Source: [`packages/api/workspace-controller/src/index.ts`](../../packages/api/workspace-controller/src/index.ts)

<a id="ctxworkspacefiles--workspacefiles"></a>

### `ctx.workspaceFiles` — `WorkspaceFiles`

Host Remote file reads and workspace directory observations over the composed filesystem.

```ts cordis-catalog
/**
 * Read one page of lines from a UTF-8 file readable by the filesystem backend.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - absolute path or path relative to the workspace root; files outside it are allowed.
 * @param range - the line window; omitted fields take the page defaults.
 * @param signal - caller cancellation.
 * @returns the page, the file's version at the stat before it, and whether it reaches the last line.
 */
@Remote async read( workspaceFileScope: WorkspaceFileScope, path: string, range: WorkspaceFileRange, signal: AbortSignal, ): Promise<WorkspaceFileText>

/**
 * Read a complete regular file or one byte range without text decoding.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - target path, absolute or workspace-relative; relative to the base file's directory when provided.
 * @param options - optional base file and range; without a range the complete-file cap applies.
 * @param signal - caller cancellation.
 * @returns native bytes with the file's version and size at the preceding stat, byte offset, and EOF marker.
 */
@Remote async readBytes( workspaceFileScope: WorkspaceFileScope, path: string, options: WorkspaceByteReadOptions, signal: AbortSignal, ): Promise<WorkspaceFileBytes>

/**
 * Report one regular file's identity, version, and size without its content.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - absolute path or path relative to the workspace root; files outside it are allowed.
 * @param signal - caller cancellation.
 * @returns the file's absolute path, current version, and byte size.
 */
@Remote async stat(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat>

/**
 * List the direct children of one directory inside the Session's workspace.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - workspace path, absolute or relative to the workspace root.
 * @param signal - caller cancellation.
 * @returns the directory's children in the backend's stable name order, bounded by the entry cap.
 */
@Remote async list(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing>

/**
 * Watch one file or a directory's direct entries in the Session's filesystem.
 * Files use the backend's read authority; directories remain workspace-scoped.
 * @param workspaceFileScope - header-derived workspace root for the Session identity on the wire.
 * @param path - target path; the Host determines its type and confines directories to the workspace.
 * @param signal - generation cancellation.
 * @returns `ready` once the target watch is active, then current metadata for queued and live invalidations.
 * @throws RemoteError when watching is unavailable or a directory is outside the workspace.
 */
@Remote({ mode: 'stream' }) changes(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame>
```

Source: [`packages/api/workspace-files/src/index.ts`](../../packages/api/workspace-files/src/index.ts)

<a id="ctxworkspaceregistry--workspaceregistry"></a>

### `ctx.workspaceRegistry` — `WorkspaceRegistry`

Durable workspace registry. Startup waits for `sessionPersistence`, builds one canonical-cwd header index, and completes the one-time history bootstrap before the service becomes active. The persistence dependency is mandatory so an unavailable peer can never be mistaken for an empty history and commit the initialized marker.

```ts cordis-catalog
/**
 * Create or reuse a workspace for an existing directory. The fully qualified
 * path is canonicalized through `fs.realpath`; a relative, nonexistent, or
 * non-directory path rejects. Repeated calls for the same canonical path
 * return the existing entity without changing its title.
 * A newly created workspace is prepended to the durable registry order.
 * Different canonical paths may share a display title.
 * @param path - Existing directory to own, in a fully qualified path spelling.
 * @param title - Display title used only when a new record is created.
 * @returns the existing or newly durable workspace.
 */
async create(path: string, title?: string): Promise<Workspace>

/**
 * Initialize the default Workspace only while both the registry and Session
 * history are empty. Repeated requests reuse its durable identity; deleting
 * that registration permanently disables automatic creation.
 * @param resolveDirectory - resolve the absolute directory; called only for
 * eligible creation, inside the registry mutation queue. Missing directories
 * are created recursively before registration, and the initial title is the
 * requested directory's own final segment — not the canonical one, so a
 * symlink at that path does not retitle the Workspace after its target.
 * After resolution, caller cancellation does not roll back creation or registration.
 * @returns the initialized Workspace, or undefined when automatic creation is ineligible.
 */
initializeDefault(resolveDirectory: () => Promise<string>): Promise<Workspace | undefined>

/**
 * Look up a workspace by id.
 * @param id - Workspace id.
 * @returns the workspace, or `undefined` when unknown.
 */
get(id: WorkspaceId): Workspace | undefined

/**
 * Synchronous workspace projection in durable registry order. Every
 * entity's `sessionIds` getter is already filtered by the startup/live
 * canonical-cwd header index; this method performs no persistence reads.
 * @returns a fresh ordered array of workspace entities.
 */
list(): Workspace[]

/**
 * Delete one workspace registration while retaining its directory and every
 * session log. The durable order is updated before the table deletion; a
 * failed table write restores the prior order and keeps the entity
 * published. Unknown ids are an idempotent no-op for domain callers.
 * @param id - Workspace registration to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
delete(id: WorkspaceId): Promise<boolean>

/**
 * Move one workspace within the durable display order, DOM-insertBefore-like.
 * With an anchor it lands before that workspace; without one it appends.
 * @param id - Workspace to move.
 * @param beforeId - Workspace anchor; omitted appends.
 * @returns the complete committed workspace order.
 */
insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]>

/**
 * Archive one session durably. The session must exist (live or in session
 * persistence); its workspace accounting — or lack of one — is irrelevant.
 * Without `stopActivity` the session must also be inactive: the
 * `workspace/session-activity` waterfall is asked once, and any reported
 * activity rejects with {@link WorkspaceActiveSessionError} before anything
 * is written. With `stopActivity` the archive is written without an
 * activity check, and the `workspace/session-stop` providers are then asked
 * to stop the session's work: the durable archive set is what a provider's
 * `agent/pre-step` gate reads, so every wake the stops induce is already
 * blocked. Archiving drops the session's pin in the same durable write
 * (pinning and archival are mutually exclusive). An already archived id
 * resolves without writing, asking, or stopping.
 * @param sessionId - The session to archive.
 * @param options - Whether running work is stopped instead of refusing.
 * @returns resolution after durability and, with `stopActivity`, after every stop request was issued.
 */
archiveSession(sessionId: SessionId, options: ArchiveSessionOptions = {}): Promise<void>

/**
 * Unarchive one session durably by dropping it from the registry-global
 * archive set; the accounting slot was never touched, so the session
 * returns to its recorded position. Unarchiving runs no session-existence
 * check because removing an id cannot introduce an unknown one, so an
 * entry whose session is gone still resolves. An id that is not archived
 * resolves without writing.
 * @param sessionId - The session to unarchive.
 * @returns resolution after durability.
 */
unarchiveSession(sessionId: SessionId): Promise<void>

/**
 * Pin one session durably, prepending it to the registry-global pin set.
 * The session must exist (live or in session persistence) and must not be
 * archived. An already pinned id resolves without writing or reordering.
 * @param sessionId - The session to pin.
 * @returns resolution after durability.
 */
pinSession(sessionId: SessionId): Promise<void>

/**
 * Unpin one session durably by dropping it from the registry-global pin
 * set. Unpinning runs no session-existence check because removing an id
 * cannot introduce an unknown one, so an entry whose session is gone still
 * resolves. An id that is not pinned resolves without writing.
 * @param sessionId - The session to unpin.
 * @returns resolution after durability.
 */
unpinSession(sessionId: SessionId): Promise<void>

/**
 * Resolve by canonical directory path without creating or mutating a
 * workspace. A missing path rejects during `realpath`; an existing unowned
 * directory returns `undefined`.
 * @param path - Existing directory path in a fully qualified spelling.
 * @returns the workspace owning the canonical path, when one exists.
 */
async resolveByPath(path: string): Promise<Workspace | undefined>
```

Types: [SessionId](core.md)

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)

<a id="workspace-events"></a>

### `workspace/*` events

<a id="workspacesession-activity--waterfall"></a>

#### `workspace/session-activity` — waterfall

Ask the composed providers what still runs for a session before it is archived. A listener prepends its own SessionActivity entries to the result of `next()`; the registry's innermost callback returns an empty list, so a composition without providers archives freely. Any non-empty result refuses the archive without a write.

```ts cordis-catalog
/**
 * Ask the composed providers what still runs for a session before it is
 * archived. A listener prepends its own {@link SessionActivity} entries to
 * the result of `next()`; the registry's innermost callback returns an
 * empty list, so a composition without providers archives freely. Any
 * non-empty result refuses the archive without a write.
 * @param request - the session about to be archived.
 * @param next - delegate to the remaining providers.
 * @mode waterfall
 */
'workspace/session-activity'( request: SessionActivityRequest, next: () => Promise<readonly SessionActivity[]>, ): Promise<readonly SessionActivity[]>
```

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)

<a id="workspacesession-stop--parallel"></a>

#### `workspace/session-stop` — parallel

Stop a session's running work because the caller archived it with `stopActivity`; the archive set is durable when this dispatches. Each provider stops its own families — cancelling a turn, its subagent descendants, owned jobs, or active schedules — through the same cancel paths the user's own stop actions use, so the session log ends every open turn regularly and a later unarchive can continue the conversation. Listeners issue their stop requests without waiting for running work to settle; a listener may await its own durability barrier. A rejection is logged by the registry and does not undo the archive.

```ts cordis-catalog
/**
 * Stop a session's running work because the caller archived it with
 * `stopActivity`; the archive set is durable when this dispatches. Each
 * provider stops its own families — cancelling a turn, its subagent
 * descendants, owned jobs, or active schedules — through the same cancel
 * paths the user's own stop actions use, so the session log ends every
 * open turn regularly and a later unarchive can continue the
 * conversation. Listeners issue their stop requests without waiting for
 * running work to settle; a listener may await its own durability
 * barrier. A rejection is logged by the registry and does not undo the
 * archive.
 * @param request - the session being archived.
 * @mode parallel
 */
'workspace/session-stop'(request: SessionActivityRequest): Promise<void> | void
```

Source: [`packages/workspace/workspace/src/index.ts`](../../packages/workspace/workspace/src/index.ts)
<!-- END GENERATED cordis-surface -->
