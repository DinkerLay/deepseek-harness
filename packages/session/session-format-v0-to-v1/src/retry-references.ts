import type { SessionFormatEvent, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'

/**
 * Remap released retry references owned by this artifact; another Session's capture stays unchanged.
 * @param event - validated event after structural remapping.
 * @param sessionId - the artifact identity.
 * @param map - exact earlier source-to-target coordinate lookup.
 * @returns event with local retry endpoints in target coordinates.
 */
export function remapReleasedRetryReferences(
  event: SessionFormatEvent,
  sessionId: string,
  map: (source: number) => number,
): SessionFormatEvent {
  const message = (value: SessionFormatJsonObject): SessionFormatJsonObject => {
    const source = value['source'] as SessionFormatJsonObject
    const retry = source?.['supercodeRetry'] as SessionFormatJsonObject | undefined
    if (source?.['kind'] !== 'user' || retry?.['sourceSessionId'] !== sessionId) return value
    return { ...value, source: { ...source, supercodeRetry: { ...retry, sourceEndSeq: map(retry['sourceEndSeq'] as number) } } }
  }
  const data = event.data as SessionFormatJsonObject
  if (event.type === 'user/message') return { ...event, data: message(data) }
  const field = event.type === 'agent/inbox/spliced' ? 'inserted' : event.type === 'session/title-llm-request' ? 'messages' : undefined
  return field === undefined ? event : { ...event, data: { ...data,
    [field]: (data[field] as readonly SessionFormatJsonObject[]).map(message) } }
}
