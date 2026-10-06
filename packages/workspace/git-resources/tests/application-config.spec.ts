/** Local Git preferences may not rewrite the user's explicitly previewed patch bytes. */
import { beforeEach, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GitOperationId } from '../src/index.ts'
import { applicationEdgeFixture, edgeScope } from './edge-harness.ts'

let test: Awaited<ReturnType<typeof applicationEdgeFixture>>
beforeEach(async () => {
  test = await applicationEdgeFixture(async (path) => { await writeFile(join(path, 'file.txt'), 'EXPLICIT TRAILING SPACES  \n') })
})

it('preserves exact previewed trailing whitespace despite local apply.whitespace=fix', async () => {
  test.git(['config', '--local', 'apply.whitespace', 'fix'])
  const selection = { consumerScope: edgeScope, integrationOperationId: test.integrated.operation.operationId,
    preserveOperationId: test.sealed.operation.operationId, targetWorkspaceId: test.workspace.id }
  const preview = await test.ctx.gitResources.previewApplication(selection)
  expect(preview.patch).toContain('+EXPLICIT TRAILING SPACES  \n')
  const applied = await test.ctx.gitResources.apply({ ...selection, operationId: GitOperationId('exact-whitespace'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }, new AbortController().signal, () => {})
  expect(applied.operation.phase).toBe('confirmed')
  expect(await readFile(join(test.project, 'file.txt'), 'utf8')).toBe('EXPLICIT TRAILING SPACES  \n')
  expect(test.git(['config', '--local', '--get', 'apply.whitespace'])).toBe('fix')
})
