/** Stable metadata hashing shared by resource schemas and independent Git plumbing modules. */
import { createHash } from 'node:crypto'

/** Hash JSON metadata with stable object-key ordering.
 * @param value - JSON-compatible immutable request or observation.
 * @returns deterministic SHA-256 digest with sorted object keys and preserved array order.
 */
export function hash(value: unknown): string {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(stable)
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stable(child)]))
    return item
  }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}
