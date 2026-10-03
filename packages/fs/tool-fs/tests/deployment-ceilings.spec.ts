import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { FsError, type FsTarget, type FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'

class ConfiningLocalFs extends LocalFileSystem {
  readonly applied: SandboxExecutionPolicy[] = []
  override get sandboxMode() { return 'read-only' as const }
  override async writeText(
    target: FsTarget, content: string, intent?: FsWriteIntent, signal?: AbortSignal, policy?: SandboxExecutionPolicy,
  ) {
    if (policy !== undefined) this.applied.push(policy)
    if (policy?.mode === 'read-only') throw new FsError('deployment denies the write', 'FS_SANDBOX_DENIED')
    return super.writeText(target, content, intent, signal)
  }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release() })

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-fs-ceiling-'))
  const ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write' })
  await ctx.plugin(ConfiningLocalFs, { cwd: directory })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(ToolFs)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('fs-ceiling'), { provider: 'test', model: 'test' }, { cwd: directory })
  return { ctx, directory, agent, fs: ctx.fs as ConfiningLocalFs }
}

function args() {
  return { file_path: 'result.txt', content: 'written', sandbox_permissions: 'danger-full-access', justification: 'Write the selected result' }
}

describe('filesystem deployment ceilings', () => {
  it('refuses wider access before requesting approval or reaching the filesystem', async () => {
    const { ctx, directory, agent, fs } = await setup()
    const approval = vi.fn(async () => 'allowed-once' as const)
    ctx.on('approval/request', approval)
    ctx.sandboxPolicy.registerConstraint((_request, policy) => ({ ...policy, mode: 'workspace-write' }))
    const result = await ctx.tools.execute({ name: 'write', arguments: args(), agent,
      callId: ToolCallId('fs-ceiling-before'), signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('configured access limit')
    expect(approval).not.toHaveBeenCalled()
    expect(fs.applied).toEqual([])
    expect(existsSync(join(directory, 'result.txt'))).toBe(false)
  })

  it('uses a ceiling installed while approval is pending at the actual write', async () => {
    const { ctx, directory, agent, fs } = await setup()
    agent.session.append('turn/start', { turn: 1 })
    ctx.on('approval/request', async () => {
      ctx.sandboxPolicy.registerConstraint((_request, policy) => ({ ...policy, mode: 'read-only' }))
      return 'allowed-once' as const
    })
    const result = await ctx.tools.execute({ name: 'write', arguments: args(), agent,
      callId: ToolCallId('fs-ceiling-after'), signal: new AbortController().signal })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(result.isError).toBe(true)
    expect(result.error?.message).toContain('read-only')
    expect(fs.applied.map(policy => policy.mode)).toEqual(['read-only'])
    expect(existsSync(join(directory, 'result.txt'))).toBe(false)
  })
})
