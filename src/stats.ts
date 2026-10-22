/**
 * Per-session approval tallies, stored in the plugin's own settings document.
 *
 * 0.1.x kept them in a dedicated settings section (`installSettingsSection` with
 * the `dsh-safe-tool-stats` namespace) and wrote them through `settings.mutate`,
 * which raised the platform's `settings/document-updated` event; the browser half
 * turned that event into a live refresh. dsh 0.2.x removed custom settings
 * namespaces (`SettingsForms` addresses Loader entry ids only), so the same data
 * now lives in the plugin's OWN entry document under the same `sessions` dict —
 * same shape, same mutate call, same event, with the entry id where the stats
 * namespace used to be.
 *
 * Every write still raises `settings/document-updated` for the entry, which is
 * why the live refresh stays exactly what it was: one pushed trigger followed by
 * one bridge read — never a poll.
 *
 * @module dsh-safe-tool/stats
 */

import Schema from '@deepseek-ai/schemastery'

/** One session's cumulative approval tally (the 0.1.x field set, unchanged). */
export interface SessionStats {
  total: number
  approved: number
  denied: number
  errorDenied: number
}

/**
 * The tallies, as one config field on this plugin's entry.
 *
 * The caller declares the field `.volatile()`: 0.2.x accepts only settings
 * writes that target volatile fields, and a volatile field also commits into the
 * running plugin without a reload.
 */
export const sessionsSchema = Schema.dict(
  Schema.object({
    total: Schema.number().default(0),
    approved: Schema.number().default(0),
    denied: Schema.number().default(0),
    errorDenied: Schema.number().default(0),
  }),
  Schema.string(),
).default({})

/** The Loader entry id whose document holds both the plugin config and tallies. */
export const STATS_NAMESPACE = 'dsh-safe-tool'

/** The one logging method the tallies report through. */
export interface StatsLogger {
  warn: (format: unknown, ...args: unknown[]) => void
}

/** The subset of the host settings service these tallies use. */
export interface StatsSettings {
  /** Current describe mirror; the entry row carries the projected config value. */
  describe(options?: { redactSecrets?: boolean }): ReadonlyArray<{ ns: unknown; value?: unknown }>
  /** Apply ordered path edits to one entry's document. */
  mutate(ns: string, ops: ReadonlyArray<Record<string, unknown>>, expectedRevision?: number): Promise<unknown>
}

/** Bound by the plugin scope; undefined until the settings service is active. */
let settings: StatsSettings | undefined

/**
 * Bound alongside the service. Reports go through the host log pipeline, so the
 * profile's own level and exporters decide what is emitted — a shipped plugin
 * never writes to the console directly.
 */
let logger: StatsLogger | undefined

/**
 * Bind the host settings service. Called from a nested inject, so the service is
 * guaranteed active before any tally is written.
 *
 * @param value - the active settings service, or undefined on teardown.
 */
export function bindStatsSettings(value: StatsSettings | undefined, log?: StatsLogger): void {
  settings = value
  logger = value === undefined ? undefined : log
}

/** Report one tally failure through the host log pipeline. */
function report(message: string, error?: unknown): void {
  if (logger === undefined) return
  if (error === undefined) logger.warn(message)
  else logger.warn('%s: %C', message, error)
}

/** Read the whole tally map from the plugin's own settings document. */
function readSessions(): Record<string, SessionStats> {
  if (settings === undefined) return {}
  try {
    const row = settings.describe({ redactSecrets: true })
      .find(candidate => String(candidate.ns) === STATS_NAMESPACE)
    const value = row?.value
    if (value === null || typeof value !== 'object') return {}
    const sessions = (value as { sessions?: unknown }).sessions
    if (sessions === null || typeof sessions !== 'object') return {}
    return sessions as Record<string, SessionStats>
  } catch (error) {
    report('failed to read the approval tallies', error)
    return {}
  }
}

/** Write ordered path ops against the plugin's own settings document. */
function writeOps(ops: ReadonlyArray<Record<string, unknown>>): void {
  if (settings === undefined) {
    report('the settings service is unavailable; the approval tally was not recorded')
    return
  }
  // No expected revision: a tally is not an edit of the user's form state, and
  // concurrent tallies must never conflict with each other or with a save.
  void settings.mutate(STATS_NAMESPACE, ops).catch((error: unknown) => {
    report('failed to persist the approval tallies', error)
  })
}

/** Read every per-session tally. */
export function readAllStats(): Record<string, SessionStats> {
  return readSessions()
}

/** Read one session's tally, or `undefined` when absent. */
export function readStats(sessionId: string): SessionStats | undefined {
  return readSessions()[sessionId]
}

/**
 * Record one settled decision.
 *
 * @param sessionId - session the reviewed call belongs to.
 * @param isFallback - the review fell back to (or failed into) another path.
 * @param approve - the review approved the call.
 */
export function recordStats(sessionId: string, isFallback: boolean, approve: boolean): void {
  const prev = readStats(sessionId) ?? { total: 0, approved: 0, denied: 0, errorDenied: 0 }
  const next: SessionStats = {
    total: prev.total + 1,
    approved: prev.approved + (!isFallback && approve ? 1 : 0),
    denied: prev.denied + (!isFallback && !approve ? 1 : 0),
    errorDenied: prev.errorDenied + (isFallback ? 1 : 0),
  }
  writeOps([{ op: 'set', path: ['sessions', sessionId], value: next }])
}

/** Drop one session's tally. */
export function deleteStats(sessionId: string): void {
  writeOps([{ op: 'unset', path: ['sessions', sessionId] }])
}

/**
 * Clear every tally, or the listed sessions' tallies.
 *
 * @param sessionIds - sessions to clear; empty or absent clears everything.
 */
export async function clearStats(sessionIds?: readonly string[]): Promise<void> {
  if (settings === undefined) {
    report('the settings service is unavailable; the approval tallies were not cleared')
    return
  }
  const ops: Array<Record<string, unknown>> = sessionIds === undefined || sessionIds.length === 0
    // One-shot clear-all, exactly as 0.1.x did against its stats namespace.
    ? [{ op: 'set', path: ['sessions'], value: {} }]
    : sessionIds.map(id => ({ op: 'unset', path: ['sessions', id] }))
  try {
    await settings.mutate(STATS_NAMESPACE, ops)
  } catch (error) {
    report('failed to clear the approval tallies', error)
    throw error
  }
}
