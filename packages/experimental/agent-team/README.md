---
description: "Run a small team of named agents in one session: durable messages between members and a shared task board, for deployments composing the experimental Team plugins."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-team` turns one coding session into a small working team: the session's agent becomes the Lead, creates named teammates for delegated work, exchanges durable messages with them, and tracks shared tasks on a common board. Messages and task state survive crashes, reloads, and interruptions, so a teammate that was offline receives its queued messages when it resumes. It provides no tools of its own — mount the sibling `dsh-experimental-tool-agent-team` so the model can create teammates, message them, and use the task board. It is published under its experimental name, carries no stability promise, and needs durable session storage to activate.

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

Add this package to a composition when one agent should run a small team of named helpers in its own working directory, with messages and task state that survive crashes and restarts. It ships no tools of its own: mount it together with `@deepseek-ai/dsh-experimental-tool-agent-team` so the model can create teammates, message them, and use the task board.

### When to choose it

Choose it when several agents must cooperate on one shared workspace and their roster, messages, and task state must survive crashes and restarts. Avoid it when teammates need separate working directories, when several processes must coordinate over one team, or when a task owner should be released automatically — none of those are supported. The team features need durable session storage to activate.

### Smallest working setup

<a id="smallest-working-setup"></a>

The smallest addition to an existing composition is durable session storage plus both Team packages:

```yaml
# smallest team setup — durable storage plus both Team packages
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
- name: '@deepseek-ai/dsh-experimental-agent-team'
- name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

With the tools installed, the model does the rest on request — for example, "create a teammate named reviewer to check the diff", then "send reviewer the change summary". All limits are optional and validated at startup:

| Field | Default | Meaning |
|---|---|---|
| `maxMembers` | `16` | Maximum teammates a team may ever create, including failed ones |
| `maxTasks` | `256` | Maximum active tasks on the board |
| `maxPendingMessagesPerMember` | `64` | Maximum queued messages for one member |
| `maxMessageBytes` | `65,536` | Maximum size of one sent message |
| `disposalTimeoutMs` | `5,000` | Time allowed for shutdown cleanup |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-team) is the exhaustive source for every accepted field and its JSDoc.

### Teammates

Ask the Lead to create a teammate: give it a unique lowercase name such as `reviewer` and describe its job. A teammate starts fresh with no memory of the Lead's conversation, or as a fork that inherits the Lead's completed turns; the creation request chooses which. An explicit Agent Preset is optional; when selected, its declaration revision is recorded and checked before cold recovery, while omission keeps the native inherited composition. Teammate names are permanent — even a failed or retired teammate keeps its name.

The roster shows every member with its role (`lead` or `teammate`) and current status: `running`, `inactive` (no turn is executing, whether loaded or stored), `provisioning`, `failed`, `retiring`, or `retired`. A member that is not loaded receives its messages when it wakes while still active.

Only the Lead can create, interrupt, or retire teammates. Retirement first blocks new Team commands, stops the live execution, and retains the Session history. The Lead must release or reassign unfinished owned tasks and allow queued Team messages to reach the member before retirement; a failed teardown stays `retiring` and finishes on recovery.

### Messages between teammates

Any active member can send a message to another active member or to the Lead. A live member receives it immediately; an offline active member's messages queue and arrive when it resumes. Messages are never lost and never delivered twice.

Every message uses Steer: a running target receives it at the nearest step boundary; an inactive target starts a turn if loaded or cold-resumes otherwise. The sender always sees the outcome — accepted by the target inbox, or retained as queued when delivery is temporarily unavailable. A queued message is already safely stored, so it must not be resent.

The Lead can page through the full original peer-message content, sender, recipient, Task link when supplied, and delivery status. A teammate cannot read third-party message history. An optional Task link names an existing Team Task and is checked against sender/recipient ownership; unlinked older messages remain visible without a fabricated Task. Monitoring reads the same Lead log as delivery and does not relay messages through the Lead.

### Shared task board

Any member can add a task with a title, details, optional dependencies on other tasks, and optional hints about which files it will touch. A new managed Task is claimable only when every prerequisite has an accepted, current result; historical version-two Tasks keep their released completion rule.

Tasks have an owner: claiming a new managed Task starts an Attempt with exact prerequisite revisions. The owner submits a result separately from the request; the Lead alone accepts it and releases downstream work. Quality rejection creates a new Task ID, preserves the old result, and marks accepted descendants stale without inventing or redirecting DAG edges. Release cancels a running Attempt; reassignment starts a new one. Historical version-two Tasks retain their prior complete/reopen transitions. Every change is compare-and-set, so an outdated update cannot overwrite newer work. Reusing the same teammate Session does not merge distinct Tasks.

File hints produce warnings when two in-progress tasks plan to touch overlapping paths — they never block anything. Deleted tasks remain in history but disappear from the active list.

### Waiting and interruption

A member can wait for the next team change — a teammate's status, an incoming message, or a task update — instead of polling repeatedly; the wait reports only whether it timed out, and the caller re-reads the current state afterward.

The Lead can stop a teammate's current turn without deleting its queued messages; task ownership is unchanged.

### What success and failure look like

Success looks like a teammate appearing in the roster, a message reporting `accepted` or `queued`, and task revisions advancing with each change. Likely failures are reported as specific errors instead of silently corrupting state: sending to a name that is not a member, claiming a task that is not ready, editing with an outdated revision, or creating a teammate beyond the member limit.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The service is built on one separation and three commitments:

- **Durable log, derived state.** The Lead Session log is the single source of truth; roster, mailbox, and task state are replayed from it on every read.
- **Process-local ownership.** All coordination lives in one process; the guarantee is retry plus de-duplication, never cross-process consensus.
- **Explicit authority.** Every service method takes the exact live calling `Agent`; only the Lead spawns, reassigns, or interrupts.
- **Bounds that fail loud.** Every limit is a validated deployment value, and exhaustion reports a typed error instead of reusing an id or name.

The [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns the identity, mailbox, task, and shared-checkout decisions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, service registration, recovery scheduling |
| [`src/roster.ts`](src/roster.ts) | Team identity, membership resolution, provisioning, and roster teardown |
| [`src/mailbox.ts`](src/mailbox.ts) | Durable queue, target-local dispatch, acknowledgement, and recovery |
| [`src/task-board.ts`](src/task-board.ts) | Task CAS commands, DAG validation, and derived views |
| [`src/journal.ts`](src/journal.ts) | Serialized Lead-log transactions and commit notification |
| [`src/projection.ts`](src/projection.ts) | Strict replay projection that decodes and validates Team events |
| [`src/activity.ts`](src/activity.ts) | One-shot change waiters and disposal release |
| [`src/lifecycle.ts`](src/lifecycle.ts) | Shared admission cutoff and bounded settlement |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion that replays candidate events before append |

### Team identity and roster

Every ordinary runtime root is the implicit Lead of a Team whose `TeamId` equals its `SessionId`; there is no creation event, and durable state begins with the first member, message, or task record. `spawnTeammate()` first appends and flushes a `provisioning` member record, then asks the configured provider to create the reserved child; a provider failure appends a durable `failed` member. A fresh child starts with no Lead history; a fork child captures the Lead's completed-turn prefix once. An explicit Preset binds the child before its first model request and records the selected declaration revision in both the Team and child Session. Recovery reconciles an unterminated provisioning record against the child's independently persisted Session, including that binding when present. A matching direct parent, continuable descriptor, optional Preset binding, and accepted initial user message produce `active`; otherwise the record becomes `failed`. If recovery wins a same-process race, the creator accepts the terminal state or reports `TEAM_PROVISIONING_CONFLICT` and drains the child. Names are reserved by the first provisioning record and never reused.

### Durable mailbox

`sendMessage()` validates peer membership, appends unlinked `team/message/queued` or Task-linked `team/message/queued-task`, and flushes before attempting delivery. The target message begins with `Team message <id> from <name>:` and keeps the same id and sender in `TeamMessageSource`. A target receipt is acknowledged with `team/message/delivered` only after the target Session durably holds the message identity in its pending inbox or recorded history. Immediate admissions are serialized per target in durable queue order; recovery dispatches queued-minus-delivered records in the same order. Delivery folds both live and persisted target inbox/history state before retrying, so a crash between inbox acceptance and model claim does not duplicate the message. The guarantee is process-local retry plus target-Session de-duplication, not cross-process exactly-once delivery.

Lead delivery calls `Agent.steer()` directly. Teammate delivery uses the continuation owner's host-only Steer path, which preserves the Team sender source while authorizing the Lead-to-child edge and cold-resuming inactive targets. Sibling messages never impersonate the Lead through the public adjacent-Agent messaging operation.

### Shared task board

Tasks are complete versioned snapshots; every mutation carries `expectedRevision`, and a stale caller receives `TEAM_TASK_STALE_REVISION` instead of overwriting a newer value. New Tasks append a `team/task/managed` event whose single transaction can update the Task, Attempt, result, and affected descendants atomically. `submitTaskResult()` does not complete the Task; `acceptTaskResult()` is Lead-only. `reworkTask()` requires settled downstream work, creates a fresh Task with explicit prerequisites, and marks historical downstream results stale without rewriting edges. Numeric `task-<n>` ids require a safe-integer suffix, and id-space exhaustion reports `TEAM_TASK_LIMIT` instead of reusing the final id. Deleted tasks remain tombstones for replay and id stability but do not consume `maxTasks` or appear in `listTasks()`. `writeScopes` are normalized workspace-relative prefixes; views warn on overlap with in-progress tasks but never block claim or authorize writes.

### Waiting and interruption

`waitForChange()` waits for one roster, task, mailbox, or live-status edge that occurs after registration, from ten seconds through one hour, and reports only whether it timed out; runtime disposal releases current waits. Cancellation preserves an Error reason or reports a non-Error reason through `TEAM_WAIT_ABORTED`. `interrupt()` is Lead-only and delegates to the continuable-subagent interrupt path, which cancels only a live teammate's current turn with `keepInbox`; it neither releases task ownership nor deletes durable mail.

### Durability model

Team events are appended to the exact live Lead Session and flushed before the operation reports success or wakes waiters. Existing `team/member`, `team/task`, and `team/message/queued` records keep their released formats; `team/member/configured`, `team/task/managed`, and `team/message/queued-task` add configuration, managed Task results, and Task linkage without changing those formats. These records and `team/message/delivered` are log-only: they never enter the conversation surface, so derived model history is untouched by coordination records. Session event `seq` and `time` own ordering and timing; snapshots do not duplicate them. The `./invariant` companion replays each candidate Team event against its committed prefix and rejects invalid transitions before append.

Native V4 Team event and checkpoint admission reject retired `tool-result` content before it can enter mailbox state. Historical conversion belongs to the Session-format migration; the Team projection does not convert old wrappers.

Mailbox projection and checkpoint admission preserve every decoded JSON field of accepted content outside the locally declared validators, including an own `__proto__` key. Local field checks cover `text`, `reasoning`, `image`, and `tool-call`; accepted unknown tags remain opaque. Team projection cache version 4 rebuilds checkpoints from earlier cache versions from the Session log; the Session format version is unchanged.

### Disposal

Disposal closes admission, aborts and awaits admitted creation and mailbox-dispatch transactions, then asks the continuation owner to release the roster's exact live direct children and their descendants; non-Team continuable children of the Lead remain untouched. Cleanup failures make disposal fail visibly, bounded by `disposalTimeoutMs`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared subsystem types to the tool surface and the decisions behind the design.

- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and the `ctx.agentTeams` service API.
- [tool-agent-team package](../tool-agent-team/README.md) — the tools that let the model create, message, and coordinate teammates.
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) — identity, mailbox, task, and shared-checkout decisions.
- [Experimental package decision](../../../.agents/notes/implemented/architecture/2026-08-18-experimental-agent-teams-packages.md) — placement, publication, and dependency isolation.

-----

<a id="model-experience"></a>

### Browser Remote

`TeamService` exposes read-only `agentTeams/view` and Lead-only paginated `agentTeams/messages` Remote methods for browser clients. Task creation and updates belong to Team agents through the service and model tools. The Client-visible `agentTeamActivity` projection advances after committed member, task, or mailbox events; it carries only a revision number, so a browser can reload the authoritative view without publishing message bodies through the projection. The `./remote` export supplies the Client contribution mounted by the Web UI, while `./client` exports browser-safe roster, task, and Lead message views.

## Model Experience

### Peer messages

#### What the model sees

Each delivered peer message is a user-role message. A short first text block names its stable message id and sender; the sender's original content blocks follow unchanged. Roster, task, and mailbox records are log-only and never enter derived model history.

#### Token effect

Each peer delivery adds the sender prefix plus message content to the target history. Task and roster mutations add no model tokens; their model-facing representation belongs to `@deepseek-ai/dsh-experimental-tool-agent-team` results.

#### KV Cache effect

Peer messages append after the target's reusable history prefix. Cold resume reuses the persisted conversation before appending a previously undelivered item.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what a team cannot do yet or what needs special operational care. They are current package constraints, not a comparison with other coordination mechanisms.

- **Experimental prototype with no stability promise** — the package is public, but its contracts can change freely while it incubates.
- **One process and one shared checkout** — members share cwd and observe edits immediately; this package provides no worktree, remote member, merge, or filesystem lock.
- **Advisory write scopes** — Bash, formatters, code generators, and direct external writers can bypass filesystem version checks; Leads must coordinate ownership and review the final diff.
- **Flat, history-preserving roster** — only the Lead creates direct teammates; retirement stops Team participation but does not delete or archive the child Session. There is no nested Team, rename, deletion, or name reuse.
- **No automatic ownership release** — inactivity, interruption, process exit, and failed work do not release a task owner.
- **Mailbox is not cross-process exactly-once** — concurrent harness processes over one Team are unsupported.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative.

#### Promotion

Promotion to a product-role group requires reviewing the public contract, limitations, test evidence, release payload, runtime dependents, and a named stable owner, per the [experimental subtree rules](../AGENTS.md).

#### Future directions

Undecided directions include nested Teams, automatic ownership release policies, cross-process mailbox transactions, and filesystem isolation via worktrees; none of these are committed.

</details>
