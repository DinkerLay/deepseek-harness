/** View-local DOM destinations for native group controls; no transcript or disclosure state. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConversationSnapshot, GroupKey } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ProcessActivity, ProcessActivitySummary } from '../contract/process-groups.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { processTitle } from './step-process.ts'
import css from './TurnProcessNodeView.module.css'

/** One control's DOM destination and presentation, bound to its original group. */
export interface ProcessHeaderPlacement {
  readonly element: HTMLElement
  readonly compact: boolean
  readonly ordinal: number
}

type Targets = SnapshotStore<ReadonlyMap<GroupKey, ProcessHeaderPlacement>>
const HeaderTargets = createContext<Targets | undefined>(undefined)

/** Keep header destinations isolated to one mounted native Chat view. */
export function ProcessHeaderProvider({ children }: { children: ReactNode }) {
  const [targets] = useState(() => createSnapshotStore<ReadonlyMap<GroupKey, ProcessHeaderPlacement>>(new Map()))
  return <HeaderTargets.Provider value={targets}>{children}</HeaderTargets.Provider>
}

/** Subscribe only to the destination belonging to this mounted group control. */
export function useProcessHeaderPlacement(groupKey: GroupKey): ProcessHeaderPlacement | undefined {
  const targets = useContext(HeaderTargets)
  const subscribe = useCallback((listener: () => void) => targets?.subscribe(listener) ?? (() => {}), [targets])
  const getSnapshot = useCallback(() => targets?.getSnapshot().get(groupKey), [targets, groupKey])
  return useSyncExternalStore(subscribe, getSnapshot)
}

function HeaderTarget({ groupKey, compact, ordinal }: { groupKey: GroupKey; compact: boolean; ordinal: number }) {
  const targets = useContext(HeaderTargets)
  const owned = useRef<HTMLElement | null>(null)
  const bind = useCallback((element: HTMLSpanElement | null) => {
    if (targets === undefined) return
    const current = targets.getSnapshot()
    const prior = current.get(groupKey)
    if (element === null && prior?.element !== owned.current) return
    owned.current = element
    if (element !== null && prior?.element === element && prior.compact === compact && prior.ordinal === ordinal) return
    const next = new Map(current)
    if (element === null) next.delete(groupKey)
    else next.set(groupKey, { element, compact, ordinal })
    targets.set(next)
  }, [compact, groupKey, ordinal, targets])
  return <span className={css.groupTarget} data-inline-process-group={groupKey} ref={bind} />
}

function turnGroups(snapshot: ConversationSnapshot, turn: number): readonly GroupKey[] {
  const view = snapshot.views.grouped('chat')
  if (view === undefined) return []
  return view.entries.flatMap(entry => entry.kind === 'group'
    && view.groupSource(entry.key).getSnapshot()?.data.turn === turn ? [entry.key] : [])
}

function summaryForTurn(snapshot: ConversationSnapshot, turn: number): ProcessActivitySummary {
  const view = snapshot.views.grouped('chat')
  const counts = new Map<ProcessActivity, number>()
  for (const key of turnGroups(snapshot, turn)) {
    for (const item of view?.groupSource(key).getSnapshot()?.data.summary.counts ?? []) {
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + item.count)
    }
  }
  return { counts: [...counts].map(([kind, count]) => ({ kind, count })), running: undefined, runningDetail: '' }
}

/** Render native group controls in source order, with one shared caption for multiple groups. */
export function TurnProcessHeaderOutlet({ turn, useConversation, t }: {
  turn: number
} & Pick<ChatViewSlotProps, 'useConversation' | 't'>) {
  const keys = useRef<readonly GroupKey[]>([])
  const selectKeys = useCallback((snapshot: ConversationSnapshot) => {
    const next = turnGroups(snapshot, turn)
    if (next.length !== keys.current.length || next.some((key, index) => key !== keys.current[index])) keys.current = next
    return keys.current
  }, [turn])
  const groups = useConversation(selectKeys)
  const caption = useConversation(useCallback(snapshot => processTitle(summaryForTurn(snapshot, turn), t), [turn, t]))
  const compact = groups.length > 1
  const targets = useMemo(() => groups.map((groupKey, index) =>
    <HeaderTarget key={groupKey} groupKey={groupKey} compact={compact} ordinal={index + 1} />), [compact, groups])
  return <span className={css.summary} data-turn-process-summary={turn}>
    {compact && <span className={css.summaryCaption}>{caption}</span>}
    {targets}
  </span>
}
