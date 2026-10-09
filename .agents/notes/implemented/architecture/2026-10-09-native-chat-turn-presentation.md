# Agent Note: Native quiet activity and inline Turn summaries

Status: implemented

English | [中文](2026-10-09-native-chat-turn-presentation.zh.md)

## Problem

Deployments need quiet running status and compact completion summaries without losing native grouping, ordering, disclosure or history. Failed and stopped work also needs its recorded elapsed time; a failure label alone hides available timing evidence.

## Decision

[Chat](../../../../packages/client/ui-chat/README.md#grouped-rendering) owns both presentation options. `quietActivity` renders static running text and elapsed time without a glyph or animated Chat title. `inlineCompletedSummary` adds one static category caption to the native closed-Turn toggle. Both default to false; deployments can choose them through Host preferences or the public injected presentation policy. `turnPresentationVersion` identifies the complete Client contract.

The Turn toggle reveals or hides its eligible process range. Full group titles and independent controls remain beside their original bodies, retaining native order and disclosure state. Intermediate narration stays between the same groups, and the final answer remains visible independently of the process. History updates and work-details mode changes retain existing seats. No DOM outlets or additional disclosure store are required.

Status, duration and aggregate caption use the content font-size setting. The inline duration keeps the UI family and tabular numerals; a long caption truncates while the elapsed label remains visible. Intermediate and final Assistant replies retain the same native Markdown typography and response spacing. Process membership controls disclosure without changing text styling.

Every settled status uses recorded start and end boundaries. Missing boundaries omit time; no current-clock estimate replaces incomplete history. Running clock ticks keep one stable status announcement.

## Alternatives considered

**Replace Chat View or group state.** This transfers unrelated execution presentation and replay behavior to a deployment for a small layout choice.

**Move individual group controls to the status row.** Long Turns produce an icon strip whose controls are separated from their bodies and intervening narration. Keeping each title at its original position preserves the relationship between its control and content.

**Repeat every group caption on the status row.** Long Turns duplicate labels and crowd narrow frames. One static aggregate caption retains the work summary without adding more actions.

## Consequences

Native Session events and model requests remain unchanged. The quiet option does not activate custom glyph contributions. Known failure and stop timing remains visible; unknown timing stays absent. A final-only Turn has no work caption. Focused tests cover six independent groups, intermediate narration, final-answer visibility, history updates, mode changes, disclosure resets and clock cleanup.
