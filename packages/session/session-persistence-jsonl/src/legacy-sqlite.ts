/** Export a legacy SQLite corpus through its own pinned DSH reader into portable JSONL. */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

/** An offline conversion leaves the original database and any existing destination untouched. */
export interface LegacySqliteExportOptions {
  /** Installed prior fork runtime containing the published Cordis and persistence package APIs. */
  readonly runtimeRoot: string
  /** Existing SQLite Session database; the converter reads a consistent backup, not this file directly. */
  readonly database: string
  /** New destination directory; an existing directory is never reused or overwritten. */
  readonly destination: string
  /** Cancellation waits for backup or child-process completion before releasing resources. */
  readonly signal?: AbortSignal
}

/** Verified corpus counts and the JSONL root to configure in the upgraded runtime. */
export interface LegacySqliteExportResult {
  readonly sessionRoot: string
  readonly sessions: number
  readonly events: number
  readonly emptySessions: number
}

/** Await process close even when cancellation first reports an AbortError. */
async function runLegacyReader(worker: string, options: object, signal?: AbortSignal): Promise<void> {
  const child = spawn(process.execPath, [worker, JSON.stringify(options)], {
    stdio: ['ignore', 'ignore', 'pipe'],
    ...(signal === undefined ? {} : { signal }),
  })
  let failure: Error | undefined
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    if (Buffer.byteLength(stderr) + chunk.byteLength > 1024 * 1024) {
      failure ??= new Error('Legacy reader exceeded its diagnostic output bound.')
      child.kill()
    } else stderr += chunk.toString('utf8')
  })
  await new Promise<void>((resolve, reject) => {
    child.once('error', (error) => { failure = error })
    child.once('close', (code, stoppedBy) => {
      if (failure !== undefined) reject(failure)
      else if (code !== 0) reject(new Error(`Legacy reader exited with ${String(code ?? stoppedBy)}: ${stderr.trim()}`))
      else resolve()
    })
  })
}

/**
 * Convert a schema supported by the recorded rc2 fork without reviving a SQLite runtime provider.
 * The prior runtime executes in a separate process, so old and current Service identities never mix.
 * Source WAL content is included through SQLite backup; failure never deletes the source database.
 * @param options - prior runtime, source database, new output directory and optional cancellation.
 * @returns verified corpus counts and the new Session root.
 * @throws when the prior runtime is incompatible, source data cannot be read, or output is occupied.
 */
export async function exportLegacySqlite(options: LegacySqliteExportOptions): Promise<LegacySqliteExportResult> {
  options.signal?.throwIfAborted()
  const destination = resolve(options.destination)
  await mkdir(dirname(destination), { recursive: true })
  await mkdir(destination, { mode: 0o700 })
  let staging: string | undefined
  let published = false
  try {
    staging = await mkdtemp(join(dirname(destination), '.dsh-sqlite-export-'))
    const backupPath = join(staging, 'source.sqlite')
    await writeFile(backupPath, '', { flag: 'wx', mode: 0o600 })
    const { DatabaseSync, backup } = await import('node:sqlite')
    const source = new DatabaseSync(resolve(options.database), { readOnly: true })
    try {
      await backup(source, backupPath)
    } finally {
      source.close()
    }
    options.signal?.throwIfAborted()
    const require = createRequire(import.meta.url)
    const packageRoot = dirname(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl/package.json'))
    const worker = join(packageRoot, 'lib', 'types', 'legacy-sqlite-worker.js')
    const sessionRoot = join(staging, 'sessions')
    const reportPath = join(staging, 'report.json')
    await runLegacyReader(worker, {
      runtimeRoot: resolve(options.runtimeRoot), database: backupPath, sessionRoot, reportPath,
    }, options.signal)
    const report: unknown = JSON.parse(await readFile(reportPath, 'utf8'))
    if (typeof report !== 'object' || report === null || !('sessions' in report) || !('events' in report) || !('emptySessions' in report)) {
      throw new Error('Legacy SQLite reader returned no valid export report.')
    }
    const { sessions, events, emptySessions } = report
    if (![sessions, events, emptySessions].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      || (emptySessions as number) > (sessions as number)) {
      throw new Error('Legacy SQLite reader returned invalid corpus counts.')
    }
    options.signal?.throwIfAborted()
    await rename(sessionRoot, join(destination, 'sessions'))
    published = true
    const result: LegacySqliteExportResult = {
      sessionRoot: join(destination, 'sessions'), sessions: sessions as number,
      events: events as number, emptySessions: emptySessions as number,
    }
    await writeFile(join(destination, 'migration.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return result
  } finally {
    if (staging !== undefined) await rm(staging, { recursive: true, force: true })
    if (!published) {
      try { await rmdir(destination) } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
  }
}
