/**
 * Runtime vocabulary derived from the persisted work-details mode. Renderers
 * and seats select single fields of this policy; none of them compares the
 * mode enum, so adding a mode changes only the table below.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { TranscriptViewMode } from '../chat-settings.ts'

/** Presentation capabilities that one work-details mode enables. */
export interface ChatPresentationPolicy {
  /** Static running presentation; absence retains native animated activity. */
  readonly quietActivity?: boolean
  /** A static completed-work summary shares the Turn toggle; group controls retain their original positions. */
  readonly inlineCompletedSummary?: boolean
  /** Mode this policy was derived from; for diagnostics, never for branching in renderers. */
  readonly mode: TranscriptViewMode
  /** Whether a normally completed Turn folds its process rows behind the whole-Turn control. */
  readonly foldCompletedTurns: boolean
  /** Collapsible group headers for all Turns, historical Turns only, or no Turns. */
  readonly stepGrouping: 'collapsed' | 'history' | 'none'
  /** Show the running command, path, query, or reasoning detail in group titles. */
  readonly liveProcessDetail: boolean
  /** Whether a settled reasoning row previews its first line beside the Think title. */
  readonly settledReasoningPreview: boolean
}

/** Deployment preferences independent of the reader's work-details mode. */
export interface ChatPresentationOptions {
  readonly quietActivity?: boolean
  readonly inlineCompletedSummary?: boolean
}

const configuredPolicies = new Map<string, ChatPresentationPolicy>()

const POLICIES: Readonly<Record<TranscriptViewMode, ChatPresentationPolicy>> = {
  compact: {
    mode: 'compact',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: false,
    settledReasoningPreview: false,
  },
  standard: {
    mode: 'standard',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  detailed: {
    mode: 'detailed',
    foldCompletedTurns: true,
    stepGrouping: 'history',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  verbose: {
    mode: 'verbose',
    foldCompletedTurns: false,
    stepGrouping: 'none',
    liveProcessDetail: false,
    settledReasoningPreview: true,
  },
}

/**
 * Resolve the policy constant for one mode. The same mode always yields the
 * same object, so selectors over a policy see stable identities.
 * @param mode - persisted work-details mode.
 * @param options - deployment presentation independent from the work-details mode.
 * @returns the mode's presentation policy.
 */
export function presentationPolicyFor(mode: TranscriptViewMode, options: ChatPresentationOptions = {}): ChatPresentationPolicy {
  const quietActivity = options.quietActivity === true
  const inlineCompletedSummary = options.inlineCompletedSummary === true
  if (!quietActivity && !inlineCompletedSummary) return POLICIES[mode]
  const key = `${mode}:${String(quietActivity)}:${String(inlineCompletedSummary)}`
  let policy = configuredPolicies.get(key)
  if (policy === undefined) {
    policy = { ...POLICIES[mode], quietActivity, inlineCompletedSummary }
    configuredPolicies.set(key, policy)
  }
  return policy
}

/**
 * Derive a policy observable from the mode observable without a subscription of
 * its own: reads are a table lookup and change notifications are the mode's.
 * @param mode - live work-details mode.
 * @param options - optional live deployment preferences; unsubscribed with the mode source.
 * @returns observable policy that changes exactly when the mode changes.
 */
export function derivePresentationPolicy(
  mode: ObservableSnapshot<TranscriptViewMode>,
  options?: ObservableSnapshot<ChatPresentationOptions>,
): ObservableSnapshot<ChatPresentationPolicy> {
  return {
    getSnapshot: () => presentationPolicyFor(mode.getSnapshot(), options?.getSnapshot()),
    subscribe: (listener) => {
      const removeMode = mode.subscribe(listener)
      const removeOptions = options?.subscribe(listener)
      return () => { removeMode(); removeOptions?.() }
    },
  }
}
