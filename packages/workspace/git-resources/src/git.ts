/** Exact argv Git plumbing with bounded bytes, isolated configuration and managed process teardown. */
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { join } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { GitResourceError } from './error.ts'

/** Explicit command bounds belong to the configured resource owner. */
export interface GitCommandLimits { readonly timeoutMs: number; readonly maxOutputBytes: number; readonly graceMs: number }
/** A local-only command's settled bytes; a nonzero exit remains available for exact refusal checks. */
export interface GitCommandResult { readonly status: number | null; readonly stdout: Buffer; readonly stderr: Buffer }
/** One resource owner uses the public subprocess seam; no shell, remote, credential helper or user hooks. */
export class ResourceGit {
  /** @param subprocess - current same-host subprocess provider.
   * @param executable - provider-resolved Git executable.
   * @param isolation - private empty HOME/hooks directory, not the parent process HOME.
   * @param limits - deployment-configured limits.
   */
  constructor(private readonly subprocess: SubprocessRuntime, private readonly executable: string,
    private readonly isolation: string, private readonly limits: GitCommandLimits) {}

  /** Execute bounded local Git plumbing and await managed process teardown.
   * @param args - exact built-in Git arguments.
   * @param cwd - verified local directory.
   * @param signal - operation cancellation; admitted process teardown is drained.
   * @param options - private index, binary stdin and explicitly tolerated failure.
   * @returns bounded raw bytes after the managed process range exits.
   */
  async run(args: readonly string[], cwd: string, signal: AbortSignal,
    options: { env?: NodeJS.ProcessEnv; input?: Buffer; allowFailure?: boolean } = {}): Promise<GitCommandResult> {
    const env: NodeJS.ProcessEnv = { HOME: this.isolation, USERPROFILE: this.isolation, XDG_CONFIG_HOME: this.isolation,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(this.isolation, 'empty-config'), GIT_CONFIG_SYSTEM: join(this.isolation, 'empty-config'), GIT_CONFIG_COUNT: '0',
      GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', LC_ALL: 'C' }
    for (const key of Object.keys(scrubbedParentEnv())) if (key.toUpperCase().startsWith('GIT_')) env[key] = undefined
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(this.isolation, 'empty-config'), GIT_CONFIG_SYSTEM: join(this.isolation, 'empty-config'),
      GIT_CONFIG_COUNT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }, options.env)
    const bounded = new AbortController(), timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const combined = AbortSignal.any([signal, timeout, bounded.signal])
    const handle = this.subprocess.spawn({ argv: [this.executable, '-c', `core.hooksPath=${this.isolation}`,
      '-c', `core.excludesFile=${join(this.isolation, 'empty-config')}`,
      '-c', `core.attributesFile=${join(this.isolation, 'empty-config')}`,
      '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0', ...args], cwd, env,
    stdio: { stdin: options.input === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: this.limits.graceMs, signal: combined })
    const collect = async (stream: typeof handle.stdout) => {
      if (stream === undefined) throw new GitResourceError('GIT_IO', 'Git byte channel is unavailable')
      const chunks: Buffer[] = []; let bytes = 0
      for await (const value of stream) {
        const raw: unknown = value
        if (!Buffer.isBuffer(raw) && typeof raw !== 'string') throw new GitResourceError('GIT_IO', 'Git emitted an unsupported byte channel')
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        bytes += chunk.length
        if (bytes > this.limits.maxOutputBytes) { bounded.abort(); throw new GitResourceError('GIT_OUTPUT_LIMIT', 'Git output exceeded its configured byte limit') }
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    }
    const output = Promise.all([collect(handle.stdout), collect(handle.stderr)])
    if (options.input !== undefined) handle.stdin?.end(options.input)
    try {
      const [outcome, [stdout, stderr]] = await Promise.all([handle.done, output])
      combined.throwIfAborted()
      if (outcome.exitCode !== 0 && !options.allowFailure) throw new GitResourceError('GIT_COMMAND_FAILED', `Git ${args[0]} refused the resource operation`)
      return { status: outcome.exitCode, stdout, stderr }
    } finally {
      handle.terminate()
      await Promise.allSettled([handle.done, output, handle.waitForExit()])
    }
  }
  /** Read lossless UTF-8 Git metadata through the bounded local runner.
   * @param args - arguments whose output is metadata, never binary file contents.
   * @param cwd - verified command directory.
   * @param signal - caller cancellation.
   * @param env - optional private plumbing environment.
   * @returns lossless UTF-8 metadata with trailing whitespace removed.
   */
  async text(args: readonly string[], cwd: string, signal: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string> {
    const bytes = (await this.run(args, cwd, signal, env === undefined ? {} : { env })).stdout, value = bytes.toString('utf8')
    if (!Buffer.from(value).equals(bytes)) throw new GitResourceError('GIT_METADATA_INVALID', 'Git metadata paths must be losslessly representable as UTF-8')
    return value.trimEnd()
  }
}
