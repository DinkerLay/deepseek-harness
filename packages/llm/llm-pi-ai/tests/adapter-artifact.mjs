/** Built-artifact smoke; run with plain Node after the package build, without tsx aliases. */
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const loaded = new Map()
const packageLib = new URL('../lib/', import.meta.url).href
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.startsWith(packageLib)) loaded.set(url, String(result.source))
    return result
  },
})
try {
  const narrow = await import('@deepseek-ai/dsh-llm-pi-ai/adapter')
  assert.deepEqual(Object.keys(narrow).sort(), ['PiAiAdapter', 'createPiAiProfiles'])
  assert.equal(loaded.has(`${packageLib}index.js`), false)
  for (const source of loaded.values()) {
    assert.doesNotMatch(source, /#region lib\/types\/(?:auth|login|discovery|index)\.js/)
  }
  const root = await import('@deepseek-ai/dsh-llm-pi-ai')
  assert.equal(root.PiAiAdapter, narrow.PiAiAdapter)
  assert.deepEqual(readdirSync(new URL('../lib/', import.meta.url)).filter(name => name.endsWith('.js')).sort(),
    [...loaded.keys()].map(url => url.slice(packageLib.length)).sort())
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  assert.equal(Object.getPrototypeOf(narrow.PiAiAdapter), LlmAdapter)
  const profiles = narrow.createPiAiProfiles({ openai: {
    api: 'openai-completions', baseURL: 'https://host.example/v1',
    models: [{ id: 'gpt-4o', contextWindow: 8192, maxTokens: 128, input: ['text'], reasoningEfforts: false }],
    retryPolicy: { mode: 'normal', maxRetries: 0 },
  } })
  assert.equal(profiles.get('openai').piProvider.getModels().length, 1)
  assert.equal(profiles.get('openai').requireApiKey, true)
  console.log('Built public adapter imports, narrow module graph, explicit factory, and class identity: PASS')
} finally {
  hooks.deregister()
}

// No repository tsconfig inheritance or source aliases: consume published declarations.
const temporary = mkdtempSync(fileURLToPath(new URL('../.adapter-types-', import.meta.url)))
try {
  writeFileSync(join(temporary, 'consumer.ts'), `
import { PiAiAdapter, createPiAiProfiles } from '@deepseek-ai/dsh-llm-pi-ai/adapter'
import type { PiAiAuthInjection, PiAiTransport } from '@deepseek-ai/dsh-llm-pi-ai/adapter'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
declare const auth: PiAiAuthInjection
declare const transport: PiAiTransport
const profiles = createPiAiProfiles({ host: {
  api: 'openai-completions', baseURL: 'https://host.example/v1',
  models: [{ id: 'host-model', contextWindow: 8192, maxTokens: 128, input: ['text'], reasoningEfforts: false }],
  retryPolicy: { mode: 'normal', maxRetries: 0 },
} })
const adapter: LlmAdapter = new PiAiAdapter({ profiles: () => profiles, auth, transport, resolveApiKey: async () => 'synthetic' })
void adapter
// @ts-expect-error Host routes cannot omit their explicit configuration.
createPiAiProfiles({ host: {} })
`)
  writeFileSync(join(temporary, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'es2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: ['node'] },
    include: ['consumer.ts'],
  }))
  execFileSync(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '-p', temporary], { stdio: 'inherit' })
  console.log('Built public adapter NodeNext declaration consumer: PASS (third-party lib checking skipped)')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
