# Agent Note: Deployment component ownership

Status: implemented

English | [中文](2026-10-09-deployment-component-ownership.zh.md)

## Problem

An installed package can expose a standalone bundle while another selected bundle already mounts its components. Its unselected standalone layer does not mean the component is disabled. A second package switch can duplicate composition or unload the carrier of an independent feature setting and durable store.

## Decision

The existing [plugin manager](../../../../packages/boot/plugin-manager/README.md) accepts `managedBundles`, an empty-by-default dictionary keyed by exact package name. Each entry declares the required independent selection, optional localized title and optional supplying `ownerBundle`. The returned deployment policy is separate from actual profile selection and runtime row phases. It extends the [snapshot and row-policy decision](2026-10-08-profile-plugin-snapshot-and-deployment-policy.md); it adds no persisted projection or feature preference.

The Host refuses contradictory selection, removal and known-name package replacement, including installation with activation disabled. Registry and local-directory identities are checked before pnpm runs. Git and tarball specs retain the existing installation path; a resolved managed name is rejected with the existing manifest and lockfile rollback. This rollback does not undo downloaded or replaced files under `node_modules`, and deployment policy does not sandbox untrusted plugin code.

Candidate bundle selection preserves both manager policy dictionaries. Existing selection drift does not prevent unrelated extension operations. A repair can only restore the declared selection. Backend management protection remains stronger than deployment rules.

The page shows named deployment components in a separate group with localized titles and actual runtime row summaries. It offers no independent package toggle, no deployment-managed row toggle and no uninstall action. Unmanaged component rows retain their ordinary controls. A selection conflict offers a one-way deployment repair. An addressable managed row with stale enablement offers the same repair even when package selection is already correct. Feature settings remain with their owning page; detail contributions can link there using the existing Slots.

## Alternatives considered

**Treat every installed package as a feature switch.** Package presence, bundle selection, component mounting and feature use are independent facts.

**Hide switches without Host policy.** Other management clients could still activate a duplicate layer or remove its carrier.

**Protect all extensions or replace installation transactions.** Exact deployment ownership leaves ordinary extensions available and preserves the established installer and its limits.

## Consequences

Deployments supply only the packages they own and the carriers already embedded in their composition. Unmanaged optional and user bundles retain existing controls. Operator-authored files remain separate authority; the manager exposes a repair instead of resetting feature settings or stores.

## Verification

Real Loader/profile tests cover mounted embedded components, duplicate activation refusal, protected removal and replacement, policy-erasing candidate layers, stale selection repair and unrelated extension management. Client component tests cover the deployment group, unavailable competing controls and the one-way repair.
