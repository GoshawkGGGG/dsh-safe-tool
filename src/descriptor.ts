/**
 * Inline implementation of foldSubagentDescriptor from @deepseek-ai/dsh-subagent.
 * This avoids the need to bundle the entire subagent package.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const SUBAGENT_DESCRIPTOR_VERSION = 2

export interface SubagentDescriptorData {
  readonly version: number
  readonly mode: 'one-shot' | 'continuable'
  readonly provider: string
  readonly label?: string
}

/**
 * Parse a subagent descriptor event payload.
 */
export function parseSubagentDescriptor(value: unknown): SubagentDescriptorData | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const obj = value as Record<string, unknown>
  
  const version = obj['version']
  if (typeof version !== 'number' || version !== SUBAGENT_DESCRIPTOR_VERSION) return undefined
  
  const mode = obj['mode']
  if (mode !== 'one-shot' && mode !== 'continuable') return undefined
  
  const provider = obj['provider']
  if (typeof provider !== 'string') return undefined
  
  const label = obj['label']
  
  return {
    version,
    mode,
    provider,
    ...(label !== undefined ? { label: label as string } : {}),
  }
}

/**
 * Fold a session's events to find the subagent descriptor.
 */
export function foldSubagentDescriptor(events: readonly SessionEvent[]): SubagentDescriptorData | undefined {
  const event = events.find(
    (candidate): candidate is SessionEvent<'subagent/descriptor'> => candidate.type === 'subagent/descriptor',
  )
  if (event === undefined) return undefined
  return parseSubagentDescriptor(event.data)
}
