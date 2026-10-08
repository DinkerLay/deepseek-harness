import { describe, expect, it } from 'vitest'
import { browserResourceAddress, browserResourceTarget } from '../src/client/browser/resource-address.ts'
import { MAX_BROWSER_URL_LENGTH } from '../src/client/browser/url.ts'

describe('stable webpage resource addresses', () => {
  it('uses normalized URL identity and decodes paths, queries and fragments once', () => {
    const first = browserResourceAddress('https://EXAMPLE.com:443/a?q=✓#section')
    const same = browserResourceAddress('https://example.com/a?q=✓#section')
    expect(first).toEqual(same)
    if (!first.ok) throw new Error('Expected a valid URL')
    expect(first.address).not.toContain('EXAMPLE')
    expect(browserResourceTarget(first.address)).toEqual({ ok: true, target: first.target })
  })
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.com/', 'https://app.test/'])('refuses %s without an address', (url) => {
    expect(browserResourceAddress(url, 'https://app.test')).toMatchObject({ ok: false })
  })
  it.each(['dsh-resource://webpage/%', 'dsh-resource://webpage/https%3A%2F%2Fexample.com/extra',
    'dsh-resource://webpage/https%3A%2F%2Fexample.com?extra', 'dsh-resource://other/https%3A%2F%2Fexample.com',
    'dsh-resource://webpage/javascript%3Aalert(1)'])('refuses malformed or unrelated identity %s', (address) => {
    expect(browserResourceTarget(address)).toMatchObject({ ok: false })
  })
  it('bounds both decoded URL input and encoded input before allocating a target', () => {
    expect(browserResourceAddress(`https://example.com/${'x'.repeat(MAX_BROWSER_URL_LENGTH)}`)).toEqual({ ok: false, reason: 'invalid' })
    expect(browserResourceTarget(`dsh-resource://webpage/${'x'.repeat(MAX_BROWSER_URL_LENGTH * 3 + 1)}`)).toEqual({ ok: false, reason: 'invalid' })
    const expanded = `https://example.com/${'✓'.repeat(MAX_BROWSER_URL_LENGTH / 2)}`
    expect(browserResourceAddress(expanded)).toEqual({ ok: false, reason: 'invalid' })
    expect(browserResourceTarget(`dsh-resource://webpage/${encodeURIComponent(expanded)}`)).toEqual({ ok: false, reason: 'invalid' })
  })
})
