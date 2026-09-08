/** Isolated old-runtime reader: all DSH imports use public exports of one prior installation. */
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

interface LegacyHeader { readonly id: string; readonly delegationDepth?: number; readonly [key: string]: unknown }
interface LegacyInspection { readonly meta: LegacyHeader; readonly events: readonly unknown[] }
interface LegacyContext {
  plugin(plugin: unknown, config?: object): Promise<unknown>
  sessionPersistence: {
    list(): Promise<LegacyHeader[]>
    inspect(id: string): Promise<LegacyInspection>
    create(header: LegacyHeader): Promise<void>
    append(id: string, events: readonly unknown[]): Promise<void>
    appendBatch(header: LegacyHeader, events: readonly unknown[], materialized: boolean): Promise<void>
  }
  fiber: { dispose(): Promise<void> }
}

const parsed: unknown = JSON.parse(process.argv[2] ?? 'null')
if (typeof parsed !== 'object' || parsed === null) throw new Error('Legacy export requires an options record.')
const options = parsed as Record<string, unknown>
for (const key of ['runtimeRoot', 'database', 'sessionRoot', 'reportPath']) {
  if (typeof options[key] !== 'string' || options[key].length === 0) throw new Error(`Legacy export requires ${key}.`)
}
const { runtimeRoot, database, sessionRoot, reportPath } = options as Record<'runtimeRoot' | 'database' | 'sessionRoot' | 'reportPath', string>
const require = createRequire(join(runtimeRoot, 'package.json'))
async function load(name: string): Promise<Record<string, unknown>> {
  const manifest: unknown = require(`${name}/package.json`)
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) throw new Error(`Legacy package ${name} has no version.`)
  if (name.startsWith('@deepseek-ai/dsh-') && manifest.version !== '0.1.1-rc.2') {
    throw new Error(`Legacy export requires the recorded rc2 runtime, got ${name} ${String(manifest.version)}.`)
  }
  const loaded: unknown = await import(pathToFileURL(require.resolve(name)).href)
  if (typeof loaded !== 'object' || loaded === null) throw new Error(`Legacy package ${name} has no module exports.`)
  return loaded as Record<string, unknown>
}
const cordis = await load('@deepseek-ai/cordis')
if (typeof cordis.Context !== 'function') throw new Error('Legacy Cordis has no Context constructor.')
// The version-checked old module intentionally has its own incompatible Service identities.
const Context = cordis.Context as new () => LegacyContext
const session = await load('@deepseek-ai/dsh-session')
if (session.SESSION_EXECUTION_DIRECTORY_VERSION !== 1) {
  throw new Error('Legacy export requires the prior fork reader with execution-directory support.')
}
const { default: Sqlite } = await load('@deepseek-ai/dsh-session-persistence-sqlite')
const { default: Jsonl } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const source = new Context()
const target = new Context()
try {
  await source.plugin(session.default)
  await source.plugin(Sqlite, { path: database, preparedSessionCacheSize: 1 })
  await target.plugin(session.default)
  await target.plugin(Jsonl, { root: sessionRoot, compression: 'none', packChunks: false, preparedSessionCacheSize: 1 })
  await mkdir(sessionRoot, { recursive: true, mode: 0o700 })
  const headers = await source.sessionPersistence.list()
  let events = 0
  let emptySessions = 0
  for (const header of headers.sort((left, right) => left.id.localeCompare(right.id))) {
    const input = await source.sessionPersistence.inspect(header.id)
    // JSONL stores the documented zero default explicitly when SQLite omits it.
    const targetMeta = { ...input.meta, delegationDepth: input.meta.delegationDepth ?? 0 }
    await target.sessionPersistence.create(targetMeta)
    if (input.events.length === 0) {
      // The public backend hook materializes a header without fabricating a Session event.
      await target.sessionPersistence.appendBatch(targetMeta, [], false)
      emptySessions += 1
    } else {
      await target.sessionPersistence.append(input.meta.id, input.events)
    }
    const output = await target.sessionPersistence.inspect(input.meta.id)
    if (!isDeepStrictEqual(targetMeta, output.meta) || !isDeepStrictEqual(input.events, output.events)) {
      const fields = [...new Set([...Object.keys(input.meta), ...Object.keys(output.meta)])]
        .filter(key => !isDeepStrictEqual(input.meta[key], output.meta[key]))
      const event = input.events.findIndex((value, index) => !isDeepStrictEqual(value, output.events[index]))
      throw new Error(`Legacy export verification failed for Session ${header.id}: metadata ${fields.join(', ')}, `
        + `event ${event}, lengths ${input.events.length}/${output.events.length}.`)
    }
    events += input.events.length
  }
  await writeFile(reportPath, JSON.stringify({ sessions: headers.length, events, emptySessions }), { flag: 'wx', mode: 0o600 })
} finally {
  await Promise.all([source.fiber.dispose(), target.fiber.dispose()])
}
