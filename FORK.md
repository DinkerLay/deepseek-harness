# Maintained fork delta

English | [中文](FORK.zh.md)

This repository branch is the DSH Runtime fork used by SuperCode. [`fork-manifest.json`](fork-manifest.json) is the machine-readable inventory; this document explains its ownership and update rules. The fork is based on official `dsh-v0.1.2-rc.1` at `a66e4702047846cdaa10c66c9d3df3951f5ea70d`.

## Bundle and package inventory

The fork adds **no DSH bundle** and does not change any package under `packages/bundle/`. Product composition remains in SuperCode's `@ainvest-team/supercode-*` packages and closed `supercode-web` patch.

The fork adds two generic DSH packages:

| Package | Responsibility |
|---|---|
| [`@deepseek-ai/dsh-session-deletion`](packages/session/session-deletion/README.md) | Host-only recursive deletion of a Session lineage across live state, persistence, projections, query indexes, workspaces, and sidecars. |
| [`@deepseek-ai/dsh-shell-exec-env`](packages/shell/shell-exec-env/README.md) | Optional registry for trusted, non-model environment values resolved immediately before Bash or Pwsh execution. |

The Session-deletion capability modifies these official packages: `dsh-agent`, `dsh-agent-loop`, `dsh-session`, `dsh-session-persistence`, the JSONL persistence provider, `dsh-session-projection-cache`, `dsh-session-query-sqlite`, `dsh-workspace`, `dsh-message-feedback`, `dsh-api-session-controller`, and `dsh-tool-cordis`. Together they reserve live Agents, discover a complete Session lineage, delete durable records, and remove derived state without simulating deletion in Product code.

The trusted shell-execution capability modifies `dsh-tool-bash` and `dsh-tool-pwsh`. Both Consumers optionally collect the new registry immediately before foreground or background process creation; Product-specific authentication remains outside this fork.

[`fork-manifest.json`](fork-manifest.json) is the exact inventory of every modified package, changed production source file, and `runtimePatchPackages` entry that a downstream Runtime must override together. Generated docs, tests, translation records, and repository scripts are not Runtime packages and therefore are not repeated in that list.

Gateway invocation policies and Connection channel authority preserve generic admission boundaries. `dsh-client-modules` accepts explicit `libraryPackages`, exposing public browser exports while leaving their default plugins inactive; its Host and Client wire must be overridden together.

## Ownership boundary

This fork contains reusable DSH capabilities and missing extension points only. It does not contain SuperCode UI, AIME authentication, Product policy, Product bundles, or `@ainvest-team/*` code. An external Product plugin may consume the published APIs, but DSH must not import that plugin.

Use the standalone maintenance checkout for DSH changes:

```sh
git clone --branch codex/supercode-rc1-runtime https://github.com/DinkerLay/deepseek-harness.git
cd deepseek-harness
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
```

The checked-out SuperCode Submodule is read-only. Develop changes in this standalone fork, run the DSH checks here, publish the fork commit, and then move SuperCode's Submodule commit, `upstream.json` fork binding, Runtime package overrides, and architecture documents together.

## Updating the fork

1. Move the upstream base deliberately and review `git diff <upstream-commit>...HEAD`.
2. Reconcile each fork change against the new official implementation; remove a fork delta when upstream supplies the complete behavior.
3. Update `fork-manifest.json` whenever an added or modified production package changes. `runtimePatchPackages` is the exact union of the added and modified Runtime packages.
4. Keep package READMEs, subsystem references, bilingual Agent Notes, tests, and generated catalogs aligned with the code.
5. In SuperCode, require its `upstream.json.runtimePatchPackages` to match this manifest before accepting the new commit.

The authoritative exhaustive file diff remains Git. The manifest classifies that diff at package and Runtime-assembly level so downstream updates do not rely on commit-message archaeology.

## Session execution coordination

The fork also exposes exact fork destinations, effect-owned Agent provisioning, sandbox policy constraints, per-message child attribution and branch-local automatic naming. Git ownership and ChatFlow policy remain in Product plugins.

Recorded Session execution directories separate physical execution from immutable creation cwd. The [execution-directory decision](.agents/notes/implemented/architecture/2026-09-07-session-execution-directory.md) defines the public event and resolver; Product owns lazy worktree allocation and reclamation.
