# Agent Note: Native Sidebar Session factory ownership

Status: implemented

English | [中文](2026-10-09-native-sidebar-session-factory.zh.md)

## Problem

A deployment can place several Session sidebars in its frame while retaining native docking, navigation and resources. Intercepting the native plugin's registration to extract its component and Store couples the deployment to private assembly details.

## Decision

The [Sidebar](../../../../packages/client/ui-sidebar-right/README.md#extension-seats) exposes `applyWithSessionFactory` and `sidebarSessionFactoryVersion`. The function retains native controllers, persistence, resource pins, focus, guide types and Session lifetimes. It registers the native Session component, children and Store under the default or deployment-owned factory name and returns the same handle.

The deployment supplies `sessionProvider(renderFactorySlot)`. A factory root does not declare the shipped Session child, so the framework does not synthesize that boundary for it. Requiring the actual authorized provider preserves shared Session bindings without an empty declaration. Ordinary `apply` retains the shipped assembly.

Factory metadata is checked against the native declaration. A custom string name is published through the public registry's runtime registration boundary; the deployment owns its corresponding declaration. No private registry or second Dock Store is introduced.

## Alternatives considered

**Intercept native registrations.** This exposes the component and handle only by recognizing implementation-specific registration calls.

**Copy the Dock or publish a generic registry.** Neither is needed to select one native assembly boundary, and both increase lifecycle ownership.

**Invent a default provider for the factory root.** A missing Session boundary is an authorization and binding error. The deployment supplies its real provider instead.

## Consequences

Custom frames and independent panes reuse native tab and resource behavior without replacing controllers. The factory name may remain deployment-owned. Tests mount a real production factory through a custom Session boundary and cover shared-store identity, background retention, Session switching and close cleanup.
