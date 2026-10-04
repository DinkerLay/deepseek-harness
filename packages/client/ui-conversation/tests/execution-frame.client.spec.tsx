// @vitest-environment jsdom
/** Actual retained Session generations rendered through the production Client roster. */
import './control-row-dom.ts'
import { act, fireEvent, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createClientTest, webApp, type TestClient } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionFollowFrame, SessionFollowRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import type { InjectFace, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ok, openStream, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { InputHub } from '../src/client/input/hub.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    executionFrameTest: unknown
  }
}

const ADDRESS = SessionId('stable-address')
const FIRST = SessionId('first-execution')
const SECOND = SessionId('second-execution')
const CONTENT = new Map([
  [ADDRESS, 'Original address transcript'],
  [FIRST, 'First execution transcript'],
  [SECOND, 'Second execution transcript'],
])
interface Surface {
  readonly client: TestClient
  readonly container: HTMLElement
}

// The consumer owns its mount and removes React while scoped services are
// still live; the test Client owns the subsequent Loader-tree teardown.
const it = createClientTest({ roster: webApp }).extend<{ surface: () => Promise<Surface> }>({
  surface: async ({ start }, use) => {
    let surface: Surface | undefined
    let unmount: (() => void) | undefined
    try {
      await use(async () => {
        if (surface !== undefined) return surface
        const client = await start()
        const container = document.createElement('div')
        document.body.appendChild(container)
        await act(async () => { unmount = client.ctx.uiRenderer.mount(container) })
        surface = { client, container }
        return surface
      })
    } finally {
      await act(async () => { unmount?.() })
      surface?.container.remove()
    }
  },
})

const rangeGeometry = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
beforeEach(() => {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }),
  })
})
afterEach(() => {
  if (rangeGeometry === undefined) Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  else Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeGeometry)
})

interface Selection {
  readonly executionId: SessionId
  readonly readOnly: boolean
}

function injectedSelection(
  selection: ReturnType<typeof createSnapshotStore<Selection>>,
  references: ReadonlyMap<SessionId, SessionReference>,
) {
  return {
    hooks: { executionSelection: selection },
    reference: (id: SessionId) => {
      const reference = references.get(id)
      if (reference === undefined) throw new Error(`missing owned execution reference ${id}`)
      return reference
    },
  }
}

type BindingProps = PropsRuntime<'conversation.binding'> & PropsRenderFactories<true>
  & InjectFace<ReturnType<typeof injectedSelection>> & { readonly matched: true }

function ExecutionBinding({ SessionProvider, renderFactorySlot, useExecutionSelection, reference }: BindingProps) {
  const selection = useExecutionSelection(value => value)
  return (
    <SessionProvider session={reference(selection.executionId)} presentationOptions={{
      addressSessionId: ADDRESS,
      readOnly: selection.readOnly,
    }}>
      {renderFactorySlot('conversation.frame', {})}
    </SessionProvider>
  )
}

function TopProbe({ sessionId, sessionAddressId, sessionReadOnly, useSession }: PropsRuntime<'conversation.top'>) {
  const actualId = useSession(value => value.sessionId)
  return <output data-testid="execution-top">{sessionId}:{actualId}:{sessionAddressId}:{String(sessionReadOnly)}</output>
}

function FirstTop() {
  return <span data-testid="first-top">First top contribution</span>
}

function HeaderMutation() {
  return <button data-testid="header-mutation">Header mutation</button>
}

function NodePresentation({ node, matched }: PropsRuntime<'conversation.chat.node.presentation'> & { matched: string }) {
  return <section data-testid="selected-node" data-original-node-key={node.key}>Selected presentation: {matched}</section>
}

function eventFor(id: SessionId) {
  return {
    type: 'user/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append',
    data: createUserMessage({ content: [{ type: 'text', text: CONTENT.get(id)! }], source: { kind: 'user' } }),
  } satisfies SessionEvent<'user/message'>
}

function scriptSessions(mock: RemoteMock, titled = false): void {
  const projections = (sessionId: SessionId) => ({ subagentCatalog: [],
    ...titled ? { title: `Title for ${sessionId}` } : {} })
  mock.remote.session.list.mockResolvedValue(ok({ items: [ADDRESS, FIRST, SECOND].map(sessionId => ({
    sessionId, updatedAt: 1, running: false, blank: false, agentAvailable: true,
    ...titled ? { projections: { kind: 'sequenced' as const, asOfSeq: 0, values: projections(sessionId) } } : {},
  })) }))
  mock.remote.session.projections.mockImplementation(async request => ok({ asOfSeq: 0, values: projections(request.sessionId) }))
  mock.stream('job/list', openStream([{ type: 'rows', jobs: [] }]))
  mock.remote.commands.list.mockResolvedValue(ok([]))
  mock.remote.skills.list.mockResolvedValue(ok({ skills: [] }))
  mock.stream('session/follow', ([raw], stream) => {
    const request = raw as SessionFollowRequest
    if (request.address.kind !== 'session') throw new Error('fixture expects ordinary Sessions')
    const id = request.address.sessionId
    stream.push({
      type: 'snapshot', header: { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false },
      cursor: SessionSeq(0), records: [{ type: 'event', event: eventFor(id) }], hasMore: false,
      projections: { asOfSeq: SessionSeq(0), values: projections(id) },
      ...request.assistantStream === true ? { assistantStream: { revision: 0 } } : {},
    } satisfies SessionFollowFrame)
  })
}

async function prepareAddress(client: TestClient): Promise<void> {
  const reference = client.ctx.sessions.retain(ADDRESS, { source: 'executionFrameTest' })
  onTestFinished(() => { reference.release() })
  await reference.ready
  client.ctx.uiSession.bindingSource(reference)
  await client.flush()
}

describe('execution-bound Conversation frame', () => {
  it('keeps the stable-address Header title while View requests continue to target the actual execution', async ({ mock, surface }) => {
    scriptSessions(mock, true)
    const { client, container } = await surface()
    await prepareAddress(client)
    const references = new Map<SessionId, SessionReference>()
    onTestFinished(() => { for (const reference of references.values()) reference.release() })
    for (const id of [FIRST, SECOND]) {
      const reference = client.ctx.sessions.retain(id, { source: 'executionFrameTest' })
      references.set(id, reference)
      await reference.ready
    }
    const selection = createSnapshotStore<Selection>({ executionId: FIRST, readOnly: false })
    const fiber = client.ctx.plugin({ inject: ['slots'], apply(ctx) {
      ctx.slots.inject('conversation.binding', () => ctx.slots.register({
        name: 'conversation.binding', select: (owner): true | null => owner.sessionId === ADDRESS ? true : null,
        inject: () => injectedSelection(selection, references),
      }, ExecutionBinding))
    } })
    await fiber.await()
    await act(async () => { client.ctx.uiWorkspace.openSession(ADDRESS) })
    const view = within(container)
    expect(await view.findByText(CONTENT.get(FIRST)!)).toBeTruthy()
    const title = () => container.querySelector('header nav')?.textContent
    expect(title()).toBe(`Title for ${ADDRESS}`)
    expect(title()).not.toContain(`Title for ${FIRST}`)
    await act(async () => { client.ctx.uiConversation.requestView(ADDRESS, 'chat') })
    expect(client.ctx.uiConversation.viewSelection.getSnapshot()?.sessionId).toBe(ADDRESS)
    await act(async () => { client.ctx.uiConversation.requestView(FIRST, 'chat') })
    expect(client.ctx.uiConversation.viewSelection.getSnapshot()).toBeNull()
    expect(view.getByText(CONTENT.get(FIRST)!)).toBeTruthy()

    await act(async () => { selection.set({ executionId: SECOND, readOnly: false }) })
    expect(await view.findByText(CONTENT.get(SECOND)!)).toBeTruthy()
    expect(title()).toBe(`Title for ${ADDRESS}`)
    await act(async () => { await fiber.dispose() })
    expect(await view.findByText(CONTENT.get(ADDRESS)!)).toBeTruthy()
    expect(title()).toBe(`Title for ${ADDRESS}`)
    await act(async () => { client.ctx.uiWorkspace.openSession(FIRST) })
    expect(await view.findByText(CONTENT.get(FIRST)!)).toBeTruthy()
    expect(title()).toBe(`Title for ${FIRST}`)
  }, 60_000)

  it('keeps the default address, transcript, composer, and top ordering without a binding entry', async ({ mock, surface }) => {
    scriptSessions(mock)
    const { client, container } = await surface()
    await prepareAddress(client)
    const fiber = client.ctx.plugin({ inject: ['slots'], apply(ctx) {
      ctx.slots.inject('conversation.top', function* () {
        yield ctx.slots.register({ name: 'conversation.top', id: 'probe', order: 20 }, TopProbe)
        yield ctx.slots.register({ name: 'conversation.top', id: 'first', order: 10 }, FirstTop)
      })
    } })
    await fiber.await()
    await act(async () => { client.ctx.uiWorkspace.openSession(ADDRESS) })
    const view = within(container)
    expect(await view.findByText(CONTENT.get(ADDRESS)!)).toBeTruthy()
    expect(view.getByTestId('execution-top').textContent).toBe(`${ADDRESS}:${ADDRESS}:${ADDRESS}:false`)
    expect(view.getByTestId('first-top').compareDocumentPosition(view.getByTestId('execution-top'))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('[data-composer-input]')).not.toBeNull()
    expect(client.ctx.sessions.retainInfo(ADDRESS).getSnapshot().retainedBy.mainView).toBe(1)
    expect(mock.log.unmatched()).toEqual([])
  }, 60_000)

  it('rebinds real execution data and input under one address, then renders readonly history without mutation chrome', async ({ mock, surface }) => {
    scriptSessions(mock)
    mock.remote.session.modelCatalog.mockResolvedValue(ok({
      default: { provider: 'deepseek-official', model: 'fixture-model' },
      routableProviders: ['deepseek-official'], failures: [],
      groups: [{ id: 'deepseek-official', name: 'Fixture', models: [{ id: 'fixture-model', name: 'Fixture' }] }],
    }))
    mock.remote.session.prompt.mockResolvedValue(ok({ accepted: true }))
    const { client, container } = await surface()
    await prepareAddress(client)
    const references = new Map<SessionId, SessionReference>()
    onTestFinished(() => { for (const reference of references.values()) reference.release() })
    for (const id of [FIRST, SECOND]) {
      const reference = client.ctx.sessions.retain(id, { source: 'executionFrameTest' })
      references.set(id, reference)
      await reference.ready
    }
    const selection = createSnapshotStore<Selection>({ executionId: FIRST, readOnly: false })
    const fiber = client.ctx.plugin({ inject: ['slots'], apply(ctx) {
      ctx.slots.inject('conversation.binding', () => ctx.slots.register({
        name: 'conversation.binding', select: (owner): true | null => owner.sessionId === ADDRESS ? true : null,
        inject: () => injectedSelection(selection, references),
      }, ExecutionBinding))
      ctx.slots.inject('conversation.top', () =>
        ctx.slots.register({ name: 'conversation.top', id: 'execution' }, TopProbe))
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({ name: 'conversation.session.header.actions', id: 'mutation' }, HeaderMutation))
    } })
    await fiber.await()
    await act(async () => { client.ctx.uiWorkspace.openSession(ADDRESS) })
    const view = within(container)
    expect(await view.findByText(CONTENT.get(FIRST)!)).toBeTruthy()
    expect(view.queryByText(CONTENT.get(ADDRESS)!)).toBeNull()
    expect(view.getByTestId('execution-top').textContent).toBe(`${FIRST}:${FIRST}:${ADDRESS}:false`)
    expect(view.getByTestId('header-mutation')).toBeTruthy()
    const hub = client.ctx.conversation.input as InputHub
    await act(async () => { hub.shell(FIRST).setDraft('Input for the actual first execution') })
    fireEvent.keyDown(container.querySelector('[data-composer-input]')!, { key: 'Enter' })
    await vi.waitFor(() => { expect(mock.remote.session.prompt).toHaveBeenCalledOnce() })
    expect(mock.remote.session.prompt.mock.calls[0]?.[0]).toMatchObject({
      sessionId: FIRST, content: [{ type: 'text', text: 'Input for the actual first execution' }],
    })

    await act(async () => { selection.set({ executionId: SECOND, readOnly: false }) })
    expect(await view.findByText(CONTENT.get(SECOND)!)).toBeTruthy()
    expect(view.queryByText(CONTENT.get(FIRST)!)).toBeNull()
    expect(view.getByTestId('execution-top').textContent).toBe(`${SECOND}:${SECOND}:${ADDRESS}:false`)
    expect(client.ctx.sessions.retainInfo(ADDRESS).getSnapshot().retainedBy.mainView).toBe(1)
    expect(client.ctx.sessions.retainInfo(FIRST).getSnapshot().retainedBy.mainView).toBeUndefined()
    expect(client.ctx.sessions.retainInfo(SECOND).getSnapshot().retainedBy.mainView).toBeUndefined()

    await act(async () => { selection.set({ executionId: FIRST, readOnly: true }) })
    expect(await view.findByText(CONTENT.get(FIRST)!)).toBeTruthy()
    expect(view.getByTestId('execution-top').textContent).toBe(`${FIRST}:${FIRST}:${ADDRESS}:true`)
    expect(container.querySelector('[data-composer-input]')).toBeNull()
    expect(view.queryByTestId('header-mutation')).toBeNull()

    await act(async () => { await fiber.dispose() })
    expect(await view.findByText(CONTENT.get(ADDRESS)!)).toBeTruthy()
    expect(container.querySelector('[data-composer-input]')).not.toBeNull()
    expect(client.ctx.sessions.binding(ADDRESS)?.session.sessionId).toBe(ADDRESS)
    expect(mock.log.unmatched()).toEqual([])
  }, 60_000)

  it('publishes shared-generation readonly changes without changing execution sources or allowing presentation downgrade', async ({ mock, surface }) => {
    scriptSessions(mock)
    const { client, container } = await surface()
    const fiber = client.ctx.plugin({ inject: ['slots'], apply(ctx) {
      ctx.slots.inject('conversation.top', () =>
        ctx.slots.register({ name: 'conversation.top', id: 'execution' }, TopProbe))
      ctx.slots.inject('conversation.session.header.actions', () =>
        ctx.slots.register({ name: 'conversation.session.header.actions', id: 'mutation' }, HeaderMutation))
    } })
    await fiber.await()
    const reference = client.ctx.sessions.retain(ADDRESS, { source: 'executionFrameTest' })
    onTestFinished(() => { reference.release() })
    await reference.ready
    client.ctx.uiSession.bindingSource(reference)
    await act(async () => { client.ctx.uiWorkspace.openSession(ADDRESS) })
    const adapter = client.ctx.uiSession.adapter
    type Present = NonNullable<typeof adapter.present>
    const present = (binding: Parameters<Present>[0], options: Parameters<Present>[1]) => {
      if (adapter.present === undefined) throw new Error('production Session adapter has no presentation method')
      return adapter.present(binding, options)
    }
    const absent = adapter.bindingSource(undefined).getSnapshot()
    expect(present(absent, { addressSessionId: FIRST, readOnly: true })).toBe(absent)
    const source = adapter.bindingSource(reference)
    const execution = source.getSnapshot()
    expect(present(execution, {})).toBe(execution)
    const displayed = present(execution, { addressSessionId: FIRST, readOnly: true })
    expect(present(execution, { addressSessionId: FIRST, readOnly: true })).toBe(displayed)
    expect(displayed).toMatchObject({ key: ADDRESS, props: { sessionId: ADDRESS, sessionAddressId: FIRST, sessionReadOnly: true } })
    expect(displayed.hooks).toBe(execution.hooks)
    expect(displayed.keyedHooks).toBe(execution.keyedHooks)
    expect(present(displayed, { readOnly: false })).toBe(displayed)
    const view = within(container)
    expect(view.getByTestId('header-mutation')).toBeTruthy()
    expect(container.querySelector('[data-composer-input]')).not.toBeNull()

    const historical = client.ctx.sessions.retain({ sessionId: ADDRESS, mode: 'read-only' }, { source: 'executionFrameTest' })
    onTestFinished(() => { historical.release() })
    await act(async () => { await historical.ready })
    expect(historical.binding).toBe(reference.binding)
    expect(adapter.bindingSource(historical)).toBe(source)
    expect(source.getSnapshot()).not.toBe(execution)
    expect(source.getSnapshot().key).toBe(execution.key)
    expect(source.getSnapshot().hooks['session']).toBe(execution.hooks['session'])
    expect(view.getByTestId('execution-top').textContent).toBe(`${ADDRESS}:${ADDRESS}:${ADDRESS}:true`)
    expect(container.querySelector('[data-composer-input]')).toBeNull()
    expect(view.queryByTestId('header-mutation')).toBeNull()
    expect(present(source.getSnapshot(), { readOnly: false })).toBe(source.getSnapshot())
    await act(async () => { historical.release() })
    expect(reference.binding.session.getSnapshot().readOnly).toBe(true)
    expect(container.querySelector('[data-composer-input]')).toBeNull()
    await act(async () => {
      client.ctx.uiWorkspace.openSession(SECOND)
      reference.release()
    })
    expect(source.getSnapshot()).toBe(absent)
    expect(await view.findByText(CONTENT.get(SECOND)!)).toBeTruthy()
    expect(container.querySelector('[data-composer-input]')).not.toBeNull()
    expect(mock.log.unmatched()).toEqual([])
  }, 60_000)

  it('elects one exact node presentation while preserving the original keyed node and no-match output', async ({ mock, surface }) => {
    scriptSessions(mock)
    const { client, container } = await surface()
    await prepareAddress(client)
    await act(async () => { client.ctx.uiWorkspace.openSession(ADDRESS) })
    const view = within(container)
    expect(await view.findByText(CONTENT.get(ADDRESS)!)).toBeTruthy()
    const original = container.querySelector('[data-chat-node-key]')!
    const originalKey = original.getAttribute('data-chat-node-key')
    const originalBody = original.textContent
    const binding = client.ctx.sessions.binding(ADDRESS)!
    const entries = binding.eventSource.getSnapshot().entries
    const fiber = client.ctx.plugin({ inject: ['slots'], apply(ctx) {
      ctx.slots.inject('conversation.chat.node.presentation', () => ctx.slots.register({
        name: 'conversation.chat.node.presentation',
        select: ({ node }) => {
          if (node.kind !== 'user') return null
          const text = node.data.content.find(block => block.type === 'text')?.text
          return text !== undefined && text === CONTENT.get(ADDRESS) ? text : null
        },
      }, NodePresentation))
    } })
    await act(async () => { await fiber.await() })
    expect(view.getByTestId('selected-node').textContent).toBe(`Selected presentation: ${CONTENT.get(ADDRESS)}`)
    expect(view.getByTestId('selected-node').getAttribute('data-original-node-key')).toBe(originalKey)
    expect(container.querySelectorAll('[data-chat-node-key]')).toHaveLength(1)
    expect(container.querySelector('[data-chat-node-key]')).toBe(original)
    expect(binding.eventSource.getSnapshot().entries).toBe(entries)

    await act(async () => { client.ctx.uiWorkspace.openSession(FIRST) })
    expect(await view.findByText(CONTENT.get(FIRST)!)).toBeTruthy()
    expect(view.queryByTestId('selected-node')).toBeNull()
    await act(async () => {
      client.ctx.uiWorkspace.openSession(ADDRESS)
      await fiber.dispose()
    })
    expect(await view.findByText(CONTENT.get(ADDRESS)!)).toBeTruthy()
    expect(container.querySelector('[data-chat-node-key]')?.textContent).toBe(originalBody)
    expect(container.querySelectorAll('[data-chat-node-key]')).toHaveLength(1)
    expect(mock.log.unmatched()).toEqual([])
  }, 60_000)
})
