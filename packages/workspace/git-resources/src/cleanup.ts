/** Cleanup selectors describe an exact owned path and file-content preservation, never rollback or cwd authority. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { GitOperationId, GitPathIdentity, GitResourceId } from './types.ts'

/** Read-only full file-content and metadata cut; empty directories and unpreserved index objects refuse. */
export interface GitResourceCleanupPreview {
  readonly resourceId: GitResourceId
  readonly resourceRevision: number
  readonly pathIdentity: GitPathIdentity
  readonly gitDirIdentity: GitPathIdentity
  readonly preserveOperationId: GitOperationId
  readonly commit: string
  readonly tree: string
  readonly manifestHash: string
  readonly ref: string
  readonly head: string
  readonly indexHash: string
  readonly fingerprint: string
}
/** Stable explicit cleanup intent; no model-authored assertion can replace the Host unused-cwd proof. */
export interface GitResourceCleanupRequest {
  readonly operationId: GitOperationId
  readonly resourceId: GitResourceId
  readonly expectedPreviewFingerprint: string
  readonly originalRequestJson?: string | undefined
}
/** Partial directory/admin removal is observable but never considered successful or blindly replayed. */
export interface GitResourceCleanupObservation { readonly pathAbsent: boolean; readonly metadataAbsent: boolean }

const id = z.string().min(1)
const operationId = id.transform(value => brandString<GitOperationId>(value))
const resourceId = id.transform(value => brandString<GitResourceId>(value))
const witness = z.object({ path: id, device: id, inode: id }).strict()
/** Strict original user correlation is optional and remains uninterpreted. */
export const cleanupRequestSchema = z.object({ operationId, resourceId, expectedPreviewFingerprint: id,
  originalRequestJson: z.string().refine((value) => {
    try { JSON.parse(value); return true } catch (_invalidJson) { return false }
  }, 'original consumer request must be JSON').optional(),
}).strict()
/** Strict exact filesystem, private-ref and index cut. */
export const cleanupPreviewSchema = z.object({ resourceId, resourceRevision: z.number().int().positive(),
  pathIdentity: witness, gitDirIdentity: witness, preserveOperationId: operationId, commit: id, tree: id,
  manifestHash: id, ref: id, head: id, indexHash: id, fingerprint: id,
}).strict()
/** Strict observation does not confuse one missing half with successful cleanup. */
export const cleanupObservationSchema = z.object({ pathAbsent: z.boolean(), metadataAbsent: z.boolean() }).strict()
