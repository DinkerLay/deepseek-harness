/** Register the HTTP(S) Browser tab type in the right Sidebar. */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { BrowserBody, type BrowserBodyProps } from './view/BrowserBody.tsx'
import { BrowserTitle } from './view/BrowserTitle.tsx'
import { createBrowserControllers } from './browser/BrowserController.ts'
import type { BrowserInjected } from './browser/BrowserController.ts'
import { createIframePage } from './pages.ts'
import { createElectronPage } from './electron/pages.ts'
import type { DesktopBrowserBridge } from '../types.ts'
import { browserWorkspace } from './electron/workspace.ts'
import type { BrowserPageFactory } from './browser/BrowserPage.ts'
import { BROWSER_ID, browserDefinition } from './definition.tsx'
import { en, zh } from './locales.ts'
import { createBrowserStore } from './browser/store.ts'
import type { BrowserPageOptions, BrowserPage } from './browser/BrowserPage.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type { BrowserBodyProps } from './view/BrowserBody.tsx'
export type { BrowserControllerState, BrowserInjected, BrowserMountRequest } from './browser/BrowserController.ts'
export type { BrowserFrame, BrowserFrameState, BrowserLoadError, BrowserSandboxControl } from './browser/BrowserFrame.ts'
export type { BrowserPage, BrowserPageFactory, BrowserPageOptions } from './browser/BrowserPage.ts'
export type { BrowserPresentation } from './view/BrowserPresentation.ts'
export type { BrowserFailure, BrowserHistoryEntry, BrowserNavigationStatus, BrowserTabState } from './browser/BrowserPersistence.ts'
export type { SidebarBrowserKey } from './locales.ts'
export type { BrowserState } from './browser/store.ts'
export type { BrowserAddressFailure, BrowserAddressResult, BrowserTarget } from './browser/url.ts'
export { browserResourceAddress } from './browser/resource-address.ts'
export type { BrowserResourceAddressResult } from './browser/resource-address.ts'

/** Public carrier factory support; controllers, navigation and persistence remain native-owned. */
export const pageFactoryVersion = 1 as const

/** Caller-owned carrier used by every Browser tab in this plugin lifetime. */
export interface BrowserPageProvider {
  /** Preserve visited presentations through hidden tabs and Session changes when the carrier requires it. */
  readonly keepMounted?: boolean
  /** @param sessionId Source Session. @param options Native checkpoint and callbacks. @returns One idle carrier page. */
  createPage(sessionId: SessionId, options: BrowserPageOptions): BrowserPage
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Optional initial Browser URL. */
    browser: { readonly url?: string }
  }
}

/** Required Browser services. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** Register the Browser type, localized guide entry, body, and title. */
export function apply(ctx: Context): void {
  install(ctx)
}

/**
 * Mount native Browser chrome and persistence over an explicit carrier factory.
 * @param ctx Owning Client plugin context.
 * @param provider Carrier construction and retention preference; pages dispose with their native tab occurrence.
 */
export function applyWithPageFactory(ctx: Context, provider: BrowserPageProvider): void {
  install(ctx, provider)
}

function install(ctx: Context, provider?: BrowserPageProvider): void {
  const namespace = 'sidebarBrowser'
  const t = ctx.locale.bind(namespace)
  ctx.inject(['shortcuts'], (ctx) => {
    ctx.effect(() => ctx.shortcuts.register({
      id: 'browser.new' as ShortcutCommandId, label: () => t('guide.title'), aliases: ['browser', 'new browser tab'],
      defaults: {
        'desktop:macos': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyT', modifiers: ['primary'] },
        'web:macos': { code: 'KeyT', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyT', modifiers: ['primary', 'alt'] },
      },
      // Each tab plugin owns its command's availability, localized refusal, and tab kind.
      /* jscpd:ignore-start */
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: ({ target: element }) => {
        const target = ctx.sidebarRight.commandTarget(element)
        if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
        return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget('browser', target) } }
      },
      /* jscpd:ignore-end */
    }), 'ui-sidebar-browser: shortcut')
  })
  const store = createBrowserStore()
  const openTabs = ctx.sidebarRight.openTabs
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly protocolVersion: number; readonly browser?: DesktopBrowserBridge }
  }).dshDesktop
  const desktop = carrier?.protocolVersion === 1 ? carrier.browser : undefined
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-sidebar-browser.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({ ...browserDefinition(t),
    keepMounted: provider?.keepMounted ?? desktop !== undefined }), 'ui-sidebar-browser.type')
  const installFrames = (scope: Context, factory: (sessionId: BrowserBodyProps['sessionId']) => BrowserPageFactory): void => {
    const controllers = new Map<BrowserBodyProps['sessionId'], BrowserInjected>()
    scope.effect(() => async () => {
      const pending = [...controllers.values()].map(controller => controller.dispose())
      controllers.clear()
      await Promise.all(pending)
    }, 'ui-sidebar-browser.frames')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale: namespace, store,
      inject: (sessionId, actions) => {
        const existing = controllers.get(sessionId)
        if (existing !== undefined) {
          existing.rebind(actions)
          return existing
        }
        const controller = createBrowserControllers(actions, factory(sessionId), tabId =>
          openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.tabId === tabId))
        controllers.set(sessionId, controller)
        return controller
      },
    }, BrowserBody)), 'ui-sidebar-browser.body')
  }
  if (provider !== undefined) installFrames(ctx, sessionId => options => provider.createPage(sessionId, options))
  else if (desktop === undefined) installFrames(ctx, () => createIframePage)
  else ctx.inject(['workspaces'], (scope) => {
    installFrames(scope, sessionId => options => createElectronPage(options, desktop,
      signal => browserWorkspace(scope.workspaces.list, sessionId, signal)))
  })
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: BROWSER_ID, store,
  }, BrowserTitle)), 'ui-sidebar-browser.title')
}
