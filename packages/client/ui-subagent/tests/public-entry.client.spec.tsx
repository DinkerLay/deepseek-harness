// @vitest-environment jsdom
/** Public Sidebar resources keep their required services and isolated Slot owner. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as resourcesApply, inject as resourcesInject } from '@deepseek-ai/dsh-client-resources/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { apply, inject, type SubagentChatResource } from '@deepseek-ai/dsh-client-ui-subagent/client'
import type { ResourceProtocolMap, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'

const runtimes: SlotTestRuntime[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose() })

it('registers and disposes its public Sidebar resource through every nested dependency fiber', async () => {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const child = await runtime.sessions.add({ id: 'sidebar-child' })
  const parent = await runtime.sessions.add({ id: 'sidebar-parent' })
  const address: SubagentAddress = { childSessionId: child, parentSessionId: parent, mode: 'continuable' }
  const resourceAddress = `dsh-resource://subagentchat/session/${child}?parent=${parent}&mode=continuable`
  const ctx: Context = runtime.ctx.isolate('slots').isolate('resources')
  await ctx.plugin(SlotRegistry)
  const rootSlots = runtime.ctx.slots
  const slots = ctx.slots
  const declaration: SlotMap['sidebar.chat.conversation'] = { kind: 'single', scope: 'session' }
  slots.register({ name: 'root', children: {
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
  } } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('uiWorkspace', { openSession: () => { throw new Error('This resource test does not navigate.') } })
  ctx.provide('sidebarRight', { openResource: () => { throw new Error('This resource test does not navigate.') } })
  const tabs = new SidebarRightTabRegistry(ctx)
  ctx.provide('sidebarRightTabs', tabs)
  await ctx.plugin({ inject: resourcesInject, apply: resourcesApply })
  const feature = ctx.plugin({ inject, apply })
  await feature
  // Optional service callbacks own separate fibers; the public parent's await alone does not inspect their failures.
  await Promise.all([...ctx.registry.values()].flatMap(entry => [...entry.fibers].map(fiber => fiber.await())))
  expect(slots.entries('sidebar.chat.conversation')).toHaveLength(1)
  expect(slots.spec('sidebar.chat.conversation')).toMatchObject(declaration)
  expect(rootSlots.entries('sidebar.chat.conversation')).toEqual([])
  expect(tabs.get('subagentchat')?.canOpen?.(resourceAddress)).toBe(true)
  expect(tabs.get('subagentchat')?.title(resourceAddress)).toBe(child)
  const source = ctx.resources.source(resourceAddress)
  const controller = new AbortController()
  ctx.resources.pin(resourceAddress, controller.signal)
  await expect.poll(() => source.getSnapshot().value).toMatchObject({ address, reference: { sessionId: child } })
  const value = source.getSnapshot().value as SubagentChatResource
  const protocol: ResourceProtocolMap['subagentchat'] = value
  expect(protocol.reference.sessionId).toBe(child)
  expect(runtime.sessions.retainInfo(child).getSnapshot().retainedBy.sidebarChat).toBe(1)
  controller.abort()
  await expect.poll(() => runtime.sessions.retainInfo(child).getSnapshot().referenceCount).toBe(0)
  await feature.dispose()
  expect(slots.entries('sidebar.chat.conversation')).toEqual([])
  expect(slots.entries('sidebar.right.pane.tab')).toEqual([])
  expect(tabs.get('subagentchat')).toBeUndefined()
})
