/** Loader configuration and real HTTP responses for deployment-owned authentication guidance. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it } from 'vitest'
import * as Connection from '../src/index.ts'

const OFFICIAL_MESSAGE = 'dsh web authentication required; reopen the URL printed by dsh web.\n'
const PRODUCT_MESSAGE = 'Example app authentication required; reopen the application startup URL.\n'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function boot(authenticationRequiredMessage?: string): Promise<{ ctx: Context; baseUrl: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-auth-copy-'))
  roots.push(root)
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { name: 'cordis:credentials', config: { path: join(root, '.credentials.yaml'), dshHome: root, watch: false } },
    { name: 'cordis:webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'connection', name: 'cordis:connection', config: {
      ...authenticationRequiredMessage === undefined ? {} : { authenticationRequiredMessage },
    } },
    { name: 'cordis:index' },
  ]))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.credentials = LocalCredentials
  ctx.loader.builtins.webserver = WebServer
  ctx.loader.builtins.connection = Connection
  ctx.loader.builtins.index = {
    inject: ['connection', 'webServer'],
    apply(owner: Context) {
      owner.effect(() => owner.webServer.register({
        kind: 'exact', path: '/',
        handler: (req, res) => {
          if (!owner.connection.authorizeIndex(req, res)) return
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end('<main>ready</main>')
        },
      }))
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  return { ctx, baseUrl: `http://127.0.0.1:${ctx.webServer.port}/` }
}

it.each([undefined, PRODUCT_MESSAGE])('serves the configured index error with unchanged authentication: %s', async (message) => {
  const { ctx, baseUrl } = await boot(message)
  const expected = message ?? OFFICIAL_MESSAGE
  for (const suffix of ['', '?token=invalid', '?token=invalid&token=again']) {
    const denied = await fetch(baseUrl + suffix, { redirect: 'manual' })
    expect(denied.status).toBe(401)
    expect(denied.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(denied.headers.get('cache-control')).toBe('no-store')
    expect(denied.headers.get('set-cookie')).toBeNull()
    expect(denied.headers.get('location')).toBeNull()
    expect(await denied.text()).toBe(expected)
  }
  const head = await fetch(baseUrl, { method: 'HEAD' })
  expect(head.status).toBe(401)
  expect(head.headers.get('cache-control')).toBe('no-store')
  expect(head.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(await head.text()).toBe('')

  const launchUrl = ctx.connection.authenticatedUrl(baseUrl)
  expect([...new URL(launchUrl).searchParams.keys()]).toEqual(['token'])
  const exchange = await fetch(launchUrl, { redirect: 'manual' })
  expect(exchange.status).toBe(303)
  expect(exchange.headers.get('location')).toBe('./')
  expect(exchange.headers.get('cache-control')).toBe('no-store')
  expect(exchange.headers.get('referrer-policy')).toBe('no-referrer')
  const setCookie = exchange.headers.get('set-cookie')
  expect(setCookie).toMatch(/; HttpOnly; SameSite=Strict$/u)
  const cookie = setCookie?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('launch token exchange did not set a browser cookie')
  const admitted = await fetch(baseUrl, { headers: { cookie } })
  expect(admitted.status).toBe(200)
  expect(await admitted.text()).toBe('<main>ready</main>')
  const api = await fetch(new URL('/api/status', baseUrl), { redirect: 'manual' })
  expect(api.status).toBe(401)
  expect(await api.text()).toBe('unauthorized')
})

it('keeps markup and header-shaped text inside the plain-text error body', async () => {
  const message = '<script>alert("example")</script>\r\nLocation: /login\n'
  const { baseUrl } = await boot(message)
  const response = await fetch(baseUrl, { redirect: 'manual' })
  expect(response.status).toBe(401)
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(response.headers.get('location')).toBeNull()
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(await response.text()).toBe(message)
})

it('validates the configured error text before plugin activation', () => {
  expect(Connection.Config({}).authenticationRequiredMessage).toBe(OFFICIAL_MESSAGE)
  expect(() => Connection.Config({ authenticationRequiredMessage: '' })).toThrow()
})
