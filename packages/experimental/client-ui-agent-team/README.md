---
description: "Use and debug the experimental Web Agent Teams roster, shared task board, and teammate navigation panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package adds an Agent Teams action to the Web conversation header, where a user can inspect the current roster, inspect the shared task board, and navigate into a teammate's conversation. It reads authoritative Team state through the generated `ctx.remote.agentTeams` contribution and keeps ordinary child-history navigation on the stable addressed-subagent path. Choose it through the published experimental Agent Teams bundle. The browser projection does not extend the stable API Proxy, store Team state, or register model-facing input.

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

Enable this package through [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.md), which supplies the Team service, tools, and Web UI together. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect and navigate the roster

Opening the panel calls `agentTeams/view`. Roster rows show durable names, turn availability, model, and diagnostics. Provisioning and running members use the shared ongoing loader, inactive and retired members use idle, retiring members use warning, and failed members use error. Selecting an active or inactive teammate opens the ordinary `{ parentSessionId, childSessionId, mode: 'continuable' }` address from its Lead and roster identity without refreshing or checking the parent catalog; retiring and retired rows stay visible but cannot be opened from the Team panel. The Host validates the parent, child, and mode when history opens. History and later human prompts continue through the stable addressed-subagent conversation path; this package adds no Team-specific address field.

### Inspect the task board

Ready pending tasks use idle, blocked pending tasks use warning, in-progress tasks use ongoing, and completed tasks use done.

The read-only task board places the roster beside a compact task list. Rows show task identity, owner, status, and blockers without expanding the request. Selecting a row opens its complete record, including a GFM-rendered Task description, each Attempt's separately submitted result and artifact references, review validity, advisory write scopes, and overlap warnings. Raw HTML and unsafe links do not execute. The existing panel marks submitted work awaiting Lead review, stale results, and rework replacements without treating a teammate Session as a Task. Historical version-two Tasks still show only their original description. A detail action opens the owner's conversation when that teammate is available, but it does not locate a task-specific Turn. Team agents create and update tasks through their tools; the panel provides no task mutation controls.

The task heading exposes two optional, session-scoped child slots: `agent-team.panel.tasks.action` for a view switch and `agent-team.panel.tasks.graph` for one read-only alternate view. Both receive the current native `TeamView` projection; the action also receives `openGraph` and `active`, while the graph receives `openMemberSession` for an explicit owner-conversation action. If no graph extension is installed, the task list remains the default Task view. An extension must derive its edges from native `blockedBy` and must not maintain a second Team state.

The Lead's Messages view pages through the original peer-message text, sender, recipient, delivery status, and optional Task link without inserting a relay message into the Lead conversation. Non-text blocks remain available as recorded JSON. Teammate Sessions do not show this view, and the Host rejects non-Lead reads. The Lead Session activity signal refreshes the open view after new queue or delivery records.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export mounts the generated `ctx.remote.agentTeams` contribution from [`@deepseek-ai/dsh-experimental-agent-team/remote`](../agent-team/README.md), then registers its locale dictionaries and one conversation-header slot through Cordis effects. Disposing the plugin fiber removes both registrations.

The panel renders outside the conversation container and stays within the viewport. Opening moves focus into the panel; Escape or Close returns focus to its trigger. Clicking outside or moving focus outside the panel and trigger closes it without moving focus back. Opening or refreshing the panel reads the complete Team view. While the Lead Session is open, its `agentTeamActivity` projection triggers a silent view reload after committed member or task changes, so the optional graph follows the Board. Overlapping refreshes keep the newest response, and responses for a previous conversation are ignored.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Generated Remote, locale, navigation, and slot registrations |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Roster, task-board, and optional view-switch interaction state |
| [`src/client/task-view-slots.ts`](src/client/task-view-slots.ts) | Typed child slots for optional task projections |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Teams bundle](../agent-team-profile/README.md) — the published opt-in bundle that mounts this Client plugin.
- [Agent Teams service](../agent-team/README.md) — authoritative roster, task, and Remote behavior.
- [Conversation UI](../../client/ui-conversation/README.md) — the stable header slot and addressed-subagent navigation surface.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser projection registers no model-facing input.

#### KV Cache effect

No direct effect; the Team tools and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Lead-scoped activity** — automatic member, task, and mailbox refresh follows the open Lead Session projection; a teammate's own Session still needs explicit refresh to see changes made elsewhere. Private-message history is available only in the Lead view.
- **Ordinary child continuation** — a human message sent after navigation uses the stable addressed-subagent prompt path, not the Team peer mailbox.
- **No task-specific conversation position** — task ownership identifies a member Session, not the Turn or Step that performed a particular task; the detail action opens that member's conversation without claiming an exact task location.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, and write scopes remain advisory metadata.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. RPC is authoritative; this package owns one disposable header registration and its task-view child declarations.
