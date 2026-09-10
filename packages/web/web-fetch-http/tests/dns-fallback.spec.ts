import { Buffer } from 'node:buffer'
import type { LookupAddress } from 'node:dns'
import { encode, RECURSION_DESIRED } from 'dns-packet'
import type { Response as UndiciResponse } from 'undici'
import { installProxyFromEnvironment, proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeIpFallback } from '../src/dns-fallback.ts'
import { publicHttpNetwork } from '../src/network.ts'

function dnsResponse(name: string, type: 'A' | 'AAAA', answers: LookupAddress[]): UndiciResponse {
  const body = encode({
    type: 'response',
    id: 0,
    flags: RECURSION_DESIRED,
    questions: [{ name, type, class: 'IN' }],
    answers: answers.map(answer => ({
      name,
      type: answer.family === 4 ? 'A' as const : 'AAAA' as const,
      class: 'IN' as const,
      ttl: 60,
      data: answer.address,
    })),
  })
  return new Response(Buffer.from(body), {
    status: 200,
    headers: { 'content-type': 'application/dns-message' },
  }) as unknown as UndiciResponse
}

function fallback() {
  return createFakeIpFallback({
    endpoint: 'https://cloudflare-dns.com/dns-query',
    bootstrapAddresses: ['1.1.1.1', '1.0.0.1'],
    ranges: ['198.18.0.0/15'],
    timeoutMs: 1_000,
  })
}

afterEach(() => { vi.restoreAllMocks() })

describe('direct Fake-IP DNS recovery', () => {
  it('pins the configured DoH endpoint and returns matched A and AAAA answers', async () => {
    const close = vi.fn(async () => {})
    const request = vi.spyOn(publicHttpNetwork, 'request')
      .mockResolvedValueOnce({ response: dnsResponse('example.com', 'A', [{ address: '8.8.8.8', family: 4 }]), close })
      .mockResolvedValueOnce({ response: dnsResponse('example.com', 'AAAA', [{ address: '2001:4860:4860::8888', family: 6 }]), close })

    await expect(fallback().resolve('example.com', new AbortController().signal)).resolves.toEqual([
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 },
    ])
    expect(request).toHaveBeenCalledTimes(2)
    for (const [url, addresses, headers] of request.mock.calls) {
      expect(url.origin + url.pathname).toBe('https://cloudflare-dns.com/dns-query')
      expect(url.searchParams.get('dns')).toMatch(/^[A-Za-z0-9_-]+$/u)
      expect(addresses).toEqual([{ address: '1.1.1.1', family: 4 }, { address: '1.0.0.1', family: 4 }])
      expect(headers).toEqual({ accept: 'application/dns-message' })
    }
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('keeps a NO_PROXY origin direct while routing the resolver through native proxy policy', async () => {
    const values: Record<string, string> = {
      HTTPS_PROXY: 'http://proxy.example:8080',
      NO_PROXY: 'origin.test',
    }
    const dispose = await installProxyFromEnvironment({
      get: name => values[name] === undefined ? undefined : { value: values[name]! },
    }, () => {})
    const close = vi.fn(async () => {})
    const request = vi.spyOn(publicHttpNetwork, 'request')
    const requestVia = vi.spyOn(publicHttpNetwork, 'requestVia')
      .mockResolvedValueOnce({ response: dnsResponse('example.com', 'A', [{ address: '8.8.8.8', family: 4 }]), close })
      .mockResolvedValueOnce({ response: dnsResponse('example.com', 'AAAA', []), close })
    try {
      expect(proxyRouteFor(new URL('https://origin.test/resource'))).toEqual({ proxied: false })
      expect(proxyRouteFor(new URL('https://cloudflare-dns.com/dns-query')).proxied).toBe(true)
      await expect(fallback().resolve('example.com', new AbortController().signal))
        .resolves.toEqual([{ address: '8.8.8.8', family: 4 }])
      expect(request).not.toHaveBeenCalled()
      expect(requestVia).toHaveBeenCalledTimes(2)
    } finally {
      await dispose()
    }
  })

  it('rejects a mismatched DNS response and closes its pinned request', async () => {
    const close = vi.fn(async () => {})
    vi.spyOn(publicHttpNetwork, 'request').mockResolvedValue({
      response: dnsResponse('other.example', 'A', [{ address: '8.8.8.8', family: 4 }]),
      close,
    })
    await expect(fallback().resolve('example.com', new AbortController().signal))
      .rejects.toMatchObject({ code: 'WEB_DNS_RESOLUTION_FAILED' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('classifies an unreachable resolver without swallowing caller cancellation', async () => {
    vi.spyOn(publicHttpNetwork, 'request').mockRejectedValueOnce(new Error('unreachable'))
    await expect(fallback().resolve('example.com', new AbortController().signal))
      .rejects.toMatchObject({ code: 'WEB_DNS_RESOLUTION_FAILED' })

    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(fallback().resolve('example.com', controller.signal)).rejects.toThrow('caller stopped')
  })

  it.each([
    [{ endpoint: 'http://resolver.example/dns-query' }, 'HTTPS URL'],
    [{ bootstrapAddresses: ['127.0.0.1'] }, 'public IP literals'],
    [{ ranges: ['not-a-range'] }, 'valid CIDRs'],
    [{ timeoutMs: 0 }, 'must be positive'],
  ] as const)('rejects unsafe resolver configuration %j', (override, message) => {
    expect(() => createFakeIpFallback({
      endpoint: 'https://resolver.example/dns-query',
      bootstrapAddresses: ['8.8.8.8'],
      ranges: ['198.18.0.0/15'],
      timeoutMs: 1_000,
      ...override,
    })).toThrow(message)
  })
})
