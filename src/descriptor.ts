/**
 * Inline reading of the `subagent/descriptor` session event.
 *
 * The platform ships `foldSubagentDescriptor` in `@deepseek-ai/dsh-subagent`,
 * but a third-party plugin installed under a profile has no `node_modules`
 * providing that package: importing it makes the whole plugin fail to load
 * (`ERR_MODULE_NOT_FOUND`). The fold is pure data handling over one event, so it
 * is implemented here and the shipped bundle stays self-contained.
 *
 * Only `label` (and the `mode`/`provider` shape that identifies a subagent
 * descriptor at all) is consumed. The descriptor's `version` is deliberately NOT
 * used as a gate: gating on the platform's internal constant silently disables
 * the reviewer guard whenever the host bumps it — it already moved 2 → 3 between
 * releases, which would have turned the guard off without a single error.
 *
 * @module dsh-safe-tool/descriptor
 */

/** The label the review subagent is created with, and the guard keys on. */
export const PLUGIN_REVIEWER_LABEL = 'ai-approval-reviewer'

/** Event type carrying a subagent's durable creation identity. */
const DESCRIPTOR_EVENT = 'subagent/descriptor'

/** The fields this plugin reads from a descriptor payload. */
export interface SubagentDescriptorData {
  readonly mode: 'one-shot' | 'continuable'
  readonly provider: string
  readonly label?: string
}

/**
 * Parse a descriptor payload, accepting any version that keeps the shape.
 *
 * @param value - the event's `data` field.
 * @returns the parsed descriptor, or `undefined` when this is not one.
 */
export function parseSubagentDescriptor(value: unknown): SubagentDescriptorData | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>

  const mode = record['mode']
  if (mode !== 'one-shot' && mode !== 'continuable') return undefined

  const provider = record['provider']
  if (typeof provider !== 'string') return undefined

  const label = record['label']
  if (label !== undefined && typeof label !== 'string') return undefined

  return {
    mode,
    provider,
    ...(label === undefined ? {} : { label }),
  }
}

/**
 * Whether one agent's own session events identify it as this plugin's reviewer.
 *
 * @param events - `Session.ownEvents()` of the agent being classified.
 * @param label - the creation label to match (defaults to the reviewer label).
 * @returns whether the session carries that descriptor label.
 */
export function hasReviewerDescriptor(
  events: readonly unknown[],
  label: string = PLUGIN_REVIEWER_LABEL,
): boolean {
  for (const candidate of events) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const event = candidate as { type?: unknown; data?: unknown }
    if (event.type !== DESCRIPTOR_EVENT) continue
    const descriptor = parseSubagentDescriptor(event.data)
    return descriptor?.label === label
  }
  return false
}
