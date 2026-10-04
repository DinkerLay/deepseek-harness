# Agent Note: Separate Session addresses from execution presentation

Status: implemented

English | [中文](2026-10-04-session-address-execution-presentation.zh.md)

## Problem

A stable conversation address can outlive the execution currently serving it. Replacing that address with an execution identity changes navigation and product references; keeping the address as the execution binding directs input, control, projections, and history at the wrong Session. Historical execution views also need their own read-only posture without creating another Session object or changing Host authority.

The shared Conversation shell includes a header, input, and target views. Reimplementing that shell in a product package duplicates its lifecycle and presentation rules. A product-specific source message may need a different card, but a second Conversation Definition would duplicate the same durable input instead of presenting its existing Node.

## Decision

The client separates execution binding from view address. An owned `SessionReference` remains the only explicit Provider target. `SessionProvider.presentationOptions` supplies a stable address and a read-only presentation without changing the binding key, scoped Context, observable sources, or command recipient. The adapter exposes optional additive `sessionAddressId` and `sessionReadOnly` standard props; runtime defaults remain the actual Session identity and writable presentation. An actual read-only Session snapshot also makes the view read-only, including a later downgrade of a shared generation.

`PropsRenderFactories<true>` opts a Session-scoped component into the Provider seat within the existing Factory-render share. Its default parameter preserves the previous share, and `PropsRuntime` does not require a Provider from components that never use one. Runtime creation of the seat does not require an area renderer until the component invokes it.

### Conversation assembly

`main.conversation` owns a `conversation.binding` chain whose owner currency is the selected Session identity. The all-decline fallback renders `conversation.frame`. A matching consumer binds its retained execution reference and renders that same Factory, so header, transcript, input, and controls use one actual execution subtree. The chain is selector replacement, not middleware; it provides no `next()` callback.

The frame owns the existing header and content assembly plus an ordered `conversation.top` list. The strict top list renders only with an execution binding, preserving the no-Session hero and resident composer. A historical consumer can render another frame under a read-only reference; the generic framework does not elect an execution, interpret product phases, or combine histories into a continuous transcript.

Read-only presentation omits composer and header mutation chrome. Chat retains Copy, inspection, and disclosure while withholding Branch and the per-message mutation-action list. View and paging state remain browser-local reads. Presentation settings are not Host credentials or authorization; Controller read-only targets and native Host checks keep their own responsibilities.

### Exact-node presentation

`conversation.chat.node.presentation` receives the original `ChatNode` and elects one replacement body. All-decline renders the existing keyed `conversation.chat.node` body with its original constrained hook context. The source Definition, Node data, Node key, flow wrapper, and Session events remain unchanged. Source recognition and any product card belong to the consuming package, not to the generic Chat fold.

## Alternatives considered

**Change the global selected Session.** This conflates stable navigation with execution identity and retargets unrelated consumers. A Provider-bound subtree isolates execution selection while retaining the address as presentation data.

**Copy the Conversation shell into a product package.** This creates another implementation of header, input, view, and scope lifetimes. The reusable frame keeps those responsibilities with their existing owners.

**Create another Definition for the same source message.** This duplicates the Node and durable-event interpretation. Exact-node presentation changes only the existing Node's body and leaves unrelated sources on the original keyed renderer.

**Require the Provider in every component's runtime props.** This expands existing component and fixture contracts even when they render no Provider. The explicit Factory-share opt-in keeps ordinary declarations compatible.

## Consequences

Address-based product operations must explicitly use the stable address, while execution actions continue through the Provider's actual scope. The view owner retains and releases its references; a Provider borrows them and never creates ownership. An explicit address override alone cannot select another execution. Inherited read-only presentation cannot be cleared by a false option, and a shared read-only generation is not made writable by releasing one history view.

The generic additions produce no Session events, model instructions, tools, or product state machine. A product consumer must verify its own readiness and current execution before choosing a reference; the framework renders the reference it supplies and grants no execution authority.

## Verification

[Execution-frame assembly tests](../../../../packages/client/ui-conversation/tests/execution-frame.client.spec.tsx) boot the production Web Client roster and renderer over scripted Remote streams and actual `ClientSessions` references. They verify unchanged no-hook selection, ordered top contributions, one stable address with distinct execution transcripts, an input RPC addressed to the actual execution, shared-generation read-only publication, reference release, and exact-node replacement with unchanged event and flow identity. They make no provider requests.

[Chat component tests](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx) keep Copy in a read-only view and withhold Branch and per-message mutation entries, then verify those controls in a writable view. [Provider tests](../../../../packages/client/ui-renderer/tests/session-provider.client.spec.tsx) cover an adapter without an area renderer when its seat is unused. The public `SlotTestRuntime` fixture mirrors read-only target posture for product policy tests; it is a test-owned Controller double, not evidence of transport or Host authorization.

The [ordinary history Host test](../../../../packages/api/session-controller/tests/read-only-history.host.spec.ts) starts a real cold Loader, Session store and Controller; an explicit read-only follow does not promote an Agent, while the default still does. [Client reference tests](../../../../packages/api/session-controller/tests/read-only-history.client.spec.ts) verify explicit targets, shared-generation downgrade, mutation refusal and final release through the production Gateway assembly. [Chat inject tests](../../../../packages/client/ui-chat/tests/apply-inject.client.spec.tsx) verify a view-only Turn request without changing navigation. These are complementary ownership tests, not provider-backed product acceptance.

The assembled fixture reports an existing render-time publication warning while the first ordinary Session's input catalogs materialize. These tests retain that diagnostic and do not claim to repair the catalog-publication path. Root-level browser replay and real-product verification remain separate from these keyless component and transport tests.
