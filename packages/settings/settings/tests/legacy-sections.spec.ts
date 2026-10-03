/** Real ConfigEditor import: identity changes preserve user choices and original evidence. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { configurationFixture as fixture } from './configuration-fixture.ts'

it('maps section and field names while an existing profile override wins', async () => {
  const f = await fixture({ settingsConfig: { legacySections: {
    'old-model': { entryId: 'default-model', fieldRenames: { selected: 'model' } },
    'old-counter': { entryId: 'first', fieldRenames: { selected: 'count' } },
  } } })
  await f.ctx.settings.update('default-model', { model: 'profile-choice' })
  await f.ctx.fiber.dispose()
  const legacy = join(f.home, 'settings.yaml')
  const bytes = 'old-model:\n  selected: legacy-choice\nold-counter:\n  selected: 8\nunknown-owner:\n  secret: preserved\n'
  writeFileSync(legacy, bytes)
  const ctx = await f.start()
  await vi.waitFor(() => { expect(ctx.settings.describe().find(row => row.ns === 'first')?.value).toMatchObject({ count: 8 }) })
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('profile-choice')
  expect(readFileSync(`${legacy}.imported`, 'utf8')).toBe(bytes)
  await vi.waitFor(() => { expect(f.messages.some(row => row.type === 'warn' && row.args.some(value => typeof value === 'string' && value.includes('unknown-owner')))).toBe(true) })
})

it('refuses colliding renamed fields before mutating the entry', async () => {
  const f = await fixture({ settingsConfig: { legacySections: {
    old: { entryId: 'first', fieldRenames: { selected: 'count' } },
  } } })
  await f.ctx.fiber.dispose()
  const legacy = join(f.home, 'settings.yaml')
  const bytes = 'old:\n  selected: 8\n  count: 9\n'
  writeFileSync(legacy, bytes)
  const ctx = await f.start()
  await vi.waitFor(() => { expect(existsSync(legacy)).toBe(false) })
  expect(ctx.settings.describe().find(row => row.ns === 'first')?.value).toMatchObject({ count: 2 })
  expect(readFileSync(`${legacy}.imported`, 'utf8')).toBe(bytes)
  await vi.waitFor(() => { expect(f.messages.some(row => row.type === 'warn' && row.args.some(value => value instanceof Error && value.message.includes('conflicting field')))).toBe(true) })
})

it('refuses sections colliding at one target without importing either value', async () => {
  const f = await fixture({ settingsConfig: { legacySections: {
    old: { entryId: 'first' }, other: { entryId: 'first' },
  } } })
  await f.ctx.fiber.dispose()
  const legacy = join(f.home, 'settings.yaml')
  writeFileSync(legacy, 'old:\n  count: 8\nother:\n  count: 9\n')
  const ctx = await f.start()
  await vi.waitFor(() => { expect(existsSync(legacy)).toBe(false) })
  expect(ctx.settings.describe().find(row => row.ns === 'first')?.value).toMatchObject({ count: 2 })
  await vi.waitFor(() => { expect(f.messages.some(row => row.type === 'warn' && row.args.some(value => value instanceof Error && value.message.includes('conflict at entry')))).toBe(true) })
})

it('rejects a mapping with duplicate destination keys at configuration admission', async () => {
  const f = await fixture({ settingsConfig: { legacySections: {
    old: { entryId: 'first', fieldRenames: { first: 'count', second: 'count' } },
  } } })
  expect(f.ctx.get('settings')).toBeUndefined()
  expect([...f.ctx.loader.entries()].find(row => row.options.id === 'settings')?.fiber?.state).toBe(FiberState.FAILED)
})

it('retains malformed legacy documents and does not modify live configuration', async () => {
  const f = await fixture()
  await f.ctx.fiber.dispose()
  const legacy = join(f.home, 'settings.yaml')
  writeFileSync(legacy, '- not a section document\n')
  const ctx = await f.start()
  await vi.waitFor(() => { expect(f.messages.some(row => row.type === 'error' && row.args.some(value => value instanceof Error && value.message.includes('must contain an object')))).toBe(true) })
  expect(ctx.agentDefaultModel.currentSelection().model).toBe('original')
  expect(readFileSync(`${legacy}.imported`, 'utf8')).toBe('- not a section document\n')
})
