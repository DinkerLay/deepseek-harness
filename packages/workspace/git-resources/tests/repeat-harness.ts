/** Real Loader fixture for repeated applications: work copies, seals, integrations and applications in one project. */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import type { GitApplicationPreviewRequest, GitResourceOperationView, GitResourceRecord } from '../src/index.ts'
import { harness, repository } from './harness.ts'

export const signal = new AbortController().signal
export const scope = GitConsumerScope('repeat-application')

/** Boot one project with helpers that make copies, seal work, integrate and apply. */
export async function fixture() {
  const test = await harness(), base = await repository(test), owner = test.ctx.gitResources
  const copy = async (name: string, commit: string): Promise<GitResourceRecord> => {
    const preview = await owner.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit } })
    return (await owner.create({ ...preview.request, consumerScope: scope, operationId: GitOperationId(`${name}-copy`),
      originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })).resource
  }
  const work = async (name: string, resource: GitResourceRecord, files: Readonly<Record<string, string | null>>) => {
    await owner.withWriteUse(resource.resourceId, { useId: name, ownerId: name, epoch: '1' }, signal, async (lease) => {
      for (const [path, text] of Object.entries(files)) {
        if (text === null) await rm(join(lease.resource.path, path))
        else await writeFile(join(lease.resource.path, path), text)
      }
    })
    const current = owner.read(resource.resourceId)
    if (current === undefined) throw new Error('work copy remains registered')
    return owner.preserve({ operationId: GitOperationId(`${name}-seal`), resourceId: current.resourceId,
      expectedRevision: current.revision, content: 'versioned' })
  }
  /** Integrate one sealed work copy onto itself, then seal the integration copy, optionally after more work on it. */
  const version = async (name: string, sealed: GitResourceOperationView, files?: Readonly<Record<string, string | null>>) => {
    const selection = { consumerScope: scope, baseResourceId: sealed.resource.resourceId,
      sourcePreserveOperationIds: [sealed.operation.operationId] }
    const preview = await owner.previewIntegration(selection)
    const integrated = await owner.integrate({ ...selection, operationId: GitOperationId(`${name}-integration`),
      originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
    const result = await work(`${name}-validated`, integrated.resource, files ?? {})
    const request: GitApplicationPreviewRequest = { consumerScope: scope, integrationOperationId: integrated.operation.operationId,
      preserveOperationId: result.operation.operationId, targetWorkspaceId: test.workspace.id }
    return { integrated, result, request }
  }
  const apply = async (name: string, request: GitApplicationPreviewRequest) => {
    const preview = await owner.previewApplication(request)
    return owner.apply({ ...request, operationId: GitOperationId(`${name}-apply`), originalRequestJson: '{}',
      expectedPreviewFingerprint: preview.fingerprint }, signal, () => {})
  }
  const commitOf = (sealed: GitResourceOperationView) => {
    if (sealed.operation.effectCommit === undefined) throw new Error('seal has its commit')
    return sealed.operation.effectCommit
  }
  const read = (path: string) => readFile(join(test.project, path), 'utf8')
  /** A code result sealed on its own work copy, applied without an integration. */
  const direct = (sealed: GitResourceOperationView): GitApplicationPreviewRequest => ({ consumerScope: scope,
    preserveOperationId: sealed.operation.operationId, targetWorkspaceId: test.workspace.id })
  return { ...test, base, owner, copy, work, version, apply, commitOf, read, direct, baseTree: test.git(['rev-parse', `${base}^{tree}`]) }
}
