/** Win32 semaphore decisions use injected kernel bindings; native Windows remains a separate lane. */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.doUnmock('koffi'); vi.resetModules() })

async function importWithLock(bindings: {
  createSemaphoreW?: (name: string, initial: number, maximum: number) => number
  waitResult?: number
  releaseSemaphore?: (handle: number) => number
  closeHandle?: (handle: number) => number
  lastError?: number
}): Promise<typeof import('../src/win32.ts')> {
  vi.resetModules()
  vi.doMock('koffi', () => ({
    default: {
      load: () => ({
        func: (_convention: string, name: string) => {
          if (name === 'CreateSemaphoreW') {
            return (_security: null, initial: number, maximum: number, semName: string) =>
              (bindings.createSemaphoreW ?? (() => 7))(semName, initial, maximum)
          }
          if (name === 'WaitForSingleObject') return () => bindings.waitResult ?? 0
          if (name === 'ReleaseSemaphore') return bindings.releaseSemaphore ?? (() => 1)
          if (name === 'CloseHandle') return bindings.closeHandle ?? (() => 1)
          if (name === 'MoveFileExW') return () => 1
          return () => bindings.lastError ?? 0 // GetLastError
        },
      }),
    },
  }))
  return import('../src/win32.ts')
}

describe('Windows write-lock semaphore', () => {
  it.each([[2, 'ENOENT'], [3, 'ENOENT'], [5, 'EACCES'], [17, 'EXDEV'], [32, 'EBUSY'], [80, 'EEXIST'], [123, 'EINVAL'], [183, 'EEXIST'], [999, 'EIO']] as const)
  ('retains the Win32 error mapping for code %s', async (lastError, code) => {
    const helper = await importWithLock({ createSemaphoreW: () => 0, lastError })
    await expect(helper.acquireLockHandleWin32('C:\\resource\\held.lock')).rejects.toMatchObject({ code, win32Code: lastError })
  })
  it('acquires a path-derived named semaphore with a zero-timeout wait', async () => {
    const created: Array<{ name: string; initial: number; maximum: number }> = []
    const { acquireLockHandleWin32 } = await importWithLock({
      createSemaphoreW: (name, initial, maximum) => {
        created.push({ name, initial, maximum })
        return 7
      },
    })
    await expect(acquireLockHandleWin32('C:\\s\\session.lock')).resolves.toBe(7)
    expect(created).toHaveLength(1)
    // Count-1 semaphore in the login-session namespace, named by path hash:
    // no filesystem footprint, and case-insensitive like Windows paths.
    expect(created[0]).toMatchObject({ initial: 1, maximum: 1 })
    expect(created[0]?.name).toMatch(/^Local\\dsh-session-lock-[0-9a-f]{64}$/)
    const upper = await importWithLock({ createSemaphoreW: (name) => { created.push({ name, initial: 1, maximum: 1 }); return 7 } })
    await upper.acquireLockHandleWin32('C:\\S\\SESSION.LOCK')
    expect(created[1]?.name).toBe(created[0]?.name)
  })

  it('maps a held semaphore (wait timeout) to EBUSY and closes the probe handle', async () => {
    const closed: number[] = []
    const { acquireLockHandleWin32 } = await importWithLock({
      waitResult: 0x102,
      closeHandle: (handle) => { closed.push(handle); return 1 },
    })
    await expect(acquireLockHandleWin32('C:\\s\\session.lock')).rejects.toMatchObject({ code: 'EBUSY' })
    expect(closed).toEqual([7])
  })

  it('surfaces create and wait failures with Win32 codes', async () => {
    const createFailed = await importWithLock({ createSemaphoreW: () => 0, lastError: 5 })
    await expect(createFailed.acquireLockHandleWin32('C:\\s\\session.lock')).rejects.toMatchObject({ code: 'EACCES', win32Code: 5 })
    const waitFailed = await importWithLock({ waitResult: 0xffffffff, lastError: 5 })
    await expect(waitFailed.acquireLockHandleWin32('C:\\s\\session.lock')).rejects.toMatchObject({ code: 'EACCES', win32Code: 5 })
  })

  it('releases by restoring the count and closing, surfacing a failed release', async () => {
    const order: string[] = []
    const working = await importWithLock({
      releaseSemaphore: (handle) => { order.push(`release:${handle}`); return 1 },
      closeHandle: (handle) => { order.push(`close:${handle}`); return 1 },
    })
    await expect(working.acquireLockHandleWin32('C:\\resource\\release.lock')).resolves.toBe(7)
    await working.releaseLockHandleWin32(7)
    expect(order).toEqual(['release:7', 'close:7'])
    const failing = await importWithLock({ releaseSemaphore: () => 0, lastError: 5 })
    await expect(failing.releaseLockHandleWin32(9)).rejects.toMatchObject({ code: 'EACCES', win32Code: 5 })
    const closeFailed = await importWithLock({ closeHandle: () => 0, lastError: 5 })
    await expect(closeFailed.releaseLockHandleWin32(9)).rejects.toMatchObject({ code: 'EACCES', win32Code: 5 })
  })
})
