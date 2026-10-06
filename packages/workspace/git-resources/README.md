---
description: "Local Git work-copy baselines, durable creation and preservation, and exclusive Host use for consumers integrating isolated code directories."
kind: "package-reference"
---

# @deepseek-ai/dsh-git-resources

English | [中文](README.zh.md)

## Summary

Create an isolated local work copy from an explicit commit or selected staged and working files without changing the project's HEAD, index or files. Keep creation identities and preserved versions across Host restarts. Prepare independent integration and reverse candidates; apply their exact differences only through explicit authenticated Host occupation. Preserve complete file content before removing an unused owned copy. The package requires a registered Git project and durable storage and exposes no model tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin beside the Workspace registry, storage-domain provider and local subprocess provider, then pass the registered project Workspace identity to `ctx.gitResources.preview`.

### Configuration and baselines

The `home` option resolves through the public Harness home-path helper. Managed work copies and the stable kernel-lock file live under its `git-resources` child; the entire owner home is leased before mutable domain storage opens. A second owner rejects instead of guessing whether another process is alive.

`timeoutMs`, `graceMs`, `maxOutputBytes`, `maxFiles`, `maxFileBytes`, `maxTotalBytes`, `maxConsumerRequestBytes` and `closeTimeoutMs` bound commands, observations, original consumer JSON and shutdown. A file must fit both its file bound and the Git byte-channel bound; preview rejects an otherwise unmaterializable baseline before reservation. The [Config declaration](src/index.ts) owns accepted defaults. Git is resolved lazily from `gitExecutable` or `git`; a missing executable refuses isolated mode while data queries and text services remain available.

A commit baseline still reports all staged, unstaged, untracked and unmerged paths. A selected baseline requires `baseCommit` and one explicit `index`, `worktree` or `untracked` source per path; index deletion is retained. Preview writes no Git objects or project data. Raw working bytes bypass Git filters, preserve binary contents and retain executable mode.

### Durable operations and observation

`create` requires the unchanged preview fingerprint, an original operation id, an opaque `consumerScope` and bounded valid `originalRequestJson`. The owner does not interpret consumer business fields or treat them as authorization. Scope and original JSON cannot be changed on retry; `listOperations(scope)` compares the exact stored scope rather than operation-name prefixes.

Creation records its absent reserved path and intent before external effects. Explicit same-request `create` retry may continue safe original steps; `reconcile` only observes registered refs, directory identity and completed materialization, and may confirm those existing facts. It does not create objects, refs, directories or missing files. Missing, moved, unknown or conflicting evidence remains attention-required without deleting or recreating the work copy. `read`, `status` and `listOperations` are pure domain observations.

`abandonOperation` terminally consumes an unstarted original request only with a durable no-external-write witness and complete no-effect checks. Unstarted application additionally requires its complete target to remain exactly before; resolution cannot have a completion effect. Missing witnesses, partial writes and existing effects refuse. Abandonment does not roll back or delete anything, and the original operation id cannot create a new effect afterward.

`preserve` first records its own intent. Its default `content: 'versioned'` seals tracked and nonignored untracked working bytes under an immutable private ref; tracked deletions remain deletions. Ignored files and directories are not read or hashed: `unpreservedPaths` records their remaining names, not evidence that they may be deleted. Explicit `content: 'all'` preserves bounded regular directory content but still rejects protected paths; it is not a code-result seal. Each operation retains its own `effectContent` and remaining paths independently of later resource versions. The receipt carries the real tree, commit, manifest hash and preservation ref without changing the user's branch, index or files.

Creation initializes only the managed work copy's own index from its exact baseline. Unknown index content is never reset on retry. Later legitimate detached commits are allowed: preservation records the real detached HEAD as its commit's parent without rewriting the immutable baseline. An attached branch rejects with a diagnostic rather than being checked out or reset.

### Independent integration and exact resolution

`previewIntegration` observes ordered immutable versioned seals in one repository and opaque consumer scope. `integrate` records the intent before computing Git merge objects and creates a separate work copy; neither operation applies changes to the project. A conflicted result stops before remaining inputs, retaining their identities, actual Git index stages and structured conflict types. `attemptedInputCount` includes the conflicting input, not a claim that it was successfully applied.

A conflicted merge can have no higher-order index stages. Neither a stage-zero index, absent marker text nor a model summary proves resolution. New seals retain the original integration's known conflict identities. `previewResolution` verifies an exact quiet sealed version, current working bytes and index. `resolveIntegration` requires a trusted Host proof of normal verification and authority, then records an independent receipt covering every known conflict of that version. Original integration and seal records stay immutable; a later version needs a new confirmation. Integration inputs select their exact `resolutionOperationIds` explicitly instead of following the resource's latest state.

### Explicit target changes and cleanup

`previewApplication` exposes the complete bounded plain/binary patch and target HEAD, index, touched bytes, modes and parent witnesses. `apply` requires authenticated Host authority and known-writer occupation; request JSON is not that proof. A fresh cut must still match immediately before the write. HEAD/index remain unchanged. Pure reconciliation reports before, after, partial or unknown; only an observed exact after can confirm a dispatched effect, and partial/unknown content is never blindly replayed.

`previewInverse` and `prepareInverse` start from the current target and the original difference, without reapplying the old source inputs or touching project files. The resulting independent candidate must pass normal verification and a new explicit application.

`inspectWorkCopy` observes versioned working hashes and actual index conflicts even inside a held write-use callback, without acquiring a competing lane or writing Git/domain facts. Its cut is not proof of quiescence or successful tests.

`previewCleanup` requires an exact all-file preservation, no current/uncertain use, no unpreserved empty directories or unresolved index stages, and every staged object covered by pinned file versions. All-file preservation is not a raw index or directory-state backup. `cleanup` additionally requires the Host to prove that no execution still uses this cwd. It removes only the original owned identity after a fresh full cut, retaining refs and history. After a dispatched removal, pure observation may confirm both directory and metadata absence; a partial or replaced path is never deleted again. Removed copies cannot be writable bases, but their immutable preserved versions remain available as explicitly selected sources.

### Exclusive use and quiet handback

`withWriteUse` serializes use acquisition, creation completion and preservation on the same resource. The callback receives a synchronous `assertCurrent` for another owner's locked CAS; it does not need to wait for Git while holding that other lock. Hosts retain the callback until execution and background work actually settle.

A successful callback confirms handback durably. Error or cancellation retains the exact owner, epoch and use id as attention-required. A cold held use never becomes quiet merely because its process disappeared. `confirmQuietUse` checks the original identity and revision with a trusted synchronous Host proof; it cannot release a still-active callback. A queued use can cancel before entry without running its callback. Shutdown aborts and drains admitted work; timeout reports failure and retains the kernel lease until that work settles.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One storage-domain record owns each repository's resources, uses and operation receipts. Changes become visible after backend durability. Git and storage are separate commit points: private refs and reciprocal worktree metadata identify an external effect when its receipt is missing. A stable whole-home kernel lease prevents another Host from opening competing mutable resource state.

Repository inspection reads configuration key names without expanding local includes before ordinary Git commands run. Command environment isolates HOME/global configuration, overrides external ignore files with the owner's empty file, and disables hooks, replace objects, monitors and lazy network fetch. Local ignore-rule links reject before evaluation; ignored directories are not traversed. Unsafe includes, executable transforms, nested repositories and unsupported links reject explicitly. Creation uses a private index and raw blobs, then materializes the verified tree without checkout filters.

No runtime invariant companion is published: physical Git/file evidence can legitimately precede its durable receipt while an intent is active. The owning create, reconcile, use and preservation operations validate that relation at their explicit admission and confirmation points; a synchronous periodic assertion would classify those admitted intermediate states as divergence.

See [the service](src/index.ts), [repository observations](src/preview.ts), [durable schemas](src/records.ts) and [managed Git runner](src/git.ts) for the exact contracts.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace registry](../workspace/README.md) — existing project directories and Session attachment.
- [Domain storage](../../storage/storage-domain/README.md) — durability-before-publication record changes.
- [Subprocess service](../../subprocess/subprocess/README.md) — exact argv, byte channels and process-range settlement.
- [File leases](../../util/file-lease/README.md) — stable cross-process kernel exclusion.

-----

<a id="model-experience"></a>
## Model Experience

### Host resource operations

#### What the model sees

`ctx.gitResources` registers no model tools, prompts or model-visible Session events. Consumers choose whether to present its detached resource facts.

#### Token effect

The package adds no request tokens and starts no model request. Consumer-owned presentation determines any indirect context cost.

#### KV Cache effect

Resource observations and mutations do not alter model history or an already reusable prompt prefix. Consumer presentation and provider cache availability remain outside this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This owner manages local regular-file work copies; it is not a sandbox or a universal file rollback service.

- Symbolic links, submodule tree entries, unsafe repository configuration, external object stores, non-UTF-8 paths, drive-qualified selectors and protected credential-shaped paths reject rather than being silently omitted. Drive-looking names also refuse on POSIX instead of acquiring different Windows meanings. Remote repositories, sparse/index extensions and arbitrary custom filters are not accepted as substitutes for a verifiable local baseline.
- Preservation and integration are not business-result acceptance. A versioned seal with remaining ignored content never authorizes cleanup. All-file preservation does not back up distinct unpinned index objects or empty directory state, so those cases explicitly refuse cleanup.
- A caller must establish execution/background quiescence before handback or preservation. The Host must mount a local subprocess provider sharing Node's filesystem; remote execution worlds are unsupported. Full-host external processes can still mutate a directory outside this owner's coordination; observed changes reject instead of proving global confinement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
