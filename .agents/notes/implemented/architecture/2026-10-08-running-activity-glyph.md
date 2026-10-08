# Agent Note: Running activity glyph ownership

Status: implemented

English | [中文](2026-10-08-running-activity-glyph.zh.md)

## Problem

Deployments need their own running icon without taking ownership of Chat grouping, activity timing or status announcements. Replacing the whole activity component for an icon duplicates unrelated behavior.

## Decision

The [Chat plugin](../../../../packages/client/ui-chat/README.md#grouped-rendering) owns the running activity and declares a nested `conversation.chat.activity.icon` single Slot in Session scope. Its owner carries the current Turn start time or null. The shipped contribution renders the native whale; another contribution can replace only that decorative glyph. Removing it restores the native contribution.

The native activity retains its label, interval, layout and accessible status. The icon receives no execution authority and creates no conversation nodes. Process-group headers and transcript renderers remain unchanged.

## Alternatives considered

**Replace the activity component.** The existing outer Slot remains useful for a complete activity redesign, but an icon change does not justify copying its clock and accessibility behavior.

**Override internal CSS or assets.** These approaches bind a deployment to private selectors or package files and cannot express lifecycle-owned replacement through the public registry.

## Consequences

A deployment can use native timeline rendering and retain its own icon. The slot is decorative: localized running status and elapsed-time ownership remain native. Registry replacement and disposal tests retain the same mounted status row, while clock tests cover glyph changes and interval cleanup.
