/**
 * Anonymous public HTTP(S) `WebFetchProvider` plugin. It contributes to the
 * `ctx.web` registry without owning the service.
 *
 * @module @deepseek-ai/dsh-web-fetch-http
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { createFakeIpFallback } from './dns-fallback.ts'
import { publicHttpNetwork } from './network.ts'
import { HttpFetchProvider } from './provider.ts'
import type { HttpFetchLimits } from './provider.ts'

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

export {
  LOCAL_FETCH_PROVIDER_ID,
  HttpFetchProvider,
} from './provider.ts'
export type { HttpFetchLimits, HttpFetchResolver } from './provider.ts'

/** Default `User-Agent`: an explicit product agent, never a browser disguise. */
export const DEFAULT_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-http'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config: the provider's transport and size limits plus its `User-Agent` (all defaulted). */
export interface Config {
  /** Recover configured synthetic system-DNS answers through a pinned public DoH resolver. */
  fakeIpDnsEnabled?: boolean
  /** HTTPS RFC 8484 endpoint; queried only after a direct request receives a synthetic answer. */
  fakeIpDnsEndpoint?: string
  /** Public IP literals used to reach the resolver without system DNS. */
  fakeIpDnsBootstrapAddresses?: string[]
  /** Synthetic DNS CIDRs eligible for recovery; other non-public answers remain blocked. */
  fakeIpRanges?: string[]
  /** Shared deadline for the recovery resolver's A and AAAA queries. */
  fakeIpDnsTimeoutMs?: number
  /** Maximum response body size in bytes. */
  maxResponseBytes?: number
  /** Maximum decoded body length in characters. */
  maxBodyChars?: number
  /** Default fetch timeout in milliseconds, within Node's timer range. */
  timeoutMs?: number
  /** Maximum number of same-origin redirect hops to follow. */
  maxRedirects?: number
  /** `User-Agent` header sent on every request. */
  userAgent?: string
}

export const Config: z<Config> = z.object({
  fakeIpDnsEnabled: z.boolean().default(true),
  fakeIpDnsEndpoint: z.string().default('https://cloudflare-dns.com/dns-query'),
  fakeIpDnsBootstrapAddresses: z.array(z.string()).default(['1.1.1.1', '1.0.0.1']),
  fakeIpRanges: z.array(z.string()).default(['198.18.0.0/15']),
  fakeIpDnsTimeoutMs: z.number().default(5_000),
  maxResponseBytes: z.number().default(5_000_000),
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(30_000),
  maxRedirects: z.number().default(5),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** A resource limit (byte/char/length/timeout cap) must be a positive finite number. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-http: ${name} must be a positive finite number`)
  }
}

/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
function assertTimeoutMs(value: number): void {
  assertPositiveFinite('timeoutMs', value)
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-http: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

/** The redirect hop cap must be a non-negative integer (0 follows no redirects). */
function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-http: ${name} must be a non-negative integer`)
  }
}

/** Register the local HTTP(S) fetch provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeoutMs(resolved.timeoutMs)
  assertNonNegativeInteger('maxRedirects', resolved.maxRedirects)
  const limits: HttpFetchLimits = {
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
  }
  const fallback = resolved.fakeIpDnsEnabled
    ? createFakeIpFallback({
      endpoint: resolved.fakeIpDnsEndpoint,
      bootstrapAddresses: resolved.fakeIpDnsBootstrapAddresses,
      ranges: resolved.fakeIpRanges,
      timeoutMs: resolved.fakeIpDnsTimeoutMs,
    })
    : undefined
  ctx.web.registerFetchProvider(new HttpFetchProvider(
    limits,
    (hostname, signal) => publicHttpNetwork.resolve(hostname, signal, undefined, fallback),
  ))
}
