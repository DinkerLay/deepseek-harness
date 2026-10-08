import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesReviewAddress, changesSummaryUrl } from '../changes.ts'
import type { ChangesSummaryState, ChangesSummaryStore } from './changes-summary.ts'

/** Read-only access to the native changed-file cache and its review coordinates. */
export interface UiChangesSummary {
  readonly version: 1
  /**
   * Observe one announced summary; undefined means it has not been requested.
   * @param sessionId - original Session owning the announcement.
   * @param seq - recorded announcement sequence.
   * @returns the native cache observation for these coordinates.
   */
  source(sessionId: SessionId, seq: number): ObservableSnapshot<ChangesSummaryState | undefined>
  /**
   * Read through the same cache used by the native card and review tab.
   * @param sessionId - original Session owning the announcement.
   * @param seq - recorded announcement sequence.
   * @returns after the native cache's read attempt settles.
   */
  load(sessionId: SessionId, seq: number): Promise<void>
  /**
   * Address the existing native review surface without changing its state.
   * @param sessionId - original Session owning the announcement.
   * @param seq - recorded announcement sequence.
   * @param turn - recorded Turn number displayed by the review.
   * @returns the native changes-review resource address.
   */
  reviewAddress(sessionId: SessionId, seq: number, turn: number): string
}

declare module '@deepseek-ai/cordis' {
  interface Context { uiChangesSummary: UiChangesSummary }
}

/**
 * Borrow the plugin's existing cache; the plugin remains its lifecycle owner.
 * @param store - native summary cache owned by the deliverables plugin.
 * @returns readonly summary observations and native review addressing.
 */
export function changesSummaryService(store: ChangesSummaryStore): UiChangesSummary {
  return {
    version: 1,
    source: (sessionId, seq) => ({
      getSnapshot: () => store.state.getSnapshot()[changesSummaryUrl(sessionId, seq)],
      subscribe: listener => store.state.subscribe(listener),
    }),
    load: (sessionId, seq) => store.load(sessionId, seq),
    reviewAddress: (sessionId, seq, turn) => changesReviewAddress({ sessionId, seq, turn }),
  }
}
