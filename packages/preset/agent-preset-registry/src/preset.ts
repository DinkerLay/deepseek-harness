import type { Volatile } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
/** Public preset roster and selection configuration. */
/** One declared preset and its current activation failure, if any. */
export interface AgentPreset {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly broken?: string
}

/** Process-local lease retaining one selected composition until released. Not a durable revision token. */
export interface PresetCompositionLease extends AsyncDisposable {
  /** Identity of the retained declaration, even if the registry later replaces it. */
  readonly id: string
  /** SHA-256 of the captured JSON declaration and preset id; absent for non-JSON declarations. Not a plugin-binary digest. */
  readonly revision: string | undefined
  /**
   * Bind an unpublished, unbound Agent scope to this exact retained revision.
   * @param ctx - Agent factory setup context; never a live published Agent scope.
   * @returns the bound preset identity.
   * @throws when the lease/registry is closed or the scope is foreign, closed, already bound, or published.
   */
  mount(ctx: Context): Promise<AgentPreset>
}

/** Registry selection policy. */
export interface Config {
  /** Deployment default when the caller omits a preset. */
  default: string
  /** User-selected default while the chooser is shown; edited through Settings. */
  selectedDefault: Volatile<string | undefined>
  /** Whether new-session surfaces expose preset selection and the saved default applies. */
  modeSelectionEnabled: Volatile<boolean>
}
