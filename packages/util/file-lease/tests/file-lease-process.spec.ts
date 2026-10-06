/** Published utility exclusion across real Node processes, including ungraceful holder exit. */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { acquireFileLease, FileLeaseBusyError } from '../src/index.ts'

const holderPath = fileURLToPath(new URL('./fixtures/lease-holder.mjs', import.meta.url))
it.each(['release', 'crash'] as const)('excludes an independent holder until its %s, then acquires immediately', { timeout: 30_000 }, async (ending) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-lease-process-'))
  const owned: { process?: ChildProcessWithoutNullStreams; settled?: Promise<unknown> } = {}
  onTestFinished(async () => {
    if (owned.process?.exitCode === null && owned.process.signalCode === null) owned.process.kill('SIGKILL')
    await owned.settled
    await rm(root, { recursive: true, force: true })
  })
  const path = join(root, 'resource.lock')
  const holder = owned.process = spawn(process.execPath, [holderPath, path], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  })
  const ready = Promise.withResolvers<undefined>()
  let output = '', errors = '', holding = false
  holder.stdout.on('data', (chunk) => {
    output += String(chunk)
    if (output.includes('holding\n')) { holding = true; ready.resolve(undefined) }
  })
  holder.stderr.on('data', (chunk) => { errors += String(chunk) })
  holder.once('error', (error) => { ready.reject(error) })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    holder.once('close', (code, signal) => {
      if (!holding) ready.reject(new Error(`lease holder exited before acquisition: ${errors}`))
      resolve({ code, signal })
    })
  })
  owned.settled = exited
  await ready.promise
  await expect(acquireFileLease(path)).rejects.toBeInstanceOf(FileLeaseBusyError)
  const independent = await acquireFileLease(join(root, 'independent.lock'))
  await independent.release()
  if (ending === 'release') holder.stdin.end('release\n')
  else expect(holder.kill('SIGKILL')).toBe(true)
  const ended = await exited
  if (ending === 'release') { expect(ended).toEqual({ code: 0, signal: null }); expect(output).toContain('released\n') }
  else {
    expect(output).not.toContain('released\n')
    if (process.platform !== 'win32') expect(ended).toEqual({ code: null, signal: 'SIGKILL' })
    else expect(ended.signal === 'SIGKILL' || ended.code !== null && ended.code !== 0).toBe(true)
  }
  const successor = await acquireFileLease(path)
  await successor.release()
})
