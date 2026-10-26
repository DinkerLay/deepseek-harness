/**
 * Host-owned adapter entry. It does not mount the plugin or load its login,
 * settings, or credential-discovery integration. SDK catalog helpers remain a
 * transitive dependency, but explicit profiles never inherit their defaults.
 * @module dsh-llm-pi-ai/adapter
 */
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import type { PiAiModelProfile } from './catalog.ts'
import { resolveProfiles } from './config.ts'
import type { PiAiProviderProfile, ResolvedPiAiProviderProfile } from './config.ts'

export { PiAiAdapter } from './adapter.ts'
export { importOpenAIReasoningMessage } from './reasoning-history.ts'
export type { OpenAIReasoningMessageV1, PiAiReasoningTarget, PiAiReasoningImportOptions } from './reasoning-history.ts'
export type { PiAiReasoningReplay } from './reasoning-replay.ts'
export type { PiAiImageReader } from './context.ts'
export type { PiAiAdapterOptions, PiAiAuthInjection } from './adapter.ts'
export type { PiAiTransport } from './transport.ts'
export type { PiAiToolCallValidation } from './strict-tool-calls.ts'
export type { ResolvedPiAiProviderProfile } from './config.ts'

/** A model whose capabilities are supplied by the host, never the SDK catalog. */
export type PiAiExplicitModel = PiAiModelProfile & Required<Pick<PiAiModelProfile,
  'contextWindow' | 'maxTokens' | 'input' | 'reasoningEfforts'>>

/** Host-owned route. Secrets arrive only through the adapter's per-call resolver. */
export interface PiAiExplicitProfile extends Pick<PiAiProviderProfile,
  'displayName' | 'headers' | 'compat' | 'reasoning' | 'thinkingBudgets' |
  'cacheRetention' | 'timeoutMs' | 'streamIdleTimeoutMs' | 'maxRequestImageBytes' |
  'requestImagePixelBudget' | 'requestImageMaxBytes'> {
  /** Explicitly selected wire protocol. */
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  /** Absolute HTTP(S) endpoint; the host owns endpoint admission. */
  baseURL: string
  /** Nonempty replacement catalog; maxTokens is also the default request cap. */
  models: PiAiExplicitModel[]
  /** Explicit retry mode and, in normal mode, a required retry count. */
  retryPolicy: RetryPolicyConfig & ({ mode: 'always' } | { mode: 'normal'; maxRetries: number })
}

/**
 * Resolve detached, explicit HTTP/SSE profiles for a host-owned adapter.
 * Known provider names receive no installed model, compatibility, or auth
 * defaults. Missing request keys fail before SDK auth or transport is invoked.
 * Replace the returned map to publish a configuration change; do not mutate it.
 * @param providers - host-admitted routes and complete model capabilities.
 * @returns profiles directly accepted by PiAiAdapterOptions.profiles.
 * @throws Error for incomplete routes, invalid capabilities or unsupported fields.
 */
export function createPiAiProfiles(
  providers: Readonly<Record<string, PiAiExplicitProfile>>,
): ReadonlyMap<string, ResolvedPiAiProviderProfile> {
  for (const [route, profile] of Object.entries(providers)) validateExplicitProfile(route, profile)
  return resolveProfiles(structuredClone(providers), 'strict', 'explicit')
}

/** Validate configuration omissions from JavaScript callers before defaults can apply. */
function validateExplicitProfile(route: string, profile: PiAiProviderProfile): void {
  const fail = (detail: string): never => { throw new Error(`llm-pi-ai: explicit route "${route}" ${detail}`) }
  if (!route || route.trim() !== route) fail('requires a nonblank route without surrounding whitespace')
  for (const key of ['apiKeyEnv', 'modelOverrides', 'defaultInput', 'defaultContextWindow', 'defaultMaxTokens', 'transport', 'requireApiKey']) {
    if (key in profile) fail(`does not accept ${key}`)
  }
  if (profile.api === undefined || !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(profile.api)) fail('requires a supported api')
  const endpoint = (() => {
    try { return new URL(profile.baseURL ?? '') } catch { return fail('requires an absolute HTTP(S) baseURL') }
  })()
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) fail('requires an HTTP(S) baseURL without credentials or fragment')
  if (!Array.isArray(profile.models) || profile.models.length === 0) return fail('requires at least one explicit model')
  for (const model of profile.models) {
    if (!model.id || model.id.trim() !== model.id) fail('requires nonblank model ids without surrounding whitespace')
    if (model.contextWindow === undefined || model.maxTokens === undefined || !model.input?.length || model.reasoningEfforts === undefined) fail(`requires explicit capabilities for model "${model.id}"`)
  }
  if (!profile.retryPolicy || !['normal', 'always'].includes(profile.retryPolicy.mode) || (profile.retryPolicy.mode === 'normal' && profile.retryPolicy.maxRetries === undefined)) fail('requires an explicit retry policy and normal-mode maxRetries')
}
