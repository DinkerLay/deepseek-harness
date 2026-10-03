/** Native V4 admission of recorded execution and automatic title state. */

import { isAbsolute } from 'node:path'
import { isSessionFormatJsonObject, SessionFormatError } from '@deepseek-ai/dsh-session-format'

/**
 * Validate execution and title payloads before encoding or physical row recovery.
 * @param value - native V4 row or logical event received from storage.
 */
export function assertV4ExecutionState(value: unknown): void {
  if (!isSessionFormatJsonObject(value)) return
  const type = value['type']
  if (type !== 'session/execution-directory' && type !== 'session/title-generation'
    && type !== 'session/title-policy' && type !== 'session/title'
    && type !== 'session/title-llm-request') return
  const data = value['data']
  if (!isSessionFormatJsonObject(data)) throw new SessionFormatError(`${type} data must be an object`)
  switch (type) {
    case 'session/execution-directory':
      if (typeof data['sessionId'] !== 'string' || data['sessionId'].length === 0
        || typeof data['cwd'] !== 'string' || !isAbsolute(data['cwd']) || data['cwd'].includes('\0')) {
        throw new SessionFormatError('session/execution-directory requires its Session id and an absolute cwd')
      }
      break
    case 'session/title-generation':
      if (data['state'] !== 'generating' && data['state'] !== 'ready' && data['state'] !== 'failed') {
        throw new SessionFormatError('session/title-generation requires generating, ready or failed state')
      }
      if (data['error'] !== undefined && (data['state'] !== 'failed' || typeof data['error'] !== 'string')) {
        throw new SessionFormatError('session/title-generation error requires failed state and string text')
      }
      break
    case 'session/title-policy':
      if (typeof data['automatic'] !== 'boolean') throw new SessionFormatError('session/title-policy requires boolean automatic')
      break
    default:
      if (data['inputTruncated'] !== undefined && data['inputTruncated'] !== true) {
        throw new SessionFormatError(`${type} inputTruncated must be true when present`)
      }
  }
}
