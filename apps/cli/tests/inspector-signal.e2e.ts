/** A same-user SIGUSR1 must not open the Node inspector of a real `dsh web` Host. */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { describe, expect, it, onTestFinished } from 'vitest'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const INSPECTOR_MESSAGE = 'Debugger listening on ws://127.0.0.1:'
// The control below proves an activated inspector reports within this bound.
const ACTIVATION_BOUND_MS = 1_000

/**
 * Deliver SIGUSR1 from where a model-run command would send it. macOS confinement
 * leaves signals open, so the sender runs under the real provider; Linux bwrap gives
 * it a private PID namespace, so the Host is signalled directly to cover the Landlock
 * rung, which has none.
 */
async function sendInspectorSignal(pid: number, root: string): Promise<void> {
  if (process.platform !== 'darwin') {
    process.kill(pid, 'SIGUSR1')
    return
  }
  const ctx = new Context()
  const provider = await ctx.plugin(LocalSandboxProvider)
  try {
    const sender = await ctx.sandbox.confine([process.execPath, '-e', `process.kill(${String(pid)}, 'SIGUSR1')`], {
      mode: 'read-only', workspaceRoot: root,
    })
    const result = spawnSync(sender.argv[0]!, sender.argv.slice(1), { cwd: root, env: {}, encoding: 'utf8', timeout: 5_000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  } finally {
    await provider.dispose()
  }
}

/** Capture output and stop the child with its test, including on failure. */
function track(child: ChildProcess): { output: () => string } {
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const closed = once(child, 'close')
  onTestFinished(async () => {
    child.kill('SIGKILL')
    await closed
  })
  return { output: () => output }
}

async function waitForOutput(output: () => string, text: string | RegExp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const matches = (): boolean => (typeof text === 'string' ? output().includes(text) : text.test(output()))
  while (!matches() && Date.now() < deadline) await delay(25)
  return matches()
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-inspector-signal-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

describe.skipIf(process.platform === 'win32')('Host inspector signal hardening', () => {
  it('control: the signal opens the inspector of a Node process with no hardening', async () => {
    const root = await temporaryRoot()
    const child = spawn(process.execPath, ['--inspect-port=0', '-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
      cwd: root, env: {}, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const { output } = track(child)
    await expect.poll(output).toContain('ready')

    await sendInspectorSignal(child.pid!, root)

    expect(await waitForOutput(output, INSPECTOR_MESSAGE, ACTIVATION_BOUND_MS), output()).toBe(true)
  })

  it('keeps the inspector closed and the Host serving after the signal', async () => {
    const root = await temporaryRoot()
    const launch = resolveExampleLaunch({
      srcBin: dshBinScript,
      configArgs: ['web', '--no-open', '--port', '0'],
      tsconfigPath,
      sourceImport: 'tsx/esm',
      env: {
        DSH_HOME: join(root, '.dsh'),
        DSH_AGENTS_HOME: join(root, '.agents'),
        DEEPSEEK_API_KEY: 'keyless-inspector-signal-no-call',
        DSH_TELEMETRY_DISABLED: '1',
        NODE_NO_WARNINGS: '1',
        SSH_CONNECTION: '',
        SSH_TTY: '',
      },
    })
    // Port zero keeps an activated inspector away from any other debugger on this host.
    const host = spawn(launch.command, ['--inspect-port=0', ...launch.args], {
      cwd: root, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const { output } = track(host)
    expect(await waitForOutput(output, /dsh web: http:\/\/\S+/u, 60_000), output()).toBe(true)
    const launchUrl = /dsh web: (http:\/\/\S+)/u.exec(output())![1]!

    await sendInspectorSignal(host.pid!, root)

    expect(await waitForOutput(output, INSPECTOR_MESSAGE, ACTIVATION_BOUND_MS), output()).toBe(false)
    expect(host.exitCode).toBeNull()
    expect(host.signalCode).toBeNull()
    expect((await fetch(launchUrl, { redirect: 'manual' })).status).toBeLessThan(500)
  })
})
