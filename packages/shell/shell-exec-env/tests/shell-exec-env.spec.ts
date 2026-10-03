import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ShellExecEnvironmentRegistry from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ShellExecEnvironmentRegistry)
  ctx.tools.register(defineTool({
    name: 'collect_environment', description: '', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, execution) {
      const snapshot = await ctx.shellExecEnv.collect(execution)
      expect(Object.isFrozen(snapshot)).toBe(true)
      return JSON.stringify(snapshot)
    },
  }))
  return ctx
}

let serial = 0
function collect(ctx: Context, signal = new AbortController().signal) {
  return ctx.tools.execute({ name: 'collect_environment', arguments: {}, signal, callId: ToolCallId(`environment-${++serial}`) })
}

describe('trusted shell execution environment', () => {
  it('collects current values in sorted order and releases ownership with the contributor', async () => {
    const ctx = await setup()
    let current = 'first'
    const release = ctx.shellExecEnv.register({
      name: 'account', keys: ['Z_VALUE', 'A_VALUE'], resolve: () => ({ Z_VALUE: current, A_VALUE: 'a' }),
    })
    expect((await collect(ctx)).value).toBe('{"A_VALUE":"a","Z_VALUE":"first"}')
    current = 'second'
    expect((await collect(ctx)).value).toBe('{"A_VALUE":"a","Z_VALUE":"second"}')
    expect(() => ctx.shellExecEnv.register({ name: 'other', keys: ['z_value'], resolve: () => ({}) })).toThrow('already owned')
    release()
    expect((await collect(ctx)).value).toBe('{}')
  })

  it('rejects undeclared and empty process environment values before delivery', async () => {
    const ctx = await setup()
    const first = ctx.shellExecEnv.register({ name: 'undeclared', keys: ['DECLARED'], resolve: () => ({ OTHER: 'value' }) })
    expect(JSON.stringify((await collect(ctx)).content)).toContain('undeclared key')
    first()
    ctx.shellExecEnv.register({ name: 'empty', keys: ['VALUE'], resolve: () => ({ VALUE: '' }) })
    expect(JSON.stringify((await collect(ctx)).content)).toContain('empty value')
    expect(() => ctx.shellExecEnv.register({ name: 'reserved', keys: ['DSH_KEY'], resolve: () => ({}) })).toThrow('invalid key')
  })

  it('rejects values resolved after the exact contribution is removed', async () => {
    const ctx = await setup()
    const ready = Promise.withResolvers<Readonly<Record<string, string>>>()
    const entered = Promise.withResolvers<undefined>()
    const release = ctx.shellExecEnv.register({ name: 'account', keys: ['VALUE'], resolve: () => {
      entered.resolve(undefined); return ready.promise
    } })
    const pending = collect(ctx)
    await entered.promise
    release()
    ready.resolve({ VALUE: 'revoked' })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('removed during collection')
    expect(JSON.stringify(result.content)).not.toContain('revoked')
  })

  it('honors cancellation while a contributor resolves and disposes plugin-owned registration', async () => {
    const ctx = await setup()
    const values = Promise.withResolvers<Readonly<Record<string, string>>>()
    const entered = Promise.withResolvers<undefined>()
    const owner = ctx.plugin({ inject: ['shellExecEnv'], apply(scope: Context) {
      scope.shellExecEnv.register({ name: 'owned', keys: ['VALUE'], resolve: () => {
        entered.resolve(undefined); return values.promise
      } })
    } })
    await owner
    const abort = new AbortController()
    const pending = collect(ctx, abort.signal)
    await entered.promise
    abort.abort(new Error('cancelled environment'))
    values.resolve({ VALUE: 'not-delivered' })
    expect((await pending).isError).toBe(true)
    await owner.dispose()
    expect((await collect(ctx)).value).toBe('{}')
  })
})
