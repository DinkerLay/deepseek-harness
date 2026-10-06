/** Shared immutable Git tree identity; filesystem scans remain with the resource owner. */
import type { TreeEntry } from './preview.ts'
import { hash } from './json-hash.ts'
import { z } from 'zod'

/** Exact regular content or definite absence; unsupported types never become empty files. */
export type GitFileState = { readonly kind: 'absent' }
  | { readonly kind: 'file'; readonly mode: '100644' | '100755'; readonly objectId: string; readonly rawHash: string }
/** One complete application path has both original and intended immutable bytes. */
export interface GitApplicationPath {
  readonly path: string
  readonly before: GitFileState
  readonly after: GitFileState
}
/** Parser for immutable Git object names in either supported object format. */
export const gitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)
/** Strict per-path content facts support pure crash observation without replaying writes. */
export const gitFileStateSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('absent') }).strict(),
  z.object({ kind: z.literal('file'), mode: z.enum(['100644', '100755']), objectId: gitObjectIdSchema,
    rawHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()])
/** Strict before/after manifest entry; filesystem paths are checked by the existing path owner. */
export const applicationPathSchema = z.object({ path: z.string().min(1), before: gitFileStateSchema, after: gitFileStateSchema }).strict()

/** Hash the complete ordered Git tree entries, including actual blob byte lengths.
 * @param entries - bounded entries returned by the sole Git tree reader.
 * @returns the existing immutable preservation digest, without scanning working files.
 */
export function treeManifestHash(entries: readonly TreeEntry[]): string { return hash(entries) }
