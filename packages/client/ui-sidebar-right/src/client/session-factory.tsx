/** Native Sidebar Session factory, independent from a deployment's surrounding frame. */
import { useMemo } from 'react'
import type {
  OwnerOf, PropsRenderFactories, SessionProviderComponent, SlotSpec, SlotMap as PublicSlotMap,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { createSidebarRightStore } from './stores.ts'
import type { SidebarRightInjected } from './shell/SidebarRight.tsx'
import { RightbarSessionRoot, type RightbarSessionRootProps } from './shell/RightbarRoot.tsx'

/** Public Session factory registered by applyWithSessionFactory. */
export const SIDEBAR_RIGHT_SESSION_FACTORY = 'sidebar.right.session'

/** One native handle shared by Sidebar seats and a deployment's independent Session panes. */
export type SidebarRightStoreHandle = ReturnType<typeof createSidebarRightStore>

/** Surrounding frame integration without changing native navigation or docking. */
export interface SidebarRightSessionFactoryOptions {
  /** Deployment-owned factory name declared with the native Sidebar factory structure. */
  readonly factoryName?: string
  /** Build the deployment Session boundary from this root's public factory renderer. */
  readonly sessionProvider: (renderFactorySlot: PropsRenderFactories['renderFactorySlot']) => SessionProviderComponent
}

/** Mounted native factory and the same store its controllers adopt. */
export interface SidebarRightSessionMount {
  readonly factoryName: string
  readonly store: SidebarRightStoreHandle
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    'sidebar.right.session': {
      scope: 'session'
      props: OwnerOf<'rightbar.session'>
      store: SidebarRightStoreHandle
      locale: 'sidebarRight'
      inject: SidebarRightInjected
      children: {
        'sidebar.right.pane.tab': SlotSpec<PublicSlotMap['sidebar.right.pane.tab']>
        'sidebar.right.pane.tab.title': SlotSpec<PublicSlotMap['sidebar.right.pane.tab.title']>
        'sidebar.right.tab.menu.item': SlotSpec<PublicSlotMap['sidebar.right.tab.menu.item']>
      }
    }
  }
}

/** Route the native root to its public factory while retaining the root's Session lifetimes. */
export function factoryRightbarRoot(options: SidebarRightSessionFactoryOptions) {
  return function FactoryRightbarRoot({ renderFactorySlot, ...props }:
    Omit<RightbarSessionRootProps, 'renderSession' | 'SessionProvider'> & PropsRenderFactories) {
    const provider = useMemo(() => options.sessionProvider(renderFactorySlot), [renderFactorySlot])
    const renderSession =
      (owner: OwnerOf<'rightbar.session'>) => options.factoryName === undefined
        ? renderFactorySlot(SIDEBAR_RIGHT_SESSION_FACTORY, owner)
        : Reflect.apply(renderFactorySlot, undefined, [options.factoryName, owner])
    return <RightbarSessionRoot {...props} SessionProvider={provider}
      renderSession={renderSession} />
  }
}
