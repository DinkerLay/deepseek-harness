# Maintaining the fork delta

English | [中文](FORK.zh.md)

This branch is the DSH Runtime fork used by SuperCode. It is based on official `dsh-v0.1.5-rc.1` at `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`. Every Runtime package in this candidate, including the fork-only packages, has version `0.1.5-rc.1`.

[`fork-manifest.json`](fork-manifest.json) is the machine-readable inventory of packages whose production source or package manifest differs from that official commit. Its `runtimePatchPackages` array is the exact override set a downstream Runtime must install together.

## Package and bundle inventory

This fork adds no DSH bundle and does not modify a package under `packages/bundle/`. Product composition remains outside this repository.

It adds two general DSH packages:

| Package | Responsibility |
|---|---|
| [`@deepseek-ai/dsh-session-deletion`](packages/session/session-deletion/README.md) | Host-only recursive Session-family deletion across live state, persistence, projections, indexes, workspaces, and registered derived state. |
| [`@deepseek-ai/dsh-shell-exec-env`](packages/shell/shell-exec-env/README.md) | Optional trusted environment registry collected immediately before Bash or PowerShell process creation. |

The manifest contains 43 modified packages and these 2 added packages. Generated documentation, tests, translation records, repository scripts, and build output are part of the reviewed Git diff but are not Runtime package overrides.

## Native foundations

The fork keeps the official 0.1.5 mechanisms as the authority for their domains:

| Domain | Native mechanism |
|---|---|
| Session restore | Version-three logs, `SessionFormatRestore`, migration coordinates, persistence handles, and publication checks. |
| Agent lifecycle | Asynchronous `ctx.agents.create`, inherited prefixes, native Activation ownership, and native continuation scheduling. |
| Session discovery | `SessionQuery`, live and cold Session records, SQLite indexing, and the native API workspace-file service. |
| Browser modules | The public Client module registry and generated Remote artifacts. Library exports load only when a composition declares `libraryPackages`; declaring a library never activates its default plugin. |
| Network routing | Native outbound proxy selection and dispatchers. DNS fallback applies the same policy independently to its HTTPS resolver request. |

This branch extends those mechanisms through public package APIs. It does not copy their internal implementations into an adapter.

## Retained general capabilities

The fork retains only reusable Runtime capabilities that remain absent from the official release:

- Session deletion reserves live ownership, discovers complete descendant families, deletes provider records, and invalidates derived state after the persistence commit.
- Recorded execution directories leave `SessionHeader.cwd` as immutable creation and storage identity. Public resolvers and query records expose the effective directory to file, hook, skill, LSP, subagent, workspace-file, summary, and open-in-app consumers.
- Exact recoverable forks preserve the requested destination. Subagent continuation uses native lifecycle ownership while retaining per-message parent Turn attribution and deployment-controlled quiet parent delivery.
- Gateway invocation policy and per-channel loopback authority provide generic admission boundaries. Client public-library loading remains conditional on an explicit composition declaration.
- Sandbox policy applies deployment access ceilings to resolved execution policy. Bash and PowerShell optionally collect trusted environment values outside model-visible tool input.
- Historical Session restore preserves admitted delegation fields and exact migration coordinates. Coordinate source revisions use copy-stable predecessor content identity. The JSONL exporter reads released SQLite Sessions without modifying the source database and reconstructs only provable rc2 chunk provenance in the new artifact.
- Message feedback writes canonical Session events and reads released version-zero sidecar rows through a strict, bounded, read-only compatibility layer. Canonical puts and deletes take precedence, including after restart. The [sidecar read-through decision](.agents/notes/implemented/bug-fix/2026-09-10-message-feedback-sidecar-read-through.md) owns that contract.
- DIRECT HTTP fetches can recover from reserved Fake-IP DNS answers through configured HTTPS DNS. Resolver traffic follows native routing policy; direct resolution uses a pinned public bootstrap, proxied resolution uses the native dispatcher, and origin connections accept only validated public addresses.
- Automatic Session titles keep branch ownership and durable generation state while the LLM title provider retains exact excerpt and token limits.

The [execution-directory decision](.agents/notes/implemented/architecture/2026-09-07-session-execution-directory.md) owns the physical-directory contract. Other retained contracts remain linked from their package references and active Agent Notes.

## Ownership boundary

This fork contains general DSH capabilities and public extension points. It contains no SuperCode UI, authentication, Product policy, Product bundle, or `@ainvest-team/*` import. External Product plugins consume published DSH APIs; DSH does not import them.

The checked-out SuperCode Submodule is read-only. Develop DSH changes in a standalone fork checkout, run the DSH checks there, publish the reviewed fork commit, then move SuperCode's Submodule binding, Runtime override list, package versions, and architecture records together.

## Updating the fork

1. Move the official base deliberately and compare the candidate with the exact official commit.
2. Reconcile every retained capability with the new native implementation. Remove a fork delta when native behavior satisfies the complete contract.
3. Recompute `fork-manifest.json` from production `src/**` and `package.json` differences. `runtimePatchPackages` is the sorted union of added and modified Runtime packages.
4. Keep package references, subsystem references, English and Chinese Agent Notes, tests, and generated catalogs aligned with production source.
5. Require the downstream Runtime override set to match the manifest before accepting the fork commit.

Git is the exhaustive file-level record. The manifest classifies the Runtime packages that must remain atomic for downstream assembly.
