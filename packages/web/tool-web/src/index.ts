/**
 * Model-facing `web_search` and `web_fetch` tools over `ctx.web`. This package owns schemas,
 * validation, prompt guidance, limits, and presentation, never concrete providers. Enablement
 * controls tool registration; an enabled tool remains visible when its provider is unavailable
 * and fails with a structured error at execution time.
 * @module @deepseek-ai/dsh-tool-web
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { applyWebSearchTool, WEB_SEARCH_MAX_QUERIES, WEB_SEARCH_MAX_RESULTS } from './search.ts'
import { applyWebFetchTool } from './fetch.ts'

export { WEB_SEARCH_MAX_QUERIES, WEB_SEARCH_MAX_RESULTS, applyWebSearchTool, formatSearchOutput, presentSearchCall, presentSearchResult, searchMetaFromValue, searchMetaFromResult } from './search.ts'
export type { WebSearchMeta } from './search.ts'
export { applyWebFetchTool, formatFetchOutput, parseFetchArgs, presentFetchCall, presentFetchResult, fetchMetaFromValue, fetchMetaFromResult } from './fetch.ts'
export type { WebFetchMeta, WebFetchWindowOptions } from './fetch.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-web'

/** Services required by the web tool suite. */
export const inject = ['tools', 'web', 'systemPrompt']

/** Default cooperative tool-call timeout budget (ms) for the web tools. */
export const DEFAULT_WEB_TOOL_TIMEOUT_MS = 30_000

/**
 * Default cap on one `web_fetch` output and on source characters converted
 * synchronously. This leaves headroom above the local provider's default
 * 100,000-character body cap while bounding custom providers and rendered output.
 */
export const DEFAULT_FETCH_MAX_OUTPUT_CHARS = 200_000

/** Default number of page copies `web_fetch` window mode keeps across sessions. */
export const DEFAULT_FETCH_WINDOW_CACHE_ENTRIES = 32

/** Default page-text characters `web_fetch` window mode keeps across copies: twenty default-capped pages. */
export const DEFAULT_FETCH_WINDOW_CACHE_CHARS = 4_000_000

/** Default time (ms) a kept page copy serves `web_fetch` continuations: 30 minutes. */
export const DEFAULT_FETCH_WINDOW_CACHE_TTL_MS = 1_800_000

/** Plugin config: which web tools to register, search bounds, per-tool budgets, the fetch output cap, and fetch windows. */
export interface Config {
  /** Register `web_search`. Defaults to true. */
  search?: boolean
  /** Register `web_fetch`. Defaults to true. */
  fetch?: boolean
  /** Upper bound on sources returned by one `web_search` call. */
  searchMaxResults?: number
  /** Upper bound on queries accepted by one `web_search` call. */
  searchMaxQueries?: number
  /** Cooperative timeout budget (ms) for `web_fetch`. Defaults to 30000. */
  fetchTimeoutMs?: number
  /** Cooperative timeout budget (ms) for `web_search`. Defaults to 30000. */
  searchTimeoutMs?: number
  /**
   * Cap on source characters converted and complete `web_fetch` output characters. Defaults to 200000.
   * With `fetchWindowTokens` set, it caps the kept page text instead of one output.
   */
  fetchMaxOutputChars?: number
  /**
   * Upper bound on the estimated tokens of one complete `web_fetch` output in window mode. Unset (the
   * default) returns the whole page in one output. When set, `web_fetch` takes an optional `start`
   * offset and returns the page text from there in a window whose header, text, and footer fit this
   * bound; the footer gives the next `start`. Continuations read the copy kept from the session's
   * fetch of the same URL. Set it at or below the spill-policy inline budget so windows are not spilled.
   */
  fetchWindowTokens?: number
  /** Most page copies kept for `web_fetch` window continuations across sessions. Defaults to 32. */
  fetchWindowCacheEntries?: number
  /**
   * Most page-text characters kept for `web_fetch` window continuations across copies; with
   * `fetchWindowTokens` set it must be at least `fetchMaxOutputChars`. Defaults to 4000000.
   */
  fetchWindowCacheChars?: number
  /** Time (ms) a kept page copy serves `web_fetch` continuations after it was stored. Defaults to 1800000. */
  fetchWindowCacheTtlMs?: number
}

export const Config: z<Config> = z.object({
  search: z.boolean().default(true),
  fetch: z.boolean().default(true),
  searchMaxResults: z.number().default(WEB_SEARCH_MAX_RESULTS),
  searchMaxQueries: z.number().default(WEB_SEARCH_MAX_QUERIES),
  fetchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS),
  searchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS),
  fetchMaxOutputChars: z.number().default(DEFAULT_FETCH_MAX_OUTPUT_CHARS),
  fetchWindowTokens: z.number(),
  fetchWindowCacheEntries: z.number().default(DEFAULT_FETCH_WINDOW_CACHE_ENTRIES),
  fetchWindowCacheChars: z.number().default(DEFAULT_FETCH_WINDOW_CACHE_CHARS),
  fetchWindowCacheTtlMs: z.number().default(DEFAULT_FETCH_WINDOW_CACHE_TTL_MS),
})

/** Complete config after schemastery applies every field default; `fetchWindowTokens` has none. */
type ResolvedConfig = Required<Omit<Config, 'fetchWindowTokens'>> & Pick<Config, 'fetchWindowTokens'>

/** Configured count, timeout, and character caps must be positive integers. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-web: ${name} must be a positive integer`)
  }
}

/**
 * Register the enabled web tools. `search`/`fetch` default to true; a product
 * that wants only one disables the other in config. Each tool's cooperative
 * timeout budget (`fetchTimeoutMs`/`searchTimeoutMs`, default 30000) is resolved
 * here and attached to the tool as `ToolDefinition.timeoutMs` for
 * `@deepseek-ai/dsh-tool-call-timeout-policy` to enforce. The tools' disposers are
 * fiber-scoped (the effect-based registries clean up on dispose), so no manual
 * teardown is needed. A set `fetchWindowTokens` registers the window-mode
 * `web_fetch`, whose kept page copies live only as long as this registration.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('searchMaxResults', resolved.searchMaxResults)
  assertPositiveInteger('searchMaxQueries', resolved.searchMaxQueries)
  assertPositiveInteger('fetchTimeoutMs', resolved.fetchTimeoutMs)
  assertPositiveInteger('searchTimeoutMs', resolved.searchTimeoutMs)
  assertPositiveInteger('fetchMaxOutputChars', resolved.fetchMaxOutputChars)
  assertPositiveInteger('fetchWindowCacheEntries', resolved.fetchWindowCacheEntries)
  assertPositiveInteger('fetchWindowCacheChars', resolved.fetchWindowCacheChars)
  assertPositiveInteger('fetchWindowCacheTtlMs', resolved.fetchWindowCacheTtlMs)
  const windowTokens = resolved.fetchWindowTokens
  if (windowTokens !== undefined) {
    assertPositiveInteger('fetchWindowTokens', windowTokens)
    // Every kept copy must fit the character bound, or continuations could never read it.
    if (resolved.fetchWindowCacheChars < resolved.fetchMaxOutputChars) {
      throw new Error('tool-web: fetchWindowCacheChars must be at least fetchMaxOutputChars when fetchWindowTokens is set')
    }
  }
  if (resolved.search) {
    applyWebSearchTool(ctx, resolved.searchMaxResults, resolved.searchMaxQueries, resolved.searchTimeoutMs, resolved.fetch)
  }
  if (resolved.fetch) {
    applyWebFetchTool(ctx, resolved.fetchTimeoutMs, resolved.fetchMaxOutputChars, windowTokens === undefined ? undefined : {
      tokens: windowTokens,
      cacheEntries: resolved.fetchWindowCacheEntries,
      cacheChars: resolved.fetchWindowCacheChars,
      cacheTtlMs: resolved.fetchWindowCacheTtlMs,
    })
  }
}
