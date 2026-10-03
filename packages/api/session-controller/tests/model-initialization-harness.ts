/** Real Loader, AgentLoop, Session Controller and JSONL fixture for execution initialization. */

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import Commands from '@deepseek-ai/dsh-commands'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import Registry from '@deepseek-ai/dsh-typert-registry'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { onTestFinished } from 'vitest'
import SessionController from '../src/index.ts'

class InitializationQuery extends SessionQuery {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('initializer fixture does not search')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('initializer fixture does not search')) }
}

/** Deterministic provider resolution barriers and real-loop request observations. */
export class InitializationAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly resolutions: string[] = []
  readonly nonReasoningModels = new Set<string>()
  private readonly held = new Map<string, {
    entered: ReturnType<typeof Promise.withResolvers<undefined>>
    released: ReturnType<typeof Promise.withResolvers<undefined>>
  }>()

  /** Hold one provider metadata resolution until the test releases it.
   * @param model - instance-local model id whose first resolution is held.
   * @returns the entry signal and idempotent release operation.
   */
  hold(model: string): { entered: Promise<void>; release(): void } {
    const barrier = { entered: Promise.withResolvers<undefined>(), released: Promise.withResolvers<undefined>() }
    this.held.set(model, barrier)
    return { entered: barrier.entered.promise, release: () => { barrier.released.resolve(undefined) } }
  }

  /** Release provider work before the owning fixture disposes its runtime. */
  releaseAll(): void { for (const barrier of this.held.values()) barrier.released.resolve(undefined) }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider: 'initialization', id: 'default', name: 'Default' }])
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.resolutions.push(model)
    const barrier = this.held.get(model)
    if (barrier !== undefined) { barrier.entered.resolve(undefined); await barrier.released.promise }
    if (this.nonReasoningModels.has(model)) return { provider, id: model, name: model }
    return { provider, id: model, name: model, reasoning: {
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high'),
    } }
  }

  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Initialized execution completed' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Boot the actual source providers through a test-only Cordis file, with only the model adapter substituted.
 * @param existingRoot - existing fixture-owned home for a cold runtime, or omitted for a new private root.
 * @returns the entered Controller, real registries and persistence, and the provider boundary.
 */
export async function initializationHarness(existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'dsh-model-initialization-'))
  const ctx = new Context()
  const adapter = new InitializationAdapter()
  onTestFinished(async () => {
    adapter.releaseAll()
    await ctx.fiber.dispose()
    if (existingRoot === undefined) await rm(root, { recursive: true, force: true })
  })
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Loader)
  const modelBoundary = { name: 'initialization-model', inject: ['llm'], apply(scope: Context) {
    scope.effect(() => scope.llm.registerAdapter(['initialization'], adapter))
  } }
  Object.assign(ctx.loader.builtins, { include: Include, modelBoundary, agentLoop: AgentLoop,
    persistence: JsonlPersistence, query: InitializationQuery, filesystem: FsLocal, storage: Storage,
    storageJson: StorageJson, storageDomain: StorageDomain, workspace: WorkspaceRegistry, attachment: AttachmentLocal,
    credentials: CredentialsLocal, connection: Connection, commands: Commands, upload: FileUploads,
    registry: Registry, defaultModel: AgentDefaultModel, title: SessionTitle, controller: SessionController })
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const path = join(root, 'cordis-initialization.json')
  await writeFile(path, JSON.stringify([
    { name: 'cordis:modelBoundary' },
    { name: 'cordis:filesystem', config: { cwd: root } },
    { name: 'cordis:storage' },
    { name: 'cordis:storageJson', config: { root: join(home, 'storage') } },
    { name: 'cordis:storageDomain', config: { backend: 'json' } },
    { name: 'cordis:workspace' },
    { name: 'cordis:attachment', config: { dshHome: home } },
    { name: 'cordis:credentials', config: { path: join(home, '.credentials.yaml'), dshHome: home, watch: false } },
    { name: 'cordis:connection', config: { trustedHosts: [] } },
    { name: 'cordis:commands' },
    { name: 'cordis:upload' },
    { name: 'cordis:registry' },
    { name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    { name: 'cordis:agentLoop', config: { agents: [] } },
    { name: 'cordis:query' },
    { name: 'cordis:title', config: { fallbackMaxWords: 8, fallbackMaxBytes: 128, maxTitleBytes: 512 } },
    { name: 'cordis:defaultModel', config: { provider: 'initialization', model: 'default' } },
    { name: 'cordis:controller', config: { nativeOpen: false } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const controller = ctx.get('sessionController')
  const entry = [...ctx.loader.entries()].find(value => value.options.name === 'cordis:controller')
  if (controller === undefined || entry?.fiber === undefined) throw new Error('initializer Loader did not activate its Controller')
  return { ctx, root, adapter, controller, controllerEntry: entry }
}
