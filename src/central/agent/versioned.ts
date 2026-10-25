// Read-modify-write over a StateStore key with optimistic versions: retried when another writer got there first.
import type { StateStore } from "../backend/types"

/** Attempts before a contended update gives up (each one re-reads the key). */
const ATTEMPTS = 16

/**
 * Applies `change` to the key's current value (undefined: missing) and writes the result with ifVersion.
 * `change` returning undefined leaves the key alone. Resolves with the written value (or undefined).
 */
export async function updateVersioned<T>(
  state: StateStore,
  userID: string,
  collection: string,
  key: string,
  change: (current: T | undefined) => T | undefined,
): Promise<T | undefined> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const current = await state.get<T>(userID, collection, key)
    const next = change(current?.value)
    if (next === undefined) return undefined
    const result = await state.put(userID, collection, key, next, { ifVersion: current?.version ?? 0 })
    if (result.ok) return next
  }
  throw new Error(`state update of ${collection}/${key} kept conflicting`)
}
