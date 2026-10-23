import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { PiAiAdapter } from '../src/adapter.ts'
import type { PiAiAdapterOptions } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { createTransportCall } from '../src/transport.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import { functionEvents, protocolTextEvents, protocols } from './strict-call-fixtures.ts'
import type { Protocol } from './strict-call-fixtures.ts'

afterEach(closeMockServers)
const prompt = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
const request: GenerateOptions = { provider: 'host', model: 'model', messages: [prompt] }
function adapter(api: Protocol, baseURL: string, overrides: Partial<PiAiAdapterOptions> = {}): PiAiAdapter {
  const profiles = resolveProfiles({ host: { api, baseURL, models: [{ id: 'model', input: ['text'], maxTokens: 128, contextWindow: 8192 }], retryPolicy: { mode: 'normal', maxRetries: 0 } } })
  return new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'synthetic-key', auth: memoryAuth(), toolCallValidation: { maxArgumentBytes: 1024 }, ...overrides })
}
async function collect(stream: AsyncIterable<StreamChunk>): Promise<{ chunks: StreamChunk[]; failure?: LlmFailure }> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of stream) chunks.push(chunk)
  } catch (error) {
    if (!(error instanceof LlmError)) throw error
    return { chunks, failure: error.failure }
  }
  const finish = chunks.findLast(chunk => chunk.type === 'finish')
  return { chunks, ...finish?.type === 'finish' && (finish.reason.kind === 'error' || finish.reason.kind === 'aborted') ? { failure: finish.reason.failure } : {} }
}
class HostFailure extends Error {
  constructor(readonly code: string, readonly status: number) { super('SYNTHETIC_SECRET') }
}
const classifyError = (error: unknown): LlmFailure | undefined => error instanceof HostFailure
  ? { code: error.code, status: error.status, message: 'Host refused model request' }
  : undefined

async function agentResult(api: Protocol, events: string[], expected: number) {
  const server = await mockServer([{ events, namedEvents: true }, { namedEvents: true, events: protocolTextEvents(api) }])
  const ctx = new Context()
  let executions = 0
  const failures: string[] = []
  try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
      await ctx.plugin(plugin)
    }
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['host'], adapter(api, server.url))
    ctx.tools.register(defineTool({ name: 'search', description: 'fixture counter', parameters: { query: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute() { executions++; return Promise.resolve('result') } }))
    ctx.on('agent/error', ({ error }) => { failures.push(error instanceof LlmError ? error.code : 'unexpected') })
    const agent = await ctx.agentLoop.create(SessionId('strict-functions'), { provider: 'host', model: 'model' })
    agent.followup(prompt)
    await agent.whenIdle()
    const recorded = agent.session.snapshotEvents()
    const types = recorded.map(event => event.type)
    expect({
      events: types,
      messages: recorded.flatMap(event => event.type === 'assistant/message' ? [event.data.message.content] : []),
      tools: recorded.flatMap(event => event.type === 'tool/call' ? [{ name: event.data.name, arguments: event.data.arguments }] : []),
      failures,
    }).toMatchSnapshot()
    expect(executions).toBe(expected)
    expect(types.filter(type => type === 'tool/call')).toHaveLength(expected)
    expect(types.filter(type => type === 'tool/result')).toHaveLength(expected)
    if (expected === 0) {
      expect(server.requests).toHaveLength(1)
      expect(types).not.toContain('assistant/message')
      expect(types).toContain('assistant/attempt')
      expect(failures).toEqual(['MALFORMED_RESPONSE'])
    } else {
      expect(server.requests).toHaveLength(2)
      expect(failures).toEqual([])
    }
  } finally { await ctx.fiber.dispose() }
}

describe.each(protocols)('%s host integration', (api) => {
  it.each(['{"query":"broken"', '{"query":"a"}{"query":"b"}', '[]', 'null', '42', '"scalar"'])('rejects terminal raw arguments %s', async (args) => {
    const server = await mockServer([{ namedEvents: true, events: functionEvents(api, [{ args }]) }])
    expect((await collect(adapter(api, server.url).stream(request))).failure?.code).toBe('MALFORMED_RESPONSE')
  })
  it.each([0, -1])('enforces the terminal UTF-8 budget at byte offset %s', async (offset) => {
    const args = '{"query":"中文"}'
    const server = await mockServer([{ namedEvents: true, events: functionEvents(api, [{ args }]) }])
    const result = await collect(adapter(api, server.url, {
      toolCallValidation: { maxArgumentBytes: Buffer.byteLength(args) + offset },
    }).stream(request))
    expect(result.failure?.code).toBe(offset === 0 ? undefined : 'MALFORMED_RESPONSE')
  })
  it('accepts an empty function argument object', async () => {
    const server = await mockServer([{ namedEvents: true, events: functionEvents(api, [{ args: '  ' }]) }])
    expect((await collect(adapter(api, server.url).stream(request))).failure).toBeUndefined()
  })
  it.each(['id', 'name'] as const)('rejects missing native %s', async (missing) => {
    const server = await mockServer([{ namedEvents: true, events: functionEvents(api, [{ args: '{}', [missing]: null }]) }])
    expect((await collect(adapter(api, server.url).stream(request))).failure?.code).toBe('MALFORMED_RESPONSE')
  })
  it.each([false, true])('never dispatches a valid sibling when bad call is first=%s', async (first) => {
    const bad = { args: '{"query":"a"}{"query":"b"}' }, good = { args: '{"query":"ok"}' }
    await agentResult(api, functionEvents(api, first ? [bad, good] : [good, bad]), 0)
  })
  it('dispatches both valid tools then completes the next model step', () => agentResult(api, functionEvents(api, [{ args: '{"query":"one"}' }, { args: '{"query":"two"}' }]), 2))
  it('preserves safe transport failure facts', async () => {
    const result = await collect(adapter(api, 'http://unused.invalid', { transport: { fetch: async () => { throw new HostFailure('HOST_REVOKED', 401) }, classifyError } }).stream(request))
    expect(result.failure).toEqual({ code: 'HOST_REVOKED', message: 'Host refused model request', status: 401 })
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET')
  })
  it('preserves a typed body-read failure', async () => {
    const result = await collect(adapter(api, 'http://unused.invalid', { transport: { fetch: async () => new Response(new ReadableStream({ pull(controller) { controller.error(new HostFailure('HOST_BODY', 502)) } })), classifyError } }).stream(request))
    expect(result.failure?.code).toBe('HOST_BODY')
    expect(result.failure?.status).toBe(502)
  })
  it('keeps safe HTTP status and retry delay without exposing the refusal body', async () => {
    const result = await collect(adapter(api, 'http://unused.invalid', { transport: { fetch: async () => new Response('SYNTHETIC_SECRET', { status: 429, headers: { 'retry-after': '2' } }), classifyError } }).stream(request))
    expect(result.failure).toEqual({ code: 'RATE_LIMIT', message: 'Model HTTP request rejected', status: 429, providerRetryAfterMs: 2000 })
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET')
  })
})

describe('Responses authoritative terminal arguments', () => {
  it.each([
    { finalOnly: true, final: '{"query":"broken"' },
    { done: '{"query":"a"}{"query":"b"}', final: '' },
    { final: '{"query":"a"}{"query":"b"}' },
    { finalIdentity: { call_id: 'changed' } },
    { finalIdentity: { name: 'changed' } },
    { finalIdentity: { id: 'changed' } },
  ])('rejects invalid terminal replacement %j', async (override) => {
    const server = await mockServer([{ namedEvents: true, events: functionEvents('openai-responses', [{ args: '{"query":"ok"}' }], override) }])
    expect((await collect(adapter('openai-responses', server.url).stream(request))).failure?.code).toBe('MALFORMED_RESPONSE')
  })
  it('accepts final-only valid arguments', async () => {
    const server = await mockServer([{ namedEvents: true, events: functionEvents('openai-responses', [{ args: '{"query":"ok"}' }], { finalOnly: true }) }])
    expect((await collect(adapter('openai-responses', server.url).stream(request))).failure).toBeUndefined()
  })
})

describe('call-local lifecycle', () => {
  it('isolates concurrent failures on one adapter and clears failure for the next call', async () => {
    let count = 0
    const entered = Promise.withResolvers<undefined>()
    const model = adapter('openai-completions', 'http://unused.invalid', { transport: { classifyError, fetch: async () => {
      const index = ++count
      if (index > 2) return new Response(textEvents.map(data => `data: ${data}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
      if (index === 2) entered.resolve(undefined)
      await entered.promise
      if (index === 1) await new Promise(resolve => setTimeout(resolve, 5))
      throw new HostFailure(`HOST_${index}`, index === 1 ? 401 : 429)
    } } })
    const [first, second] = await Promise.all([collect(model.stream(request)), collect(model.stream(request))])
    expect([first.failure?.code, second.failure?.code]).toEqual(['HOST_1', 'HOST_2'])
    expect((await collect(model.stream(request))).failure).toBeUndefined()
  })
  it('cancels while a credential resolver is pending without issuing a model request', async () => {
    const entered = Promise.withResolvers<AbortSignal>(), credential = Promise.withResolvers<string>()
    const controller = new AbortController()
    let fetched = false
    const model = adapter('openai-completions', 'http://unused.invalid', { resolveApiKey: async (_provider, _profile, signal) => { entered.resolve(signal); return credential.promise }, transport: { fetch: async () => { fetched = true; throw new Error('must not fetch') }, classifyError } })
    const pending = collect(model.stream({ ...request, signal: controller.signal }))
    const signal = await entered.promise
    controller.abort()
    expect((await pending).failure?.code).toBe('ABORTED')
    expect(signal.aborted).toBe(true)
    credential.resolve('late-key')
    expect(fetched).toBe(false)
  })
  it('keeps cancellation from a pending body read out of failure state', async () => {
    const read = Promise.withResolvers<undefined>()
    let cancelled = false
    const call = createTransportCall({
      classifyError,
      fetch: async () => new Response(new ReadableStream({
        pull() { read.resolve(undefined) },
        cancel() { cancelled = true },
      })),
    }, new AbortController().signal)
    const response = await call.fetch('http://unused.invalid')
    const reader = response.body!.getReader()
    const pending = reader.read()
    await read.promise
    await reader.cancel()
    expect((await pending).done).toBe(true)
    expect(cancelled).toBe(true)
    expect(call.failure()).toBeUndefined()
    reader.releaseLock()
  })
})


describe('host contract boundaries', () => {
  it.each([0, -1, 1.1, Infinity])('rejects invalid argument budget %s', (maxArgumentBytes) => {
    expect(() => adapter('openai-completions', 'http://unused.invalid', {
      toolCallValidation: { maxArgumentBytes },
    })).toThrow('maxArgumentBytes must be a positive safe integer')
  })
  it('sanitizes classifier exceptions', async () => {
    const result = await collect(adapter('openai-completions', 'http://unused.invalid', {
      transport: {
        fetch: async () => { throw new Error('SYNTHETIC_SECRET') },
        classifyError: () => { throw new Error('CLASSIFIER_SECRET') },
      },
    }).stream(request))
    expect(result.failure).toEqual({ code: 'TRANSPORT', message: 'Model transport failed' })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })
  it('keeps caller abort ahead of a late transport failure', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const model = adapter('openai-completions', 'http://unused.invalid', {
      transport: { classifyError, fetch: async () => {
        entered.resolve(undefined)
        await release.promise
        throw new HostFailure('HOST_LATE', 401)
      } },
    })
    const pending = collect(model.stream({ ...request, signal: controller.signal }))
    await entered.promise
    controller.abort()
    release.resolve(undefined)
    expect((await pending).failure?.code).toBe('ABORTED')
  })
  it('closes a host response stream when the idle timeout fires', async () => {
    const profiles = resolveProfiles({ host: { api: 'openai-completions', baseURL: 'http://unused.invalid', streamIdleTimeoutMs: 50, models: [{ id: 'model' }] } })
    let cancelled = false
    const model = adapter('openai-completions', 'http://unused.invalid', {
      profiles: () => profiles,
      transport: { classifyError, fetch: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${textEvents[0]}\n\n`)) },
        cancel() { cancelled = true },
      }), { headers: { 'content-type': 'text/event-stream' } }) },
    })
    expect((await collect(model.stream(request))).failure?.code).toBe('TIMEOUT')
    expect(cancelled).toBe(true)
  })
  it('preserves host context-overflow classification', async () => {
    const result = await collect(adapter('openai-completions', 'http://unused.invalid', {
      transport: { fetch: async () => { throw new HostFailure('CONTEXT_WINDOW_EXCEEDED', 400) }, classifyError },
    }).stream(request))
    expect(result.failure?.code).toBe('CONTEXT_WINDOW_EXCEEDED')
  })
  it('ignores an overflowing Retry-After without losing the HTTP refusal', async () => {
    const result = await collect(adapter('openai-completions', 'http://unused.invalid', {
      transport: { fetch: async () => new Response('SYNTHETIC_SECRET', { status: 429, headers: { 'retry-after': '1e308' } }), classifyError },
    }).stream(request))
    expect(result.failure).toEqual({ code: 'RATE_LIMIT', message: 'Model HTTP request rejected', status: 429 })
  })
  it('cancels a late response body when the caller aborted during fetch', async () => {
    const controller = new AbortController()
    let cancelled = false
    const call = createTransportCall({ classifyError, fetch: async () => {
      controller.abort()
      return new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}) } }))
    } }, controller.signal)
    await expect(call.fetch('http://unused.invalid')).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
  })
  it.each(['websocket', 'auto'] as const)('refuses %s before credential resolution with host transport', async (transport) => {
    const profiles = resolveProfiles({ host: { api: 'openai-responses', baseURL: 'http://unused.invalid', transport, models: [{ id: 'model' }] } })
    let resolved = false
    const model = adapter('openai-responses', 'http://unused.invalid', {
      profiles: () => profiles,
      resolveApiKey: async () => { resolved = true; return 'key' },
      transport: { fetch: async () => { throw new Error('must not fetch') }, classifyError },
    })
    expect((await collect(model.stream(request))).failure?.code).toBe('UNSUPPORTED_OPTION')
    expect(resolved).toBe(false)
  })
})
