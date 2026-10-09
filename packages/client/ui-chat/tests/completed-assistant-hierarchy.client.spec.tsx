// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { KeyedSnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssistantMessageNode, ChatNode, ChatNodeOwnerProps } from '../src/client/index.ts'
import { ChatNodeSeat } from '../src/client/chat/ChatNodeSeat.tsx'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { useDisclosure } from '../src/client/chat/use-disclosure.ts'
import { createChatStore } from '../src/client/stores.ts'
import { presentationPolicyFor } from '../src/client/presentation-policy.ts'
import { en } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

afterEach(cleanup)

function keyed<Value>(source: (key: string) => ObservableSnapshot<Value>): KeyedSnapshotSelectorHook<Value> {
  return ((key: string, select?: (value: Value) => unknown, equal?: (a: unknown, b: unknown) => boolean) =>
    bindSnapshotSelector(source(key))(select ?? (value => value), equal)) as KeyedSnapshotSelectorHook<Value>
}

function assistant(seq: number, text: string, step: number): AssistantMessageNode {
  return { kind: 'assistant', seq, time: seq * 1000, turn: 1, step, blocks: [{ kind: 'text', text }] }
}

function fixture(slice: Parameters<typeof chatSnapshotFixture>[0], inline = true, groupPart = 'response') {
  const snapshot = chatSnapshotFixture(slice)
  const store = createChatStore().create()
  const usePresentation = bindSnapshotSelector(createSnapshotStore(presentationPolicyFor('standard', { inlineCompletedSummary: inline })))
  const t = makeTranslate(en)
  const renderSlot = ((_name: string, owner: ChatNodeOwnerProps & { node: ChatNode }, options?: { fallback?: ReactNode }) => {
    if (owner.node.kind !== 'assistant-step') return options?.fallback ?? null
    return <AssistantMarkdown blocks={owner.node.data.blocks} streaming={owner.node.data.status === 'running'}
      interrupted={owner.node.data.status === 'interrupted'} groupPart={owner.groupPart} useDisclosure={useDisclosure}
      usePresentation={usePresentation} t={t} renderMessageImages={() => { throw new Error('No images in this fixture') }} />
  }) as ComponentProps<typeof ChatNodeSeat>['renderSlot']
  const props: Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey'> = {
    groupPart, nodeStore: snapshot.nodes, useChatNode: keyed(key => snapshot.nodes.source(key)),
    useChatNodeProcess: keyed(key => snapshot.nodes.processSource(key)), usePresentation,
    useStore: bindSnapshotSelector(store), actions: store.actions, renderSlot, t,
    openFile: () => { throw new Error('No file open in this fixture') },
    openSkill: () => { throw new Error('No Skill open in this fixture') },
    inspectCall: undefined, forkAt: () => { throw new Error('No fork in this fixture') },
    loadImage: async () => { throw new Error('No image load in this fixture') },
    renderMessageImages: () => { throw new Error('No images in this fixture') }, fileMentions: () => undefined,
  }
  const nodes = snapshot.nodes.values().filter(node => node.kind === 'assistant-step' || node.kind === 'turn-error')
  const view = render(<>{nodes.map(node => <ChatNodeSeat key={node.key} {...props} nodeKey={node.key} />)}</>)
  return { view, store }
}

const finalAnswer = assistant(4, 'final answer', 2)
const completed = {
  nodes: [assistant(2, 'intermediate narration', 1), finalAnswer],
  turnEnds: new Map([[1, 5]]), turnTimings: new Map([[1, { startTime: 0, endTime: 5000 }]]),
}

it('uses secondary hierarchy only for completed process narration, retaining it across whole-Turn disclosure', () => {
  const { view, store } = fixture(completed)
  const intermediate = view.getByText('intermediate narration').closest('[data-chat-node-key]')
  const answer = view.getByText('final answer').closest('[data-chat-node-key]')
  expect(intermediate?.hasAttribute('data-turn-process-member')).toBe(true)
  expect(intermediate?.hasAttribute('data-completed-process-assistant')).toBe(true)
  expect(intermediate?.getAttribute('hidden')).toBe('until-found')
  expect(answer?.hasAttribute('data-completed-process-assistant')).toBe(false)
  act(() => { store.actions.setTurnProcessOpen(1, 2, true) })
  expect(intermediate?.hasAttribute('hidden')).toBe(false)
  expect(intermediate?.hasAttribute('data-completed-process-assistant')).toBe(true)
  expect(answer?.hasAttribute('data-turn-process-answer')).toBe(false)
  expect(answer?.hasAttribute('data-completed-process-assistant')).toBe(false)
  act(() => { store.actions.setTurnProcessOpen(1, 2, false) })
  expect(intermediate?.getAttribute('hidden')).toBe('until-found')
  expect(view.getAllByText('final answer')).toHaveLength(1)
})

it('preserves the native default hierarchy when the deployment option is absent', () => {
  const { view } = fixture(completed, false)
  expect(view.getByText('intermediate narration').closest('[data-turn-process-member]')).not.toBeNull()
  expect(view.container.querySelector('[data-completed-process-assistant]')).toBeNull()
})

it('keeps both settled progress and the current streaming response at ordinary size while the Turn runs', () => {
  const { view } = fixture({
    nodes: [assistant(2, 'settled live progress', 1)],
    partial: { turn: 1, step: 2, blocks: [{ kind: 'text', text: 'current streaming answer' }] },
    turnTimings: new Map([[1, { startTime: 0 }]]),
  })
  expect(view.getByText('settled live progress')).toBeTruthy()
  expect(view.getByText('current streaming answer').closest('[data-streaming]')).not.toBeNull()
  expect(view.container.querySelector('[data-completed-process-assistant]')).toBeNull()
})

it('keeps an interrupted last response and independent failure notices outside secondary narration', () => {
  const partial: AssistantMessageNode = { ...assistant(2, 'interrupted last response', 1), interrupted: true }
  const { view } = fixture({
    nodes: [partial, { kind: 'turn-error', seq: 3, time: 3000, turn: 1, step: 1, message: 'request failed' }],
    turnEnds: new Map([[1, 4]]),
  })
  expect(view.getByText('interrupted last response').closest('[data-completed-process-assistant]')).toBeNull()
  expect(view.container.querySelector('[data-chat-flow-kind="turn-error"]')?.hasAttribute('data-completed-process-assistant')).toBe(false)
  fireEvent.click(view.getByRole('button', { name: /Unknown surface event: turn-error/ }))
  expect(view.container.textContent).toContain('request failed')
})

it('retains body Markdown code and tables instead of switching completed narration to the compact renderer', () => {
  const { view } = fixture({ ...completed, nodes: [assistant(2,
    'Progress with `value`.\n\n```text\ncode payload\n```\n\n| Name | Value |\n| --- | --- |\n| sample | 42 |', 1), finalAnswer] })
  const prose = view.container.querySelector('[data-completed-process-assistant] [data-chat-assistant-prose]')
  expect(prose?.querySelector('p')).not.toBeNull()
  expect(prose?.querySelector('pre')).not.toBeNull()
  expect(prose?.querySelector('table')).not.toBeNull()
  expect(prose?.querySelector('[data-markdown-variant="compact"]')).toBeNull()
})
