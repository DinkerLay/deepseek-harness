import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiAiAdapter, createPiAiProfiles } from '@deepseek-ai/dsh-llm-pi-ai/adapter'
import type { PiAiExplicitProfile, PiAiImageReader, PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai/adapter'
import { PiAiAdapter as PluginAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'
import { protocols, protocolTextEvents } from './strict-call-fixtures.ts'

afterEach(closeMockServers)
function profile(): PiAiExplicitProfile {
  return { api: 'openai-completions', baseURL: 'https://host.example/v1', models: [{ id: 'gpt-4o', contextWindow: 8192, maxTokens: 128, input: ['text'], reasoningEfforts: false }], retryPolicy: { mode: 'normal', maxRetries: 0 } }
}
const request = { provider: 'openai', model: 'gpt-4o', messages: [createUserMessage({ content: [{ type: 'text' as const, text: 'hello' }], source: { kind: 'user' as const } })] }
async function collect(adapter: PiAiAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk)
  return chunks
}

describe('public host adapter entry', () => {
  it('shares the plugin class and resolves only declared capabilities on a catalog route', () => {
    expect(PiAiAdapter).toBe(PluginAdapter)
    const source = profile()
    const profiles = createPiAiProfiles({ openai: source })
    source.models[0]!.input.push('image')
    source.models[0]!.contextWindow = 99999
    const resolved = profiles.get('openai')!
    const models = resolved.piProvider!.getModels()
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({ id: 'gpt-4o', input: ['text'], contextWindow: 8192, maxTokens: 128, baseUrl: 'https://host.example/v1' })
    expect(models[0]!.reasoning).toBeFalsy()
    expect(resolved.retryPolicy).toMatchObject({ mode: 'normal', maxRetries: 0 })
    expect(Object.keys(resolved.piProvider!.auth)).toEqual(['apiKey'])
  })
  it.each(['api', 'baseURL', 'models', 'retryPolicy'])('rejects omitted %s instead of using SDK defaults', (key) => {
    const input = profile()
    Reflect.deleteProperty(input, key)
    expect(() => createPiAiProfiles({ openai: input })).toThrow()
  })
  it.each(['contextWindow', 'maxTokens', 'input', 'reasoningEfforts'])('requires model capability %s', (key) => {
    const input = profile()
    Reflect.deleteProperty(input.models[0]!, key)
    expect(() => createPiAiProfiles({ openai: input })).toThrow('explicit capabilities')
  })
  it.each(['apiKeyEnv', 'modelOverrides', 'defaultInput', 'transport', 'requireApiKey'])('rejects plugin-only field %s', (key) => {
    expect(() => createPiAiProfiles({ openai: { ...profile(), [key]: 'unexpected' } })).toThrow(`does not accept ${key}`)
  })
  it.each(['file:///tmp/model', 'https://user:secret@host.example', 'https://host.example/#fragment'])('rejects endpoint %s', (baseURL) => {
    expect(() => createPiAiProfiles({ openai: { ...profile(), baseURL } })).toThrow('HTTP(S)')
  })
  it('requires an explicit retry count', () => {
    const input = profile()
    Reflect.deleteProperty(input.retryPolicy, 'maxRetries')
    expect(() => createPiAiProfiles({ openai: input })).toThrow('maxRetries')
  })
  it.each([undefined, '', '   ', 'bad\nkey'])('refuses missing or unusable request key %s before ambient auth or HTTP', async (key) => {
    const auth = memoryAuth({ openai: { type: 'api_key', key: 'stored-key' } })
    const read = vi.spyOn(auth.credentials, 'read')
    const env = vi.spyOn(auth.authContext, 'env').mockResolvedValue('ambient-key')
    const fetch = vi.fn<typeof globalThis.fetch>()
    const profiles = createPiAiProfiles({ openai: profile() })
    const adapter = new PiAiAdapter({
      profiles: () => profiles, resolveApiKey: async () => key, auth, transport: { fetch, classifyError: () => undefined },
    })
    await expect(collect(adapter)).rejects.toMatchObject({ code: key === undefined ? 'MISSING_CREDENTIAL' : 'INVALID_CREDENTIAL' })
    expect(read).not.toHaveBeenCalled()
    expect(env).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(protocols)('accepts a request-only image reader for %s', async (api) => {
    const server = await mockServer([{ namedEvents: true, events: protocolTextEvents(api) }])
    const profiles = createPiAiProfiles({ openai: { ...profile(), api, baseURL: server.url,
      models: [{ ...profile().models[0]!, input: ['text', 'image'] }],
    } })
    const ref = { attachmentId: AttachmentId('fixture-image'), mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const readImageRequest = vi.fn<PiAiImageReader['readImageRequest']>(async attachment => ({
      variantId: ImageVariantId('fixture-variant'), attachment, data: Uint8Array.of(1, 2, 3),
      mediaType: 'image/png', bytes: 3, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: false,
    }))
    const reader = { readImageRequest }
    const resolveImageAccess = vi.fn<NonNullable<PiAiAdapterOptions<PiAiImageReader>['resolveImageAccess']>>(() => undefined)
    const adapter = new PiAiAdapter({ profiles: () => profiles, auth: memoryAuth(), resolveApiKey: async () => 'host-key',
      resolveAttachments: () => reader, resolveImageAccess,
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ ...request,
      messages: [createUserMessage({ content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } })],
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(readImageRequest).toHaveBeenCalledExactlyOnceWith(ref, expect.objectContaining({ width: 1, height: 1 }), expect.any(AbortSignal))
    expect(resolveImageAccess).toHaveBeenCalledWith(reader, ref)
    expect(JSON.stringify(server.requests)).toContain('AQID')
  })
  it.each(protocols)('streams %s using only host key and explicit route', async (api) => {
    const server = await mockServer([{ namedEvents: true, events: protocolTextEvents(api) }])
    const auth = memoryAuth()
    const fail = () => { throw new Error('ambient auth must not run') }
    vi.spyOn(auth.credentials, 'read').mockImplementation(fail)
    vi.spyOn(auth.authContext, 'env').mockImplementation(fail)
    vi.spyOn(auth.authContext, 'fileExists').mockImplementation(fail)
    const profiles = createPiAiProfiles({ openai: { ...profile(), api, baseURL: server.url } })
    const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'host-key', auth, toolCallValidation: { maxArgumentBytes: 1024 } })
    expect((await collect(adapter)).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ model: 'gpt-4o' })
  })
})
