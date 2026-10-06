/** Real kernel descriptors plus deterministic filesystem refusals and inode replacement. */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireFileLease, FileLeaseBusyError } from '../src/index.ts'

const faults = vi.hoisted(() => ({ open: false, stat: false, flock: '', swap: 0, drop: false }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs,
    open: (async (path: string, ...args: never[]) => {
      if (faults.open) { faults.open = false; throw Object.assign(new Error('open denied'), { code: 'EACCES' }) }
      return fs.open(path, ...args)
    }) as typeof fs.open,
    stat: (async (path: string, ...args: never[]) => {
      if (faults.stat) { faults.stat = false; throw Object.assign(new Error('stat denied'), { code: 'EACCES' }) }
      if (faults.drop) { faults.drop = false; await fs.unlink(path) }
      else if (faults.swap > 0) { faults.swap--; await fs.unlink(path); await fs.writeFile(path, '') }
      return fs.stat(path, ...args)
    }) as typeof fs.stat,
  }
})
vi.mock('@deepseek-ai/node-addon-system/flock', async (original) => {
  const native = await original<typeof import('@deepseek-ai/node-addon-system/flock')>()
  return { tryLockExclusive: async (fd: number) => {
    if (faults.flock !== '') { const code = faults.flock; faults.flock = ''; throw Object.assign(new Error(code), { code }) }
    return native.tryLockExclusive(fd)
  } }
})
const roots: string[] = []
afterEach(async () => {
  Object.assign(faults, { open: false, stat: false, flock: '', swap: 0, drop: false })
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function path() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-lease-'))
  roots.push(root)
  return join(root, 'resource.lock')
}

it('excludes a live holder, independently locks another path and releases idempotently', async () => {
  const file = await path(), other = await path()
  const first = await acquireFileLease(file), independent = await acquireFileLease(other)
  try {
    await expect(acquireFileLease(file)).rejects.toMatchObject({ name: 'FileLeaseBusyError', path: file })
    await first.release(); await first.release()
    const next = await acquireFileLease(file)
    await next.release()
    if (process.platform !== 'win32') expect(existsSync(file)).toBe(true)
  } finally { await first.release(); await independent.release() }
})
it.skipIf(process.platform === 'win32')('does not create a missing parent directory', async () => {
  await expect(acquireFileLease(join(await path(), 'missing', 'resource.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it.skipIf(process.platform === 'win32').each(['EAGAIN', 'EWOULDBLOCK'])('maps %s without mistaking unrelated refusals for contention', async (code) => {
  const file = await path()
  faults.flock = code
  await expect(acquireFileLease(file)).rejects.toBeInstanceOf(FileLeaseBusyError)
  const lease = await acquireFileLease(file); await lease.release()
})
it.skipIf(process.platform === 'win32')('surfaces filesystem and non-contention kernel failures without retaining the descriptor', async () => {
  const file = await path()
  faults.open = true
  await expect(acquireFileLease(file)).rejects.toMatchObject({ code: 'EACCES' })
  faults.flock = 'EACCES'
  await expect(acquireFileLease(file)).rejects.toMatchObject({ code: 'EACCES' })
  faults.stat = true
  await expect(acquireFileLease(file)).rejects.toMatchObject({ code: 'EACCES' })
  const lease = await acquireFileLease(file); await lease.release()
})
it.skipIf(process.platform === 'win32')('reopens replaced or vanished inodes and refuses permanently unstable paths', async () => {
  const file = await path()
  faults.swap = 1
  const replaced = await acquireFileLease(file); await replaced.release()
  faults.drop = true
  const vanished = await acquireFileLease(file); await vanished.release()
  faults.swap = 3
  await expect(acquireFileLease(file)).rejects.toBeInstanceOf(FileLeaseBusyError)
  const stable = await acquireFileLease(file); await stable.release()
})
