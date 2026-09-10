# Agent Note: Submodule startup and restored history

Status: implemented

English | [中文](2026-09-10-submodule-startup-and-restored-history.zh.md)

## Problem

A standard Submodule places `core.worktree` in its common Git configuration. The hook installer rejected this layout. Separately, Session Query validated a continued fork as a new constructor seed, which cannot contain its local continuation. Unsupported historical bodies also prevented otherwise readable headers from appearing in directory listings.

## Decision

The installer moves the existing worktree setting into the main worktree configuration when enabling worktree configuration, retaining its exact value and rolling back on failure. Normal hook installation remains enabled. Temporary Git fixtures cover ordinary and linked checkouts and a Submodule in a linked superproject.

Session Query uses the native `Session.fromRestore` path for its independently owned full log, preserving ancestry, inherited count and local events. Directory discovery may fall back to a readable creation-directory header only for an explicitly unsupported historical-format error; explicit history reads, ordinary I/O errors and conflicting headers still fail normally. The fallback is revision-cached.

Connection RPC registrations acquire the optional Web server through an owned injection scope. Channel names are reserved synchronously, HTTP routes follow server availability, and caller disposal releases both the reservation and route. A consumer needs only the Connection service. Within this injection, scoped lookup preserves caller isolation despite Cordis retaining the service origin for property access. A real WebServer test verifies HTTP dispatch, since a root-level fake does not enforce scoped service reads.

## Alternatives considered

**Disable installation scripts.** This hides an unsupported Git topology and skips unrelated required preparation.

**Change the fork header or truncate history.** This would hide the constructor error by losing lineage or local events.

**Accept unsupported history.** A readable listing does not authorize an unsupported body; its original data remains untouched and direct reads still reject it.

## Consequences

Submodule dependency installation can use normal scripts. Continued live and persisted forks are readable without weakening creation validation. Unsupported old Sessions no longer block listing other Sessions, but opening those histories still requires a supported format. Targeted installer and Session Query tests cover these behaviors.
