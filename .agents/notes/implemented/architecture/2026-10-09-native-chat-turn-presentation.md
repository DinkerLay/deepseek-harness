# Agent Note: Native quiet activity and inline Turn summaries

Status: implemented

English | [中文](2026-10-09-native-chat-turn-presentation.zh.md)

## Problem

Deployments need quiet running status and compact completion summaries without losing native grouping, ordering, disclosure or history. Failed and stopped work also needs its recorded elapsed time; a failure label alone hides available timing evidence.

## Decision

[Chat](../../../../packages/client/ui-chat/README.md#grouped-rendering) owns both presentation options. `quietActivity` renders static running text and elapsed time without a glyph or animated Chat title. `inlineCompletedSummary` places native group controls on the native closed-Turn row. Both default to false; deployments can choose them through Host preferences or the public injected presentation policy. `turnPresentationVersion` identifies the complete Client contract.

Group controls remain children of their native React seats and target view-local DOM outlets. Multiple groups share one category caption; their individual controls retain source order and disclosure state. A control outside a folded Turn reveals the Turn before opening its group. The outlets hold DOM destinations only, with no second conversation or disclosure store. History updates and work-details mode changes retain existing seats.

Every settled status uses recorded start and end boundaries. Missing boundaries omit time; no current-clock estimate replaces incomplete history. Running clock ticks keep one stable status announcement.

## Alternatives considered

**Replace Chat View or group state.** This transfers unrelated execution presentation and replay behavior to a deployment for a small layout choice.

**Move DOM nodes after rendering.** This bypasses React ownership, complicates late history updates and separates controls from their native subscriptions.

**Repeat every group caption on the status row.** Long Turns duplicate labels and crowd narrow frames. One caption with independent native controls retains the information and actions.

## Consequences

Native Session events and model requests remain unchanged. The quiet option does not activate custom glyph contributions. Known failure and stop timing remains visible; unknown timing stays absent. Focused tests cover multiple groups, intermediate narration, history updates, mode changes, folded-Turn reveal and clock cleanup.
