/** Local metadata checks refuse links and external object/config resources before Git follows them. */
import { lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitConsumerScope, GitOperationId } from '../src/index.ts'
import { harness, repository } from './harness.ts'

describe('same-host repository and managed-directory safety', () => {
  it.each(['objects', 'objects/info', 'info'])('rejects linked Git metadata directory %s without reading outside metadata', async (path) => {
    const test = await harness(), base = await repository(test), outside = join(test.root, 'outside-metadata')
    await mkdir(outside); await writeFile(join(outside, 'canary'), 'must remain untouched\n')
    const actual = join(test.project, '.git', path)
    await rename(actual, `${actual}-original`); await symlink(outside, actual)
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    expect(preview).toMatchObject({ permitted: false, risks: ['GIT_METADATA_INVALID'] })
    expect(await readFile(join(outside, 'canary'), 'utf8')).toBe('must remain untouched\n')
  })

  it.each(['alternates', 'http-alternates'])('rejects declared external Git object stores in %s', async (name) => {
    const test = await harness(), base = await repository(test)
    await writeFile(join(test.project, '.git', 'objects', 'info', name), '/not-a-registered-object-store\n')
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    expect(preview).toMatchObject({ permitted: false, risks: ['GIT_ALTERNATES_UNSUPPORTED'] })
  })

  it('rejects linked repository attributes metadata and overrides external core.attributesFile', async () => {
    const test = await harness(), base = await repository(test), external = join(test.root, 'external-attributes')
    await writeFile(external, '*.txt filter=must-not-run\n')
    test.git(['config', 'core.attributesFile', external])
    expect((await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })).permitted).toBe(true)
    await symlink(external, join(test.project, '.git', 'info', 'attributes'))
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    expect(preview).toMatchObject({ permitted: false, risks: ['GIT_METADATA_INVALID'] })
  })

  it('refuses a replaced resource parent before reservation without writing to the external directory', async () => {
    const test = await harness(), base = await repository(test), external = join(test.root, 'not-owned-workcopies')
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const managed = join(test.home, 'git-resources', 'workcopies')
    await mkdir(external); await rename(managed, `${managed}-original`); await symlink(external, managed)
    const operationId = GitOperationId('replaced-parent')
    await expect(test.ctx.gitResources.create({ ...preview.request, operationId, consumerScope: GitConsumerScope('safety'),
      originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })).rejects.toMatchObject({ code: 'SYMLINK_UNSUPPORTED' })
    expect(test.ctx.gitResources.status(operationId)).toBeUndefined()
    expect(test.git(['for-each-ref', '--format=%(refname)', 'refs/dsh-resources'])).toBe('')
    expect((await lstat(external)).isDirectory()).toBe(true)
  })

  it('rejects non-UTF-8 Git paths rather than materializing a replacement-character filename', async () => {
    const test = await harness(), base = await repository(test)
    const blob = test.git(['hash-object', '-w', '--stdin'], 'owned fixture content\n')
    const tree = test.git(['mktree', '-z'], Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0xff, 0])]))
    const commit = test.git(['commit-tree', tree, '-p', base, '-m', 'owned invalid path fixture'])
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit } })
    expect(preview).toMatchObject({ permitted: false, risks: ['GIT_METADATA_INVALID'] })
    expect(test.ctx.gitResources.listOperations(GitConsumerScope('safety'))).toEqual([])
  })

  it('rejects content that cannot fit the actual Git byte-channel bound before reserving a copy', async () => {
    const test = await harness({ maxFileBytes: 8192, maxOutputBytes: 512 }), base = await repository(test)
    await writeFile(join(test.project, 'large-binary'), Buffer.alloc(4096))
    const request = { workspaceId: test.workspace.id, baseline: { kind: 'selected' as const, baseCommit: base,
      paths: [{ path: 'large-binary', source: 'untracked' as const }] } }
    const preview = await test.ctx.gitResources.preview(request)
    expect(preview).toMatchObject({ permitted: false, risks: ['FILE_LIMIT'] })
    expect(test.ctx.gitResources.listOperations(GitConsumerScope('safety'))).toEqual([])
    expect(test.git(['for-each-ref', '--format=%(refname)', 'refs/dsh-resources'])).toBe('')
  })

  it('rejects an external worktree override before Git can inspect its ignore rules or files', async () => {
    const test = await harness(), base = await repository(test), external = join(test.root, 'not-the-registered-project')
    await mkdir(external); await writeFile(join(external, '.gitignore'), '*.txt\n')
    test.git(['config', 'core.worktree', external])
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    expect(preview).toMatchObject({ permitted: false, risks: ['GIT_CONFIG_UNSAFE'] })
    expect(JSON.stringify(preview)).not.toContain(external)
  })
})
