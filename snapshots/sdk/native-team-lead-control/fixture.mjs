/** Authored keyless coordination through the native runtime and original model tools. */
export const name = 'native-team-lead-control-fixture'
export const inject = ['agents', 'agentTeams', 'agentPresets', 'sessionProjections', 'sessions', 'llm', 'tools', 'loader']

export async function apply(ctx) {
  const modules = await Promise.all(['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-experimental-agent-team',
    '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools'].map(name => ctx.loader.import(name)))
  const [{ SessionId }, { TeamLeadOperationId }, { createUserMessage }, { defineTool }] = modules
  const presets = await Promise.all([
    ctx.agentPresets.register({ id: 'snapshot-control-lead', plugins: [] }),
    ctx.agentPresets.register({ id: 'snapshot-control-worker', plugins: [] }),
  ])
  let anchor
  let worker
  let flow
  let started = false
  const actors = []
  const handles = []
  const lifetime = new AbortController()
  const markerEntered = Promise.withResolvers()
  const noticeDelivered = Promise.withResolvers()
  const owner = ctx.agentTeams.installLeadExecutions({
    resolveAnchor: async id => {
      const live = ctx.agents.get(id)
      if (live === undefined) throw new Error('snapshot anchor is not live')
      return live
    },
    isReady: () => true,
  })
  const coordinator = ctx.agentTeams.installLeadCoordinator({ id: 'snapshot-control-coordinator' })
  const unused = async () => { throw new Error('Lead-control snapshot does not mutate Tasks') }
  const writer = ctx.agentTeams.installTaskExtension({ id: 'snapshot-task-writer',
    validateMemberGroup: (_caller, group) => { if (group !== 'qa-control') throw new Error('snapshot member requires its QA group') },
    planLeadRelease: () => '{}', create: unused, update: unused,
  })
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Lead-control snapshot disposed'))
    for (const actor of actors) actor.cancel({ kind: 'user' }, { keepInbox: true })
    if (worker) worker.cancel({ kind: 'user' }, { keepInbox: true })
    await Promise.allSettled([flow])
    for (const handle of handles.toReversed()) await handle.dispose()
    writer.dispose()
    await coordinator.dispose()
    await owner.dispose()
    for (const remove of presets) await remove()
  })
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession === undefined) {
      if (anchor !== undefined) throw new Error('snapshot has more than one anchor')
      if (!ctx.llm.listProviders().some(provider => provider.name === 'Native Team Lead Control Replay')) {
        throw new Error('native-team-lead-control requires its keyless recorded-role adapter')
      }
      anchor = agent
      await owner.prepareAnchor(agent)
      return
    }
    if (ctx.agentTeams.tryMembership(agent)?.role !== 'teammate') return
    worker = agent
    agent.ctx.tools.register(defineTool({ name: 'qa_control_marker',
      description: 'Inert QA marker. Wait for cancellation without file, network or process effects.',
      parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(_args, exec) {
        markerEntered.resolve()
        await new Promise(resolve => {
          if (exec.signal.aborted) resolve()
          else exec.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return 'Inert QA marker stopped'
      } }))
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (session !== anchor?.session || event.type !== 'team/message/lead-delivered' || !worker) return
    const state = ctx.sessionProjections.stateOf(session, 'agentTeam')
    const message = state.messages.find(item => item.id === event.data.messageId)
    const source = message?.transfer?.input.message.source
    if (source?.kind === 'subagent-settled' && source.senderSessionId === worker.id) {
      noticeDelivered.resolve()
    }
  }, { global: true })
  async function switchLead(term, signal) {
    const operationId = TeamLeadOperationId(`snapshot-control-${term}`)
    await coordinator.record(anchor, { operationId, previousTerm: term - 1, phase: 'requested',
      recordId: `requested-${term}`, dataJson: '{}' })
    await coordinator.record(anchor, { operationId, previousTerm: term - 1, phase: 'frozen',
      recordId: `frozen-${term}`, dataJson: '{}' })
    let candidate
    await coordinator.runAtSafePoint(anchor, { operationId, previousTerm: term - 1, signal,
      record: { recordId: `safe-${term}`, dataJson: '{}' }, readBlockers: () => [] }, async safe => {
      await safe.record({ recordId: `prepared-${term}`, dataJson: '{}' }, true)
      const lease = await ctx.agentPresets.acquireComposition('snapshot-control-lead')
      try {
        candidate = await owner.create(anchor, { sessionId: SessionId(`snapshot-control-execution-${term}`),
          term, presetId: lease.id, revision: lease.revision, agentOptions: anchor.options, signal })
        handles.push(candidate)
        await safe.commitLeadTransaction({ binding: { executionId: candidate.agent.id, term,
          presetId: lease.id, revision: lease.revision }, releases: [],
          record: { recordId: `committed-${term}`, dataJson: '{}' } })
      } finally { await lease[Symbol.asyncDispose]() }
    })
    await coordinator.record(anchor, { operationId, previousTerm: term - 1, phase: 'ready',
      recordId: `ready-${term}`, dataJson: '{}' })
    const actor = candidate.agent
    actors.push(actor)
    return actor
  }
  async function turn(actor, text) {
    await ctx.agents.receiveInput(actor, { message: createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text }] }), target: 'next-turn', wakeup: true })
    await actor.whenIdle()
  }
  function waitResult(actor) {
    const event = actor.session.snapshotEvents().find(item => item.type === 'tool/result'
      && item.data.message.source.callId === `control-wait-${ctx.agentTeams.membership(actor).term}`)
    if (!event) throw new Error('current Lead has no recorded wait result')
    const value = JSON.parse(event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    if (value.noProgress?.reason !== 'no-active-peer') throw new Error('current Lead waited on its own roster row')
  }
  async function run() {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000)])
    const cancel = () => { for (const actor of actors) actor.cancel({ kind: 'user' }, { keepInbox: true }); worker?.cancel({ kind: 'user' }, { keepInbox: true }) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const member = await ctx.agentTeams.spawnTeammate(anchor, { name: 'control-worker', group: 'qa-control',
        presetId: 'snapshot-control-worker', provider: 'spawn', context: 'fresh', prompt: [], signal })
      const second = await switchLead(2, signal)
      await turn(second, 'QA: wait while every teammate is inactive')
      waitResult(second)
      await ctx.agentTeams.sendMessage(second, { target: member.member.name,
        content: [{ type: 'text', text: 'Run the inert QA marker until interrupted' }], signal })
      await markerEntered.promise
      const queued = createUserMessage({ source: { kind: 'tool-registry' }, content: [{ type: 'text', text: 'Retained inert QA material' }] })
      const receipt = ctx.agents.sendInput(worker, { message: queued, target: 'next-turn', wakeup: false })
      if (receipt !== undefined) await receipt
      await turn(second, 'QA: interrupt control-worker, then finish this turn')
      await worker.whenIdle()
      const pendingRetained = [...worker.inbox.nextTurn, ...worker.inbox.nextStep].some(message => message.id === queued.id)
      if (!pendingRetained) throw new Error('member interruption removed its pending material')
      await ctx.agentTeams.sendMessage(second, { target: member.member.name,
        content: [{ type: 'text', text: 'QA: consume the retained inert material and finish' }], signal })
      await noticeDelivered.promise
      await ctx.sessions.flush(anchor.session)
      await second.whenIdle()
      const third = await switchLead(3, signal)
      await turn(third, 'QA: wait while every teammate is inactive')
      waitResult(third)
      await coordinator.record(anchor, { operationId: TeamLeadOperationId('snapshot-control-3'), previousTerm: 2,
        recordId: 'control-complete', dataJson: JSON.stringify({ inactiveTerms: [2, 3], pendingRetained,
          memberParentUnchanged: worker.session.header.parentSession === anchor.id }) })
    } finally { signal.removeEventListener('abort', cancel) }
  }
  ctx.on('session/event', (session, event) => {
    if (session.id !== anchor?.id || event.type !== 'turn/end' || started) return
    started = true
    flow = Promise.resolve().then(async () => {
      await anchor.whenIdle()
      await run()
    }).catch(async error => {
      ctx.logger.error(error)
      const state = ctx.sessionProjections.stateOf(anchor.session, 'agentTeam')
      const operation = state.leadCoordination
      if (operation) await coordinator.record(anchor, { operationId: operation.operationId, previousTerm: operation.previousTerm,
        recordId: 'control-complete', dataJson: JSON.stringify({ error: error.message }) })
      else await writer.commitRecord(anchor, () => ({ recordId: 'control-complete', dataJson: JSON.stringify({ error: error.message }) }))
    })
  }, { global: true })
}
