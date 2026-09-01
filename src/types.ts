/** Shared type definitions for the AI approval plugin. */

export interface ApprovalConfig {
  /** Master switch — when false, the plugin does nothing. */
  enabled: boolean
  /** dsh-registered provider ID for the review model; omitted = inherit from parent agent. */
  provider?: string
  /** Model name for the review agent; omitted = inherit from parent agent. */
  model?: string
  /** Maximum tokens the review agent may consume per call. */
  maxTokens: number
  /** Timeout in milliseconds for a single review request. */
  timeoutMs: number
  /** Timeout in milliseconds for human approval fallback. */
  humanTimeoutMs: number
  /** Tool filter mode: 'deny-list' blocks listed tools; 'allow-list' only allows listed tools. */
  filterMode: 'deny-list' | 'allow-list'
  /** Tool names that determine whether review is triggered. */
  tools: string[]
  /**
   * Regular expressions matched against the JSON-serialised tool arguments.
   * A match skips the review entirely (fast-path allow).
   */
  autoAllowPatterns: string[]
  /**
   * When true (default), the review subagent's session is deleted from disk
   * after the review settles — no review session record is retained. When
   * false, the review subagent's session persists for traceability.
   */
  deleteReviewerSessions: boolean
  /**
   * The agent-preset id the dedicated review parent agent mounts (default
   * `minimal`). The review subagent inherits this preset instead of the
   * main agent's, so the reviewer runs a minimal, permission-poor composition.
   */
  reviewerPreset: string
}

/** Tool filter configuration: which tools trigger review. */
export interface ToolFilterConfig {
  mode: 'deny-list' | 'allow-list'
  tools: string[]
}

/** Parsed approval decision from the review subagent. */
export interface ReviewDecision {
  /** Whether the command should be executed. */
  approve: boolean
  /** Human-readable reason in Chinese (brief, ≤50 chars). */
  reason: string
  /**
   * When true, the AI review could not produce a deterministic decision
   * (e.g. parse failure). The plugin should fall back to human approval
   * instead of hard-denying. Never set together with approve=true.
   */
  fallback?: boolean
}

/** Raw output from the review subagent run. */
export interface ReviewResult {
  /** Raw text content from the subagent's final assistant message. */
  content: string
  /** Structured value captured via `outputSchema`; present when the child called `structured_output`. */
  structured?: ReviewDecision
}
