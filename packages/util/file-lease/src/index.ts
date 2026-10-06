/** Kernel ownership of a caller-selected lock path, without directory or stale-owner policy. */
import { open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { acquireLockHandleWin32, releaseLockHandleWin32 } from './win32.ts'

/** One held kernel lock; readers do not acquire it. */
export interface FileLease {
  /** Close the held descriptor or kernel handle once; never unlink the lock path. */
  release(): Promise<void>
}

/** Another holder or an unstable lock inode prevents confirmed ownership. */
export class FileLeaseBusyError extends Error {
  override readonly name = 'FileLeaseBusyError'
  /** @param path - caller-selected lock path whose ownership could not be acquired. */
  constructor(readonly path: string) { super(`kernel lease is busy or its lock path is unstable: ${path}`) }
}

type HeldLock =
  | { readonly kind: 'posix'; readonly handle: FileHandle }
  | { readonly kind: 'win32'; readonly handle: number }

class HeldFileLease implements FileLease {
  private released = false
  constructor(private readonly held: HeldLock) {}
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    /* v8 ignore start -- native Windows coverage exercises this platform branch; Linux covers the POSIX peer */
    if (this.held.kind === 'win32') {
      await releaseLockHandleWin32(this.held.handle)
      return
    }
    /* v8 ignore stop */
    await this.held.handle.close()
  }
}

function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

/**
 * Acquire a non-blocking kernel lease. The caller owns the existing parent directory.
 * POSIX verifies the locked inode against the current path and retries replacement three times;
 * Windows uses the existing path-derived, login-session kernel semaphore namespace.
 * @param path - lock path, distinct from the data it protects; POSIX may create its empty file.
 * @returns ownership retained until release or process death; no directory or lock file is removed.
 * @throws {FileLeaseBusyError} on contention or when the lock path does not stabilize.
 */
export async function acquireFileLease(path: string): Promise<FileLease> {
  /* v8 ignore start -- native Windows coverage exercises this platform branch; Linux covers the POSIX peer */
  if (process.platform === 'win32') {
    try {
      return new HeldFileLease({ kind: 'win32', handle: await acquireLockHandleWin32(path) })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EBUSY') throw new FileLeaseBusyError(path)
      throw error
    }
  }
  /* v8 ignore stop */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await open(path, 'w')
    try {
      try { await tryLockExclusive(handle.fd) }
      catch (error: unknown) {
        if (isLockContention(error)) throw new FileLeaseBusyError(path)
        throw error
      }
      const held = await handle.stat({ bigint: true })
      const current = await stat(path, { bigint: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
        throw error
      })
      if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
        return new HeldFileLease({ kind: 'posix', handle })
      }
    } catch (error: unknown) {
      await handle.close()
      throw error
    }
    await handle.close()
  }
  throw new FileLeaseBusyError(path)
}
