/** Team membership, continuable-child provisioning, and roster-owned teardown. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { foldContinuablePreset, foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { ContinuablePresetBinding, ContinuableStart } from '@deepseek-ai/dsh-subagent'
import { errorMessage, TeamError } from './error.ts'
import type { TeamJournal } from './journal.ts'
import type { TeamRuntimeLifecycle } from './lifecycle.ts'
import { readPersistedSession } from './persisted.ts'
import type { TeamState } from './projection.ts'
import { messageAccepted } from './session-message.ts'
import { TeamId } from './types.ts'
import type {
  SpawnTeammateRequest,
  SpawnTeammateResult,
  TeamMemberLegacySnapshot,
  TeamMemberSnapshot,
  TeamMemberView,
} from './types.ts'
import { requiredText } from './validation.ts'

const MEMBER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const DELEGATION_PRESET_MODULES = new Set([
  '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-subagent-control/list-agents', '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-workflow-ptc', '@deepseek-ai/dsh-tool-ralph',
])

/** Fixed first input for a controlled teammate; caller-authored work is ignored. */
function controlledStandbyPrompt(name: string, group: string | undefined, description: string) {
  return [{ type: 'text' as const, text: `<system-reminder>
You are teammate "${name}" in group "${group ?? 'unassigned'}".
Your Team Lead is "lead". Your responsibility is: ${description}.
Remain on standby until a Task is assigned. Read the Task Board when needed and send coordination questions only to lead. Do not message another teammate or start unassigned work.
</system-reminder>` }]
}

/** Caller identity inside one implicit Team. */
export interface TeamMembership {
  readonly root: Agent
  readonly id: TeamId
  readonly role: 'lead' | 'teammate'
  readonly name: string
}

/**
 * Resolve one active Team member by model-facing name, including the Lead pseudo-row.
 * @param root - exact live Team Lead.
 * @param state - current Team state.
 * @param rawName - candidate member name.
 * @returns resolved durable id and normalized name.
 */
export function resolveActiveMember(
  root: Agent,
  state: TeamState,
  rawName: string,
): { id: SessionId; name: string } {
  const name = rawName.trim()
  if (name === 'lead') return { id: root.id, name }
  const member = state.members.find(candidate => candidate.name === name)
  if (member === undefined || member.phase !== 'active') {
    throw new TeamError(`active teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
  }
  return { id: member.id, name }
}

/** Owns Team identities and the lifecycle of rostered continuable children. */
export class TeamRoster {
  private readonly inFlightCreations = new Set<Promise<unknown>>()

  /**
   * @param ctx - Team service context with Agent, Session, persistence, and subagent services.
   * @param journal - authoritative Lead-log transaction owner.
   * @param lifecycle - shared Team runtime admission cutoff.
   * @param maxMembers - maximum immutable roster entries per Team.
   * @param maxActiveMembers - maximum provisioning, active, or retiring entries per Team.
   */
  constructor(
    private readonly ctx: Context,
    private readonly journal: TeamJournal,
    private readonly lifecycle: TeamRuntimeLifecycle,
    private readonly maxMembers: number,
    private readonly maxActiveMembers: number,
  ) {}

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    const membership = this.tryMembership(agent)
    if (membership === undefined) {
      throw new TeamError(`agent "${agent.id}" is not a member of an active Agent Team`, 'TEAM_NOT_MEMBER')
    }
    return membership
  }

  /**
   * Resolve a caller without throwing for scoped installation and lifecycle observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents and stale identities.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    if (this.ctx.agents.get(agent.id) !== agent) return undefined
    try {
      const parentId = agent.session.header.parentSession
      if (parentId !== undefined) {
        const root = this.ctx.agents.get(parentId)
        if (root !== undefined) {
          const member = this.journal.state(root).members.find(candidate => candidate.id === agent.id)
          if (member?.phase === 'active' || member?.phase === 'provisioning') {
            return { root, id: TeamId(root.id), role: 'teammate', name: member.name }
          }
          // A direct child outside the durable roster is not a teammate. Ordinary
          // host forks are independent roots; subagent descriptors distinguish
          // provider-owned workers that must not receive a nested Team identity.
          if (this.subagentDescriptor(agent)) return undefined
          return { root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' }
        }
      }
      // A continuation can briefly outlive its parent during child-first teardown.
      // Do not reinterpret that durable child as a new implicit root Team. A host-
      // resumed ordinary fork has no descriptor in its own suffix and remains a
      // valid new root whose inherited Team records stay outside its projected Team state.
      if (this.subagentDescriptor(agent)) return undefined
      return { root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' }
    } catch {
      // This method is used by lifecycle observers and teardown discovery. A
      // malformed durable stream is surfaced by authoritative Team operations;
      // the non-throwing probe must not veto unrelated Agent lifecycle edges.
      return undefined
    }
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param membership - exact caller membership resolved by this roster.
   * @returns Lead and teammate rows in creation order.
   */
  list(membership: TeamMembership): TeamMemberView[] {
    const { root } = membership
    const state = this.journal.state(root)
    const result: TeamMemberView[] = [{
      id: root.id,
      name: 'lead',
      role: 'lead',
      status: availability(root),
      ...root.options.model === undefined ? {} : { model: root.options.model },
      diagnostics: [],
    }]
    for (const member of state.members) {
      const live = this.ctx.agents.get(member.id)
      const model = live?.options.model ?? root.options.model
      result.push({
        id: member.id,
        name: member.name,
        role: 'teammate',
        status: member.phase === 'retiring' || member.phase === 'retired' || member.phase === 'failed'
          || member.phase === 'provisioning' ? member.phase : availability(live),
        description: member.description,
        ...member.group === undefined ? {} : { group: member.group },
        provider: member.provider,
        context: member.context,
        ...member.preset === undefined ? {} : { preset: member.preset },
        ...model === undefined ? {} : { model },
        diagnostics: member.error === undefined ? [] : [member.error],
      })
    }
    return result
  }

  /**
   * Create one named, continuable direct child of the Team Lead.
   * @param caller - exact live Lead Agent.
   * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
   * @returns the active roster row.
   */
  async spawn(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    const operation = this.spawnAdmitted(caller, request)
    this.inFlightCreations.add(operation)
    try {
      return await operation
    } finally {
      this.inFlightCreations.delete(operation)
    }
  }

  /**
   * Return admitted creation operations captured for ordered disposal.
   * @returns detached snapshot ordered only by Set insertion.
   */
  pendingCreations(): readonly Promise<unknown>[] {
    return [...this.inFlightCreations]
  }

  /**
   * Reconcile provisioning state when one Team member Session starts.
   * @param agent - newly started exact live Agent.
   * @param signal - shared runtime cancellation.
   */
  async recoverFor(agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const membership = this.tryMembership(agent)
    if (membership?.role === 'lead') {
      await this.reconcileProvisioning(membership.root, signal)
      await this.reconcileRetiring(membership.root, signal)
    }
  }

  /**
   * Remove a member from Team admission without deleting its Session history.
   * Unfinished assignments and undelivered mail must be settled first.
   * @param caller - exact live Lead Agent authorizing removal.
   * @param targetName - immutable teammate name.
   * @returns the retired roster row after its live activation is stopped.
   */
  async retire(caller: Agent, targetName: string): Promise<TeamMemberView> {
    const membership = this.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can retire teammates', 'TEAM_LEAD_REQUIRED')
    const root = membership.root
    this.journal.assertWriteAdmission(root)
    const name = targetName.trim()
    const member = await this.journal.transact(root.id, async () => {
      if (this.ctx.agents.get(root.id) !== root) throw new TeamError('Team Lead is no longer live', 'TEAM_NOT_MEMBER')
      const state = this.journal.state(root)
      const current = state.members.find(candidate => candidate.name === name)
      if (current === undefined) throw new TeamError(`teammate "${name}" not found`, 'TEAM_MEMBER_NOT_FOUND')
      if (current.phase === 'retired' || current.phase === 'retiring') return current
      if (current.phase !== 'active' && current.phase !== 'failed') {
        throw new TeamError(`teammate "${name}" is not active or failed`, 'TEAM_MEMBER_NOT_ACTIVE')
      }
      const assignment = state.tasks.find(task => task.ownerId === current.id
        && task.status !== 'completed' && task.status !== 'deleted')
      if (assignment !== undefined) {
        throw new TeamError(`release or reassign task "${assignment.id}" before retiring "${name}"`, 'TEAM_MEMBER_HAS_TASKS')
      }
      const pending = state.messages.find(message => message.targetId === current.id
        && !state.delivered.includes(message.id)
        && !state.cancelled.some(item => item.messageId === message.id))
      if (pending !== undefined) {
        throw new TeamError(`deliver Team message "${pending.id}" before retiring "${name}"`, 'TEAM_MEMBER_HAS_MESSAGES')
      }
      const retiring: TeamMemberSnapshot = { ...current, phase: 'retiring' }
      await this.appendMember(root, retiring)
      return retiring
    })
    if (member.phase !== 'retired') await this.finishRetirement(root, member.id)
    const result = this.list(membership).find(row => row.id === member.id)
    if (result === undefined) throw new TeamError(`retired teammate "${name}" disappeared`, 'TEAM_MEMBER_NOT_FOUND')
    return result
  }

  /**
   * Interrupt one live teammate turn without clearing its pending inbox.
   * @param caller - exact live Lead Agent.
   * @param targetName - durable teammate name.
   * @returns the target status sampled before cancellation.
   */
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' } {
    const membership = this.membership(caller)
    if (membership.role !== 'lead') throw new TeamError('only the Team Lead can interrupt teammates', 'TEAM_LEAD_REQUIRED')
    const state = this.journal.state(membership.root)
    this.journal.assertWriteAdmission(membership.root)
    const target = resolveActiveMember(membership.root, state, targetName)
    if (target.id === membership.root.id) throw new TeamError('the Team Lead cannot interrupt itself', 'TEAM_INVALID_TARGET')
    const live = this.ctx.agents.get(target.id)
    if (live === undefined) return { previousStatus: 'inactive' }
    const previousStatus = availability(live)
    this.ctx.subagents.interrupt(target.id, { kind: 'ancestor', agent: caller })
    return { previousStatus }
  }

  /**
   * Group exact live roster children by their current Lead for runtime teardown.
   * @returns each live Lead and the roster child ids currently in the Agent registry.
   */
  liveChildrenByRoot(): Map<Agent, SessionId[]> {
    const teams = new Map<Agent, SessionId[]>()
    for (const agent of this.ctx.agents.list()) {
      const rootId = agent.session.header.parentSession
      if (rootId === undefined) continue
      const root = this.ctx.agents.get(rootId)
      if (root === undefined
        || !this.journal.state(root).members.some(member => member.id === agent.id)) continue
      const children = teams.get(root) ?? []
      children.push(agent.id)
      teams.set(root, children)
    }
    return teams
  }

  /**
   * Release exact teammate Activations through the continuation lifecycle owner.
   * @param root - exact live Team Lead authorizing release.
   * @param childIds - selected roster child ids.
   */
  async stopTeammates(root: Agent, childIds: readonly SessionId[]): Promise<void> {
    await this.lifecycle.withTimeout(this.ctx.subagents.drainContinuableChildren(root, childIds))
  }

  /** Perform one creation admitted before the Team runtime disposal cutoff. */
  private async spawnAdmitted(
    caller: Agent,
    request: SpawnTeammateRequest,
  ): Promise<SpawnTeammateResult> {
    const membership = this.membership(caller)
    if (membership.role !== 'lead') {
      throw new TeamError('only the Team Lead can create teammates', 'TEAM_LEAD_REQUIRED')
    }
    const signal = AbortSignal.any([request.signal, this.lifecycle.signal])
    signal.throwIfAborted()
    const root = membership.root
    this.journal.assertWriteAdmission(root)
    const name = this.memberName(request.name)
    const description = requiredText(request.description, 'description', 200)
    const group = request.group === undefined ? undefined : requiredText(request.group, 'group', 64)
    let preset: ContinuablePresetBinding | undefined
    const mode = this.journal.state(root).mode
    if (mode !== undefined && request.context !== 'fresh') {
      throw new TeamError('controlled teammates require fresh context', 'TEAM_INVALID_ARGUMENT')
    }
    if (request.presetId !== undefined || mode !== undefined) {
      const registry = this.ctx.get('agentPresets')
      if (registry === undefined) throw new TeamError('explicit teammate preset requires the Agent Preset registry', 'TEAM_PRESET_UNAVAILABLE')
      const selectedId = request.presetId ?? root.session.header.agentPreset ?? registry.defaultId
      await using lease = await registry.acquireComposition(selectedId)
      if (lease.revision === undefined) {
        throw new TeamError(`preset "${lease.id}" has no durable declaration revision`, 'TEAM_PRESET_UNAVAILABLE')
      }
      if (mode !== undefined && lease.compositionRows.some(row =>
        row.enabled !== false && DELEGATION_PRESET_MODULES.has(row.moduleName))) {
        throw new TeamError(`preset "${lease.id}" exposes delegation outside Agent Team`, 'TEAM_UNSAFE_PRESET')
      }
      preset = { id: lease.id, revision: lease.revision }
    }
    const childId = brandString<SessionId>(randomUUID())
    const member: TeamMemberSnapshot = {
      id: childId,
      name,
      description,
      ...group === undefined ? {} : { group },
      provider: requiredText(request.provider, 'provider', 200),
      context: request.context,
      ...preset === undefined ? {} : { preset },
      phase: 'provisioning',
    }

    await this.journal.transact(root.id, async () => {
      const state = this.journal.state(root)
      if (state.members.some(member => member.name === name)) {
        throw new TeamError(`teammate name "${name}" was already used in this Team`, 'TEAM_MEMBER_NAME_TAKEN')
      }
      if (state.members.length >= this.maxMembers) {
        throw new TeamError(`Team member limit ${this.maxMembers} reached`, 'TEAM_MEMBER_LIMIT')
      }
      const activeCount = state.members.filter(candidate => candidate.phase === 'provisioning'
        || candidate.phase === 'active' || candidate.phase === 'retiring').length
      if (activeCount >= this.maxActiveMembers) {
        throw new TeamError(`active Team member limit ${this.maxActiveMembers} reached`, 'TEAM_ACTIVE_MEMBER_LIMIT')
      }
      await this.appendMember(root, member)
    })

    let started: ContinuableStart
    try {
      started = await this.ctx.subagents.startContinuable({
        childId,
        provider: request.provider,
        label: description,
        request: {
          prompt: mode === undefined ? request.prompt : controlledStandbyPrompt(name, group, description),
          parent: root,
        },
        ...preset === undefined ? {} : { preset },
        signal,
      })
      await this.checkpointInitialPrompt(childId, started.messageId, signal)
    } catch (error: unknown) {
      const failed: TeamMemberSnapshot = {
        ...member,
        phase: 'failed',
        error: errorMessage(error),
      }
      try {
        const phase = await this.settleProvisioning(root, failed)
        await this.stopTeammates(root, [childId])
        if (phase === 'active') {
          throw new TeamError(
            `teammate "${name}" became active while its creator reported failure`,
            'TEAM_PROVISIONING_CONFLICT',
            { cause: error },
          )
        }
      } catch (recordError: unknown) {
        throw new AggregateError([error, recordError], 'teammate creation and durable failure recording both failed')
      }
      throw error
    }
    const active = {
      ...member,
      phase: 'active' as const,
    } satisfies TeamMemberSnapshot
    // Once the continuation accepted its first prompt, it is a real child. If
    // this checkpoint fails, keep the in-memory active edge instead of inventing
    // an impossible active -> failed transition; restart reconciliation covers
    // the provisioning-only durable prefix.
    const settledPhase = await this.settleProvisioning(root, active)
    if (settledPhase === 'failed') {
      const conflict = new TeamError(
        `teammate "${name}" was reconciled as failed while creation was in progress`,
        'TEAM_PROVISIONING_CONFLICT',
      )
      try {
        await this.stopTeammates(root, [childId])
      } catch (cleanupError: unknown) {
        /* v8 ignore next -- requires the independently tested HMR settlement conflict and cleanup failure together. */
        throw new AggregateError([conflict, cleanupError], 'provisioning conflict cleanup failed')
      }
      throw conflict
    }
    return { member: this.memberView(active) }
  }

  /** Flush the accepted initial inbox item before the Lead can commit `active`. */
  private async checkpointInitialPrompt(
    childId: SessionId,
    messageId: MessageId,
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      signal.throwIfAborted()
      const session = this.ctx.sessions.get(childId)
      if (session === undefined) {
        const stored = await readPersistedSession(this.ctx.sessionPersistence, childId, signal)
        const suffix = stored.events.slice(stored.inheritedEventCount)
        if (messageAccepted(suffix, message => message.id === messageId)) return
        throw new TeamError(
          `teammate "${childId}" initial prompt was not durably accepted`,
          'TEAM_PROVISIONING_CONFLICT',
        )
      }

      const progress = Promise.withResolvers<void>()
      // Abort can win while the durability flush is still pending; mark the
      // later-awaited rejection handled without changing its eventual result.
      void progress.promise.catch(() => undefined)
      const stopEvent = this.ctx.on('session/event', (candidate) => {
        if (candidate === session) progress.resolve()
      })
      const stopDisposed = this.ctx.on('session/disposed', (candidate) => {
        if (candidate === session) progress.resolve()
      })
      const onAbort = (): void => {
        const reason: unknown = signal.reason
        progress.reject(reason instanceof Error
          ? reason
          : new TeamError(`teammate creation aborted: ${errorMessage(reason)}`, 'TEAM_DISPOSED'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        signal.throwIfAborted()
        await this.ctx.sessions.flush(session)
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        const suffix = session.snapshotEvents(session.inheritedEventCount)
        if (messageAccepted(suffix, message => message.id === messageId)) return
        if (this.ctx.sessions.get(childId) !== session) continue
        await progress.promise
      } finally {
        signal.removeEventListener('abort', onAbort)
        stopDisposed()
        stopEvent()
      }
    }
  }

  /** Settle provisioning-only members from their independently durable child Sessions. */
  private async reconcileProvisioning(root: Agent, signal: AbortSignal): Promise<void> {
    const provisioning = this.journal.state(root).members.filter(member => member.phase === 'provisioning')
    for (const member of provisioning) {
      signal.throwIfAborted()
      // A live child means creation is still completing in this process. Its
      // creator owns the terminal member edge.
      if (this.ctx.agents.get(member.id) !== undefined) continue
      let phase: 'active' | 'failed' = 'failed'
      let failure = 'provisioning did not leave a resumable child Session'
      try {
        const loaded = await readPersistedSession(this.ctx.sessionPersistence, member.id, signal)
        const suffix = loaded.events.slice(loaded.inheritedEventCount)
        const descriptor = foldSubagentDescriptor(suffix)
        const actualPreset = foldContinuablePreset(suffix)
        const acceptedInitialPrompt = messageAccepted(suffix, message => message.source.kind === 'user')
        if (loaded.header.parentSession === root.id
          && descriptor?.mode === 'continuable'
          && descriptor.provider === member.provider
          && ((member.preset === undefined && actualPreset === undefined)
            || (member.preset !== undefined
              && actualPreset?.id === member.preset.id
              && actualPreset.revision === member.preset.revision))
          && acceptedInitialPrompt) {
          phase = 'active'
        } else {
          failure = 'persisted child Session does not match the provisioned continuation'
        }
      } catch (error: unknown) {
        failure = `child Session recovery failed: ${errorMessage(error)}`
      }
      signal.throwIfAborted()
      await this.journal.transact(root.id, async () => {
        signal.throwIfAborted()
        const current = this.journal.state(root).members.find(candidate => candidate.id === member.id)
        if (current?.phase !== 'provisioning') return
        const settled: TeamMemberSnapshot = {
          ...current,
          phase,
          ...phase === 'failed' ? { error: failure } : {},
        }
        await this.appendMember(root, settled)
      })
    }
  }

  /** Complete a durable retirement left between admission cutoff and activation teardown. */
  private async reconcileRetiring(root: Agent, signal: AbortSignal): Promise<void> {
    const members = this.journal.state(root).members.filter(member => member.phase === 'retiring')
    for (const member of members) {
      signal.throwIfAborted()
      await this.finishRetirement(root, member.id)
    }
  }

  /** Stop the execution before publishing the final retired roster edge. */
  private async finishRetirement(root: Agent, memberId: SessionId): Promise<void> {
    await this.stopTeammates(root, [memberId])
    await this.journal.transact(root.id, async () => {
      const current = this.journal.state(root).members.find(member => member.id === memberId)
      if (current?.phase === 'retired') return
      if (current?.phase !== 'retiring') {
        throw new TeamError(`teammate "${memberId}" is not retiring`, 'TEAM_MEMBER_NOT_ACTIVE')
      }
      await this.appendMember(root, { ...current, phase: 'retired' })
    })
  }

  /** Build one runtime member row after successful creation. */
  private memberView(member: TeamMemberSnapshot & { readonly phase: 'active' }): TeamMemberView {
    const live = this.ctx.agents.get(member.id)
    return {
      id: member.id,
      name: member.name,
      role: 'teammate',
      status: availability(live),
      description: member.description,
      ...member.group === undefined ? {} : { group: member.group },
      provider: member.provider,
      context: member.context,
      ...member.preset === undefined ? {} : { preset: member.preset },
      ...live?.options.model === undefined ? {} : { model: live.options.model },
      diagnostics: [],
    }
  }

  /** Keep the released version-two event exact; use a new event for explicit compositions. */
  private async appendMember(root: Agent, member: TeamMemberSnapshot): Promise<void> {
    if (member.preset === undefined && member.group === undefined
      && (member.phase === 'provisioning' || member.phase === 'active' || member.phase === 'failed')) {
      const legacy: TeamMemberLegacySnapshot = {
        id: member.id,
        name: member.name,
        description: member.description,
        provider: member.provider,
        context: member.context,
        phase: member.phase,
        ...member.error === undefined ? {} : { error: member.error },
      }
      await this.journal.appendAndFlush(root, 'team/member', { version: 2, teamId: TeamId(root.id), member: legacy })
      return
    }
    await this.journal.appendAndFlush(root, 'team/member/configured', { version: 3, teamId: TeamId(root.id), member })
  }

  /** Validate a never-reused model-facing teammate name. */
  private memberName(value: string): string {
    if (!MEMBER_NAME.test(value) || value.length > 64 || value === 'lead') {
      throw new TeamError(
        'teammate name must be lower-kebab-case, at most 64 characters, and not "lead"',
        'TEAM_INVALID_MEMBER_NAME',
      )
    }
    return value
  }

  /** Append one terminal provisioning edge unless recovery already settled it. */
  private async settleProvisioning(
    root: Agent,
    terminal: TeamMemberSnapshot,
  ): Promise<'active' | 'failed'> {
    return this.journal.transact(root.id, async () => {
      const current = this.journal.state(root).members.find(member => member.id === terminal.id)
      /* v8 ignore next 3 -- the append-only provisioning event is committed by this operation before settlement. */
      if (current === undefined) {
        throw new TeamError(`provisioned teammate "${terminal.id}" disappeared`, 'TEAM_PROVISIONING_CONFLICT')
      }
      if (current.phase === 'active' || current.phase === 'failed') return current.phase
      if (current.phase !== 'provisioning') {
        throw new TeamError(`teammate "${current.name}" is no longer provisioning`, 'TEAM_PROVISIONING_CONFLICT')
      }
      await this.appendMember(root, terminal)
      return terminal.phase === 'active' ? 'active' : 'failed'
    })
  }

  /** Whether a Session's own suffix identifies a provider-owned subagent child. */
  private subagentDescriptor(agent: Agent): boolean {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    return foldSubagentDescriptor(agent.session.snapshotEvents(agent.session.inheritedEventCount)) !== undefined
  }
}

/** Turn availability is independent of whether the Agent is loaded. */
function availability(agent: Agent | undefined): 'running' | 'inactive' {
  return agent?.status === 'running' ? 'running' : 'inactive'
}
