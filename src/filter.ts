/**
 * Tool name matching logic for the approval filter.
 *
 * Supports two modes:
 * - `deny-list`: tools **in** the list trigger review; others pass through.
 * - `allow-list`: tools **not in** the list trigger review; listed tools pass through.
 */

import type { ToolFilterConfig } from './types.ts'

/**
 * Determine whether a tool call should be sent for AI review.
 *
 * @param filter - the configured tool filter.
 * @param toolName - the name of the tool being called.
 * @returns `true` if the call must be reviewed, `false` to bypass.
 */
export function needsReview(filter: ToolFilterConfig, toolName: string): boolean {
  const isInList = filter.tools.includes(toolName)
  return filter.mode === 'deny-list' ? isInList : !isInList
}

/**
 * Check whether any auto-allow regex matches the serialised tool arguments.
 *
 * A match means the command is considered safe by policy and skips review.
 *
 * @param args - the parsed tool arguments.
 * @param patterns - list of regex strings (compiled on each call for freshness).
 * @returns `true` if any pattern matches, forcing a fast-path allow.
 */
export function isAutoAllowed(args: unknown, patterns: string[]): boolean {
  if (patterns.length === 0) return false
  const text = typeof args === 'string' ? args : JSON.stringify(args)
  return patterns.some((p) => {
    try {
      return new RegExp(p, 'iu').test(text)
    } catch {
      return false
    }
  })
}

/**
 * Hash tool-name + args into a stable short string for cache keying.
 *
 * Uses a synchronous approach compatible with both Node and browser environments.
 */
export function hashArgs(toolName: string, args: unknown): string {
  const json = typeof args === 'string' ? args : JSON.stringify(args)
  const input = `${toolName}\0${json}`
  // FNV-1a 32-bit hash — fast, deterministic, no crypto dependency
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
