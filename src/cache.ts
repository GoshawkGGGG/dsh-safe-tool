/**
 * In-memory TTL cache for approval decisions.
 *
 * Keyed by `(sessionId, toolName, argsHash)` with a 60-second TTL.
 * Cache entries are cleaned up automatically when they expire.
 */

import type { ReviewDecision } from './types.ts'

const CACHE_TTL_MS = 60_000

interface CacheEntry {
  decision: ReviewDecision
  expiresAt: number
}

/**
 * TTL cache for review decisions.
 *
 * Uses a plain Map; entries expire based on wall-clock time.
 * No persistence — cache is in-memory only and restarts with dsh.
 *
 * The cleanup timer never keeps the process alive (`unref`) and is disposed
 * through the plugin's effect scope, so reloads cannot accumulate timers.
 */
export class ApprovalCache {
  private readonly store = new Map<string, CacheEntry>()
  private readonly cleanupTimer: ReturnType<typeof setInterval>
  private disposed = false

  constructor() {
    // Periodic cleanup every 30s to avoid unbounded growth. `unref` keeps the
    // timer from pinning the event loop (it also lets plain node test runs
    // exit once the suite settles).
    this.cleanupTimer = setInterval(() => this.cleanup(), CACHE_TTL_MS / 2)
    this.cleanupTimer.unref?.()
  }

  /**
   * Look up a cached decision. Returns undefined on miss or expiry.
   */
  get(sessionId: string, toolName: string, argsHash: string): ReviewDecision | undefined {
    const key = `${sessionId}\0${toolName}\0${argsHash}`
    const entry = this.store.get(key)
    if (entry === undefined) return undefined
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return entry.decision
  }

  /**
   * Store a decision in the cache with a 60-second TTL.
   */
  set(sessionId: string, toolName: string, argsHash: string, decision: ReviewDecision): void {
    if (this.disposed) return
    const key = `${sessionId}\0${toolName}\0${argsHash}`
    this.store.set(key, {
      decision,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
  }

  /** Stop the cleanup timer and drop every entry. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.cleanupTimer)
    this.store.clear()
  }

  /** Remove all expired entries. */
  private cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key)
      }
    }
  }
}
