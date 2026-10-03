import { expect, it, onTestFinished } from 'vitest'
import {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
} from '../src/index.ts'
import type { CordisInspectQueryRequest } from '../src/types.ts'
import { AGENT_A, AGENT_B, CLIENT_CODE, setup } from './helpers.ts'

const HOST = 'return { name: "contract-fixture", apply() {} }'

async function harness() {
  const test = await setup()
  const gates: Array<ReturnType<typeof Promise.withResolvers<undefined>>> = []
  onTestFinished(async () => {
    for (const gate of gates) gate.resolve(undefined)
    await test.ctx.fiber.dispose()
  })
  const requests: Array<{ requestId: ReturnType<typeof ApprovalRequestId> }> = []
  test.ctx.on('cordis/request-run', (request) => { requests.push(request) })
  return { ...test, gates, requests }
}

type Harness = Awaited<ReturnType<typeof harness>>

function define(test: Harness, code: { host?: string; client?: string } = { host: HOST }) {
  return test.runner.define({
    sessionId: AGENT_A.id, plugin: { kind: 'new', idPrefix: 'check' },
    name: 'contract fixture', purpose: 'exercise lifecycle ownership', code,
  })
}

function next(test: Harness, pluginId: ReturnType<typeof CordisDynamicPluginId>, code: { host?: string; client?: string }) {
  return test.runner.define({
    sessionId: AGENT_A.id, plugin: { kind: 'existing', pluginId },
    name: 'next fixture', purpose: 'exercise immutable versions', code,
  })
}

it('validates semantic prefixes and existing definition ownership before creating a package', async () => {
  const test = await harness()
  for (const idPrefix of ['ab', 'UPPER', 'too-long']) {
    expect(() => test.runner.define({
      sessionId: AGENT_A.id, plugin: { kind: 'new', idPrefix }, name: 'name', purpose: 'purpose', code: { host: HOST },
    })).toThrow('3–6 lowercase English letters')
  }
  const mine = define(test)
  expect(() => test.runner.define({
    sessionId: AGENT_B.id, plugin: { kind: 'existing', pluginId: mine.pluginId }, name: 'name', purpose: 'purpose', code: { host: HOST },
  })).toThrow('no dynamic plugin')
  expect(() => next(test, CordisDynamicPluginId('missing-plugin'), { host: HOST })).toThrow('no dynamic plugin')
  expect(test.runner.inventory()).toHaveLength(1)
  expect(test.runner.inventory()[0]?.packages).toHaveLength(1)
})

it('inspects source-free references and exact package source across version selection', async () => {
  const test = await harness()
  const first = define(test)
  const client = next(test, first.pluginId, { client: CLIENT_CODE })
  expect(test.runner.reference(AGENT_A, first.pluginId)).toMatchObject({ packageId: client.packageId })
  expect(test.runner.listPlugins(AGENT_A)[0]?.packages).toHaveLength(2)
  expect(test.runner.listPlugins(AGENT_B)).toEqual([])
  expect(test.runner.inspectPackage(AGENT_A, first.pluginId, first.packageId).code).toEqual({ host: HOST })
  expect(test.runner.inspectPackage(AGENT_A, first.pluginId, client.packageId).code).toEqual({ client: CLIENT_CODE })
  const started = await test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
  if (!started.ok) throw new Error(started.message)
  expect(test.runner.reference(AGENT_A, first.pluginId)).toMatchObject({
    packageId: first.packageId, currentPackageId: first.packageId, activeRun: { pluginRunId: started.pluginRunId },
  })
  expect(test.runner.inspectPackage(AGENT_A, first.pluginId, first.packageId)).toMatchObject({
    currentPackageId: first.packageId, activeRun: { pluginRunId: started.pluginRunId }, latestRun: { status: 'running' },
  })
  const broken = next(test, first.pluginId, { host: 'throw new Error("update rejected")', client: CLIENT_CODE })
  const failed = await test.runner.runHostHalf(AGENT_A, first.pluginId, broken.packageId, 'update', null, false)
  expect(failed).toMatchObject({ ok: false, message: 'update rejected' })
  expect(test.runner.reference(AGENT_A, first.pluginId)).toMatchObject({
    packageId: broken.packageId, currentPackageId: first.packageId, nextPackageId: broken.packageId,
  })
  expect(test.runner.inspectPackage(AGENT_A, first.pluginId, broken.packageId)).toMatchObject({
    code: { host: 'throw new Error("update rejected")', client: CLIENT_CODE }, nextPackageId: broken.packageId,
  })
  expect(test.runner.reference(AGENT_B, first.pluginId)).toBeUndefined()
  expect(() => test.runner.inspectPlugin(AGENT_B, first.pluginId)).toThrow('no dynamic plugin')
  expect(() => test.runner.inspectPackage(AGENT_B, first.pluginId, first.packageId)).toThrow('no dynamic plugin')
  expect(() => test.runner.inspectPackage(AGENT_A, first.pluginId, CordisDynamicPackageId('missing-package'))).toThrow('does not exist')
})

it('keeps panel stop and remove results aligned with the process-local registry', async () => {
  const test = await harness()
  const first = define(test)
  await expect(test.runner.stopFromPanel(AGENT_A, first.pluginId)).resolves.toMatchObject({ ok: false, reason: 'not-running' })
  await expect(test.runner.undefineFromPanel(AGENT_B, first.pluginId)).resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
  await expect(test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')).resolves.toMatchObject({ ok: true })
  await expect(test.runner.undefineFromPanel(AGENT_A, first.pluginId)).resolves.toEqual({ ok: true, wasRunning: true })
  expect(test.runner.inventory()).toEqual([])
  await expect(test.runner.stopFromPanel(AGENT_A, first.pluginId)).resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
  await expect(test.runner.settleUserRun(AGENT_A, first.pluginId, { ok: false, reason: 'rejected' })).resolves.toMatchObject({ ok: false, reason: 'plugin-missing' })
})

it('refuses canceled, missing and incompatible targets before creating an activation', async () => {
  const test = await harness()
  const first = define(test)
  await expect(test.runner.run(AGENT_A, first.pluginId, first.packageId, 'update')).resolves.toMatchObject({ ok: false, reason: 'invalid-mode' })
  await expect(test.runner.run(AGENT_A, first.pluginId, CordisDynamicPackageId('missing-package'), 'run')).resolves.toMatchObject({ ok: false, reason: 'package-missing' })
  await expect(test.runner.runHostHalf(AGENT_B, first.pluginId, first.packageId, 'run', null, false)).resolves.toMatchObject({ ok: false })
  await expect(test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run', AbortSignal.abort())).resolves.toMatchObject({ ok: false, reason: 'cancelled' })
  expect(test.runner.snapshot(AGENT_A)[0]?.latestRun).toBeUndefined()
  await test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
  const second = next(test, first.pluginId, { host: HOST })
  await expect(test.runner.run(AGENT_A, first.pluginId, first.packageId, 'update')).resolves.toMatchObject({ ok: false, reason: 'invalid-mode' })
  await expect(test.runner.run(AGENT_A, first.pluginId, second.packageId, 'run')).resolves.toMatchObject({ ok: false, reason: 'invalid-mode' })
  expect(test.runner.inventory()[0]?.currentPackageId).toBe(first.packageId)
})

it('refuses a second model activation while a Host half is still loading', async () => {
  const test = await harness()
  const entered = Promise.withResolvers<undefined>()
  const gate = Promise.withResolvers<undefined>()
  test.gates.push(gate)
  await test.ctx.plugin({
    name: 'load-gate-fixture',
    apply(ctx) { ctx.provide('loadGateFixture', { wait() { entered.resolve(undefined); return gate.promise } }) },
  })
  const first = define(test, { host: 'return { name: "wait-for-load", inject: ["loadGateFixture"], async apply(ctx) { await ctx.loadGateFixture.wait() } }' })
  const pending = test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
  await entered.promise
  await expect(test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')).resolves.toMatchObject({ ok: false, reason: 'transition-in-flight' })
  gate.resolve(undefined)
  await expect(pending).resolves.toMatchObject({ ok: true })
  expect(test.runner.inventory()[0]?.latestRun?.status).toBe('running')
})

it('keeps an outstanding approval exclusive and rejects unrelated activation identities', async () => {
  const test = await harness()
  const first = define(test, { client: CLIENT_CODE })
  await test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
  const request = test.requests.at(-1)!
  await expect(test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')).resolves.toMatchObject({ ok: false, reason: 'transition-in-flight' })
  const blocked = await test.runner.runHostHalf(AGENT_A, first.pluginId, first.packageId, 'run', null, false)
  if (blocked.ok) throw new Error('a pending approval must prevent a direct run')
  expect(blocked.message).toContain('pending run request')
  const unrelated = await test.runner.runHostHalf(AGENT_A, first.pluginId, first.packageId, 'run', ApprovalRequestId('unknown-request'), false)
  if (unrelated.ok) throw new Error('an unrelated request must not authorize activation')
  expect(unrelated.message).toContain('does not authorize')
  await expect(test.runner.resolveRequestRun(request.requestId, { ok: true, pluginRunId: CordisDynamicPluginRunId('stale-run') })).resolves.toEqual({ accepted: false })
  await expect(test.runner.resolveRequestRun(request.requestId, { ok: false, reason: 'client-half-failed', pluginRunId: CordisDynamicPluginRunId('stale-run') })).resolves.toEqual({ accepted: false })
  await expect(test.runner.resolveRequestRun(request.requestId, { ok: false, reason: 'rejected' })).resolves.toEqual({ accepted: true })
  expect(test.runner.inventory()[0]?.latestRun?.status).toBe('rejected')
})

it('attaches to an approved Client transition until a render failure makes that transition stale', async () => {
  const test = await harness()
  const first = define(test, { client: CLIENT_CODE })
  await test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
  const request = test.requests.at(-1)!
  const initial = await test.runner.runHostHalf(AGENT_A, first.pluginId, first.packageId, 'run', request.requestId, true)
  if (!initial.ok) throw new Error(initial.message)
  await test.runner.resolveRequestRun(request.requestId, { ok: true, pluginRunId: initial.pluginRunId })
  const second = next(test, first.pluginId, { client: CLIENT_CODE })
  await expect(test.runner.run(AGENT_A, first.pluginId, second.packageId, 'update')).resolves.toMatchObject({ ok: true, status: 'starting' })
  const update = test.requests.at(-1)!
  const loading = await test.runner.runHostHalf(AGENT_A, first.pluginId, second.packageId, 'update', update.requestId, false)
  if (!loading.ok) throw new Error(loading.message)
  await expect(test.runner.runHostHalf(AGENT_A, first.pluginId, second.packageId, 'update', update.requestId, false)).resolves.toMatchObject({ ok: true, startedHere: false })
  await test.runner.reportRenderFailure(AGENT_A, first.pluginId, loading.pluginRunId, { slot: 'test.slot', message: 'render failed', abdicated: false })
  const stale = await test.runner.runHostHalf(AGENT_A, first.pluginId, second.packageId, 'update', update.requestId, false)
  if (stale.ok) throw new Error('the failed activation must not restart under the same request')
  expect(stale.message).toContain('no longer identifies')
  await expect(test.runner.resolveRequestRun(update.requestId, { ok: false, reason: 'client-half-failed', pluginRunId: loading.pluginRunId, startedHere: true })).resolves.toEqual({ accepted: true })
  expect(test.runner.inventory()[0]?.activeRun).toBeUndefined()
})

it('rejects Host-only Client-source reads, stale invocation ids and missing methods', async () => {
  const test = await harness()
  const first = define(test)
  const started = await test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
  if (!started.ok) throw new Error(started.message)
  expect(() => test.runner.getClientCode(AGENT_A, first.pluginId, started.pluginRunId)).toThrow('no Client half')
  await expect(test.runner.invoke(first.pluginId, CordisDynamicPluginRunId('stale-run'), 'missing', null)).resolves.toMatchObject({ ok: false, code: 'stale-run' })
  await expect(test.runner.invoke(first.pluginId, started.pluginRunId, 'missing', null)).resolves.toMatchObject({ ok: false, code: 'method-not-found' })
  await expect(test.runner.settleUserRun(AGENT_A, first.pluginId, { ok: true, pluginRunId: CordisDynamicPluginRunId('stale-run') })).resolves.toMatchObject({ ok: false, reason: 'client-half-failed' })
  expect(test.runner.inventory()[0]?.activeRun?.pluginRunId).toBe(started.pluginRunId)
})

it('forwards inspect manifests and settles a Client query only for its owning Session', async () => {
  const test = await harness()
  expect(test.runner.syncInspectManifest([{
    id: 'Fixture', description: 'fixture provider', methods: [{
      name: 'read', description: 'read fixture', inputSchema: { type: 'object' }, outputSchema: { type: 'string' },
    }],
  }])).toBeNull()
  const requests: CordisInspectQueryRequest[] = []
  test.ctx.on('cordis/inspect-query', (request) => { requests.push(request) })
  const controller = new AbortController()
  onTestFinished(() => { controller.abort() })
  const pending = test.ctx.cordisInspect.query('client', 'Fixture', 'read', {}, AGENT_A, controller.signal)
  const request = requests.at(-1)!
  expect(test.runner.resolveInspectQuery(AGENT_B, request.requestId, { ok: true, data: 'wrong owner' })).toEqual({ accepted: false })
  expect(test.runner.resolveInspectQuery(AGENT_A, request.requestId, { ok: true, data: 'fixture value' })).toEqual({ accepted: true })
  await expect(pending).resolves.toBe('fixture value')
})

it.each([
  ['throw "primitive failure"', 'primitive failure'],
  ['throw null', 'null'],
  ['throw { detail: "unstructured failure" }', '[object Object]'],
  ['throw { message: "structured failure" }', 'structured failure'],
])('normalizes dynamic-code rejection from %s', async (host, message) => {
  const test = await harness()
  const first = define(test, { host })
  await expect(test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')).resolves.toMatchObject({ ok: false, reason: 'host-half-failed', message })
  expect(test.runner.inventory()[0]?.latestRun).toMatchObject({ status: 'failed', error: { message } })
  expect(test.runner.inventory()[0]?.activeRun).toBeUndefined()
})

it('records Host startup failure before settling the published Client activation request', async () => {
  const test = await harness()
  const first = define(test, { host: 'throw new Error("host startup failed")', client: CLIENT_CODE })
  await test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
  const request = test.requests.at(-1)!
  const result = await test.runner.runHostHalf(AGENT_A, first.pluginId, first.packageId, 'run', request.requestId, false)
  if (result.ok) throw new Error('the failing Host must not start')
  await expect(test.runner.resolveRequestRun(request.requestId, { ok: false, reason: 'host-half-failed', message: result.message })).resolves.toEqual({ accepted: true })
  expect(test.runner.inventory()[0]?.latestRun?.error).toMatchObject({ phase: 'host-apply', message: 'host startup failed' })
})

it('removes an unstarted definition and stops a pending Client approval without an active run', async () => {
  const test = await harness()
  const unstarted = define(test)
  await expect(test.runner.undefineFromPanel(AGENT_A, unstarted.pluginId)).resolves.toEqual({ ok: true, wasRunning: false })
  const pending = define(test, { client: CLIENT_CODE })
  await test.runner.run(AGENT_A, pending.pluginId, pending.packageId, 'run')
  await expect(test.runner.stopFromPanel(AGENT_A, pending.pluginId)).resolves.toEqual({ ok: true })
  expect(test.runner.inventory()[0]).toMatchObject({ latestRun: { status: 'stopped' } })
  expect(test.runner.inventory()[0]?.activeRun).toBeUndefined()
})

it.each(['return undefined', 'return 123'])('reports %s as a Host plugin result failure without publishing an active run', async (host) => {
  const test = await harness()
  const first = define(test, { host })
  const result = await test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
  if (result.ok) throw new Error('an invalid Host result must not activate')
  expect(result.reason).toBe('host-half-failed')
  expect(result.message).toBe(host.endsWith('undefined')
    ? 'the Host half returned `undefined` — did you forget `return`?'
    : 'the Host half must return a Plugin function or an object with apply(ctx)')
  expect(test.runner.inventory()[0]?.activeRun).toBeUndefined()
})

it('contains duplicate standalone handler failures and ignores guard reports for inactive runs', async () => {
  const test = await harness()
  const first = define(test, { host: 'harness.handle("fail", async () => { throw new Error("handler failure") }); return { apply() {} }' })
  const started = await test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
  if (!started.ok) throw new Error(started.message)
  for (let call = 0; call < 2; call += 1) {
    await expect(test.runner.invoke(first.pluginId, started.pluginRunId, 'fail', null)).resolves.toMatchObject({
      ok: false, code: 'handler-error', message: 'handler failure',
    })
  }
  await test.runner.stop(AGENT_A, first.pluginId)
  await expect(test.runner.reportClientGuardFailure(AGENT_A, first.pluginId, started.pluginRunId, { message: 'late guard' })).resolves.toBeNull()
  await expect(test.runner.reportClientGuardFailure(AGENT_B, first.pluginId, started.pluginRunId, { message: 'other Session' })).resolves.toBeNull()
  expect(test.runner.inventory()[0]?.latestRun?.status).toBe('stopped')
})

it('contains runtime failure reports for waiting and failed activations', async () => {
  const test = await harness()
  const first = define(test, { host: 'return { name: "waiting-fixture", inject: ["missingFixtureService"], apply() {} }' })
  const started = await test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
  if (!started.ok) throw new Error(started.message)
  expect(test.runner.inventory()[0]?.latestRun?.status).toBe('waiting')
  await test.runner.reportClientGuardFailure(AGENT_A, first.pluginId, started.pluginRunId, { message: 'waiting guard' })
  await test.runner.reportRenderFailure(AGENT_A, first.pluginId, started.pluginRunId, { slot: 'test.slot', message: 'render failed', abdicated: true })
  await test.runner.reportClientGuardFailure(AGENT_A, first.pluginId, started.pluginRunId, { message: 'late failed guard' })
  expect(test.runner.inventory()[0]?.latestRun?.status).toBe('failed')
  expect(test.runner.snapshot(AGENT_A)[0]?.activeRun?.renderFailure?.message).toBe('render failed')
})

it('keeps an old active run separate from a newer outstanding Client transition', async () => {
  const test = await harness()
  const first = define(test)
  const active = await test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
  if (!active.ok) throw new Error(active.message)
  const second = next(test, first.pluginId, { client: CLIENT_CODE })
  const newer = await test.runner.run(AGENT_A, first.pluginId, second.packageId, 'update')
  if (!newer.ok) throw new Error(newer.message)
  await expect(test.runner.settleUserRun(AGENT_A, first.pluginId, { ok: true, pluginRunId: active.pluginRunId })).resolves.toMatchObject({
    ok: true, mode: 'run', pluginRunId: active.pluginRunId,
  })
  await test.runner.reportRenderFailure(AGENT_A, first.pluginId, active.pluginRunId, { slot: 'test.slot', message: 'old UI failed', abdicated: false })
  expect(test.runner.inventory()[0]?.latestRun).toMatchObject({ pluginRunId: newer.pluginRunId, status: 'awaiting-approval' })
  const staleFailure = await test.runner.settleUserRun(AGENT_A, first.pluginId, {
    ok: false, reason: 'client-half-failed', pluginRunId: CordisDynamicPluginRunId('old-page-run'), message: 'old page failed', stack: 'old page stack',
  })
  expect(staleFailure).toMatchObject({ ok: false, message: 'old page failed', stack: 'old page stack' })
  expect(test.runner.inventory()[0]?.latestRun?.pluginRunId).toBe(newer.pluginRunId)
  await test.runner.stop(AGENT_A, first.pluginId)
})

it('retains Client failure details when a direct page reports failure for its current run', async () => {
  const test = await harness()
  const first = define(test, { client: CLIENT_CODE })
  const loaded = await test.runner.runHostHalf(AGENT_A, first.pluginId, first.packageId, 'run', null, false)
  if (!loaded.ok) throw new Error(loaded.message)
  const failure = await test.runner.settleUserRun(AGENT_A, first.pluginId, {
    ok: false, reason: 'client-half-failed', pluginRunId: loaded.pluginRunId, stack: 'page stack',
  })
  expect(failure).toMatchObject({ ok: false, message: 'client-half-failed', stack: 'page stack' })
  expect(test.runner.inventory()[0]?.latestRun?.error).toMatchObject({ message: 'client-half-failed', stack: 'page stack' })
})

it('does not let an old handler disposer remove its replacement in the same activation', async () => {
  const test = await harness()
  const first = define(test, { host: `
    const removeOld = harness.handle('value', async () => 1)
    harness.handle('value', async () => 2)
    removeOld()
    return { apply() {} }
  ` })
  const active = await test.runner.run(AGENT_A, first.pluginId, first.packageId, 'run')
  if (!active.ok) throw new Error(active.message)
  await expect(test.runner.invoke(first.pluginId, active.pluginRunId, 'value', null)).resolves.toEqual({ ok: true, value: 2 })
  await test.runner.stop(AGENT_A, first.pluginId)
  await expect(test.runner.invoke(first.pluginId, active.pluginRunId, 'value', null)).resolves.toMatchObject({ ok: false, code: 'plugin-not-running' })
})
