/** How Git on this Host reads file names on disk, and which tree paths it cannot read under their own name. */
import type { ResourceGit } from './git.ts'
import { GitResourceError } from './error.ts'

/** How Git on this Host turns a file name read from disk into a path name. */
export interface GitNameRules {
  /** Git composes decomposed Unicode names it reads from disk; only Git for macOS does, and only with core.precomposeunicode true. */
  readonly composesDecomposed: boolean
}

/** Paths named in a refusal; the rest are counted. */
const NAMED_PATHS = 20

/** Name refused paths in a bounded diagnostic.
 * @param paths - refused paths in their reported order.
 * @returns the first paths, then a count of the rest.
 */
export function namedPaths(paths: readonly string[]): string {
  const more = paths.length - NAMED_PATHS
  return `${paths.slice(0, NAMED_PATHS).join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

/** Read core.precomposeunicode through the owner's isolated runner, which sees only the repository's own configuration,
 * the configuration every Git command of this owner runs with.
 * @param git - isolated runner.
 * @param root - repository or work-copy directory.
 * @param signal - cancellation.
 * @returns the boolean setting, or `unset` when the repository does not set it.
 */
export async function readPrecompose(git: ResourceGit, root: string, signal: AbortSignal): Promise<'true' | 'false' | 'unset'> {
  const read = await git.run(['config', '--bool', '--get', 'core.precomposeunicode'], root, signal, { allowFailure: true })
  if (read.status === 1) return 'unset'
  // Git for macOS refuses every command on a value that is not a boolean; it is refused here the same way.
  if (read.status !== 0) throw new GitResourceError('GIT_METADATA_INVALID', 'Repository setting core.precomposeunicode is not a boolean')
  return read.stdout.toString('utf8').trim() === 'true' ? 'true' : 'false'
}

/** Decide how Git reads file names in one repository on this Host. Git composes decomposed names only in its macOS build
 * and only when the setting is true; unset counts as false, and other platforms never read the setting.
 * @param git - isolated runner.
 * @param root - repository or work-copy directory.
 * @param signal - cancellation.
 * @param platform - this Host's operating system.
 * @returns the rules for comparing names on disk with tree paths.
 */
export async function nameRules(git: ResourceGit, root: string, signal: AbortSignal,
  platform: NodeJS.Platform): Promise<GitNameRules> {
  return { composesDecomposed: platform === 'darwin' && await readPrecompose(git, root, signal) === 'true' }
}

/** Code points that combine with the character before them: marks and the Hangul vowel and final jamo. */
const COMBINING = /[\p{M}\u1160-\u11FF\uD7B0-\uD7FF]/u
/** Code points outside the Basic Multilingual Plane; Git for macOS leaves a name holding one entirely as it is. */
const SUPPLEMENTARY = /[\u{10000}-\u{10FFFF}]/u
/** The Balinese block. The composition table of Git for macOS lacks the composites Unicode added for scripts encoded
 * after version 3.2; inside the Basic Multilingual Plane those are the Balinese ones. */
const LATER_COMPOSITES = /[\u1B00-\u1B7F]/gu

/** Compose a name as Git for macOS does: canonical composition, except Balinese composites. A Balinese composite the
 * name already holds is split as well, so this matches Git only for a name without one.
 * @param name - a name without code points outside the Basic Multilingual Plane.
 * @returns the composed name.
 */
function compose(name: string): string {
  return name.normalize('NFC').replace(LATER_COMPOSITES, character => character.normalize('NFD'))
}

/** The name Git reads for one name on disk, emulating Git for macOS: it composes base and combining sequences, except
 * pairs Unicode added after Unicode 3.2 (such as Balinese); never splits a character the name holds, so it leaves alone
 * a name already in composed form and characters whose only decomposition is a single other character (U+212B ANGSTROM
 * SIGN, U+2126 OHM SIGN, U+212A KELVIN SIGN, U+1F71, CJK compatibility ideographs), which `String.normalize('NFC')`
 * would replace; and leaves a name holding any code point outside the Basic Multilingual Plane (emoji, CJK Extension B,
 * Kaithi, Chakma, Grantha, Tirhuta, Siddham, Dives Akuru) entirely as it is.
 * @param raw - one name component as read from disk.
 * @param rules - how Git on this Host reads names.
 * @returns Git's name, or `undefined` when the name mixes decomposed and composed forms and Git's result is not certain.
 */
export function gitNameOf(raw: string, rules: GitNameRules): string | undefined {
  if (!rules.composesDecomposed || !/[^\0-\x7f]/u.test(raw) || SUPPLEMENTARY.test(raw)) return raw
  if (raw === raw.normalize('NFD')) return compose(raw)
  if (!COMBINING.test(raw) || raw === raw.normalize('NFC') || raw === compose(raw)) return raw
  return undefined
}

/** The non-ASCII code points of a name, so names that differ only in Unicode form read apart.
 * @param name - a name or path.
 * @returns each non-ASCII code point as `U+XXXX`, in order.
 */
function codePoints(name: string): string[] {
  return (name.match(/[^\0-\x7f]/gu) ?? [])
    .map(character => `U+${Number(character.codePointAt(0)).toString(16).toUpperCase().padStart(4, '0')}`)
}

/** A path followed by the non-ASCII code points of its last name.
 * @param path - a path.
 * @returns the path, with the code points in brackets when its last name has any.
 */
export function withCodePoints(path: string): string {
  const points = codePoints(path.slice(path.lastIndexOf('/') + 1))
  return points.length === 0 ? path : `${path} [${points.join(' ')}]`
}

/** Tree paths Git on this Host cannot read under their own name: a file written under such a path is listed by Git under
 * another name, or under no certain one.
 * @param paths - tree paths.
 * @param rules - how Git on this Host reads names.
 * @returns the paths with such a name component, in their given order.
 */
export function unreadableNames(paths: Iterable<string>, rules: GitNameRules): string[] {
  return [...paths].filter(path => path.split('/').some(name => gitNameOf(name, rules) !== name))
}

/** Refuse tree paths Git on this Host cannot read under their own name; nothing written under them stays the same path.
 * The refusal lasts until the names are recorded in composed form.
 * @param paths - tree paths about to be copied or written.
 * @param rules - how Git on this Host reads names.
 */
export function assertReadableNames(paths: Iterable<string>, rules: GitNameRules): void {
  const unreadable = unreadableNames(paths, rules).map(path =>
    `${path} [${path.split('/').filter(name => gitNameOf(name, rules) !== name).flatMap(codePoints).join(' ')}]`)
  if (unreadable.length > 0) {
    throw new GitResourceError('PATH_NAME_UNREPRESENTABLE', `Git on this Mac reads these file names in another Unicode form than they are recorded in, so they cannot be copied or written back exactly (the brackets hold the non-ASCII code points of each recorded name that Git reads otherwise): ${namedPaths(unreadable)}. They stay refused until each is recorded in composed form: rename it with \`git -c core.precomposeunicode=false mv -f <name> <composed name>\` in the repository that records it, then commit`)
  }
}
