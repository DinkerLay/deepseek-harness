import type { ConversationViewBuilder, ConversationViewDefinition } from '../contract/conversation.ts'
import { ConversationDefinitionRegistry } from './definition-registry.ts'

/** Runtime registry of per-target Conversation snapshot builders. */
export class ConversationViewRegistry extends ConversationDefinitionRegistry<ConversationViewDefinition> {
  /** Public builder-decoration capability; decorators do not replace Definitions. */
  get builderDecoratorsVersion(): 1 { return 1 }
  private readonly decorators = new Map<string, { target: string; wrap: (builder: ConversationViewBuilder) => ConversationViewBuilder }>()
  private decorated: readonly ConversationViewDefinition[] | undefined

  /** Return stable Definitions with the registered builder decorators applied in order. */
  override entries(): readonly ConversationViewDefinition[] {
    return this.decorated ??= super.entries().map((definition) => {
      const matching = [...this.decorators.values()].filter(item => item.target === definition.target)
      if (matching.length === 0) return definition
      return { ...definition, create: () => matching.reduce((builder, item) => item.wrap(builder), definition.create()) }
    })
  }

  /** Invalidate decorated Definitions before notifying active Session assemblers. */
  protected override refresh(): void {
    this.decorated = undefined
    super.refresh()
  }

  /**
   * Decorate a target's per-Session builder without taking ownership of its projection.
   * @param target - target whose builder is decorated, including a target registered later.
   * @param id - unique registration identity.
   * @param wrap - factory producing an independent wrapper for each builder instance.
   * @returns caller-owned disposer; registration and disposal rebuild active target snapshots.
   */
  decorate(target: string, id: string, wrap: (builder: ConversationViewBuilder) => ConversationViewBuilder): () => void {
    if (this.decorators.has(id)) throw new Error(`conversation view decorator "${id}" is already registered`)
    const dispose = this.ctx.effect(() => {
      this.decorators.set(id, { target, wrap })
      this.refresh()
      return () => { this.decorators.delete(id); this.refresh() }
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
