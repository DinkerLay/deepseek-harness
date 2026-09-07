import { globSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeSessionSnapshot } from '@deepseek-ai/dsh-acp-snapshot'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const configPath = fileURLToPath(new URL('../execution-directory.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const expected = fileURLToPath(new URL('./execution-directory.expected.jsonl', import.meta.url))

describe('recorded execution directory through the Loader', () => {
  it('keeps one Session while real file, search and shell tools move into its execution directory', async () => {
    const result = await runLoaderSmoke({
      label: 'recorded execution directory', tempDirPrefix: 'dsh-directory-loader-',
      configPath, binScript, libBinScript: binScript,
      binArgs: [configPath, 'Read the shared baseline and produce a branch artifact.'],
      tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      prepare: cwd => writeFile(join(cwd, 'baseline.txt'), 'shared-baseline'),
      inspect: async (cwd) => {
        const files = globSync('**/session.jsonl', { cwd: join(cwd, '.sessions') })
        expect(files).toHaveLength(1)
        const raw = await readFile(join(cwd, '.sessions', files[0]!), 'utf8')
        const snapshot = normalizeSessionSnapshot(raw, { sessionIds: ['directory-fixture'], cwd })
        if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, snapshot)
        expect(snapshot).toBe(await readFile(expected, 'utf8'))
        expect(await readFile(join(cwd, 'branch/result.txt'), 'utf8')).toBe('branch-result')
        expect(await readFile(join(cwd, 'baseline.txt'), 'utf8')).toBe('shared-baseline')
        await expect(readFile(join(cwd, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        const events = raw.trim().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
        expect(events.filter(event => event.type === 'session/execution-directory')).toHaveLength(1)
        expect(events.filter(event => event.type === 'tool/result').every(event => !event.data.message.content[0].isError)).toBe(true)
      },
    })
    expect(result.stdout).toContain('The file, search and shell tools see the branch result.')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
