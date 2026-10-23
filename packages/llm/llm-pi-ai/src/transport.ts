/** Call-local HTTP failure capture for hosts that own model transport. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { SimpleStreamOptions } from '@earendil-works/pi-ai'

/** Host-owned HTTP transport. Neither callback may perform SDK-level retries. */
export interface PiAiTransport {
  /** Authorized fetch, including any host-owned credential refresh. HTTP/SSE only. */
  fetch: NonNullable<SimpleStreamOptions['fetch']>
  /** Map a live transport exception to safe serializable facts; no secret text or cause. */
  classifyError: (error: unknown) => LlmFailure | undefined
}

/** One invocation's transport and the final failure hidden by the SDK. */
export interface PiAiTransportCall {
  fetch: NonNullable<SimpleStreamOptions['fetch']>
  failure: () => LlmFailure | undefined
}

/**
 * Capture request and body-read failures without sharing state between calls.
 * @param transport - host transport and safe error classifier.
 * @param signal - cancellation shared with the SDK request.
 * @returns the fetch passed to the SDK and a private failure accessor.
 */
export function createTransportCall(transport: PiAiTransport, signal: AbortSignal): PiAiTransportCall {
  let failure: LlmFailure | undefined
  const capture = (error: unknown): LlmError => {
    let classified: LlmFailure | undefined
    try {
      classified = transport.classifyError(error)
    } catch (_classifierFailure) {
      // An unsafe classifier exception must not replace the sanitized failure.
    }
    const safe = classified === undefined
      ? new LlmError('Model transport failed', 'TRANSPORT')
      : new LlmError(classified.message, classified.code, classified)
    failure = safe.failure
    return safe
  }
  return {
    failure: () => failure,
    async fetch(input, init) {
      try {
        signal.throwIfAborted()
        const response = await transport.fetch(input, init)
        if (signal.aborted) {
          void response.body?.cancel().catch((_abortCleanupFailure: unknown) => {
            // Caller cancellation owns the outcome even if cleanup fails.
          })
          signal.throwIfAborted()
        }
        if (!response.ok) {
          // Hosts classify context overflow/quota before returning a response.
          // Unclassified rejections retain status but never expose their body.
          const status = response.status
          const delay = Number(response.headers.get('retry-after')) * 1000
          const code = status === 401 || status === 403 ? 'AUTH'
            : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'INVALID_REQUEST'
          const error = new LlmError('Model HTTP request rejected', code, {
            status,
            ...Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {},
          })
          failure = error.failure
          void response.body?.cancel().catch((_refusalCleanupFailure: unknown) => {
            // The HTTP rejection already owns the outcome.
          })
          throw error
        }
        if (response.body === null) return response
        const reader = response.body.getReader()
        let closed = false
        let onAbort: () => void = () => {}
        const close = (): void => {
          closed = true
          signal.removeEventListener('abort', onAbort)
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            onAbort = () => {
              if (closed) return
              close()
              controller.error(new LlmError('Model transport cancelled', 'ABORTED'))
              // Wake an SDK reader even when a custom fetch body ignores abort.
              void reader.cancel().then(
                () => { reader.releaseLock() },
                () => { reader.releaseLock() },
              )
            }
            signal.addEventListener('abort', onAbort, { once: true })
            if (signal.aborted) onAbort()
          },
          async pull(controller) {
            let item: ReadableStreamReadResult<Uint8Array>
            try {
              item = await reader.read()
            } catch (error) {
              if (closed) return
              close()
              reader.releaseLock()
              controller.error(capture(error))
              return
            }
            if (closed) return
            if (item.done) {
              close()
              reader.releaseLock()
              controller.close()
            } else {
              controller.enqueue(item.value)
            }
          },
          async cancel(reason) {
            if (closed) return
            close()
            try {
              await reader.cancel(reason)
            } finally {
              reader.releaseLock()
            }
          },
        })
        const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
        for (const key of ['url', 'redirected', 'type'] as const) {
          Object.defineProperty(wrapped, key, { value: response[key] })
        }
        return wrapped
      } catch (error) {
        const safe = failure ?? capture(error).failure
        signal.throwIfAborted()
        throw new LlmError(safe.message, safe.code, safe)
      }
    },
  }
}
