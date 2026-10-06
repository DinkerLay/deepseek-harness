/** Durable record relationships and subprocess byte-channel failures retain exact resource facts. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { GitConsumerScope, GitOperationId, GitRepositoryId, GitResourceId } from '../src/index.ts'
import { cleanupRequestSchema } from '../src/cleanup.ts'
import { ResourceGit } from '../src/git.ts'
import { repositorySchema } from '../src/records.ts'
import type { RepositoryRecord } from '../src/records.ts'
import { harness, repository } from './harness.ts'

const signal = new AbortController().signal

/** Parser-only intended facts; no successful Git effect is asserted by this sample. */
function intendedRecord(): RepositoryRecord {
  const repositoryId = GitRepositoryId('parser-repository'), resourceId = GitResourceId('parser-resource'),
    consumerScope = GitConsumerScope('parser-consumer'), workspaceId = WorkspaceId('parser-workspace')
  const identity = { path: '/parser-only', device: '1', inode: '2' }
  return { revision: 1,
    identity: { repositoryId, workspaceId, root: identity, gitDir: identity, commonDir: identity, objectFormat: 'sha1' },
    resources: [{ resourceId, repositoryId, consumerScope, revision: 1, path: '/parser-only/reserved', reservedAbsent: true,
      privateRef: 'refs/dsh/parser-only', state: 'reserved', useHistory: [] }],
    operations: [{ operationId: GitOperationId('parser-operation'), repositoryId, resourceId, consumerScope,
      fingerprint: 'parser-fingerprint', kind: 'create', phase: 'intended', createdAt: 'parser-time',
      request: { operationId: GitOperationId('parser-operation'), consumerScope, originalRequestJson: '{}', workspaceId,
        baseline: { kind: 'commit', commit: 'HEAD' }, expectedPreviewFingerprint: 'parser-preview' } }],
  }
}

describe('authoritative repository JSON', () => {
  it.each(['resource', 'operation'] as const)('rejects duplicate %s identity instead of collapsing records', (kind) => {
    const value = intendedRecord()
    expect(repositorySchema.parse(value)).toEqual(value)
    const duplicated = kind === 'resource' ? { ...value, resources: [...value.resources, ...value.resources] }
      : { ...value, operations: [...value.operations, ...value.operations] }
    expect(() => repositorySchema.parse(duplicated)).toThrow('resource operation identity is duplicated')
  })

  it('rejects a resource registered against another repository', () => {
    const value = intendedRecord(), resource = value.resources[0]
    if (resource === undefined) throw new Error('parser sample requires one intended resource')
    expect(() => repositorySchema.parse({ ...value,
      resources: [{ ...resource, repositoryId: GitRepositoryId('another-parser-repository') }] }))
      .toThrow('resource belongs to another repository')
  })

  it.each(['missing-resource', 'consumer-scope', 'repository'] as const)('rejects an operation with %s ownership mismatch', (kind) => {
    const value = intendedRecord(), operation = value.operations[0]
    if (operation === undefined) throw new Error('parser sample requires one intended operation')
    const changed = kind === 'missing-resource' ? { ...operation, resourceId: GitResourceId('absent-parser-resource') }
      : kind === 'consumer-scope' ? { ...operation, consumerScope: GitConsumerScope('another-parser-consumer') }
        : { ...operation, repositoryId: GitRepositoryId('another-parser-repository') }
    expect(() => repositorySchema.parse({ ...value, operations: [changed] })).toThrow('operation resource ownership does not match')
  })

  it('rejects invalid original request JSON rather than admitting an uninterpretable durable intent', () => {
    const value = intendedRecord(), operation = value.operations[0]
    if (operation === undefined) throw new Error('parser sample requires one intended operation')
    expect(() => repositorySchema.parse({ ...value,
      operations: [{ ...operation, request: { ...operation.request, originalRequestJson: '{unfinished' } }] }))
      .toThrow('original consumer request is not JSON')
  })

  it('preserves optional cleanup correlation while refusing invalid JSON or undeclared fields', () => {
    const request = { operationId: GitOperationId('parser-cleanup'), resourceId: GitResourceId('parser-resource'),
      expectedPreviewFingerprint: 'parser-preview' }
    expect(cleanupRequestSchema.parse(request)).toEqual(request)
    expect(cleanupRequestSchema.parse({ ...request, originalRequestJson: '{"userRequest":1}' }))
      .toEqual({ ...request, originalRequestJson: '{"userRequest":1}' })
    expect(() => cleanupRequestSchema.parse({ ...request, originalRequestJson: '{unfinished' }))
      .toThrow('original consumer request must be JSON')
    expect(() => cleanupRequestSchema.parse({ ...request, authorizeDeletion: true })).toThrow()
  })

  it('cold-decodes all three actual unmerged index stages in both the resource seal and its operation', async () => {
    const test = await harness(), base = await repository(test), scope = GitConsumerScope('cold-conflict-consumer')
    const preview = await test.ctx.gitResources.preview({ workspaceId: test.workspace.id, baseline: { kind: 'commit', commit: base } })
    const made = await test.ctx.gitResources.create({ ...preview.request, consumerScope: scope,
      operationId: GitOperationId('cold-conflict-copy'), originalRequestJson: '{}', expectedPreviewFingerprint: preview.fingerprint })
    const objectId = test.git(['rev-parse', `${base}:file.txt`])
    test.git(['-C', made.resource.path, 'update-index', '--index-info'],
      `0 ${'0'.repeat(objectId.length)}\tfile.txt\n${[1, 2, 3].map(stage => `100644 ${objectId} ${stage}\tfile.txt\n`).join('')}`)
    const stages = [1, 2, 3].map(stage => ({ path: 'file.txt', mode: '100644', objectId, stage }))
    expect(test.git(['-C', made.resource.path, 'ls-files', '--unmerged']).split('\n')).toHaveLength(3)
    const index = await readFile(join(test.project, '.git', 'index'))
    const sealed = await test.ctx.gitResources.preserve({ operationId: GitOperationId('cold-conflict-seal'),
      resourceId: made.resource.resourceId, expectedRevision: made.resource.revision, content: 'versioned' })
    expect(sealed.resource.preservedConflictStages).toEqual(stages)
    expect(sealed.operation.effectConflictStages).toEqual(stages)
    await test.ctx.fiber.dispose()
    const cold = await harness({}, test.resources)
    expect(cold.ctx.gitResources.read(made.resource.resourceId)?.preservedConflictStages).toEqual(stages)
    expect(cold.ctx.gitResources.status(sealed.operation.operationId)?.operation).toEqual(sealed.operation)
    expect(await readFile(join(test.project, '.git', 'index'))).toEqual(index)
    expect(test.git(['-C', made.resource.path, 'ls-files', '--unmerged']).split('\n')).toHaveLength(3)
    expect(await readFile(join(made.resource.path, 'file.txt'), 'utf8')).toBe('BASE\n')
    expect(test.git(['rev-parse', 'HEAD'])).toBe(base)
  })
})

describe('managed subprocess byte channels', () => {
  it('losslessly collects string chunks emitted by an actual UTF-8 Git stream', async () => {
    const test = await harness({}, undefined, false), executable = await test.ctx.subprocess.resolveExecutable('git'),
      spawn = test.ctx.subprocess.spawn.bind(test.ctx.subprocess)
    const encoded = vi.spyOn(test.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const handle = spawn(spec)
      handle.stdout?.setEncoding('utf8'); handle.stderr?.setEncoding('utf8')
      return handle
    })
    onTestFinished(() => { encoded.mockRestore() })
    const runner = new ResourceGit(test.ctx.subprocess, executable, join(test.root, 'git-home'),
      { timeoutMs: 10_000, maxOutputBytes: 4_096, graceMs: 100 })
    try {
      const result = await runner.run(['--version'], test.project, signal)
      expect(result.status).toBe(0)
      expect(Buffer.isBuffer(result.stdout)).toBe(true)
      expect(result.stdout.toString('utf8').trimEnd()).toBe(test.git(['--version']))
      expect(result.stderr).toEqual(Buffer.alloc(0))
    } finally { encoded.mockRestore() }
  })

  it.each(['missing', 'object'] as const)('rejects %s stdout from the provider and awaits its actual Git process range', async (kind) => {
    const test = await harness({}, undefined, false), executable = await test.ctx.subprocess.resolveExecutable('git'),
      spawn = test.ctx.subprocess.spawn.bind(test.ctx.subprocess)
    let doneObserved = false, terminated = false, exited = false
    const invalid = vi.spyOn(test.ctx.subprocess, 'spawn').mockImplementation((spec): SubprocessHandle => {
      const actual = spawn(spec)
      actual.stdout?.resume()
      return { ...actual, stdout: kind === 'missing' ? undefined : Readable.from([{ invalidByteChannel: true }]),
        done: actual.done.then((outcome) => { doneObserved = true; return outcome }),
        terminate: () => { terminated = true; actual.terminate() },
        waitForExit: async (cancellation) => { const empty = await actual.waitForExit(cancellation); exited = empty; return empty },
      }
    })
    onTestFinished(() => { invalid.mockRestore() })
    const runner = new ResourceGit(test.ctx.subprocess, executable, join(test.root, 'git-home'),
      { timeoutMs: 10_000, maxOutputBytes: 4_096, graceMs: 100 })
    try {
      await expect(runner.run(['--version'], test.project, signal)).rejects.toMatchObject({ code: 'GIT_IO',
        message: kind === 'missing' ? 'Git byte channel is unavailable' : 'Git emitted an unsupported byte channel' })
      expect(terminated).toBe(true)
      expect(doneObserved).toBe(true)
      expect(exited).toBe(true)
    } finally { invalid.mockRestore() }
  })
})
