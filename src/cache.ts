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
 * LRU-style TTL cache for review decisions.
 *
 * Uses a plain Map; entries expire based on wall-clock time.
 * No persistence — cache is in-memory only and restarts with dsh.
 */
export class ApprovalCache {
  private readonly store = new Map<string, CacheEntry>()
  private readonly cleanupTimer: ReturnType<typeof setTimeout>

  constructor() {
    // Periodic cleanup every 30s to avoid unbounded growth
    this.cleanupTimer = setInterval(() => this.cleanup(), CACHE_TTL_MS / 2)
    // Clean up on process exit
    if (typeof process !== 'undefined') {
      process.once('exit', () => clearInterval(this.cleanupTimer))
    }
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
    const key = `${sessionId}\0${toolName}\0${argsHash}`
    this.store.set(key, {
      decision,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
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
