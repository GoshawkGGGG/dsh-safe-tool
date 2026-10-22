/**
 * Minimal snapshot store owned by this bundle.
 *
 * The Client rules forbid loading a Harness Client package as a module, so the
 * observable the slot `hooks` compartment and `useSyncExternalStore` need is
 * implemented here: `getSnapshot` is referentially stable between writes and
 * `subscribe` notifies every listener on change.
 *
 * @module dsh-safe-tool/client/store
 */

/** A read/write store shaped like a Host observable. */
export interface SnapshotStore<T> {
  /** Current value; the same reference until the next write. */
  getSnapshot(): T
  /** Notify on every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Replace the value and notify. */
  set(value: T): void
  /** Mutate a clone of the value and notify. */
  update(recipe: (draft: T) => void): void
}

/**
 * Create a store with an initial value.
 *
 * @param initial - the starting value.
 * @returns the store.
 */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      value = next
      notify()
    },
    update(recipe) {
      const draft = structuredClone(value) as T
      recipe(draft)
      value = draft
      notify()
    },
  }
}
