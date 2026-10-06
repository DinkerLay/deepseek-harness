/** Host directory binding over real native members, continuation reservations and JSONL. */
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as Id } from '@deepseek-ai/dsh-session'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { TeamMemberExecution, TeamExecutionDirectory } from '../src/index.ts'
import { nativeFacadeHarness, facadeControlledMode } from './native-facade-harness.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const signal = new AbortController().signal
const text = (value: string) => [{ type: 'text' as const, text: value }]
const gate = () => Promise.withResolvers<undefined>()

async function setup() {
  let leadHandle: AgentHandle | undefined
  const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode, messageRetryDelayMs: 2_000 },
    script: Array.from({ length: 8 }, () => textResponse('Read the actual execution directory')),
    beforeLead: (ctx) => {
      const create = ctx.agents.create.bind(ctx.agents)
      const creation = vi.spyOn(ctx.agents, 'create').mockImplementation(async (options) => {
        leadHandle = await create(options); creation.mockRestore(); return leadHandle
      })
    } })
  if (leadHandle === undefined) throw new Error('actual parent creation did not return its handle')
  vi.spyOn(test.ctx.sessionQuery, 'observeSession').mockImplementation((id, options) =>
    SessionQuery.prototype.observeSession.call(test.ctx.sessionQuery, id, options))
  const unsupported = async (): Promise<never> => { throw new Error('model Task writes are outside directory binding') }
  test.ctx.agentTeams.installTaskExtension({ id: facadeControlledMode.requiredTaskExtensionId, create: unsupported, update: unsupported,
    validateMemberGroup: () => undefined, assessSettlementNotice: () => 'suppress' })
  const claims = new Map<Id, { cwd: string }>()
  const calls: TeamMemberExecution[] = []
  let observe: ((binding: TeamMemberExecution, incoming: AbortSignal) => Promise<void>) | undefined
  const owner = test.ctx.agentTeams.installMemberExecutions({ id: 'directory-owner',
    resolveExecutionDirectory: async (anchor, binding, incoming): Promise<TeamExecutionDirectory | undefined> => {
      expect(anchor).toBe(test.lead)
      calls.push(binding)
      const claim = claims.get(binding.executionId)
      await observe?.(binding, incoming)
      return claim === undefined ? undefined : { cwd: claim.cwd, assertCurrent: () => {
        if (claims.get(binding.executionId) !== claim) throw new Error('directory use changed')
        return undefined
      } }
    } })
  const member = (await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'directory-worker', context: 'fresh',
    provider: 'spawn', presetId: 'standard', prompt: [], signal })).member
  const directory = async () => await realpath(await mkdtemp(join(test.resources.root, 'working-directory-')))
  const send = async (message = 'Actual bound work') => await test.ctx.agentTeams.sendMessage(test.lead,
    { target: member.name, content: text(message), signal })
  const prepare = async (id: Id, cwd: string) => {
    const source = owner.read(test.lead, member.id).member
    if (source.preset === undefined) throw new Error('native member did not retain its Preset')
    await test.ctx.subagents.prepareContinuable({ childId: id, cwd, provider: source.provider, label: source.description,
      preset: source.preset, request: { parent: test.lead }, signal })
  }
  const stored = async (id: Id) => {
    using snapshot = await test.ctx.sessionQuery.observeSession(id)
    return { header: snapshot.header, events: snapshot.events }
  }
  return { ...test, claims, calls, owner, member, directory, send, prepare, stored, leadHandle,
    observe: (reader: typeof observe) => { observe = reader } }
}

it('binds actual first delivery and cold continuation to the same Host directory while the Team anchor remains unchanged', async () => {
  const test = await setup(), cwd = await test.directory()
  await writeFile(join(cwd, 'same-relative-name.txt'), 'Independent working copy')
  test.claims.set(test.member.id, { cwd })
  const anchorCwd = test.lead.session.header.cwd
  expect((await test.send()).status).toBe('accepted')
  await vi.waitFor(() => { expect(test.adapter.requests).toHaveLength(1) })
  await test.ctx.agents.get(test.member.id)?.whenIdle()
  await vi.waitFor(() => { expect(test.ctx.agents.get(test.member.id)).toBeUndefined() })
  expect((await test.stored(test.member.id)).header.cwd).toBe(cwd)
  expect((await test.send('A separate cold continuation')).status).toBe('accepted')
  await vi.waitFor(() => { expect(test.adapter.requests).toHaveLength(2) })
  expect((await test.stored(test.member.id)).header.cwd).toBe(cwd)
  expect(test.lead.session.header.cwd).toBe(anchorCwd)
  expect(test.calls.every(binding => binding.memberId === test.member.id
    && binding.executionId === test.member.id && binding.generation === 1))
    .toBe(true)
})

it('keeps deliberately unbound shared execution on the original inheritance path', async () => {
  const test = await setup()
  expect((await test.send()).status).toBe('accepted')
  await vi.waitFor(() => { expect(test.adapter.requests).toHaveLength(1) })
  expect((await test.stored(test.member.id)).header.cwd).toBe(test.lead.session.header.cwd)
})

it('does not prepare a claim after a real member hold closes its current input admission', async () => {
  const test = await setup(), cwd = await test.directory()
  test.claims.set(test.member.id, { cwd }); await test.prepare(test.member.id, cwd)
  const source = await test.ctx.agents.resume({ resumeSessionId: test.member.id, parentAgent: test.lead,
    agentOptions: { provider: 'mock', model: 'mock' } })
  onTestFinished(() => source.dispose())
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'directory-claim-held', expectedGeneration: 1 },
    () => ({ recordId: 'directory-claim-held:held', dataJson: '{}' }))
  const before = source.agent.session.seq
  await test.ctx.agents.prepareInputClaim(source.agent, signal)
  expect(source.agent.session.seq).toBe(before)
  expect(test.ctx.agents.canClaimInput(source.agent)).toBe(false)
  expect(test.adapter.requests).toHaveLength(0)
})

it('rejects cold factory preparation after its real parent leaves during directory observation', async () => {
  const test = await setup(), cwd = await test.directory(), entered = gate(), resume = gate()
  test.claims.set(test.member.id, { cwd })
  await test.prepare(test.member.id, cwd)
  test.observe(async () => { entered.resolve(undefined); await resume.promise })
  const resuming = test.ctx.agents.resume({ resumeSessionId: test.member.id, agentOptions: { provider: 'mock', model: 'mock' } })
  const rejected = expect(resuming).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = test.leadHandle.dispose()
    await vi.waitFor(() => { expect(test.ctx.agents.get(test.lead.id) === undefined).toBe(true) })
    resume.resolve(undefined)
    await rejected
    await closing
    expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  } finally { resume.resolve(undefined); await Promise.allSettled([resuming, closing]) }
})

it.each(['missing', 'file', 'relative'])('does not start work or adopt a fallback when the Host directory is %s', async (invalid) => {
  const test = await setup(), file = join(test.resources.root, 'a-file')
  await writeFile(file, 'This is not a directory')
  test.claims.set(test.member.id, { cwd: invalid === 'relative' ? 'relative-cwd'
    : invalid === 'file' ? file : join(test.resources.root, 'missing-directory') })
  expect((await test.send()).status).toBe('queued')
  expect(await test.ctx.sessionPersistence.stat(test.member.id)).toBeUndefined()
  expect(test.ctx.agents.get(test.member.id)).toBeUndefined()
  expect(test.adapter.requests).toHaveLength(0)
})

it('rechecks a directory use changed while its actual Host reader was pending before the first creation', async () => {
  const test = await setup(), cwd = await test.directory(), entered = gate(), resume = gate()
  test.claims.set(test.member.id, { cwd })
  test.observe(async () => { entered.resolve(undefined); await resume.promise })
  const sending = test.send()
  try {
    await entered.promise
    test.claims.set(test.member.id, { cwd })
    resume.resolve(undefined)
    expect((await sending).status).toBe('queued')
    expect(await test.ctx.sessionPersistence.stat(test.member.id)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
    test.observe(undefined)
    const next = await test.send('New current directory use')
    // A retry of the original queued message may already own target serialization.
    expect(['accepted', 'queued']).toContain(next.status)
    await vi.waitFor(() => {
      expect(test.ctx.sessionProjections.stateOf(test.lead.session, 'agentTeam')?.delivered).toContain(next.messageId)
    }, { timeout: 4_000 })
    expect((await test.stored(test.member.id)).header.cwd).toBe(cwd)
  } finally { resume.resolve(undefined); await Promise.allSettled([sending]) }
})

it('rechecks native admission when a real member hold wins while directory resolution was pending', async () => {
  const test = await setup(), cwd = await test.directory(), entered = gate(), resume = gate()
  test.claims.set(test.member.id, { cwd })
  test.observe(async () => { entered.resolve(undefined); await resume.promise })
  const sending = test.send()
  try {
    await entered.promise
    await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'directory-held', expectedGeneration: 1 },
      () => ({ recordId: 'directory-held:held', dataJson: '{}' }))
    resume.resolve(undefined)
    expect((await sending).status).toBe('queued')
    expect(await test.ctx.sessionPersistence.stat(test.member.id)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  } finally { resume.resolve(undefined); await Promise.allSettled([sending]) }
})

it('rejects direct cold activation against a different directory before mounting its Preset or requesting a model', async () => {
  const test = await setup(), cwd = await test.directory()
  test.claims.set(test.member.id, { cwd })
  await test.send()
  await vi.waitFor(() => { expect(test.adapter.requests).toHaveLength(1) })
  await test.ctx.agents.get(test.member.id)?.whenIdle()
  await vi.waitFor(() => { expect(test.ctx.agents.get(test.member.id)).toBeUndefined() })
  test.claims.set(test.member.id, { cwd: await test.directory() })
  const mount = vi.fn()
  await expect(test.ctx.agents.resume({ resumeSessionId: test.member.id,
    agentOptions: { provider: 'mock', model: 'mock' }, setup: async () => { mount() } }))
    .rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  expect(mount).not.toHaveBeenCalled()
  expect(test.adapter.requests).toHaveLength(1)
  expect((await test.stored(test.member.id)).header.cwd).toBe(cwd)
})

it('uses the reserved future generation for candidate commit and refuses a mismatching actual cwd', async () => {
  const test = await setup(), wrong = await test.directory(), next = await test.directory()
  const candidate = SessionId('directory-candidate'), replacement = SessionId('directory-replacement')
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'directory-renew', expectedGeneration: 1,
    nextExecutionId: candidate }, () => ({ recordId: 'directory-renew:held', dataJson: '{}' }))
  await test.prepare(candidate, wrong)
  test.claims.set(candidate, { cwd: next })
  await expect(test.owner.commit(test.lead, test.member.id, 'directory-renew',
    { recordId: 'directory-renew:commit', dataJson: '{}' }, () => [])).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  expect(test.owner.read(test.lead, test.member.id).execution.generation).toBe(1)
  expect(test.calls).toContainEqual({ memberId: test.member.id, executionId: candidate, generation: 2 })
  await test.owner.retarget(test.lead, test.member.id, 'directory-renew', candidate, replacement,
    { recordId: 'directory-renew:retarget', dataJson: '{}' }, () => [])
  test.claims.set(replacement, { cwd: next })
  await test.prepare(replacement, next)
  expect(test.adapter.requests).toHaveLength(0)
  expect(await test.owner.commit(test.lead, test.member.id, 'directory-renew',
    { recordId: 'directory-renew:commit', dataJson: '{}' }, () => [])).toEqual({ memberId: test.member.id, executionId: replacement, generation: 2 })
  expect(await test.owner.commit(test.lead, test.member.id, 'directory-renew',
    { recordId: 'directory-renew:commit', dataJson: '{}' }, () => [])).toEqual({ memberId: test.member.id, executionId: replacement, generation: 2 })
  await test.owner.release(test.lead, test.member.id, 'directory-renew', { recordId: 'directory-renew:ready', dataJson: '{}' }, () => [])
  expect((await test.send('First generation-two work')).status).toBe('accepted')
  expect((await test.stored(replacement)).header.cwd).toBe(next)
  expect(await test.ctx.sessionPersistence.stat(test.member.id)).toBeUndefined()
})

it('rejects a different reserved candidate which wins while the former candidate directory was being resolved', async () => {
  const test = await setup(), cwd = await test.directory()
  const old = SessionId('directory-old-reservation'), next = SessionId('directory-new-reservation'), entered = gate(), resume = gate()
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'directory-retarget', expectedGeneration: 1,
    nextExecutionId: old }, () => ({ recordId: 'directory-retarget:held', dataJson: '{}' }))
  test.claims.set(old, { cwd }); await test.prepare(old, cwd)
  test.observe(async (binding) => { if (binding.executionId === old) { entered.resolve(undefined); await resume.promise } })
  const committing = test.owner.commit(test.lead, test.member.id, 'directory-retarget',
    { recordId: 'directory-retarget:commit', dataJson: '{}' }, () => [])
  const rejected = expect(committing).rejects.toMatchObject({ code: 'TEAM_MEMBER_OPERATION_STALE' })
  try {
    await entered.promise
    await test.owner.retarget(test.lead, test.member.id, 'directory-retarget', old, next,
      { recordId: 'directory-retarget:next', dataJson: '{}' }, () => [])
    test.claims.set(next, { cwd }); await test.prepare(next, cwd)
    resume.resolve(undefined); await rejected
    expect(test.owner.read(test.lead, test.member.id).execution.generation).toBe(1)
    expect(test.adapter.requests).toHaveLength(0)
  } finally { resume.resolve(undefined); await Promise.allSettled([committing]) }
})

it('rechecks the candidate directory use after quiet observation before the binding transaction', async () => {
  const test = await setup(), cwd = await test.directory(), candidate = SessionId('directory-final-candidate')
  const entered = gate(), resume = gate()
  await test.owner.hold(test.lead, { memberId: test.member.id, operationId: 'directory-final', expectedGeneration: 1,
    nextExecutionId: candidate }, () => ({ recordId: 'directory-final:held', dataJson: '{}' }))
  test.claims.set(candidate, { cwd })
  await test.prepare(candidate, cwd)
  const committing = test.owner.commit(test.lead, test.member.id, 'directory-final',
    { recordId: 'directory-final:commit', dataJson: '{}' }, async () => { entered.resolve(undefined); await resume.promise; return [] })
  const rejected = expect(committing).rejects.toThrow('directory use changed')
  try {
    await entered.promise; test.claims.set(candidate, { cwd }); resume.resolve(undefined); await rejected
    expect(test.owner.read(test.lead, test.member.id).execution.generation).toBe(1)
    expect(test.adapter.requests).toHaveLength(0)
  } finally { resume.resolve(undefined); await Promise.allSettled([committing]) }
})

it('aborts directory resolution and drains its admitted callback before the sole member owner closes', async () => {
  const test = await setup(), cwd = await test.directory(), entered = gate(), resume = gate()
  let incoming: AbortSignal | undefined, disposed = false
  test.claims.set(test.member.id, { cwd })
  test.observe(async (_binding, current) => { incoming = current; entered.resolve(undefined); await resume.promise })
  const sending = test.send()
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = test.owner.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(incoming?.aborted).toBe(true) })
    expect(disposed).toBe(false)
    resume.resolve(undefined)
    expect((await sending).status).toBe('queued')
    await closing
    expect(await test.ctx.sessionPersistence.stat(test.member.id)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
    test.observe(undefined)
    expect((await test.send('Retry after the directory owner closed')).status).toBe('queued')
    expect(await test.ctx.sessionPersistence.stat(test.member.id)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  } finally { resume.resolve(undefined); await Promise.allSettled([sending, closing]) }
})
