/** Stable HTTP(S) navigation addresses for native Sidebar resource deduplication. */
import { MAX_BROWSER_URL_LENGTH, parseBrowserAddress, type BrowserAddressResult, type BrowserTarget } from './url.ts'

const PREFIX = 'dsh-resource://webpage/'

/** Canonical resource address or the native address refusal. */
export type BrowserResourceAddressResult =
  | { readonly ok: true; readonly address: string; readonly target: BrowserTarget }
  | Extract<BrowserAddressResult, { ok: false }>

/**
 * Normalize an HTTP(S) URL into a stable resource identity, independent from display titles.
 * @param value URL input.
 * @param applicationOrigin Current application origin, which navigation cannot open.
 * @returns Canonical address and target, or a refusal without allocating a tab.
 */
export function browserResourceAddress(value: string, applicationOrigin?: string): BrowserResourceAddressResult {
  const result = parseBrowserAddress(value, applicationOrigin)
  if (!result.ok) return result
  if (result.target.url.length > MAX_BROWSER_URL_LENGTH) return { ok: false, reason: 'invalid' }
  return { ...result, address: PREFIX + encodeURIComponent(result.target.url) }
}

/**
 * Decode only one bounded HTTP(S) resource segment; other resources remain unrelated.
 * @param address Sidebar resource identity.
 * @param applicationOrigin Current application origin.
 * @returns Native target or address refusal; malformed encodings never become URLs.
 */
export function browserResourceTarget(address: string, applicationOrigin?: string): BrowserAddressResult {
  if (!address.startsWith(PREFIX) || address.length > PREFIX.length + MAX_BROWSER_URL_LENGTH * 3) {
    return { ok: false, reason: 'invalid' }
  }
  const segment = address.slice(PREFIX.length)
  if (segment === '' || /[/?#]/u.test(segment)) return { ok: false, reason: 'invalid' }
  let value: string
  try { value = decodeURIComponent(segment) }
  catch (_invalidEncoding) { return { ok: false, reason: 'invalid' } }
  if (!/^https?:\/\//iu.test(value)) return { ok: false, reason: 'protocol' }
  const result = parseBrowserAddress(value, applicationOrigin)
  return result.ok && result.target.url.length > MAX_BROWSER_URL_LENGTH ? { ok: false, reason: 'invalid' } : result
}
