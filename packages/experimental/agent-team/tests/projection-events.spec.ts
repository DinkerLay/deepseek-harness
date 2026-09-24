import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { teamActivityProjectionDefinition } from '../src/activity-projection.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamProjectionState, TeamState } from '../src/projection.ts'
import { TeamId, TeamMessageId, TeamTaskId } from '../src/types.ts'
import type { TeamMemberLegacySnapshot, TeamMemberSnapshot, TeamMessageSnapshot, TeamTaskSnapshot } from '../src/types.ts'

const ROOT = SessionId('team-root')
const TEAM = TeamId(ROOT)
const CHILD = SessionId('child-a')

function event<T extends Extract<SessionEventType, `team/${string}`>>(type: T, data: SessionEventMap[T], seq: SessionSeq): SessionEvent<T> {
  return { type, data, seq, time: seq } as unknown as SessionEvent<T>
}

function project(rootId: SessionId, events: readonly SessionEvent[]): TeamProjectionState {
  let state = teamProjectionDefinition.init({
    version: SESSION_FORMAT_VERSION,
    id: rootId,
    createdAt: 0,
    isSeeded: false,
  })
  for (const event of events) state = teamProjectionDefinition.apply(state, event)
  return state
}

function teamState(projected: TeamProjectionState): TeamState {
  if (projected.failure !== undefined) throw new Error(projected.failure)
  return projected
}

function projectTeam(rootId: SessionId, events: readonly SessionEvent[]): TeamState {
  return teamState(project(rootId, events))
}

/** Queued-minus-delivered mail retained by the projection. */
function pending(state: TeamState): TeamMessageSnapshot[] {
  return state.messages.filter(message => !state.delivered.includes(message.id))
}

/** Whether one Team state contains no projected records. */
function isEmptyState(state: TeamState): boolean {
  return state.members.length === 0 && state.tasks.length === 0
    && state.messages.length === 0 && state.delivered.length === 0
}

function member(overrides: Partial<TeamMemberLegacySnapshot> = {}): TeamMemberLegacySnapshot {
  return {
    id: CHILD,
    name: 'worker-a',
    description: 'worker',
    provider: 'spawn',
    context: 'fresh',
    phase: 'provisioning',
    ...overrides,
  }
}

function configuredMember(overrides: Partial<TeamMemberSnapshot> = {}): TeamMemberSnapshot {
  return { ...member(), ...overrides }
}

function task(overrides: Partial<TeamTaskSnapshot> = {}): TeamTaskSnapshot {
  return {
    id: TeamTaskId('task-1'),
    revision: 1,
    subject: 'subject',
    description: 'description',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ...overrides,
  }
}

function message(overrides: Partial<TeamMessageSnapshot> = {}): TeamMessageSnapshot {
  return {
    id: TeamMessageId('message-1'),
    senderId: ROOT,
    senderName: 'lead',
    targetId: CHILD,
    content: [{ type: 'text', text: 'hello' }],
    ...overrides,
  }
}

describe('Agent Teams projection events', () => {
  it('publishes only a revision signal for durable Team changes', () => {
    const initial = teamActivityProjectionDefinition.init()
    expect(initial).toEqual({ revision: 0 })
    const afterMessage = teamActivityProjectionDefinition.apply(initial, event('team/message/queued', {
      version: 2, teamId: TEAM, message: message(),
    }, SessionSeq(0)))
    expect(afterMessage).toEqual({ revision: 1 })
    const afterTask = teamActivityProjectionDefinition.apply(afterMessage, event('team/task', {
      version: 2, teamId: TEAM, task: task(),
    }, SessionSeq(1)))
    const afterMember = teamActivityProjectionDefinition.apply(afterTask, event('team/member', {
      version: 2, teamId: TEAM, member: member(),
    }, SessionSeq(2)))
    expect(afterMember).toEqual({ revision: 3 })
    expect(teamActivityProjectionDefinition.wire.view(afterMember)).toEqual({ revision: 3 })
    expect(teamActivityProjectionDefinition.wire.viewSchema.parse(afterMember)).toEqual({ revision: 3 })
  })

  it('rejects retired tool-result content when restoring a native V4 Team checkpoint', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.effect(() => ctx.sessionProjections.register(teamProjectionDefinition))
    const session = ctx.sessions.create(ROOT)
    const restore = (val: unknown) => ctx.sessionProjections.restore({
      agentTeam: { ver: teamProjectionDefinition.stateVersion, seq: -1, val },
    }, [], SessionLogOffset(0), session.header, SessionLogOffset(0))
    const valid = { ...project(ROOT, []), messages: [message()], messageTimes: { 'message-1': 0 } }
    expect(restore(JSON.parse(JSON.stringify(valid))).checkpoint['agentTeam']?.val).toEqual(valid)
    const retiredMessage = message({ content: [{
      type: 'tool-result', toolCallId: 'retired', content: [{ type: 'text', text: 'old result' }],
    }] as unknown as TeamMessageSnapshot['content'] })
    const retired = { ...valid, messages: [retiredMessage] }
    expect(() => restore(JSON.parse(JSON.stringify(retired)))).toThrow()
    expect(() => projectTeam(ROOT, [event('team/message/queued', {
      version: 2, teamId: TEAM, message: retiredMessage,
    }, SessionSeq(0))])).toThrow(/team\/message\/queued payload is invalid/)
  })

  it('projects current-team records independently from inherited records', () => {
    const records: SessionEvent[] = [
      event('team/member', { version: 2, teamId: TeamId('ancestor'), member: member() }, SessionSeq(0)),
      event('team/member', { version: 2, teamId: TEAM, member: member() }, SessionSeq(1)),
      event('team/member', {
        version: 2,
        teamId: TEAM,
        member: member({ phase: 'active' }),
      }, SessionSeq(2)),
      event('team/task', { version: 2, teamId: TEAM, task: task({ id: TeamTaskId('task-7') }) }, SessionSeq(3)),
      event('team/message/queued', { version: 2, teamId: TEAM, message: message() }, SessionSeq(4)),
    ]
    const projected = project(ROOT, records)
    const state = teamState(projected)

    expect(state).toMatchObject({ id: TEAM })
    expect(state.members).toHaveLength(1)
    expect(state.tasks).toHaveLength(1)
    expect(pending(state)).toHaveLength(1)
    expect(state.nextTaskNumber).toBe(8)
    expect(state.members.find(member => member.id === CHILD)?.name).toBe('worker-a')
    expect(teamProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(projected))))
      .toEqual(projected)
  })

  it('enforces teammate identity and lifecycle', () => {
    const base = event('team/member', { version: 2, teamId: TEAM, member: member() }, SessionSeq(0))
    expect(() => projectTeam(ROOT, [event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({ phase: 'active' }),
    }, SessionSeq(0))])).toThrow(/must begin provisioning/)
    expect(() => projectTeam(ROOT, [base, event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({ name: 'renamed', phase: 'active' }),
    }, SessionSeq(1))])).toThrow(/immutable identity/)
    expect(() => projectTeam(ROOT, [base, event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({ phase: 'active' }),
    }, SessionSeq(1)), event('team/member', {
      version: 2,
      teamId: TEAM,
      member: member({ phase: 'failed' }),
    }, SessionSeq(2))])).toThrow(/invalid active -> failed/)

    const duplicateName = member({ id: SessionId('child-b') })
    expect(() => projectTeam(ROOT, [base, event('team/member', {
      version: 2,
      teamId: TEAM,
      member: duplicateName,
    }, SessionSeq(1))])).toThrow(/name .* reused/)
  })

  it('reads legacy members and validates version-three preset and retirement edges', () => {
    const preset = { id: 'reviewer', revision: 'a'.repeat(64) }
    const provisioning = event('team/member/configured', {
      version: 3, teamId: TEAM, member: configuredMember({ preset }),
    }, SessionSeq(0))
    const active = event('team/member/configured', {
      version: 3, teamId: TEAM, member: configuredMember({ preset, phase: 'active' }),
    }, SessionSeq(1))
    const retiring = event('team/member/configured', {
      version: 3, teamId: TEAM, member: configuredMember({ preset, phase: 'retiring' }),
    }, SessionSeq(2))
    const retired = event('team/member/configured', {
      version: 3, teamId: TEAM, member: configuredMember({ preset, phase: 'retired' }),
    }, SessionSeq(3))
    expect(projectTeam(ROOT, [provisioning, active, retiring, retired]).members[0])
      .toMatchObject({ preset, phase: 'retired' })
    expect(() => projectTeam(ROOT, [provisioning, active, retired]))
      .toThrow(/invalid active -> retired/)
    expect(() => projectTeam(ROOT, [provisioning, event('team/member/configured', {
      version: 3, teamId: TEAM, member: configuredMember({ preset: { ...preset, id: 'changed' }, phase: 'active' }),
    }, SessionSeq(1))])).toThrow(/immutable identity/)
    const invalidLegacy = { ...member(), preset }
    expect(() => projectTeam(ROOT, [event('team/member', {
      version: 2, teamId: TEAM, member: invalidLegacy,
    }, SessionSeq(0))])).toThrow(/payload is invalid/)
    expect(() => projectTeam(ROOT, [event('team/member/configured', {
      version: 3, teamId: TEAM, member: configuredMember({ preset: { ...preset, revision: 'bad' } }),
    }, SessionSeq(0))])).toThrow(/payload is invalid/)
  })

  it('enforces task revision continuity', () => {
    const first = event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0))
    expect(() => projectTeam(ROOT, [event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({ revision: 2 }),
    }, SessionSeq(0))])).toThrow(/begin at revision 1/)
    expect(() => projectTeam(ROOT, [first, event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({ revision: 3 }),
    }, SessionSeq(1))])).toThrow(/revision is not contiguous/)
  })

  it('keeps a managed Task transaction atomic and rejects legacy rewrites of its result state', () => {
    const initial = event('team/task/managed', {
      version: 1, teamId: TEAM,
      updates: [{ task: task(), review: { attempts: [], validity: 'none' } }],
    }, SessionSeq(0))
    expect(projectTeam(ROOT, [initial]).managed[TeamTaskId('task-1')]).toEqual({ attempts: [], validity: 'none' })
    const duplicate = event('team/task/managed', {
      version: 1, teamId: TEAM,
      updates: [
        { task: task({ revision: 2 }), review: { attempts: [], validity: 'none' } },
        { task: task({ revision: 2 }), review: { attempts: [], validity: 'none' } },
      ],
    }, SessionSeq(1))
    const damaged = project(ROOT, [initial, duplicate])
    expect(damaged.failure).toMatch(/occurs twice/)
    expect(damaged.tasks[0]?.revision).toBe(1)
    expect(() => projectTeam(ROOT, [initial, event('team/task/managed', {
      version: 1, teamId: TEAM,
      updates: [{ task: task({ revision: 2, status: 'completed' }),
        review: { attempts: [], validity: 'valid' } }],
    }, SessionSeq(1))])).toThrow(/no valid accepted result/)
    expect(() => projectTeam(ROOT, [initial, event('team/task', {
      version: 2, teamId: TEAM, task: task({ revision: 2 }),
    }, SessionSeq(1))])).toThrow(/managed task .* legacy task event/)
  })

  it('rejects every invalid persisted task dependency relation', () => {
    const first = event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0))
    const second = event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({
        id: TeamTaskId('task-2'),
        blockedBy: [TeamTaskId('task-1')],
      }),
    }, SessionSeq(1))
    const invalid: Array<{ records: SessionEvent[]; message: RegExp }> = [
      {
        records: [event('team/task', {
          version: 2,
          teamId: TEAM,
          task: task({ blockedBy: [TeamTaskId('missing')] }),
        }, SessionSeq(0))],
        message: /blocker task "missing" .* is missing or deleted/,
      },
      {
        records: [event('team/task', {
          version: 2,
          teamId: TEAM,
          task: task({ blockedBy: [TeamTaskId('task-1')] }),
        }, SessionSeq(0))],
        message: /cannot block itself/,
      },
      {
        records: [first, event('team/task', {
          ...second.data,
          task: { ...second.data.task, blockedBy: [TeamTaskId('task-1'), TeamTaskId('task-1')] },
        }, SessionSeq(1))],
        message: /repeats blocker/,
      },
      {
        records: [first, second, event('team/task', {
          version: 2,
          teamId: TEAM,
          task: task({ revision: 2, blockedBy: [TeamTaskId('task-2')] }),
        }, SessionSeq(2))],
        message: /dependency cycle/,
      },
      {
        records: [first, second, event('team/task', {
          version: 2,
          teamId: TEAM,
          task: task({ revision: 2, status: 'deleted' }),
        }, SessionSeq(2))],
        message: /blocker task "task-1" .* is missing or deleted/,
      },
    ]

    for (const { records, message: expected } of invalid) {
      expect(() => projectTeam(ROOT, records)).toThrow(expected)
    }
  })

  it('leaves numeric allocation unchanged for a branded nonstandard task id', () => {
    const state = projectTeam(ROOT, [event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({ id: TeamTaskId('external-task') }),
    }, SessionSeq(0))])
    expect(state.nextTaskNumber).toBe(1)
  })

  it('rejects a persisted numeric task id outside the safe integer range', () => {
    expect(() => projectTeam(ROOT, [event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task({ id: TeamTaskId('task-9007199254740992') }),
    }, SessionSeq(0))])).toThrow(/persisted Agent Teams team\/task payload is invalid/)
  })

  it('enforces mailbox queue and acknowledgement relations', () => {
    const queued = event('team/message/queued', { version: 2, teamId: TEAM, message: message() }, SessionSeq(0))
    const delivered = event('team/message/delivered', {
      version: 2,
      teamId: TEAM,
      messageId: TeamMessageId('message-1'),
      targetId: CHILD,
    }, SessionSeq(1))
    expect(pending(projectTeam(ROOT, [queued, delivered]))).toEqual([])
    expect(() => projectTeam(ROOT, [queued, queued])).toThrow(/queued twice/)
    expect(() => projectTeam(ROOT, [delivered])).toThrow(/delivered before queueing/)
    expect(() => projectTeam(ROOT, [queued, event('team/message/delivered', {
      ...delivered.data,
      targetId: SessionId('other'),
    }, SessionSeq(1))])).toThrow(/target changed/)
    expect(() => projectTeam(ROOT, [queued, delivered, { ...delivered, seq: SessionSeq(2) }])).toThrow(/delivered twice/)
  })

  it('validates every current-version persisted payload before projecting it', () => {
    const malformed = [
      {
        ...event('team/member', { version: 2, teamId: TEAM, member: member() }, SessionSeq(0)),
        data: { version: 2, teamId: TEAM, member: { ...member(), name: 42 } },
      },
      {
        ...event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0)),
        data: { version: 2, teamId: TEAM, task: { ...task(), blockedBy: [42] } },
      },
      {
        ...event('team/message/queued', { version: 2, teamId: TEAM, message: message() }, SessionSeq(0)),
        data: {
          version: 2,
          teamId: TEAM,
          message: { ...message(), content: [{ type: 'text', text: 42 }] },
        },
      },
      {
        ...event('team/message/delivered', {
          version: 2,
          teamId: TEAM,
          messageId: TeamMessageId('message-1'),
          targetId: CHILD,
        }, SessionSeq(0)),
        data: {
          version: 2,
          teamId: TEAM,
          messageId: TeamMessageId('message-1'),
          targetId: 42,
        },
      },
      {
        ...event('team/member', { version: 2, teamId: TEAM, member: member() }, SessionSeq(0)),
        data: { version: 2, teamId: TEAM, member: member(), unexpected: true },
      },
      {
        ...event('team/task', { version: 2, teamId: TEAM, task: task() }, SessionSeq(0)),
        data: { version: 2, teamId: 42, task: task() },
      },
    ] as unknown as SessionEvent[]

    for (const candidate of malformed) {
      expect(() => projectTeam(ROOT, [candidate]))
        .toThrow(/persisted Agent Teams .* payload is invalid/)
    }
  })

  it('retains merge-extensible content blocks while rejecting malformed core variants', () => {
    const extension = { type: 'plugin/custom', payload: { value: 1 } } as never
    const state = projectTeam(ROOT, [event('team/message/queued', {
      version: 2,
      teamId: TEAM,
      message: message({ content: [extension] }),
    }, SessionSeq(0))])
    expect(pending(state)[0]?.content).toEqual([extension])
  })

  it('preserves opaque JSON through projection and checkpoints', () => {
    const extension = JSON.parse('{"type":"plugin/custom","__proto__":{"saved":true},"constructor":{"saved":false},"content":[{"__proto__":{"nested":true},"opaque":true}]}') as ContentBlock
    const content = [extension]
    const queued = event('team/message/queued', { version: 2, teamId: TEAM, message: message({ content }) }, SessionSeq(0))
    const before = JSON.stringify(queued)
    const projected = projectTeam(ROOT, [queued])
    expect(projected.messages[0]?.content).toEqual(content)
    const checkpoint = teamProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(projected)))
    expect(JSON.stringify(checkpoint)).toBe(JSON.stringify(projected))
    expect(JSON.stringify(queued)).toBe(before)
    const block = checkpoint.messages[0]!.content[0]!
    expect(Object.hasOwn(block, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(block)).toBe(Object.prototype)
  })

  it.each([
    null, [], 3,
    { type: '' },
    { type: null },
    { type: 'text', text: false },
  ])('rejects malformed content in events and checkpoints: %j', (block) => {
    const content: unknown = [block]
    const saved = message({ content: content as ContentBlock[] })
    const queued = event('team/message/queued', { version: 2, teamId: TEAM, message: saved }, SessionSeq(0))
    expect(() => projectTeam(ROOT, [queued])).toThrow(/team\/message\/queued payload is invalid/)
    expect(() => teamProjectionDefinition.stateSchema.parse({ ...project(ROOT, []), messages: [saved] })).toThrow()
  })

  it('rebuilds lossy version-3 Team checkpoints from the original log', async () => {
    const ctx = new Context()
    const registry = ctx.plugin(SessionProjectionRegistry)
    try {
      await registry
      ctx.sessionProjections.register(teamProjectionDefinition)
      const extension = JSON.parse('{"type":"plugin/custom","__proto__":{"saved":true}}') as ContentBlock
      const queued = event('team/message/queued', {
        version: 2, teamId: TEAM, message: message({ content: [extension] }),
      }, SessionSeq(0))
      const oldContent: unknown = [{ type: 'plugin/custom' }]
      const oldState = project(ROOT, [event('team/message/queued', {
        version: 2, teamId: TEAM, message: message({ content: oldContent as ContentBlock[] }),
      }, SessionSeq(0))])
      const restored = ctx.sessionProjections.restore(
        { agentTeam: { ver: 3, seq: SessionSeq(0), val: oldState } },
        [queued],
        SessionLogOffset(0),
        { version: SESSION_FORMAT_VERSION, id: ROOT, createdAt: 0, isSeeded: false },
        SessionLogOffset(0),
      )
      const state = teamProjectionDefinition.stateSchema.parse(restored.checkpoint['agentTeam']!.val)
      expect(state.messages[0]?.content).toEqual([extension])
    } finally {
      await registry.dispose()
    }
  })

  it('records unsupported event versions without applying them', () => {
    const invalid = event('team/task', {
      version: 1 as 2,
      teamId: TEAM,
      task: task(),
    }, SessionSeq(0))
    const later = event('team/task', {
      version: 2,
      teamId: TEAM,
      task: task(),
    }, SessionSeq(1))
    const state = project(ROOT, [invalid, later])
    expect(state.failure).toMatch(/unsupported Agent Teams event version 1/)
    expect(isEmptyState(state)).toBe(true)
  })

  it('isolates unsupported inherited Team records from the current Team', () => {
    const inherited = event('team/task', {
      version: 1 as 2,
      teamId: TeamId('ancestor'),
      task: task(),
    }, SessionSeq(0))
    const projected = project(ROOT, [inherited])
    expect(projected.failure).toBeUndefined()
    expect(isEmptyState(teamState(projected))).toBe(true)
  })

  it('ignores malformed current-version records inherited from another Team', () => {
    const inherited = {
      ...event('team/task', {
        version: 2,
        teamId: TeamId('ancestor'),
        task: task(),
      }, SessionSeq(0)),
      data: {
        version: 2,
        teamId: TeamId('ancestor'),
        task: { ...task(), subject: 42 },
      },
    } as unknown as SessionEvent
    expect(isEmptyState(projectTeam(ROOT, [inherited]))).toBe(true)
  })
})
