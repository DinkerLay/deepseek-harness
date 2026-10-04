---
description: "Eleven tools that let the model create, message, retire, and coordinate teammates, for compositions mounting the experimental Team plugins."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

English | [中文](README.zh.md)

## Summary

This package lets the model create teammates, message them, wait, interrupt work, retire members, and coordinate through a shared task board. The default policy exposes the same eleven tools to every member and creates teammates only on explicit request. A durable controlled Team mode selects role-scoped tools and guidance; the current `controlledTasks` setting only withholds tools from unmarked Teams in a controlled product composition. The independent `autonomousDelegation` switch changes only the Lead's recruitment guidance. It replaces legacy subagent controls with the same tool names, so compositions that need both must disable the legacy definitions.

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

Add this package on top of `@deepseek-ai/dsh-experimental-agent-team` when the model should run a team through tools. By default every member gets the same eleven tools and coordination policy. In controlled mode the Lead receives a wider collaboration tool set than teammates; `spawn_teammate` only registers the member, whose first real mailbox input starts its execution.

### When to choose it

Choose it when the model should create and coordinate teammates rather than a human driving subagent controls. Avoid it when the legacy global subagent tools with the same names must stay available: the team tools replace them for team members, so a composition that wants both must disable the legacy definitions. By default both native and controlled policies require an explicit user request before recruitment; `autonomousDelegation: true` lets a product Lead recruit when delegation would materially help, independently of controlled mode.

### Smallest working example

The smallest addition to an existing composition is the two-package fragment from the [agent-team README](../agent-team/README.md#smallest-working-setup): durable session storage, the team domain package, and this package. The plugin settings include:

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
  config:
    freshProvider: spawn
    forkProvider: fork
```

| Field | Default | Meaning |
|---|---|---|
| `freshProvider` | `spawn` | Provider that starts fresh teammates |
| `forkProvider` | `fork` | Provider that starts fork teammates |
| `reviewedTasks` | `false` | Guide Task submission and Lead acceptance instead of native completion |
| `controlledTasks` | `false` | Withhold Team tools from unmarked Teams in a controlled product composition; durable mode selects controlled tools and guidance |
| `autonomousDelegation` | `false` | Let the Lead recruit when delegation helps without an explicit Team request; independent of controlled mode |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-tool-agent-team) is the exhaustive source for every accepted field and its JSDoc.

Try it by asking the Lead model: "create a teammate named reviewer to check the diff, then send reviewer the change summary". The model calls the creation tool and then the messaging tool.

### What the model can do

The eleven tools group into five capabilities:

- **Create a teammate** — in official mode `spawn_teammate` takes a name, description, initial task, and optional `preset_id`; in controlled mode it takes a name, optional group and Preset but no caller-authored description or first task. Only the Lead can call it.
- **Send messages** — `send_message` steers a running member at its nearest step boundary, starts or resumes an inactive member.
- **Retire a teammate** — `team_message_cancel` settles undelivered mail, then `retire_teammate` removes a member from Team admission while preserving its history; only the Lead can call them.
- **See and wait** — `list_agents` returns each member’s `target`, availability, and optional applied Profile slot id; `wait_agent` waits for the next team change; `interrupt_agent` stops a teammate's current turn (Lead only).
- **Manage the task board** — `team_task_create`, `team_task_list`, `team_task_get`, and `team_task_update` add, browse, read, and update shared tasks.

Creation and listing results identify members by `target`, with no member Session ID. Use that value in message and interrupt calls or the task tools’ `owner` parameter; task `ownerName` uses the same value. `inactive` means no turn is executing, whether the member is loaded or must be resumed; it does not describe task completion or outcome. `provisioning` and `failed` describe member creation. In the default mode any member can message any other member and use the task board; only the Lead creates and interrupts teammates. Task updates keep the domain's owner and revision checks, so an outdated edit is rejected instead of overwriting newer work.

By default, the model sees the native claim-and-complete Task workflow. A product composition can set `reviewedTasks: true` to instead tell members to submit results for Lead acceptance and to omit `complete` and `reopen` from the model-facing `team_task_update` action enum. A persisted controlled mode selects controlled guidance and seat-specific Team tools even after configuration changes; ordinary Preset tools remain available regardless of Task state. The controlled guidance tells the Lead to write user conditions and acceptance criteria in each Task, connect required Task results through prerequisite paths, and settle even Lead-owned Tasks before its final answer. Members may read accepted indirect upstream results and dispatch authorized additional input work themselves. The controlled Team service denies peer messages. Server-side Task operations enforce their own authorization in every mode.

Releasing a Task cancels its Attempt but does not interrupt an executing member turn or undo file effects. To stop work, the Lead first calls `interrupt_agent`, waits for the member to become inactive, then releases the Task; stale results are rejected by the Task writer. Team does not inspect or block ordinary tool names; product bundles omit delegation plugin rows from their own Presets. Unmarked official Teams retain their default delegation behavior.

### What success and failure look like

Roster tools return only their declared model-facing fields. The native runtime's startup/navigation flag remains available to the Client and does not enter creation or listing tool results.

Sending a message succeeds as soon as it is safely stored: the result is `accepted` (delivered now) or `queued` (waiting), and a queued message must not be resent. `wait_agent` returns `noProgress` right away when no other member is running or provisioning, telling the caller to wake a teammate first; otherwise it waits for the next change and the caller re-reads state afterward. A Lead that takes over the Team does not count its own running turn as another member. Task edits based on an outdated revision are rejected rather than overwriting newer work.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the adapter and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The adapter is built on three commitments:

- **Scoped, not global.** Every registration lives on the member Agent's own `ctx`; installation uses the member identity available when the Agent is published.
- **Declared results, compact JSON.** Every tool declares its complete result schema and renders that value as compact JSON, so the compiler checks `execute` against what the model is promised and no result spends tokens on indentation.
- **The domain owns authority.** Tools delegate to `ctx.agentTeams`, which enforces Lead authority and revision checks; the adapter adds no weaker path.

The [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns the model-facing and scoping decisions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, the selected policy text, and the eleven scoped tool registrations |
| — | No runtime invariant companion is published; the Team service owns durable and authorization relations. |

### Policy and tools

One `team:policy` section on the member scope states the shared coordination rules; its Task workflow wording and the `team_task_update` action enum follow `reviewedTasks`. The eleven tool registrations are declared in [`src/index.ts`](src/index.ts). Tool schemas are registered in scopes recognized as Team members at publication. Scoped registrations with the same names as the legacy global continuable-subagent controls shadow those globals for team members only.

### Scoped registration and teardown

`maybeInstall` runs for every live Agent and subscribes to `agent/created`; it skips Agents without Team membership. Disposal of an Agent runs the installed disposer, and plugin HMR disposes every installed scope before reinstall. Each disposer unwinds registrations in reverse order, so a failed install cannot leave a partial scope.

Native recorded changes refresh the collaboration scope. Owned transitions that open admission refresh it through `agent-team/confirmed` after the durable checkpoint, not an early ready event. A committed but unconfirmed execution therefore receives no premature Lead tools; the confirmed new execution acquires its tools without another model turn. This listener does not filter Preset tools or alter official uncoordinated sessions.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the domain service to the exact schemas and the decisions behind the design.

- [agent-team package](../agent-team/README.md) — the `ctx.agentTeams` domain service behind these tools.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and service API.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-agent-team) — every tool schema the model receives.
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) — model-facing, scoping, and isolation decisions.

-----

<a id="model-experience"></a>
## Model Experience

### Team policy and tools

#### What the model sees

The default system policy states the explicit-delegation requirement, shared-cwd behavior, filesystem stale-version recovery, Bash/formatter/codegen risk, task and write-scope coordination, Steer delivery, the no-retry mailbox rule, and the Lead's duty to wait before answering. The independent autonomy switch replaces only its recruitment guidance. In that mode all eleven Team schemas are identical for Leads and teammates; execution enforces Lead-only operations. Controlled mode instead uses distinct Lead and teammate policies and collaboration tool lists. Its `spawn_teammate` accepts neither a model-authored responsibility nor an initial task. Registration makes no model request; the first mailbox input carries the member name, group, Lead-only coordination rule and instruction to work only on an assigned running Task. The default mode still prefixes its initial user message with the ordinary identity reminder followed by the task.

#### Token effect

Fixed policy and schema cost on every Team member request. The initial identity text follows ordinary history through later steps, cold recovery, and compaction; the plugin neither scans for it nor reinserts it. Tool calls add compact JSON roster, task, wait, or receipt results. Peer content is retained by the Team domain in the target's history.

#### KV Cache effect

With the same provider/model, shared system policy, and tool schemas, a fork retains the parent request prefix and appends the initial task with its identity prefix. Tool results and peer messages append after the reusable request prefix. Sessions recorded with identity inside the system prompt can change that prefix on their first request under this layout; actual provider cache hits remain best-effort.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One-shot child tool visibility** — in-process one-shot children receive their subagent descriptor after publication. Team installation can therefore mistake them for Leads and expose Team policy and tools. Calls are rejected once the descriptor identifies them as non-members. Correcting installation timing is deferred.

These limits describe what the policy and tools cannot guarantee for a team. They are current package constraints, not a comparison with other collaboration surfaces.

- **Prompt policy is coordination, not confinement** — it cannot stop Bash or external processes from writing overlapping files.
- **Autonomy is guidance, not a mandatory delegation trigger** — with the switch enabled, the Lead may still answer simple requests itself.
- **No Web controls** — browser roster and task-board presentation is outside this runtime package.
- **Experimental prototype with no stability promise** — the package is public, but its schemas can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
