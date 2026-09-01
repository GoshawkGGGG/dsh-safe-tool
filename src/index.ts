/**
 * AI command approval plugin for DeepSeek Harness.
 *
 * Intercepts model tool calls via `tools/pre-execute`, routes matching calls
 * through a read-only review subagent, and allows or denies execution based
 * on the AI's structured decision.
 *
 * @module dsh-safe-tool
 */

export { apply, name, inject, Config } from './plugin.ts'
export type { ApprovalConfig, ToolFilterConfig, ReviewDecision } from './types.ts'
