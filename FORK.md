# Maintaining the SuperCode kernel fork

English | [中文](FORK.zh.md)

This fork uses official [`dsh-v0.2.0-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2). Runtime package versions remain `0.2.0-rc.2`; the fork commit and content-addressed artifacts identify the modified bytes. [fork-manifest.json](fork-manifest.json) owns the exact base commit and the added and modified Runtime package inventory.

## Capability ownership

Official DSH owns native V4 history, Agent execution, continuation, tools, providers, projections, transport and persistence. This fork adds public creation and deletion reservations, effective execution directories, recoverable fork destinations, title policy and generation state, awaited prompt preparation, deployment access constraints, trusted execution environment, admission policies, scoped parent delivery and bounded DNS recovery. Product policy and business behavior remain external plugins.

Public browser libraries load without activating their default plugins. Conversation builder decorators forward grouping and publication; Chat presentation can exclude replaced Turns from logical navigation and counts. Markdown local links retain caller-owned resolution. Administrative channels retain authenticated loopback authority. Browser index authentication errors accept deployment-owned plain-text guidance while preserving status, headers and token exchange. Model catalogs distinguish registered execution providers from providers with available models.

Subagent Sidebar registration declares all nested resource dependencies and its public Client entry exposes the readonly resource type plus the associated Slot, protocol and retention-source declarations. Downstream presentation reuses native retention, restore and disposal.

The PiAi bridge carries additive developer Tool changes through pi-ai transcript system messages. Route capability is explicit and bound to the prepared model snapshot; unsupported routes use the native DSH compatibility projection. Provider-specific protocol support requires real transport evidence before enablement.

Workspace Project inventory stays shared while deployments may select a separate archive/pin metadata domain. The selected unit starts empty, preserves old shared Session arrays and records recoverable cross-unit changes. Native Workspace streams project the selected metadata and current header-valid membership.

Conversation consumers can register an effect-owned UI event-source adapter around the canonical Session binding. Adapters preserve source identity and monotonic revision; they do not clone bindings, change native transport or alter durable/model-visible history.

## Native V4 scope

The downstream release starts a separate V4 Session generation and excludes pre-upgrade Session data from import and resume. Old files and owned directories remain outside active allocation and deletion. This fork does not retain custom legacy readers, migration-coordinate APIs, SQLite Session conversion or feedback sidecar import. Required execution-directory and title events are understood by the native V4 codec and projections.

## Development and binding

Edit and test in a standalone fork checkout. Preserve the official base ancestry, derive the complete Runtime delta, and publish a reviewed fork commit before downstream adopts it. Downstream binds that commit as a read-only Submodule, installs official packages plus matching fork tarballs, and updates its dependency family, UI composition and declaration snapshots atomically. A package-count target does not determine which behavior to preserve.

## Verification

Focused source tests cover creation and deletion races, native V4 persistence, exact fork cuts and destinations, directory consumers, title state, policy disposal, scoped execution and browser library activation. Native system locks are built and exercised. The PiAi request tests inspect actual local Responses and Completions payloads; they do not establish compatibility with a remote gateway. Host compilation and Runtime bundles are separate checks from downstream Product acceptance.
