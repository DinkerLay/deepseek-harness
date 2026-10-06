/** Cold durable-input fault injection, never a manufactured live resource state or a normal writer crash representation. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import type { GitOperationId, GitResourceOperation } from '../src/types.ts'
import { repositorySchema } from '../src/records.ts'
import { harness } from './harness.ts'

/** Retain an original legal aggregate, alter only its private backend bytes, and boot a new real Loader owner.
 * @param test - owning private fixture with its actual domain and contexts.
 * @param operationId - legal operation created through the public API before the fault.
 * @param corrupt - explicit persisted-metadata fault; it never receives or changes the live Domain cache.
 * @returns new owner plus the original detached facts and their private JSON backup.
 */
export async function coldCorruptOperation(test: Pick<Awaited<ReturnType<typeof harness>>, 'ctx' | 'root' | 'resources'>,
  operationId: GitOperationId, corrupt: (operation: GitResourceOperation) => GitResourceOperation) {
  const pending = test.ctx.gitResources.status(operationId), domain = test.ctx.storageDomain.get('git_resources')
  if (pending === undefined || domain === undefined) throw new Error('fault injection requires an actual legal original operation')
  const original = repositorySchema.parse(domain.table('repositories').get(pending.resource.repositoryId))
  const backup = join(test.root, `original-${operationId}.json`)
  await writeFile(backup, JSON.stringify(original))
  const unit = Reflect.get(domain, 'unit') as KvUnit
  await unit.putRecord('repositories', pending.resource.repositoryId, { ...original,
    operations: original.operations.map(operation => operation.operationId === operationId
      ? corrupt(structuredClone(operation)) : operation) })
  await test.ctx.fiber.dispose()
  const cold = await harness({}, test.resources)
  return { ...cold, pending, original, backup }
}
