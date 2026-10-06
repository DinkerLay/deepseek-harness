/** Real Loader, local Git, JSON domain storage and Workspace registry in one private fixture. */
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SessionStore from '@deepseek-ai/dsh-session'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { onTestFinished } from 'vitest'
import GitResources from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** Boot the actual production plugin rows through cordis.yml, with no model or fake resource peer. */
export async function harness(config: Config = {}, shared?: { root: string; contexts: Context[] }, ownerEnabled = true) {
  const resources = shared ?? { root: await mkdtemp(join(tmpdir(), 'dsh-git-resources-')), contexts: [] }
  const ctx = new Context(); resources.contexts.push(ctx)
  if (shared === undefined) onTestFinished(async () => {
    for (const context of resources.contexts.toReversed()) await context.fiber.dispose()
    await rm(resources.root, { recursive: true, force: true })
  })
  const root = resources.root, project = join(root, 'project'), home = join(root, 'home')
  await mkdir(project, { recursive: true, mode: 0o700 }); await mkdir(join(root, 'git-home'), { recursive: true, mode: 0o700 })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, object>([['storage', Storage], ['domain', Domain], ['json', JsonStorage],
    ['subprocess', Subprocess], ['sessions', SessionStore], ['persistence', Persistence],
    ['workspace', WorkspaceRegistry], ['git-resources', GitResources]])
  const internal: ModuleLoaderV2 = { version: 'v2', loadCache: new Map(), import: async (name: string) => {
    const module = modules.get(name)
    if (module === undefined) throw new Error(`unknown fixture module ${name}`)
    return module
  }, register(): never { throw new Error('fixture does not register module hooks') },
  getOrCreateModuleJob(): never { throw new Error('fixture does not create module jobs') },
  resolveSync(): never { throw new Error('fixture does not resolve module jobs') },
  load(): never { throw new Error('fixture does not run load hooks') } }
  ctx.loader.internal = internal
  const configPath = join(root, `cordis-${resources.contexts.length}.yml`)
  await writeFile(configPath, JSON.stringify([{ name: 'storage' }, { name: 'json', config: { root: join(home, 'domains') } },
    { name: 'domain', config: { backend: 'json' } }, { name: 'sessions' },
    { name: 'persistence', config: { root: join(home, 'sessions'), compression: 'none' } },
    { name: 'workspace' }, { name: 'subprocess' }, { name: 'git-resources', disabled: !ownerEnabled,
      config: Object.assign({ home }, config) }]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const workspace = await ctx.workspaceRegistry.create(project)
  const git = (args: readonly string[], input?: string | Buffer) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args], {
      cwd: project, input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(root, 'git-home'),
        USERPROFILE: join(root, 'git-home'), XDG_CONFIG_HOME: join(root, 'git-home'), GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(root, 'git-home', 'missing-config'), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0',
        GIT_AUTHOR_NAME: 'Resource fixture', GIT_AUTHOR_EMAIL: 'fixture@dsh.invalid', GIT_COMMITTER_NAME: 'Resource fixture',
        GIT_COMMITTER_EMAIL: 'fixture@dsh.invalid', LC_ALL: 'C' } })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr}`)
    return result.stdout.trimEnd()
  }
  return { ctx, root, home, project, workspace, git, resources }
}

/** Seed only this fixture's declared local repository and preserve its known initial commit. */
export async function repository(test: Awaited<ReturnType<typeof harness>>) {
  test.git(['init', '--quiet'])
  await writeFile(join(test.project, 'file.txt'), 'BASE\n')
  await writeFile(join(test.project, 'removed.txt'), 'Remove this deliberately\n')
  test.git(['add', '--', 'file.txt', 'removed.txt'])
  test.git(['commit', '--quiet', '-m', 'initial fixture baseline'])
  return test.git(['rev-parse', 'HEAD'])
}
