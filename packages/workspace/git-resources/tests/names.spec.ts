/** File names compare the way Git on this Host reads them from disk. */
import { link, lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ResourceGit } from '../src/git.ts'
import { assertReadableNames, gitNameOf, nameRules, namedPaths, readPrecompose, unreadableNames, withCodePoints } from '../src/names.ts'
import { exactPaths, targetRefusal } from '../src/application.ts'
import { indexInfo } from '../src/manifest.ts'
import { harness } from './harness.ts'

const signal = new AbortController().signal
const composing = { composesDecomposed: true }, plain = { composesDecomposed: false }

/** Names on disk and the name Git for macOS with core.precomposeunicode true lists for each; `undefined` is refused. */
const table: readonly (readonly [string, string, string | undefined])[] = [
  ['decomposed Latin', 'cafe\u0301', 'caf\u00e9'],
  ['composed Latin', 'caf\u00e9', 'caf\u00e9'],
  ['decomposed Hangul jamo', '\u1112\u1161\u11ab', '\ud55c'],
  ['composed Hangul', '\ud55c', '\ud55c'],
  ['decomposed kana', '\u304b\u3099', '\u304c'],
  ['decomposed symbol', '=\u0338', '\u2260'],
  ['decomposed arrow', '\u2190\u0338', '\u219a'],
  ['Devanagari composition exclusion', '\u0915\u093c', '\u0915\u093c'],
  ['Hebrew composition exclusion', '\u05e9\u05c1', '\u05e9\u05c1'],
  ['mark with no composite', 'q\u0301', 'q\u0301'],
  ['composed letter and a further mark', '\u00e9\u0301', '\u00e9\u0301'],
  ['ANGSTROM SIGN', '\u212b', '\u212b'],
  ['OHM SIGN', '\u2126', '\u2126'],
  ['KELVIN SIGN', '\u212a', '\u212a'],
  ['Greek with a singleton decomposition', '\u1f71', '\u1f71'],
  ['CJK compatibility ideograph', '\uf900', '\uf900'],
  ['decomposed and composed forms mixed', 'e\u0301\u00e9', undefined],
  ['marks out of canonical order', 'e\u0301\u0327', undefined],
  ['singleton followed by a mark', '\u212b\u0301', undefined],
  ['ASCII', 'plain-name.txt', 'plain-name.txt'],
  // Git for macOS lacks the composites Unicode added for later scripts, and leaves a name holding any code point outside
  // the Basic Multilingual Plane entirely as it is.
  ['decomposed Balinese', '\u1b05\u1b35', '\u1b05\u1b35'],
  ['decomposed Balinese vowel sign', '\u1b13\u1b3a\u1b35', '\u1b13\u1b3a\u1b35'],
  ['composed Balinese vowel sign', '\u1b13\u1b3b', '\u1b13\u1b3b'],
  ['decomposed Balinese and Latin', '\u1b05\u1b35e\u0301', '\u1b05\u1b35\u00e9'],
  ['composed Latin and decomposed Balinese', '\u00e9\u1b05\u1b35', '\u00e9\u1b05\u1b35'],
  ['decomposed Kaithi', '\u{11099}\u{110ba}', '\u{11099}\u{110ba}'],
  ['decomposed Chakma', '\u{11131}\u{11127}', '\u{11131}\u{11127}'],
  ['decomposed Grantha', '\u{11347}\u{1133e}', '\u{11347}\u{1133e}'],
  ['decomposed Tirhuta', '\u{114b9}\u{114ba}', '\u{114b9}\u{114ba}'],
  ['decomposed Siddham', '\u{115b8}\u{115af}', '\u{115b8}\u{115af}'],
  ['decomposed Dives Akuru', '\u{11935}\u{11930}', '\u{11935}\u{11930}'],
  ['decomposed Kaithi and Latin', '\u{11099}\u{110ba}e\u0301', '\u{11099}\u{110ba}e\u0301'],
  ['emoji and decomposed Latin', '\u{1f44d}cafe\u0301', '\u{1f44d}cafe\u0301'],
  ['decomposed Latin and CJK Extension B', 'e\u0301\u{20000}', 'e\u0301\u{20000}'],
  ['emoji and decomposed Hangul jamo', '\u{1f600}\u1112\u1161\u11ab', '\u{1f600}\u1112\u1161\u11ab'],
]

describe('names Git reads from disk', () => {
  it.each(table)('composes %s as Git for macOS does', (_label, raw, git) => {
    expect(gitNameOf(raw, composing)).toBe(git)
    expect(gitNameOf(raw, plain)).toBe(raw)
  })

  it('lists tree paths with a name Git cannot read under itself, by any component', () => {
    const paths = ['caf\u00e9/notes.txt', 'Re\u0301/file.txt', 'docs/cafe\u0301.txt', '\u212b.txt', 'mixed/e\u0301\u00e9']
    expect(unreadableNames(paths, composing)).toEqual(['Re\u0301/file.txt', 'docs/cafe\u0301.txt', 'mixed/e\u0301\u00e9'])
    expect(unreadableNames(paths, plain)).toEqual([])
    expect(() => { assertReadableNames(paths, plain) }).not.toThrow()
    // Each name is followed by the code points of the names Git reads otherwise, so a decomposed name reads apart from the
    // composed one it looks like; the step that clears the refusal follows.
    expect(() => { assertReadableNames(paths, composing) }).toThrow(expect.objectContaining({ code: 'PATH_NAME_UNREPRESENTABLE',
      message: 'Git on this Mac reads these file names in another Unicode form than they are recorded in, so they cannot be copied or written back exactly (the brackets hold the non-ASCII code points of each recorded name that Git reads otherwise): Re\u0301/file.txt [U+0301], docs/cafe\u0301.txt [U+0301], mixed/e\u0301\u00e9 [U+0301 U+00E9]. They stay refused until each is recorded in composed form: rename it with `git -c core.precomposeunicode=false mv -f <name> <composed name>` in the repository that records it, then commit' }))
    expect(() => { assertReadableNames(['Re\u0301/cafe\u0301.txt', '\u1112\u1161\u11ab/\u00e9.txt'], composing) })
      .toThrow(/: Re\u0301\/cafe\u0301\.txt \[U\+0301 U\+0301\], \u1112\u1161\u11ab\/\u00e9\.txt \[U\+1112 U\+1161 U\+11AB\]\. They stay/u)
  })

  it('follows a path with the code points of its last name only when that name is not plain ASCII', () => {
    expect(withCodePoints('docs/cafe\u0301.txt')).toBe('docs/cafe\u0301.txt [U+0301]')
    expect(withCodePoints('R\u00e9/notes.txt')).toBe('R\u00e9/notes.txt')
    expect(withCodePoints('\u{1f44d}')).toBe('\u{1f44d} [U+1F44D]')
  })

  it('names at most 20 refused paths and counts the rest', () => {
    const paths = Array.from({ length: 23 }, (_, index) => `f${index}`)
    expect(namedPaths(paths)).toBe(`${paths.slice(0, 20).join(', ')} and 3 more`)
    expect(namedPaths(paths.slice(0, 20))).toBe(paths.slice(0, 20).join(', '))
  })
})

describe('the repository setting', () => {
  async function repository(setting?: string) {
    const test = await harness(); test.git(['init', '--quiet'])
    // git init on macOS writes the setting and elsewhere does not; setting it first makes the unset case the same everywhere.
    test.git(['config', 'core.precomposeunicode', setting ?? 'true'])
    if (setting === undefined) test.git(['config', '--unset', 'core.precomposeunicode'])
    const runner = new ResourceGit(test.ctx.subprocess, 'git', join(test.root, 'git-home'), {
      timeoutMs: 10_000, graceMs: 100, maxOutputBytes: 1_000_000 })
    return { ...test, runner }
  }

  it.each([['true', 'true'], ['yes', 'true'], ['false', 'false'], ['0', 'false'], [undefined, 'unset']] as const)(
    'reads %s as %s and composes only on macOS when true', async (setting, read) => {
      const test = await repository(setting)
      expect(await readPrecompose(test.runner, test.project, signal)).toBe(read)
      expect(await nameRules(test.runner, test.project, signal, 'darwin')).toEqual({ composesDecomposed: read === 'true' })
      for (const platform of ['linux', 'win32'] as const) {
        expect(await nameRules(test.runner, test.project, signal, platform)).toEqual({ composesDecomposed: false })
      }
    })

  it('refuses a value that is not a boolean on macOS, where Git refuses it too, and never reads it elsewhere', async () => {
    const test = await repository('maybe')
    await expect(nameRules(test.runner, test.project, signal, 'darwin')).rejects.toMatchObject({ code: 'GIT_METADATA_INVALID',
      message: 'Repository setting core.precomposeunicode is not a boolean' })
    expect(await nameRules(test.runner, test.project, signal, 'linux')).toEqual({ composesDecomposed: false })
  })
})

describe('exact names on disk', () => {
  async function tree() {
    const test = await harness()
    await mkdir(join(test.project, 'Re\u0301'))
    await writeFile(join(test.project, 'Re\u0301', 'cafe\u0301.txt'), 'disk\n')
    await mkdir(join(test.project, 'docs'))
    await writeFile(join(test.project, 'docs', 'file.txt'), 'disk\n')
    return test
  }
  const caseInsensitive = (root: string) => lstat(join(root, 'DOCS')).then(() => true, () => false)
  const normalizationInsensitive = (root: string) => lstat(join(root, 'R\u00e9')).then(() => true, () => false)

  it('takes the names as they are when Git does not compose them', async () => {
    const test = await tree(), exact = exactPaths(test.project, plain), same = { exact: true }
    expect(await exact('Re\u0301/cafe\u0301.txt')).toEqual(same)
    expect(await exact('docs/file.txt')).toEqual(same)
    expect(await exact('docs/new/deeper.txt')).toEqual(same)
    // A name that exists only through another normalization or case is not the path and is named as on disk; a name that
    // does not exist at all is the path.
    expect(await exact('R\u00e9/caf\u00e9.txt')).toEqual(await normalizationInsensitive(test.project)
      ? { exact: false, onDisk: 'Re\u0301' } : same)
    expect(await exact('Docs/file.txt')).toEqual(await caseInsensitive(test.project) ? { exact: false, onDisk: 'docs' } : same)
    expect(await exact('Docs/new.txt')).toEqual(await caseInsensitive(test.project) ? { exact: false, onDisk: 'docs' } : same)
  })

  it('never takes a decomposed path as itself when Git lists its name on disk composed', async () => {
    const test = await tree()
    expect(await exactPaths(test.project, composing)('Re\u0301/cafe\u0301.txt')).toEqual({ exact: false, onDisk: 'Re\u0301' })
  })

  it.runIf(process.platform === 'darwin')('takes decomposed names on disk as their composed form when Git composes them', async () => {
    const test = await tree(), exact = exactPaths(test.project, composing)
    expect(await exact('R\u00e9/caf\u00e9.txt')).toEqual({ exact: true })
    expect(await exact('R\u00e9/new.txt')).toEqual({ exact: true })
  })

  it('refuses a name on disk whose form Git would not settle', async () => {
    const test = await harness()
    await writeFile(join(test.project, 'e\u0301\u00e9.txt'), 'disk\n')
    expect(await exactPaths(test.project, composing)('e\u0301\u00e9.txt')).toEqual({ exact: false, onDisk: 'e\u0301\u00e9.txt' })
    expect(await exactPaths(test.project, plain)('e\u0301\u00e9.txt')).toEqual({ exact: true })
  })

  it('names the entry that is the opened file, before another link to it', async () => {
    const test = await harness()
    await writeFile(join(test.project, 'Readme.md'), 'disk\n')
    await link(join(test.project, 'Readme.md'), join(test.project, 'A-link.md'))
    const aliased = await lstat(join(test.project, 'README.md')).then(() => true, () => false)
    expect(await exactPaths(test.project, plain)('README.md')).toEqual(aliased ? { exact: false, onDisk: 'Readme.md' } : { exact: true })
  })

  it('gives no spelling on disk for a name that appeared after its directory was listed', async () => {
    const test = await harness()
    await writeFile(join(test.project, 'gone.txt'), 'disk\n')
    const exact = exactPaths(test.project, plain)
    expect(await exact('later.txt')).toEqual({ exact: true })
    // The listing read above holds neither the new file nor the removed one any more.
    await rm(join(test.project, 'gone.txt')); await writeFile(join(test.project, 'later.txt'), 'disk\n')
    expect(await exact('later.txt')).toEqual({ exact: false })
    expect(await exactPaths(test.project, plain)('later.txt')).toEqual({ exact: true })
  })
})

describe('refused touched paths', () => {
  const paths = ['README.md', 'Readme.md', 'caf\u00e9.txt', 'docs/new.txt', 'notes.txt', 'x.txt']
  const changed = { path: 'notes.txt', known: false, name: { exact: true } }
  const decomposed = { path: 'caf\u00e9.txt', known: true, name: { exact: false, onDisk: 'cafe\u0301.txt' } }
  const renamed = [{ path: 'docs/new.txt', known: true, name: { exact: false, onDisk: 'Docs' } }, decomposed]
  const twice = { path: 'README.md', known: true, name: { exact: false, onDisk: 'readme.md' } }
  const renamedText = 'Target names differ only in case or Unicode form from the names this version records: docs/new.txt (recorded docs, on disk Docs), caf\u00e9.txt (recorded caf\u00e9.txt [U+00E9], on disk cafe\u0301.txt [U+0301]); renaming each on disk to its recorded name lets the write-back proceed'
  const twiceText = 'This version records these names in two spellings that differ only in case or Unicode form, which this target holds as one name, so they are not written back here: README.md (recorded README.md, on disk readme.md)'

  it('reports changed content as changed', () => {
    expect(targetRefusal([changed], paths)).toMatchObject({ code: 'APPLICATION_TARGET_CHANGED',
      message: 'Target files changed from the state this version starts from and are not overwritten: notes.txt' })
  })

  it('reports names spelled otherwise on disk apart, with both spellings and whether renaming lets the write-back proceed', () => {
    expect(targetRefusal(renamed, paths)).toMatchObject({ code: 'APPLICATION_TARGET_NAME_MISMATCH', message: renamedText })
    // The version itself records README.md and Readme.md, which a target that compares names apart from case holds as one.
    expect(targetRefusal([twice], paths)).toMatchObject({ code: 'APPLICATION_TARGET_NAME_MISMATCH', message: twiceText })
    expect(targetRefusal([...renamed, twice], paths)).toMatchObject({ code: 'APPLICATION_TARGET_NAME_MISMATCH',
      message: `${renamedText}. ${twiceText}` })
  })

  it('reports changed content first, with any names after it', () => {
    // Content changed under another name, and a name whose spelling on disk could not be read, count as changed.
    const other = { path: 'x.txt', known: false, name: { exact: false, onDisk: 'X.txt' } }
    const unread = { path: 'docs/new.txt', known: true, name: { exact: false } }
    expect(targetRefusal([changed, other, unread, decomposed, twice], paths)).toMatchObject({
      code: 'APPLICATION_TARGET_CHANGED', message: 'Target files changed from the state this version starts from and are not overwritten: notes.txt, x.txt (recorded x.txt, on disk X.txt), docs/new.txt. Target names differ only in case or Unicode form from the names this version records: caf\u00e9.txt (recorded caf\u00e9.txt [U+00E9], on disk cafe\u0301.txt [U+0301]); renaming each on disk to its recorded name lets the write-back proceed. ' + twiceText })
  })
})

it('writes index rows byte-exact, whatever the name holds', async () => {
  const test = await harness(); test.git(['init', '--quiet'])
  const object = test.git(['hash-object', '-w', '--stdin'], 'content\n')
  // Windows file names cannot hold a line break, so Git for Windows may refuse one in the index too.
  const decomposed = 'cafe\u0301.txt', names = [decomposed, '-leading-dash', ...process.platform === 'win32' ? [] : ['line\nbreak.txt'], '\u212b.txt']
  const runner = new ResourceGit(test.ctx.subprocess, 'git', join(test.root, 'git-home'), {
    timeoutMs: 10_000, graceMs: 100, maxOutputBytes: 1_000_000 })
  await runner.run(['update-index', '-z', '--index-info'], test.project, signal,
    { input: indexInfo(names.map(name => [name, { mode: '100644', objectId: object }]), 'sha1') })
  expect(test.git(['ls-files', '-z']).split('\0').filter(Boolean).toSorted()).toEqual(names.toSorted())
  await runner.run(['update-index', '-z', '--index-info'], test.project, signal,
    { input: indexInfo([[decomposed, { kind: 'absent' }], ['never-there', { kind: 'absent' }]], 'sha1') })
  expect(test.git(['ls-files', '-z']).split('\0').filter(Boolean).toSorted()).toEqual(names.filter(name => name !== decomposed).toSorted())
})

it.runIf(process.platform === 'darwin')('composes every table name exactly as Git for macOS lists it', async () => {
  const test = await harness(); test.git(['init', '--quiet']); test.git(['config', 'core.precomposeunicode', 'true'])
  for (const [index, [, raw]] of table.entries()) await writeFile(join(test.project, `${index}-${raw}`), '')
  const listed = new Map(test.git(['ls-files', '-o', '-z']).split('\0').filter(Boolean)
    .map(name => [Number(name.slice(0, name.indexOf('-'))), name.slice(name.indexOf('-') + 1)]))
  for (const [index, [label, raw, git]] of table.entries()) {
    if (git === undefined) continue
    expect({ label, name: gitNameOf(raw, composing) }).toEqual({ label, name: listed.get(index) })
  }
})

it.runIf(process.platform === 'darwin')('reads every decomposable character, decomposed or not, as Git for macOS lists it or refuses a few marks', async () => {
  const test = await harness(); test.git(['init', '--quiet']); test.git(['config', 'core.precomposeunicode', 'true'])
  const names: string[] = []
  for (let point = 0x80; point <= 0x10ffff; point++) {
    // Hangul syllables compose by rule; the table holds them.
    if (point >= 0xd800 && point <= 0xdfff || point >= 0xac00 && point <= 0xd7a3) continue
    const character = String.fromCodePoint(point), decomposed = character.normalize('NFD')
    if (decomposed !== character) names.push(decomposed, character)
  }
  for (const [index, name] of names.entries()) await writeFile(join(test.project, `${index}-${name}`), '')
  const listed = new Map(test.git(['ls-files', '-o', '-z']).split('\0').filter(Boolean)
    .map(name => [Number(name.slice(0, name.indexOf('-'))), name.slice(name.indexOf('-') + 1)]))
  expect(listed.size).toBe(names.length)
  const differing = names.filter((name, index) => ![undefined, listed.get(index)].includes(gitNameOf(name, composing)))
  expect(differing).toEqual([])
  // Only these composed marks are refused: Git leaves them as they are, but canonical composition would replace them, as
  // they are composition exclusions or decompose to a single other mark.
  const refused = names.filter(name => gitNameOf(name, composing) === undefined)
  expect(refused).toEqual(['̀', '́', '̓', '̈́', 'ཱི', 'ཱུ', 'ྲྀ', 'ླྀ', 'ཱྀ', 'ྒྷ',
    'ྜྷ', 'ྡྷ', 'ྦྷ', 'ྫྷ', 'ྐྵ'])
})
