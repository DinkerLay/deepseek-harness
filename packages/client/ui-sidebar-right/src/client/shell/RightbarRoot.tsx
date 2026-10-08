/** Root-scoped controller for the right Sidebar's Session content. */
import { useLayoutEffect } from 'react'
import type {
  HostObservable, InjectFace, OwnerOf, PropsRenderSlots, PropsRuntime, SessionProviderComponent,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SidebarSessionViewSnapshot } from '../session-views.ts'
import type {} from '../contract/slots.ts'
import css from './SidebarRight.module.css'

/** Root-only retained Session targets and their committed mount lifetimes. */
export interface RightbarRootInjected {
  readonly hooks: { readonly views: HostObservable<readonly SidebarSessionViewSnapshot[]> }
  readonly mountView: (reference: SessionReference) => () => void
}

type RootBaseProps = PropsRuntime<'rightbar'> & InjectFace<RightbarRootInjected>
type RenderSession = (owner: OwnerOf<'rightbar.session'>) => ReactNode
type RootProps = RootBaseProps & PropsRenderSlots<'rightbar.session'>
/** Native retained-Session root with an explicitly supplied presentation boundary. */
export type RightbarSessionRootProps = RootBaseProps & {
  readonly SessionProvider: SessionProviderComponent
  readonly renderSession: RenderSession
}

function SessionView({ view, visible, SessionProvider, renderSession, mountView, width, viewportWidth, canShow }:
  Pick<RightbarSessionRootProps, 'SessionProvider' | 'mountView' | 'width' | 'viewportWidth' | 'canShow'>
  & { readonly view: SidebarSessionViewSnapshot; readonly visible: boolean; readonly renderSession: RenderSession }) {
  useLayoutEffect(() => mountView(view.reference), [mountView, view.reference])
  const active = visible && view.selected
  return <div className={css.session} hidden={!active} data-sidebar-right-session={view.sessionId}>
    <SessionProvider session={view.reference}>
      {renderSession({ width, viewportWidth, canShow, active, retainTab: view.retainTab })}
    </SessionProvider>
  </div>
}

/**
 * Keep independent Session subtrees and hide those outside the selected Conversation.
 * @param props - frame geometry, view targets and the authorized Session renderer.
 * @returns the foreground and retained background Sidebars.
 */
export function RightbarRoot({ usePanelInfo, useViews, ...props }: RootProps) {
  return <RightbarSessionRoot {...props} usePanelInfo={usePanelInfo} useViews={useViews}
    renderSession={owner => props.renderSlot('rightbar.session', owner)} />
}

/** Keep native retained Session lifetimes around either the shipped seat or a public factory. */
export function RightbarSessionRoot({ usePanelInfo, useViews, ...props }: RightbarSessionRootProps) {
  const visible = usePanelInfo(info => info.activePanelId === null)
  const views = useViews(value => value)
  return <>{views.map(view => <SessionView key={view.sessionId} {...props} view={view} visible={visible} />)}</>
}
