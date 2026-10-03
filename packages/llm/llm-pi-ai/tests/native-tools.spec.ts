import { afterEach, describe, expect, it } from 'vitest'
import type { Model } from '@earendil-works/pi-ai'
import { stream as streamResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { stream as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { createDeveloperMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { toPiContext } from '../src/context.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'pi-native-tools-test': { kind: 'pi-native-tools-test' } & ContextFormed
  }
}

afterEach(closeMockServers)

const search: ToolSchema = { name: 'search', description: 'Find an available tool', parameters: { type: 'object' } }
const lookup: ToolSchema = { name: 'lookup', description: 'Read the selected item', parameters: { type: 'object' }, deferLoading: true }

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a request object')
  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected a request array')
  return value
}

function request(): GenerateOptions {
  return {
    provider: 'test', model: 'm', system: 'Assistant', tools: [search, lookup],
    messages: [
      createUserMessage({ content: [{ type: 'text', text: 'Look up the item' }], source: { kind: 'pi-native-tools-test' } }),
      createDeveloperMessage({ content: [{ type: 'tool-addition', toolName: 'lookup' }], source: { kind: 'pi-native-tools-test' } }),
    ],
  }
}

function responseModel(baseUrl: string, toolSearch: boolean): Model<'openai-responses'> {
  return {
    id: 'm', name: 'm', api: 'openai-responses', provider: 'test', baseUrl, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
    compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: !toolSearch, supportsToolSearch: toolSearch },
  }
}

describe('native additive tools through the Pi bridge', () => {
  it('preserves activation position and omits the deferred schema from initial tools', () => {
    const context = toPiContext(request())
    expect(context.tools?.map(tool => tool.name)).toEqual(['search'])
    expect(context.messages.map(message => message.role)).toEqual(['user', 'system'])
    expect(context.messages[1]).toMatchObject({ toolsAdded: [{ name: 'lookup', parameters: lookup.parameters }] })
  })

  it.each([false, true])('serializes native Responses additions (tool search: %s)', async (toolSearch) => {
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"resp_1"}}',
      '{"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}',
    ] }])
    for await (const event of streamResponses(responseModel(server.url, toolSearch), normalizeContext(toPiContext(request())), { apiKey: 'test-key' })) {
      if (event.type === 'error') throw new Error(event.error.errorMessage)
    }
    const body = server.requests[0]
    expect(body).toMatchObject({ tools: [{ name: 'search' }] })
    expect(array(record(body).tools).some(tool => record(tool).name === 'lookup')).toBe(false)
    const input = array(record(body).input)
    if (toolSearch) {
      expect(input.find(item => record(item).type === 'tool_search_call')).toBeDefined()
      expect(input.find(item => record(item).type === 'tool_search_output'))
        .toMatchObject({ tools: [{ name: 'lookup', parameters: lookup.parameters }] })
    } else {
      expect(input.find(item => record(item).type === 'additional_tools'))
        .toMatchObject({ tools: [{ name: 'lookup', parameters: lookup.parameters }] })
    }
  })

  it('serializes supported completions additions in a later system message', async () => {
    const server = await mockServer([{ events: textEvents }])
    const model: Model<'openai-completions'> = {
      id: 'm', name: 'm', api: 'openai-completions', provider: 'test', baseUrl: server.url,
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192, maxTokens: 1024,
      compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true },
    }
    for await (const event of streamCompletions(model, normalizeContext(toPiContext(request())), { apiKey: 'test-key' })) {
      if (event.type === 'error') throw new Error(event.error.errorMessage)
    }
    const body = record(server.requests[0])
    expect(body.tools).toMatchObject([{ function: { name: 'search' } }])
    const activation = array(body.messages).find(item => record(item).role === 'system' && record(item).tools !== undefined)
    expect(activation).toMatchObject({ tools: [{ function: { name: 'lookup', parameters: lookup.parameters } }] })
  })

  it('advertises only the configured route protocol and captured model capability', async () => {
    let enabled = true
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ test: {
        api: 'openai-completions', baseURL: 'https://example.test', models: [{ id: 'm' }],
        compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: enabled },
      } }),
      resolveApiKey: () => Promise.resolve('test-key'), auth: memoryAuth(),
    })
    const prepared = await adapter.prepareCall('test', 'm')
    expect(prepared.model.toolUpdate).toBe('addition-only')
    enabled = false
    expect((await adapter.resolveModel('test', 'm')).toolUpdate).toBeUndefined()
    expect(prepared.model.toolUpdate).toBe('addition-only')
    await expect(async () => {
      for await (const _chunk of adapter.stream(request())) { /* Consume the rejected call. */ }
    }).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})
