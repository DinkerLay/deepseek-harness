# Agent Note: Transcript echo retention during inbox preparation

Status: implemented

English | [中文](2026-09-17-transcript-echo-inbox-handoff.zh.md)

## Problem

An idle prompt passes through the Host inbox before preparation produces its durable user message. Treating that transient queue occurrence as the transcript replacement removes the local bubble while the conversation has no user node to render. First-turn workspace preparation makes the gap visible. This refines the submission lifecycle retained by the [generic attachment decision](../feature/2026-08-26-generic-file-upload.md).

## Decision

Session retains a `transcript` submission until a matching durable `user/message` is observed, an identified failure occurs, or the Session is disposed. Queue observation can retire only queued or steering submissions. Chat deduplicates a transcript echo against durable user/steering nodes, never against an inbox occurrence. Steering echoes still deduplicate against their visible pending steering bubble.

The existing frame-delayed retirement and `rpcId` correlation remain authoritative. There is no new timeout, wire field, Session event, model input or history rewrite. Attachment retirement follows the same durable handoff, keeping image previews available during preparation.

## Alternatives considered

**Retain the bubble for a fixed delay.** Preparation latency varies; a timeout can still leave a gap or duplicate a completed message.

**Retain only Session memory while Chat hides the inbox match.** The bubble still disappears during admission. Both the lifecycle and presentation must recognize the same replacement.

**Retain every echo until a durable user message.** Queued and steering submissions already have visible Host-owned pending surfaces and must preserve their existing handoff.

## Consequences

An idle-send bubble stays visible while a turn prepares. The original Session and Chat component regressions cover admission, inbox consumption, delayed durable delivery, one final bubble and exactly one settlement. Running-turn queue and steering behavior remains covered by the same suites. The change affects transient presentation, so persisted Session output is unchanged.
