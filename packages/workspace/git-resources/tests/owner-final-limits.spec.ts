/** Default diagnostics and explicit all-content traversal keep their configured bounds. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import GitResources, { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { harness, repository } from './harness.ts'

it('bounds an abandonment diagnostic when a directly constructed owner uses omitted defaults', async () => {
  const test = await harness({}, undefined, false)
  const owner = new GitResources(test.ctx, { home: test.home })
  await expect(owner.abandonOperation(GitOperationId('unopened-original'), 'unopened-fingerprint', 'x'.repeat(128 * 1024 + 1)))
    .rejects.toMatchObject({ code: 'DIAGNOSTIC_INVALID' })
  expect(test.ctx.storageDomain.get('git_resources')).toBeUndefined()
})

it.each(['files', 'empty-directories'] as const)('bounds actual ignored %s when the user explicitly requests all-content preservation', async (kind) => {
  const test = await harness({ maxFiles: 2 }), base = await repository(test)
  const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
  const made = await test.ctx.gitResources.create({ ...preview.request, consumerScope: GitConsumerScope('all-content-limit'),
    originalRequestJson: '{}', operationId: GitOperationId('all-content-limit-copy'), expectedPreviewFingerprint: preview.fingerprint })
  await writeFile(join(test.project, '.git', 'info', 'exclude'), 'generated-cache/\n')
  const ignored = join(made.resource.path, 'generated-cache')
  await mkdir(ignored)
  for (const name of ['one', 'two', 'three']) {
    if (kind === 'files') await writeFile(join(ignored, name), 'fixture-generated cache content\n')
    else await mkdir(join(ignored, name))
  }
  const operationId = GitOperationId(`all-content-${kind}`)
  await expect(test.ctx.gitResources.preserve({ operationId, resourceId: made.resource.resourceId,
    expectedRevision: made.resource.revision, content: 'all' })).rejects.toMatchObject({
    code: 'MANIFEST_LIMIT', message: 'Work-copy file/directory count exceeds its configured limit',
  })
  expect(test.ctx.gitResources.status(operationId)?.operation).toMatchObject({ phase: 'needs_attention' })
  expect(test.ctx.gitResources.status(operationId)?.operation.effectRef).toBeUndefined()
  expect(test.git(['for-each-ref', '--format=%(refname)', `refs/dsh-resources/${made.resource.resourceId}/preserved/`])).toBe('')
})
