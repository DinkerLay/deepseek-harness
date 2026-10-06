---
description: "Non-blocking kernel ownership for Session writers and managed Git-resource operations."
kind: "package-library"
---

# @deepseek-ai/dsh-util-file-lease

English | [中文](README.zh.md)

## Summary

Use this library to exclude other processes while a caller holds a lock path. `acquireFileLease` returns a lease or reports immediate contention; `release` closes its kernel descriptor or handle without removing a POSIX lock file. Session persistence and managed Git resources retain their own directory, identity, operation and recovery rules. No PID record, stale timeout or live-holder takeover participates in ownership.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The caller supplies a lock path distinct from its data and ensures that the parent directory exists with suitable ownership and permissions. Import the library directly; it is not a Cordis plugin.

```text
import { acquireFileLease } from '@deepseek-ai/dsh-util-file-lease'

const lease = await acquireFileLease(lockPath)
try {
  await updateOwnedResource()
} finally {
  await lease.release()
}
```

`FileLeaseBusyError.path` identifies contention or an unstable lock inode. Other filesystem or kernel failures retain their original diagnostic. Release is idempotent and never removes the POSIX lock file. Readers do not take a lease.

Session persistence creates its private artifact directory and translates contention to its Session-specific error. Git resources acquire leases only on their own registered operation paths; neither consumer gains permission to delete or adopt an arbitrary directory.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

POSIX uses non-blocking native `flock`, then compares the descriptor's inode and device with the lock path. Replacement or disappearance retries against the current path up to three times. Windows uses a zero-timeout named kernel semaphore without a filesystem handle. Its existing `Local\\dsh-session-lock-` path-hash namespace remains unchanged so existing Session holders and this shared implementation contend against the same object.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Public lease and busy-error interface |
| [`src/win32.ts`](src/win32.ts) | Internal semaphore bindings and error translation |

No runtime invariant companion is published because the library owns no event stream or independent runtime projection; kernel contention and path verification are enforced at acquisition and in process tests.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session persistence](../../session/session-persistence-jsonl/README.md) — lazy materialization and Session ownership.
- [Native system support](../../../native/system/README.md) — asynchronous POSIX flock.

<a id="model-experience"></a>
## Model Experience

### Kernel ownership

#### What the model sees

`acquireFileLease` and `FileLease.release` register no tools, prompts or model-visible messages; their consumers own any rendered diagnostic.

#### Token effect

Kernel ownership adds no request content or tokens.

#### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Leases are cooperative, not a sandbox. Unlinking a live POSIX lock path forfeits exclusion; callers must keep its inode and ownership stable.
- Advisory flock is unreliable on some network filesystems. The Windows semaphore namespace is local to one login session.
- POSIX requires the matching system addon. Native Windows behavior requires its Windows lane; injected bindings on another host do not establish native-platform evidence.
- A live wedged holder remains owner until it releases or exits. This library does not time out, inspect PIDs, clean resources or retry a consumer's operation.

<a id="dev-note"></a>
### Dev Note

None.
