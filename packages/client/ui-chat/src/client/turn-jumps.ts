/** Cross-session requests to open Chat at one durable Turn. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** One target that Chat consumes after the destination Session opens. */
export interface ChatTurnJumpRequest {
  readonly requestId: number
  readonly sessionId: SessionId
  readonly turn: number
  readonly seq: SessionSeq
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Open a Session and land its Chat at a durable Turn. */
    chatTurnJumps: ChatTurnJumps
  }
}

/** Client navigation request retained across destination Session mounting. */
export class ChatTurnJumps extends Service {
  /** Latest unconsumed navigation request, observable across Session mounts. */
  readonly pending: SnapshotStore<ChatTurnJumpRequest | null> = createSnapshotStore(null)
  private nextRequestId = 0

  constructor(ctx: Context) { super(ctx, 'chatTurnJumps') }

  /**
   * Open a Session and request its Chat Turn.
   * @param target - Session id or direct-child address.
   * @param turn - host-assigned Turn number.
   * @param seq - durable `turn/start` sequence number.
   */
  open(target: SessionTarget, turn: number, seq: SessionSeq): void {
    const sessionId = typeof target === 'string' ? target : target.childSessionId
    const request: ChatTurnJumpRequest = { requestId: ++this.nextRequestId, sessionId, turn, seq }
    this.pending.set(request)
    const viewRequestId = this.ctx.uiConversation.requestView(sessionId, 'chat')
    try { this.ctx.uiWorkspace.openSession(target) }
    catch (error) {
      this.consume(request.requestId)
      this.ctx.uiConversation.consumeViewRequest(viewRequestId)
      throw error
    }
  }

  /**
   * Clear only the request handled by the mounted Chat view.
   * @param requestId - request generation observed by that view.
   */
  consume(requestId: number): void {
    if (this.pending.getSnapshot()?.requestId === requestId) this.pending.set(null)
  }
}
