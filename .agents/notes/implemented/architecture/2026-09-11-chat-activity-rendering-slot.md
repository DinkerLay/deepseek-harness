# Agent Note: Chat activity rendering slot

Status: implemented

English | [中文](2026-09-11-chat-activity-rendering-slot.zh.md)

## Problem

Products need their own running indicators while the native Chat view retains Turn timing, streaming and lifecycle ownership.

## Decision

The Session-scoped `conversation.chat.activity` slot receives the running Turn start time. Native Chat supplies its existing activity renderer by default. Product registrations replace only that renderer; the native view controls when it appears and disappears. Completed process disclosure remains a separate native Chat node.

## Alternatives considered

Copying ChatView duplicates streaming and paging. DOM rewriting breaks React ownership. Styling hashed private classes makes Product behavior depend on build output.

## Consequences

The default UI keeps its existing label and clock behavior. Products can add accessible indicators without adding another execution-state projection.
