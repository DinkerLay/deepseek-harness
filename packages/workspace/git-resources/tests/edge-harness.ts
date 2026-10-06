/** Real Loader and Git versions shared by the independently owned edge suites. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { ResourceGit } from '../src/git.ts'
import type { GitApplicationSource } from '../src/application.ts'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { onTestFinished, vi } from 'vitest'
import { harness, repository } from './harness.ts'

export const edgeSignal = new AbortController().signal
export const edgeLimits = { maxFiles: 100, maxFileBytes: 100_000, maxTotalBytes: 1_000_000 }
export const edgeScope = GitConsumerScope('real-edge-consumer')

/** Allocate a Loader owner and one actual versioned input with its immutable initial baseline. */
export async function edgeFixture(change: (path: string) => Promise<void> = async (path) => {
  await writeFile(join(path, 'file.txt'), 'EDGE RESULT\n')
}, objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const test = await harness()
  test.git(['init', '--quiet', `--object-format=${objectFormat}`])
  const base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  if (preview.repository === undefined) throw new Error('edge fixture repository is unavailable')
  const made = await test.ctx.gitResources.create({ ...preview.request, consumerScope: edgeScope,
    operationId: GitOperationId('edge-copy'), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  await test.ctx.gitResources.withWriteUse(made.resource.resourceId, { useId: 'edge-write', ownerId: 'edge-owner', epoch: '1' },
    edgeSignal, async (lease) => { lease.assertCurrent(); await change(lease.resource.path) })
  const current = test.ctx.gitResources.read(made.resource.resourceId)
  if (current === undefined) throw new Error('edge fixture resource disappeared')
  const version = await test.ctx.gitResources.preserve({ operationId: GitOperationId('edge-version'), resourceId: current.resourceId,
    expectedRevision: current.revision, content: 'versioned' })
  const runner = new ResourceGit(test.ctx.subprocess, 'git', join(test.root, 'git-home'), {
    timeoutMs: 10_000, graceMs: 100, maxOutputBytes: 1_000_000 })
  const selection = { consumerScope: edgeScope, baseResourceId: made.resource.resourceId,
    sourcePreserveOperationIds: [version.operation.operationId] }
  return { ...test, base, identity: preview.repository, made, version, runner, selection,
    lease: { signal: edgeSignal, assertCurrent: () => {} } }
}

/** Prepare an actual integration and seal selected through the public resource service. */
export async function applicationEdgeFixture(change?: (path: string) => Promise<void>) {
  const test = await edgeFixture(change), preview = await test.ctx.gitResources.previewIntegration(test.selection)
  const integrated = await test.ctx.gitResources.integrate({ ...test.selection, operationId: GitOperationId('edge-integration'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
  const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('edge-integration-version'),
    resourceId: integrated.resource.resourceId, expectedRevision: integrated.resource.revision, content: 'versioned' })
  const { effectCommit, effectTree, effectManifestHash } = sealed.operation
  if (effectCommit === undefined || effectTree === undefined || effectManifestHash === undefined
    || integrated.operation.integrationEffect === undefined) throw new Error('edge application has no complete immutable facts')
  const source: GitApplicationSource = { repository: test.identity, integrationOperationId: integrated.operation.operationId,
    preserveOperationId: sealed.operation.operationId, resourceId: integrated.resource.resourceId, consumerScope: edgeScope,
    originalTargetBaseTree: integrated.operation.integrationEffect.originalTargetBaseTree,
    resultCommit: effectCommit, resultTree: effectTree, manifestHash: effectManifestHash }
  const scratch = join(test.root, 'edge-inverse-scratch'); await mkdir(scratch)
  return { ...test, integrated, sealed, source, scratch }
}

/** Abort only after the real domain backend durably saves this operation's original intent. */
export function abortAfterIntent(test: Awaited<ReturnType<typeof edgeFixture>>, operationId: ReturnType<typeof GitOperationId>,
  cancellation: AbortController) {
  const domain = test.ctx.storageDomain.get('git_resources')
  if (domain === undefined) throw new Error('edge resource domain is not open')
  const unit = Reflect.get(domain, 'unit') as KvUnit, put = unit.putRecord.bind(unit)
  const fault = vi.spyOn(unit, 'putRecord').mockImplementation(async (...args) => {
    await put(...args)
    const value = args[2]
    if (value !== null && typeof value === 'object' && 'operations' in value && Array.isArray(value.operations)
      && value.operations.some((operation: unknown) => operation !== null && typeof operation === 'object'
        && 'operationId' in operation && operation.operationId === operationId
        && 'phase' in operation && operation.phase === 'intended')) cancellation.abort(new Error('frozen after durable original intent'))
  })
  onTestFinished(() => { fault.mockRestore() })
  return fault
}
