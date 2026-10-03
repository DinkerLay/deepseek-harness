import type { ConversationViewBuilder, ConversationViewDefinition } from '../contract/conversation.ts'
import { ConversationDefinitionRegistry } from './definition-registry.ts'

/** Runtime registry of per-target Conversation snapshot builders. */
export class ConversationViewRegistry extends ConversationDefinitionRegistry<ConversationViewDefinition> {
  /** Public builder-decoration capability; decorators preserve registered Definitions. */
  get builderDecoratorsVersion(): 1 { return 1 }

  private readonly decorators = new Map<string, {
    target: string
    wrap: (builder: ConversationViewBuilder) => ConversationViewBuilder
  }>()
  private decorated: readonly ConversationViewDefinition[] | undefined

  /** @returns reference-stable Definitions with decorators applied in registration order. */
  override entries(): readonly ConversationViewDefinition[] {
    return this.decorated ??= super.entries().map((definition) => {
      const matching = [...this.decorators.values()].filter(item => item.target === definition.target)
      if (matching.length === 0) return definition
      return {
        ...definition,
        create: () => matching.reduce((builder, item) => item.wrap(builder), definition.create()),
      }
    })
  }

  /** Invalidate decorated factories before notifying active Session assemblers. */
  protected override refresh(): void {
    this.decorated = undefined
    super.refresh()
  }

  /**
   * Decorate each Session's independent builder without replacing its Definition.
   * Wrappers forward changedTurns, groupInput and publish when the native builder supplies them.
   * @param target - target to decorate, including one registered later.
   * @param id - unique decorator identity across targets.
   * @param wrap - factory invoked separately for each builder, in registration order.
   * @returns idempotent caller-owned disposer; registration and removal rebuild active targets.
   * @throws when another decorator owns the same identity.
   */
  decorate(target: string, id: string, wrap: (builder: ConversationViewBuilder) => ConversationViewBuilder): () => void {
    if (this.decorators.has(id)) throw new Error(`conversation view decorator "${id}" is already registered`)
    const dispose = this.ctx.effect(() => {
      this.decorators.set(id, { target, wrap })
      this.refresh()
      return () => {
        this.decorators.delete(id)
        this.refresh()
      }
    }, `uiConversation.views.decorate(${JSON.stringify(id)})`)
    return () => { void dispose() }
  }

  /**
   * Register a uniquely named view builder factory for the caller's lifetime.
   * @param definition - target builder contribution.
   * @returns idempotent disposer.
   */
  register(definition: ConversationViewDefinition): () => void {
    return this.registerDefinition(
      definition.target,
      definition,
      `conversation view target "${definition.target}" is already registered`,
      `uiConversation.views.register(${JSON.stringify(definition.target)})`,
    )
  }
}
