/** Bounded DNS-over-HTTPS recovery for explicitly configured synthetic address ranges. */
import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { decode, encode, RECURSION_DESIRED } from 'dns-packet'
import ipaddr from 'ipaddr.js'
import { WebError } from '@deepseek-ai/dsh-web'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { isPublicIpAddress, publicHttpNetwork } from './network.ts'
import type { PublicAddress, SyntheticAddressFallback } from './network.ts'
import { validateFetchUrl } from './policy.ts'

/** Deployment-owned resolver and synthetic address ranges; never supplied by model requests. */
export interface FakeIpDnsOptions {
  /** HTTPS RFC 8484 endpoint receiving only queried hostnames. */
  endpoint: string
  /** Public IP literals used to reach the resolver without system DNS. */
  bootstrapAddresses: readonly string[]
  /** CIDRs identifying synthetic answers eligible for a fresh public lookup. */
  ranges: readonly string[]
  /** One deadline shared by the A and AAAA queries. */
  timeoutMs: number
}

// A DNS wire message has a 16-bit length in the stream representation (RFC 1035).
const MAX_DNS_MESSAGE_BYTES = 65_535
const canonicalName = (name: string): string => name.toLowerCase().replace(/\.$/u, '')

/**
 * Validate resolver configuration and construct a synthetic-address recovery policy.
 * @param options - deployment configuration after plugin defaults.
 * @returns a policy whose results must pass the ordinary public-address validator.
 */
export function createFakeIpFallback(options: FakeIpDnsOptions): SyntheticAddressFallback {
  const timeoutMs = options.timeoutMs
  const endpoint = validateFetchUrl(options.endpoint)
  if (endpoint.protocol !== 'https:' || endpoint.hash !== '' || endpoint.search !== '') {
    throw new Error('web-fetch-http: fakeIpDnsEndpoint must be an HTTPS URL without a query or fragment')
  }
  if (options.bootstrapAddresses.length === 0) throw new Error('web-fetch-http: fakeIpDnsBootstrapAddresses must not be empty')
  const bootstrap: PublicAddress[] = options.bootstrapAddresses.map((address) => {
    const family = isIP(address)
    if ((family !== 4 && family !== 6) || !isPublicIpAddress(address)) {
      throw new Error('web-fetch-http: fakeIpDnsBootstrapAddresses must contain only public IP literals')
    }
    return { address, family }
  })
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-http: fakeIpDnsTimeoutMs must be positive and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const ranges = options.ranges.map((range) => {
    try { return ipaddr.parseCIDR(range) }
    catch (cause) { throw new Error('web-fetch-http: fakeIpRanges must contain valid CIDRs', { cause }) }
  })
  if (ranges.length === 0) throw new Error('web-fetch-http: fakeIpRanges must not be empty')
  return {
    matches(address) {
      if (!ipaddr.isValid(address)) return false
      const parsed = ipaddr.parse(address)
      return ranges.some(([network, prefix]) => parsed.kind() === network.kind() && parsed.match(network, prefix))
    },
    async resolve(hostname, signal) {
      using operation = deadline(signal, timeoutMs, 'WEB_DNS_TIMEOUT')
      try {
        // One operation owns both requests; each releases its body and pool before the next starts.
        const a = await query(hostname, 'A', endpoint, bootstrap, operation.signal)
        const aaaa = await query(hostname, 'AAAA', endpoint, bootstrap, operation.signal)
        operation.signal.throwIfAborted()
        return [...a, ...aaaa]
      } catch (cause) {
        signal.throwIfAborted()
        throw new WebError(`Public DNS resolution failed for "${hostname}"; check the configured DNS resolver's reachability.`,
          'WEB_DNS_RESOLUTION_FAILED', { cause })
      }
    },
  }
}

async function query(hostname: string, type: 'A' | 'AAAA', endpoint: URL,
  bootstrap: readonly PublicAddress[], signal: AbortSignal): Promise<LookupAddress[]> {
  signal.throwIfAborted()
  const name = canonicalName(hostname)
  if (name.length > 253 || name.split('.').some(label => label.length === 0 || label.length > 63)) {
    throw new Error('DNS hostname exceeds the wire-format limits')
  }
  const message = encode({ type: 'query', id: 0, flags: RECURSION_DESIRED, questions: [{ name, type, class: 'IN' }] })
  const url = new URL(endpoint)
  url.searchParams.set('dns', message.toString('base64url'))
  // The resolver URL makes its own native routing decision. A proxied resolver
  // lets the trusted proxy resolve that hostname; a direct resolver uses the
  // configured public bootstrap set to avoid the same synthetic system DNS.
  const route = proxyRouteFor(url)
  const request = route.proxied
    ? await publicHttpNetwork.requestVia(route.dispatcher, url, { accept: 'application/dns-message' }, signal)
    : await publicHttpNetwork.request(url, bootstrap, { accept: 'application/dns-message' }, signal)
  const reader = request.response.body?.getReader()
  try {
    const response = request.response
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/dns-message') {
      throw new Error(`DNS resolver returned an unsupported response (HTTP ${response.status})`)
    }
    const declared = Number(response.headers.get('content-length'))
    if (declared > MAX_DNS_MESSAGE_BYTES) throw new Error('DNS response exceeds the wire-format limit')
    if (reader === undefined) throw new Error('DNS resolver returned no body')
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_DNS_MESSAGE_BYTES) throw new Error('DNS response exceeds the wire-format limit')
      chunks.push(value)
    }
    signal.throwIfAborted()
    return decodeAnswers(Buffer.concat(chunks), name, type)
  } finally {
    if (reader !== undefined) {
      try { await reader.cancel() }
      catch { /* An errored or aborted body is already unusable; the dispatcher below owns socket cleanup. */ }
      reader.releaseLock()
    }
    await request.close()
  }
}

function decodeAnswers(bytes: Buffer, name: string, type: 'A' | 'AAAA'): LookupAddress[] {
  const response = decode(bytes)
  const question = response.questions?.[0]
  if (decode.bytes !== bytes.length || response.id !== 0 || response.type !== 'response'
    || (bytes.readUInt16BE(2) & 0x7a0f) !== 0 // QUERY opcode, no truncation, NOERROR rcode.
    || response.questions?.length !== 1 || question?.type !== type || question.class !== 'IN'
    || canonicalName(question.name) !== name) {
    throw new Error('DNS resolver returned an invalid or mismatched answer')
  }
  const aliases = new Map<string, string>()
  for (const answer of response.answers ?? []) {
    if (answer.type !== 'CNAME' || answer.class !== 'IN') continue
    const owner = canonicalName(answer.name), target = canonicalName(answer.data)
    if (aliases.has(owner) && aliases.get(owner) !== target) throw new Error('DNS resolver returned conflicting aliases')
    aliases.set(owner, target)
  }
  const names = new Set<string>()
  let current: string | undefined = name
  while (current !== undefined) {
    if (names.has(current)) throw new Error('DNS resolver returned an alias cycle')
    names.add(current)
    current = aliases.get(current)
  }
  return (response.answers ?? []).flatMap(answer => answer.type === type && answer.class === 'IN'
    && names.has(canonicalName(answer.name)) ? [{ address: answer.data, family: type === 'A' ? 4 : 6 }] : [])
}
