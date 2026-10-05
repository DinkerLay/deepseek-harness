/** Scoped model-facing tools for the opt-in Agent Teams runtime. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import type { TeamMemberView } from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ToolDefinition, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-agent-team'
/** Services required by the Team tool plugin. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt']

/** Tool routing configuration. */
export interface Config {
  /** Continuable-subagent provider used for fresh teammates. */
  readonly freshProvider?: string
  /** Continuable-subagent provider used for completed-prefix fork teammates. */
  readonly forkProvider?: string
  /** Use product Task submission and Lead acceptance instead of native complete/reopen. */
  readonly reviewedTasks?: boolean
  /** Withhold Team tools from unmarked Teams in a controlled product composition. */
  readonly controlledTasks?: boolean
  /** Let the Lead recruit teammates when task complexity warrants it, without an explicit Team request. */
  readonly autonomousDelegation?: boolean
}

/** Loader schema for the opt-in Team tool plugin. */
export const Config: z<Config> = z.object({
  freshProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
  reviewedTasks: z.boolean().default(false),
  controlledTasks: z.boolean().default(false),
  autonomousDelegation: z.boolean().default(false),
})

/** Model-facing collaboration guidance shared by Lead and teammates. */
const NATIVE_TASK_WORKFLOW = 'Shared-task workflow is list, get, claim with the current revision, perform the work, then complete.'
const REVIEWED_TASK_WORKFLOW = 'Shared-task workflow is list/get, then claim or Lead reassign, perform the work, use team_task_review to read the running Attempt id, and call team_task_submit_result with that id and current revision. Submission does not complete the Task: the Lead checks it with team_task_review and calls team_task_accept_result. Quality rework uses team_task_rework to create a new Task. Releasing a Task cancels its Attempt but does not stop a running member turn or undo file effects. To stop ongoing work, the Lead uses interrupt_agent, waits until that member is inactive, then releases the Task; a late result is rejected. Do not use complete or reopen.'
const POLICY = (reviewedTasks: boolean, autonomousDelegation: boolean): string => `${autonomousDelegation
  ? 'Agent Teams is available in this session. Answer simple requests yourself; recruit teammates when delegation would materially help, without waiting for an explicit Team request.'
  : 'Agent Teams is available in this session, but create teammates only when the user explicitly asks to use Agent Teams or teammates.'}

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use the target returned by spawn_teammate or list_agents for send_message and interrupt_agent, or as owner when assigning or filtering shared tasks. send_message steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A delivered peer item starts with its stable message id and sender name. A successful send is already durable even when its result says queued; do not resend it. ${reviewedTasks ? REVIEWED_TASK_WORKFLOW : NATIVE_TASK_WORKFLOW} Task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.`

const CONTROLLED_LEAD_POLICY = `Agent Team is available by default. You are lead.

The shared Task Board is the authoritative collaboration channel. Only accepted Task results can serve downstream work. Write each Task's division of work, user-provided conditions and acceptance criteria into its own requirements; teammates cannot see the user's conversation. When a Task needs another Task's result, give it a prerequisite path in blockedBy. An accepted indirect upstream result needs no redundant direct edge. Do not relay another Task's result in ordinary messages. A Task with unaccepted prerequisites may remain a draft, but must not be assigned early. Once prerequisites are accepted, review the current results and explicitly confirm or rewrite a draft's requirements in the same assignment operation. Use team_task_assign for this. Receive member coordination messages, inspect submitted results, and accept or rework them. Before replying with a final answer, ensure no Task remains pending, running, or awaiting acceptance, including your own Task, and handle pending proposals and open claim broadcasts; a chat answer does not complete a Task. Do not treat ordinary messages as accepted Task results. Members may message only lead, not one another. Do not use subagent, workflow, or another delegation path outside Agent Team.

Recruiting a controlled member only registers it; its first Task, message, broadcast or comment delivery starts it. Prefer direct assignment for a known owner. Use a claim broadcast only to find applicants, then approve before they work. Notification broadcasts coordinate operations and never carry Task results. Create the current independent batch, not later phases whose requirements depend on unaccepted results; keep future planning in your personal todo.

Messages clarify, remind, correct or authorize existing work; they do not replace a Task assignment. Write changed deliverables back into the Task. If urgent, interrupt the member before messaging it. When Auto blocks a member operation, decide whether it is needed. If so, write the exact action, target and scope in your own words; do not copy a member's request or result as authorization. Member-authored requirements need your actual rewrite or a separate explicit authorization. A member run-completion notice is not Task completion: inspect its unsubmitted Attempts before waiting or closing the work.`
const CONTROLLED_MEMBER_POLICY = 'You are a controlled Agent Team teammate. Registration does not start work: your first input is the actual Team delivery, with a system identity reminder. Work only on a running Task assigned to you. A claim broadcast allows an application, not work; wait for Lead approval and an assignment. Without a running Attempt do not research, run commands, or edit files. Use Team read-only queries, a message to lead, an allowed comment response, or a broadcast application.\n\nThe Task requirements provide your division of work, user conditions and acceptance criteria. Read accepted results from direct or transitive DAG upstream Tasks through the Task Board; unrelated results remain forbidden. Submit formal work for Lead acceptance, never through messages, comments or broadcasts. If a required input has no prerequisite path, report it to lead and do not submit that Attempt; lead must stop and repair or replace it.\n\nMessage only lead for blockers and clarification. If authorized and an extra input is needed, dispatch a Task yourself; otherwise propose one for Lead review. You may comment on a related executing Task, apply to a claim broadcast while busy, or release your running Task. Do not edit, delete, reassign or complete Tasks directly. A Lead message clarifies or authorizes existing work and does not assign a new Task. When Auto blocks an operation, do not repeatedly retry it unchanged: report the operation and reason to lead, and wait for explicit authorization or another approach. Member run completion is not Task completion.'

const RECRUITMENT_POLICY = (autonomousDelegation: boolean): string => autonomousDelegation
  ? 'Handle simple work yourself rather than recruiting unnecessarily. This decides who executes, not whether a deliverable needs a Task: follow the product Task policy for your own work too. When delegation would materially help, use agent_find to identify a suitable Preset and recruit teammates without waiting for the user to mention Agent Team.'
  : 'Create teammates only when the user explicitly asks for Team collaboration or teammates.'

const NATIVE_TASK_ACTIONS = ['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'] as const
const REVIEWED_TASK_ACTIONS = ['claim', 'release', 'edit', 'set_dependencies', 'reassign', 'delete'] as const
const CONTROLLED_MEMBER_TASK_ACTIONS = ['release'] as const

const ACTIVE_WAIT_STATUSES: ReadonlySet<TeamMemberView['status']> = new Set(['running', 'provisioning'])
const NO_ACTIVE_PEER_MESSAGE = 'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.'

/**
 * One model-facing roster row. The Lead pseudo-row omits the
 * teammate-only provisioning fields, so only identity, role, status, and
 * diagnostics are required.
 */
const MEMBER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: { type: 'string', required: true },
    role: { type: 'string', required: true, enum: ['lead', 'teammate'] },
    status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed', 'retiring', 'retired'] },
    description: { type: 'string' },
    group: { type: 'string' },
    slotId: { type: 'string' },
    provider: { type: 'string' },
    context: { type: 'string', enum: ['fresh', 'fork'] },
    preset: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        revision: { type: 'string', required: true },
      },
    },
    model: { type: 'string' },
    diagnostics: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** Expose the addressable member row without runtime-only Client navigation flags. */
function modelMember(member: TeamMemberView): InferValue<typeof MEMBER_VIEW_SCHEMA> {
  const { id: _id, name, executionStarted: _executionStarted, execution: _execution, ...details } = member
  return { target: name, ...details }
}

/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    subject: { type: 'string', required: true },
    description: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    ownerName: { type: 'string' },
    blockedBy: { type: 'array', required: true, items: { type: 'string' } },
    writeScopes: { type: 'array', required: true, items: { type: 'string' } },
    ready: { type: 'boolean', required: true },
    resultUnavailable: { type: 'boolean' },
    dispatchBlocked: { type: 'boolean', enum: [true] },
    writeScopeWarnings: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

const CONTROLLED_TASK_VIEW_SCHEMA = {
  ...TASK_VIEW_SCHEMA,
  properties: { ...TASK_VIEW_SCHEMA.properties,
    suggestedActions: { type: 'array', items: { type: 'string' } },
  },
} as const

const SPAWN_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    member: { ...MEMBER_VIEW_SCHEMA, required: true },
  },
} as const

const MEMBER_LIST_VALUE_SCHEMA = { type: 'array', items: MEMBER_VIEW_SCHEMA } as const

const SEND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['accepted', 'queued'] },
  },
} as const

const CANCEL_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    messageIds: { type: 'array', required: true, items: { type: 'string' } },
  },
} as const

/** `noProgress` is present only on the model-only shortcut that skips the wait. */
const WAIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    timedOut: { type: 'boolean', required: true },
    noProgress: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', required: true, const: 'no-active-peer' },
        message: { type: 'string', required: true },
      },
    },
  },
} as const

const INTERRUPT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    previousStatus: { type: 'string', required: true, enum: ['running', 'inactive'] },
  },
} as const

const TASK_LIST_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: { type: 'array', required: true, items: TASK_VIEW_SCHEMA },
    nextCursor: { type: 'integer' },
  },
} as const

/**
 * Declare one canonical output schema with compact model-facing JSON. Every
 * Team result is a fixed record, so the declared schema is what makes the
 * compiler check `execute` against the value the model is promised.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  /* v8 ignore next 2 -- Team tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
  if (agent === undefined) throw new Error(`${toolName} requires a calling Agent`)
  return agent
}

/** Register the complete Team tool set in one exact Agent scope. */
function install(agent: Agent, ctx: Context, config: Required<Config>): () => void {
  const scoped = agent.ctx
  const membership = ctx.agentTeams.membership(agent)
  const controlledLead = config.controlledTasks && membership.role === 'lead'
  const controlledMember = config.controlledTasks && membership.role === 'teammate'
  const disposers: Array<() => unknown> = []
  const register = (disposer: () => unknown): void => { disposers.push(disposer) }
  const registerTeamTool = (tool: ToolDefinition): () => void => scoped.tools.register(tool)
  try {
    register(scoped.systemPrompt.section({
      name: 'team:policy',
      order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: controlledLead ? `${RECRUITMENT_POLICY(config.autonomousDelegation)}\n\n${CONTROLLED_LEAD_POLICY}`
        : controlledMember ? CONTROLLED_MEMBER_POLICY : POLICY(config.reviewedTasks, config.autonomousDelegation),
    }))

    if (!controlledMember) {
      register(registerTeamTool(defineTool({
        name: 'spawn_teammate',
        description: 'Create one named, durable teammate. Only the Team Lead may call this tool.',
        parameters: {
          name: { type: 'string', required: true, description: 'Unique lower-kebab-case teammate name.' },
          ...config.controlledTasks ? {} : { description: {
            type: 'string', required: true as const, description: 'Short description of the delegated responsibility.',
          } },
          group: { type: 'string', description: 'Optional durable collaboration group, distinct from the teammate name.' },
          ...config.controlledTasks ? {} : { prompt: { type: 'string', required: true as const, description: 'Complete initial task for the teammate.' } },
          ...config.controlledTasks ? {} : { context: {
            type: 'string',
            enum: ['fresh', 'fork'],
            description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
          } },
          preset_id: { type: 'string', description: (typeof ctx.agentTeams.defaultMemberPresetId !== 'function'
            || ctx.agentTeams.defaultMemberPresetId() === undefined)
            ? 'Optional declared Agent Preset for this teammate; omit to inherit the Lead composition.'
            : 'Optional declared Agent Preset for this teammate; omit to use the configured member default.' },
        },
        output: jsonOutput(SPAWN_VALUE_SCHEMA),
        async execute(args, exec) {
          const agent = callingAgent(exec.agent, 'spawn_teammate')
          const context = config.controlledTasks ? 'fresh' : args.context ?? 'fresh'
          const result = await ctx.agentTeams.spawnTeammate(agent, {
            name: args.name,
            ...args.description === undefined ? {} : { description: args.description },
            ...args.group === undefined ? {} : { group: args.group },
            prompt: config.controlledTasks ? [] : [
              { type: 'text', text: `<system-reminder>
You are teammate "${args.name.trim()}".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

` },
              // The normal catalog requires prompt; the controlled catalog has no prompt field.
              { type: 'text', text: args.prompt as string },
            ],
            context,
            provider: context === 'fork' ? config.forkProvider : config.freshProvider,
            ...args.preset_id === undefined ? {} : { presetId: args.preset_id },
            signal: exec.signal,
          })
          return { member: modelMember(result.member) }
        },
      })))
    }

    register(registerTeamTool(defineTool({
      name: 'send_message',
      description: 'Send one durable message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn.',
      parameters: {
        target: { type: 'string', required: true, description: 'Member target returned by spawn_teammate or list_agents, including lead.' },
        message: { type: 'string', required: true, description: 'Self-contained message for the target.' },
      },
      output: jsonOutput(SEND_VALUE_SCHEMA),
      execute(args, exec) {
        return ctx.agentTeams.sendMessage(callingAgent(exec.agent, 'send_message'), {
          target: args.target,
          content: [{ type: 'text', text: args.message }],
          signal: exec.signal,
        })
      },
    })))

    register(registerTeamTool(defineTool({
      name: 'list_agents',
      description: 'List the Lead and every durable teammate with an addressable target and current availability. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.',
      parameters: {},
      output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
      execute(_args, exec) {
        return Promise.resolve(ctx.agentTeams.listMembers(callingAgent(exec.agent, 'list_agents')).map(modelMember))
      },
    })))

    if (!controlledMember) {
      register(registerTeamTool(defineTool({
        name: 'wait_agent',
        description: 'Wait for the next teammate status, mailbox, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.',
        parameters: {
          timeout_ms: {
            type: 'integer',
            description: 'Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.',
          },
        },
        output: jsonOutput(WAIT_VALUE_SCHEMA),
        async execute(args, exec) {
          const caller = callingAgent(exec.agent, 'wait_agent')
          const timeoutMs = args.timeout_ms ?? 30_000
          // Preserve TeamService's authoritative timeout validation before the
          // model-only no-progress shortcut.
          if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
            return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
          }
          // The active-peer read and waiter registration must remain one synchronous
          // span; awaiting between them can lose the only peer-status edge.
          // The Lead roster row keeps its anchor id when its execution changes.
          const hasActivePeer = ctx.agentTeams.listMembers(caller).some(member =>
            member.name !== membership.name && ACTIVE_WAIT_STATUSES.has(member.status))
          if (!hasActivePeer) {
            return {
              timedOut: false,
              noProgress: {
                reason: 'no-active-peer' as const,
                message: NO_ACTIVE_PEER_MESSAGE,
              },
            }
          }
          return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal)
        },
      })))
    }

    if (!controlledMember) {
      register(registerTeamTool(defineTool({
        name: 'interrupt_agent',
        description: 'Interrupt one teammate\'s current turn while preserving its pending inbox. Team Lead only.',
        parameters: {
          target: { type: 'string', required: true, description: 'Teammate target returned by spawn_teammate or list_agents.' },
        },
        output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
        execute(args, exec) {
          return Promise.resolve(ctx.agentTeams.interrupt(callingAgent(exec.agent, 'interrupt_agent'), args.target))
        },
      })))

      register(registerTeamTool(defineTool({
        name: 'retire_teammate',
        description: 'Remove a teammate from Team admission while retaining its Session history. Team Lead only; first resolve unfinished owned tasks and pending Team messages.',
        parameters: {
          target: { type: 'string', required: true, description: 'Teammate target returned by list_agents.' },
        },
        output: jsonOutput(MEMBER_VIEW_SCHEMA),
        async execute(args, exec) {
          const member = await ctx.agentTeams.retireTeammate(callingAgent(exec.agent, 'retire_teammate'), args.target)
          return modelMember(member)
        },
      })))

      register(registerTeamTool(defineTool({
        name: 'team_message_cancel',
        description: 'Cancel undelivered messages to one teammate before retirement. Team Lead only; delivered messages and Session history stay intact.',
        parameters: {
          target: { type: 'string', required: true, description: 'Teammate target returned by list_agents.' },
          reason: { type: 'string', required: true, description: 'Why the pending messages must not be delivered.' },
        },
        output: jsonOutput(CANCEL_VALUE_SCHEMA),
        async execute(args, exec) {
          const messageIds = await ctx.agentTeams.cancelPendingMessages(
            callingAgent(exec.agent, 'team_message_cancel'), args.target, args.reason,
          )
          return { messageIds: [...messageIds] }
        },
      })))
    }

    if (!controlledMember) {
      register(registerTeamTool(defineTool({
        name: 'team_task_create',
        description: 'Create one unowned pending task on the shared Team task board.',
        parameters: {
          subject: { type: 'string', required: true, description: 'Concise task title.' },
          description: { type: 'string', required: true, description: 'Complete task details and acceptance criteria.' },
          blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task ids that must complete first.' },
          write_scopes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Advisory workspace-relative file or directory prefixes this task expects to modify.',
          },
        },
        output: jsonOutput(TASK_VIEW_SCHEMA),
        async execute(args, exec) {
          return await ctx.agentTeams.createTask(callingAgent(exec.agent, 'team_task_create'), {
            subject: args.subject,
            description: args.description,
            ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
            ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
          })
        },
      })))
    }

    register(registerTeamTool(defineTool({
      name: 'team_task_list',
      description: 'List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.',
      parameters: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'Optional exact status filter.',
        },
        owner: { type: 'string', description: 'Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner.' },
        ready: { type: 'boolean', description: 'Optional readiness filter.' },
        cursor: { type: 'integer', description: 'Zero-based result offset. Defaults to 0.' },
        limit: { type: 'integer', description: 'Number of rows, 1 through 100. Defaults to 50.' },
      },
      output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
      execute(args, exec) {
        const status = args.status
        const filtered = ctx.agentTeams.listTasks(callingAgent(exec.agent, 'team_task_list')).filter(task =>
          (status === undefined || task.status === status)
          && (args.owner === undefined || (args.owner === 'unowned' ? task.ownerName === undefined : task.ownerName === args.owner))
          && (args.ready === undefined || task.ready === args.ready))
        const cursor = args.cursor ?? 0
        const limit = args.limit ?? 50
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative safe integer')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100')
        return Promise.resolve({
          tasks: filtered.slice(cursor, cursor + limit),
          ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
        })
      },
    })))

    register(registerTeamTool(defineTool({
      name: 'team_task_get',
      description: 'Read the complete latest value of one shared task before changing or executing it.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
      },
      output: jsonOutput(TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        return Promise.resolve(ctx.agentTeams.getTask(
          callingAgent(exec.agent, 'team_task_get'),
          TeamTaskId(args.task_id),
        ))
      },
    })))

    register(registerTeamTool(defineTool({
      name: 'team_task_update',
      description: config.reviewedTasks
        ? 'Compare-and-set a shared Task action. Submit results with team_task_submit_result; only the Lead accepts them.'
        : 'Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'Shared task id.' },
        expected_revision: { type: 'integer', required: true, description: 'Current task revision used as the CAS precondition.' },
        action: {
          type: 'string',
          required: true,
          enum: controlledMember ? CONTROLLED_MEMBER_TASK_ACTIONS : config.reviewedTasks ? REVIEWED_TASK_ACTIONS : NATIVE_TASK_ACTIONS,
          description: 'Task transition to apply.',
        },
        subject: { type: 'string', description: 'Replacement title for edit.' },
        description: { type: 'string', description: 'Replacement details for edit.' },
        blocked_by: { type: 'array', items: { type: 'string' }, description: 'Complete blocker list for set_dependencies.' },
        write_scopes: { type: 'array', items: { type: 'string' }, description: 'Replacement advisory write scopes for edit.' },
        owner: { type: 'string', description: 'Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign.' },
      },
      output: jsonOutput(controlledMember ? CONTROLLED_TASK_VIEW_SCHEMA : TASK_VIEW_SCHEMA),
      async execute(args, exec) {
        const caller = callingAgent(exec.agent, 'team_task_update')
        const task = await ctx.agentTeams.updateTask(caller, {
          taskId: TeamTaskId(args.task_id),
          expectedRevision: args.expected_revision,
          action: args.action,
          ...args.subject === undefined ? {} : { subject: args.subject },
          ...args.description === undefined ? {} : { description: args.description },
          ...args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
          ...args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes },
          ...args.owner === undefined ? {} : { owner: args.owner },
        })
        return { ...task, ...controlledMember && args.action === 'release'
          ? { suggestedActions: [...ctx.agentTeams.releaseHints(caller)] } : {} }
      },
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/** Install Team tools in every live or subsequently published Team member scope. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: Required<Config> = {
    freshProvider: config.freshProvider ?? 'spawn',
    forkProvider: config.forkProvider ?? 'fork',
    reviewedTasks: config.reviewedTasks ?? false,
    controlledTasks: config.controlledTasks ?? false,
    autonomousDelegation: config.autonomousDelegation ?? false,
  }
  const installed = new Map<Agent, () => void>()
  const maybeInstall = (agent: Agent): void => {
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership === undefined || membership.role === 'host') {
      installed.get(agent)?.()
      installed.delete(agent)
      return
    }
    if (installed.has(agent)) return
    const controlled = ctx.agentTeams.controlledMode(agent) !== undefined
    if (resolved.controlledTasks && !controlled) return
    installed.set(agent, install(agent, ctx, {
      ...resolved,
      controlledTasks: controlled,
      reviewedTasks: controlled || resolved.reviewedTasks,
    }))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'team/lead/transaction' && event.type !== 'team/extension') return
    for (const agent of ctx.agents.list()) maybeInstall(agent)
  })
  ctx.on('agent-team/confirmed', () => {
    for (const agent of ctx.agents.list()) maybeInstall(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  }, 'tool-team.scopedTools()')
}
