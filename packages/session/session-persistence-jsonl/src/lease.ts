/** Session artifact ownership over the shared non-blocking kernel lease. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireFileLease, FileLeaseBusyError } from '@deepseek-ai/dsh-util-file-lease'
import type { FileLease } from '@deepseek-ai/dsh-util-file-lease'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Base name of the kernel lock path inside a materializing Session directory. */
export const LEASE_FILENAME = 'session.lock'

/** One Session writer's ownership, retained for its write handle lifetime. */
export class SessionWriteLease {
  private constructor(private readonly lease: FileLease) {}

  /**
   * Acquire Session ownership, creating its private artifact directory if absent.
   * @param dir - Session artifact directory, created with owner-only permissions.
   * @param id - Session identity used for ownership errors.
   * @returns the held kernel lease; release never removes its POSIX lock file.
   * @throws {SessionAlreadyOwnedError} on contention or an unstable lock inode.
   */
  static async acquire(dir: string, id: SessionId): Promise<SessionWriteLease> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try { return new SessionWriteLease(await acquireFileLease(join(dir, LEASE_FILENAME))) }
    catch (error: unknown) {
      if (error instanceof FileLeaseBusyError) throw new SessionAlreadyOwnedError(id)
      throw error
    }
  }

  /** Close the kernel lease once, retaining the stable POSIX lock inode. */
  release(): Promise<void> { return this.lease.release() }
}
