/** Local Git preferences may not rewrite the user's explicitly previewed patch bytes. */
import { expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { GitOperationId } from '../src/index.ts'
import { applicationEdgeFixture, edgeScope } from './edge-harness.ts'
import { fixture, signal } from './repeat-harness.ts'

it('preserves exact previewed trailing whitespace despite local apply.whitespace=fix', async () => {
  const test = await applicationEdgeFixture(async (path) => { await writeFile(join(path, 'file.txt'), 'EXPLICIT TRAILING SPACES  \n') })
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

/** Repository settings that would otherwise change the paths a patch names, its bytes, whether it applies, or the bytes
 * Git writes from it. */
const settings: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  'without path prefixes': [['diff.noprefix', 'true'], ['color.ui', 'always'], ['diff.context', '0'],
    ['diff.suppressBlankEmpty', 'true'], ['core.quotePath', 'false'], ['diff.algorithm', 'histogram'],
    ['diff.interHunkContext', '20'], ['diff.relative', 'true'], ['apply.whitespace', 'fix'], ['apply.ignoreWhitespace', 'change'],
    ['core.autocrlf', 'true']],
  'with other path prefixes': [['diff.srcPrefix', 'x/'], ['diff.dstPrefix', 'y/'], ['diff.mnemonicPrefix', 'true'],
    ['color.diff', 'always'], ['diff.orderFile', '.git/order'], ['apply.whitespace', 'error']],
}

it.each(Object.keys(settings))('writes exactly the version\'s bytes to the recorded paths in a repository set up %s', async (label) => {
  const test = await fixture()
  // A nested file has a twin with the same content one level up, where a patch path without its first component lands.
  const twin = 'one\n\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n'
  for (const path of ['src/x/a.ts', 'x/a.ts']) {
    await mkdir(join(test.project, dirname(path)), { recursive: true }); await writeFile(join(test.project, path), twin)
  }
  await writeFile(join(test.project, 'café.txt'), 'caf\n')
  test.git(['add', '--', 'src/x/a.ts', 'x/a.ts', 'café.txt']); test.git(['commit', '--quiet', '-m', 'nested twins'])
  const head = test.git(['rev-parse', 'HEAD'])
  // Trailing spaces, a space before a tab and a final blank line are what fixing whitespace would change.
  const version = { 'src/x/a.ts': 'ONE\n\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN  \n \tindented\n\n',
    'src/x/new.ts': 'new\t \n', 'café.txt': 'CAF \n' }
  const sealed = await test.work('settings', await test.copy('settings', head), version)
  const plain = await test.owner.previewApplication(test.direct(sealed))
  await writeFile(join(test.project, '.git', 'order'), 'src/*\n')
  for (const [key, value] of settings[label] ?? []) test.git(['config', '--local', key, value])
  const preview = await test.owner.previewApplication(test.direct(sealed))
  expect(preview.patch).toBe(plain.patch)
  expect(preview.patch.split('\n').filter(line => line.startsWith('diff --git '))).toEqual(['diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    'diff --git a/src/x/a.ts b/src/x/a.ts', 'diff --git a/src/x/new.ts b/src/x/new.ts'])
  const applied = await test.owner.apply({ ...test.direct(sealed), operationId: GitOperationId('settings-apply'),
    originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint }, signal, () => {})
  expect(applied.operation).toMatchObject({ phase: 'confirmed', applicationObservation: { state: 'after' } })
  for (const [path, text] of Object.entries(version)) expect(await readFile(join(test.project, path), 'utf8')).toBe(text)
  expect(await readFile(join(test.project, 'x/a.ts'), 'utf8')).toBe(twin)
  expect(test.git(['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean).toSorted())
    .toEqual([' M café.txt', ' M src/x/a.ts', '?? src/x/new.ts'])
  for (const [key, value] of settings[label] ?? []) expect(test.git(['config', '--local', '--get', key])).toBe(value)
})
