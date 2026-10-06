/** Non-blocking path-derived Win32 kernel semaphore; no filesystem handle is held. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

type CreateSemaphoreW = (security: null, initial: number, maximum: number, name: string) => number
type WaitForSingleObject = (handle: number, milliseconds: number) => number
type ReleaseSemaphore = (handle: number, count: number, previous: null) => number
type CloseHandle = (handle: number) => number
type GetLastError = () => number

interface Win32Bindings {
  createSemaphoreW: CreateSemaphoreW
  waitForSingleObject: WaitForSingleObject
  releaseSemaphore: ReleaseSemaphore
  closeHandle: CloseHandle
  getLastError: GetLastError
}

interface Win32ErrnoException extends NodeJS.ErrnoException {
  win32Code: number
  dest: string
}

const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x00000102
const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5
const ERROR_NOT_SAME_DEVICE = 17
const ERROR_SHARING_VIOLATION = 32
const ERROR_FILE_EXISTS = 80
const ERROR_INVALID_NAME = 123
const ERROR_ALREADY_EXISTS = 183

let bindings: Win32Bindings | undefined

/** Load the small Win32 API lazily so non-Windows processes never load Koffi. */
async function win32(): Promise<Win32Bindings> {
  if (bindings !== undefined) return bindings
  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  bindings = {
    createSemaphoreW: kernel32.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']) as CreateSemaphoreW,
    waitForSingleObject: kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']) as WaitForSingleObject,
    releaseSemaphore: kernel32.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']) as ReleaseSemaphore,
    closeHandle: kernel32.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as CloseHandle,
    getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []) as GetLastError,
  }
  return bindings
}

function errnoCode(win32Code: number): string {
  switch (win32Code) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
      return 'ENOENT'
    case ERROR_ACCESS_DENIED:
      return 'EACCES'
    case ERROR_NOT_SAME_DEVICE:
      return 'EXDEV'
    case ERROR_SHARING_VIOLATION:
      return 'EBUSY'
    case ERROR_FILE_EXISTS:
    case ERROR_ALREADY_EXISTS:
      return 'EEXIST'
    case ERROR_INVALID_NAME:
      return 'EINVAL'
    default:
      return 'EIO'
  }
}

function win32Error(syscall: string, win32Code: number, path: string, dest: string): Win32ErrnoException {
  const code = errnoCode(win32Code)
  const error = new Error(`${syscall} ${code} (Win32 ${win32Code}): ${path} -> ${dest}`) as Win32ErrnoException
  error.code = code
  error.errno = win32Code
  error.syscall = syscall
  error.path = path
  error.dest = dest
  error.win32Code = win32Code
  return error
}

/**
 * Acquire a path lock as a named kernel semaphore (count 1) whose
 * name is derived from the canonical lock path. A kernel object never touches
 * the filesystem, so readers, searches, and directory removal proceed freely
 * while the lock is held; a second acquirer's zero-timeout wait times out
 * (`EBUSY`); and when the last handle closes — including on any process
 * death — the object is destroyed, so a successor's create starts fresh.
 * @param path - the lock file path the name is derived from (case-folded:
 *   Windows paths are case-insensitive).
 * @returns the open semaphore handle, released via {@link releaseLockHandleWin32}.
 */
export async function acquireLockHandleWin32(path: string): Promise<number> {
  const api = await win32()
  const name = `Local\\dsh-session-lock-${createHash('sha256').update(resolve(path).toLowerCase()).digest('hex')}`
  const handle = api.createSemaphoreW(null, 1, 1, name)
  if (handle === 0) throw win32Error('CreateSemaphoreW', api.getLastError(), path, name)
  const wait = api.waitForSingleObject(handle, 0)
  if (wait === WAIT_OBJECT_0) return handle
  api.closeHandle(handle)
  if (wait === WAIT_TIMEOUT) throw win32Error('WaitForSingleObject', ERROR_SHARING_VIOLATION, path, name)
  throw win32Error('WaitForSingleObject', api.getLastError(), path, name)
}

/**
 * Release a lock from {@link acquireLockHandleWin32}: restore the semaphore
 * count and close the handle (the object dies with its last handle).
 * @param handle - the open semaphore handle.
 */
export async function releaseLockHandleWin32(handle: number): Promise<void> {
  const api = await win32()
  const released = api.releaseSemaphore(handle, 1, null)
  const closed = api.closeHandle(handle)
  if (released === 0 || closed === 0) throw win32Error('ReleaseSemaphore', api.getLastError(), `handle:${handle}`, `handle:${handle}`)
}
