# Agent Note: Profile plugin snapshots and deployment-owned row policy

Status: implemented

English | [中文](2026-10-08-profile-plugin-snapshot-and-deployment-policy.zh.md)

## Problem

Bundle selection, declared rows and Loader state describe different facts. Independent reads can join a new selection with old runtime entries, and an invalidated read can replace a newer view. Deployments also need to retain their shell and management components while leaving optional bundles selectable; a disabled switch alone cannot enforce this through direct service calls.

## Decision

The [Host manager](../../../../packages/boot/plugin-manager/README.md) exposes `snapshot()` for one bundle-and-plugin observation. It takes the existing profile manifest writer lock, then enters the HMR queue and awaits inventory work before releasing either. This extends the [current-profile transaction owner](2026-09-14-current-profile-plugin-management.md), without a separate installer or synchronization service. Existing list methods remain available. Snapshot serialization covers coordinated profile mutations and HMR reloads; it does not lock arbitrary editors or make fiber phases permanent.

The [Client manager](../../../../packages/client/ui-plugin-manager/README.md) consumes that snapshot. An invalidation during a read discards the whole pass and requests a fresh one; accepted cards remain visible. A mutation keeps its busy key through the final refresh attempt. Transport failures settle as an error with retry available, and disposal prevents late publication. The [sidebar and installation-request owner](2026-09-09-plugin-management-in-the-web-sidebar.md) remains active.

`managedRows` defaults to an empty dictionary. Each rule names one exact composition row id and module, its required enablement, and an optional replacement module for display. Runtime enablement and phase remain observed values; `deploymentPolicy` never substitutes required values for them. A module mismatch does not inherit the rule. Policy does not install packages, rewrite startup selections or reactivate optional bundles.

The Host rejects manager requests that contradict a matching rule. Repair to the desired state still requires a unique, addressable Include row, and backend management protection remains stronger than deployment configuration. Explicitly supported replacement of management UI can require that UI row to stay disabled while retaining the management backend. Bundle selection checks the candidate composition with current user, home and invocation overlays before saving. It rejects changes to a protected row's module or effective enablement, including disabling an ancestor group, and refuses changes that remove or alter the current manager's policy declaration. Changed unresolved conditions fail closed; unrelated optional layers remain selectable.

## Alternatives considered

**Joining independent list responses.** A Client read counter can discard stale replies but cannot make two Host observations describe the same profile generation. One serialized Host operation supplies the missing relationship.

**Disabling controls only in the page.** Direct Remote and tool callers can bypass a disabled switch. The manager owns rejection and the page renders the returned reason.

**Protecting every installed plugin or forcing defaults at startup.** This removes legitimate optional choices and hides saved configuration behind desired values. Exact deployment rules protect only named rows and keep actual state visible.

## Consequences

The Host and Client snapshot consumers ship together. Reads can wait behind package operations or HMR work. Manager-controlled changes preserve deployment rules before saving, while operator-authored configuration remains separate authority and is not normalized by this policy. The manager owns no extra persisted projection and changes no Session format or model request construction.

## Verification

Host regressions exercise the profile lock and HMR queue across asynchronous inventory, desired-state repair, ambiguous targets, module mismatch, optional layers, ancestor-group disablement and attempts to erase manager policy. Client regressions exercise invalidated snapshots, mutation refresh, transport failure, disposal, and separate actual/required state. Browser component fixtures verify the replacement label and unavailable controls; they do not establish external plugin compatibility.
