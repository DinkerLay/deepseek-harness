# Agent Note: Conversation builder decorators

Status: implemented

English | [中文](2026-09-10-conversation-builder-decorators.zh.md)

## Problem

Downstream transcript presentation can require hiding superseded attempts without copying the native Chat projection or mutating rendered DOM.

## Decision

Conversation View Registry owns effect-scoped builder decorators, keyed by target and unique registration ID. Wrappers are instantiated per Session; registration and withdrawal rebuild active targets. Ordinary Definitions, node identity, persistence and execution stay with their existing owners.

## Alternatives considered

Replacing the native Chat target duplicates its projection and paging behavior. DOM rewriting breaks renderer ownership. Neither is needed for a presentation-only policy.

## Consequences

A downstream policy can preserve incremental updates while changing which native nodes appear. Registry tests cover late targets, independent builders, stable entries, duplicate IDs and disposal.
