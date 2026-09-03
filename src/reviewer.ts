/**
 * Review subagent launcher.
 *
 * Starts a read-only spawn subagent with zero tool permissions and a
 * structured-output schema, then disposes it immediately after to prevent
 * session persistence.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ReviewDecision } from './types.ts'

export interface ReviewerRequest {
  /** Fully-built review prompt text, ready to send to the subagent. */
  prompt: string
  provider?: string
  model?: string
  maxTokens: number
  timeoutMs: number
  /** When true, delete the review subagent's persisted session after settling. */
  deleteSession: boolean
}

/**
 * How long to wait after `dispose()` before physically removing the review
 * subagent's persisted session. The session-persistence coordinator flushes a
 * session's buffered events on `session/disposed` (fire-and-forget), batched
 * with a `maxDelayMs` window (default 200ms in dsh). This settle delay lets
 * that final flush complete so we delete the finished artifact instead of
 * racing a write that would recreate it.
 */
const DELETE_SETTLE_DELAY_MS = 300

/** Yield the event loop for `ms` without blocking. */
function settle(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Physically remove the review subagent's persisted session from disk.
 *
 * Uses `ctx.sessionPersistence.locate(header)` to resolve the backend-owned
 * artifact path (jsonl → the session's `session.jsonl.zstd` file), so the
 * plugin never hardcodes a `~/.dsh`-style path — it honours whatever
 * persistence backend and DSH_HOME the host is running. The whole session
 * directory (the artifact's parent) is removed.
 *
 * Also deletes the session's projection-cache record (`session_projcache`):
 * the projection cache checkpoints a session on `session/disposed`, so a
 * disposed review subagent would otherwise leave a ghost row in the sidebar
 * session list. The cache exposes no public delete, so we resolve the
 * storage-domain facility's `session_projcache` domain and delete its
 * `sessions` table row directly — again, no hardcoded path.
 *
 * Best-effort: any failure is swallowed, leaving the record behind rather
 * than failing the review.
 */
export async function removeReviewerSession(
  ctx: Context,
  header: SessionHeader | undefined,
): Promise<void> {
  if (header === undefined) return

  // Wait for the disposal-time writes to settle: both session-persistence
  // (`session/disposed` → retire → flush) and the projection cache
  // (`session/disposed` → write) drain on the fire-and-forget dispose path,
  // batched inside a default 200ms write window in dsh.
  await settle(DELETE_SETTLE_DELAY_MS)

  // 1. Remove the session's persistence artifact (jsonl → session.jsonl.zstd).
  try {
    const persistence = ctx.get('sessionPersistence') as {
      locate?: (meta: SessionHeader) => { path?: string } | undefined
    } | undefined
    const location = persistence?.locate?.(header)
    if (location?.path) {
      rmSync(dirname(location.path), { recursive: true, force: true })
    }
  } catch {
    // Best-effort: a transient lock or race leaves the record behind.
  }

  // 2. Remove the session's projection-cache record.
  try {
    const facility = ctx.get('storageDomain') as {
      get?: (name: string) => {
        table?: (name: string) => { delete?: (key: string) => Promise<unknown> } | undefined
      } | undefined
    } | undefined
    const table = facility?.get?.('session_projcache')?.table?.('sessions')
    if (table && typeof table.delete === 'function') {
      await table.delete(header.id)
    }
  } catch {
    // Best-effort: the cache is never an authority, so a stale ghost row only
    // costs a discarded cold read, not correctness.
  }
}

/**
 * Start a read-only review subagent and return its decision.
 *
 * The subagent is disposed immediately after result settlement to prevent
 * session persistence — no review sessions are stored in the session log.
 *
 * @param ctx - the host Cordis context (must have `subagents` service).
 * @param request - review parameters including a pre-built prompt.
 * @param parent - the agent that initiated the tool call being reviewed.
 * @returns the parsed approval decision.
 * @throws if the subagent service is unavailable.
 */
export async function startReviewer(
  ctx: Context,
  request: ReviewerRequest,
  parent: Agent,
): Promise<ReviewDecision> {
  // ctx.subagents is a declared inject — access directly, not ctx.get
  const subagents = (ctx as unknown as Record<string, unknown>).subagents as {
    start: (name: string, request: Record<string, unknown>) => Promise<{
      id: string
      localAgent?: { session?: { header?: SessionHeader } }
      result: Promise<unknown>
      dispose: () => Promise<void>
    }>
  }
  if (!subagents) {
    throw new Error(
      'dsh-safe-tool: subagents service not available — '
      + 'ensure dsh-subagent-spawn-in-process is composed in the profile.',
    )
  }

  // Build abort signal with timeout
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), request.timeoutMs)

  // Build deny-list: reviewer subagent should have no tools except structured_output
  // Try dynamic introspection first; fall back to hardcoded candidate pool
  let denyList: string[]
  try {
    const parentTools = (parent.ctx as unknown as Record<string, unknown>).tools as {
      schemas?: (scope?: unknown) => { name: string }[]
    }
    if (parentTools?.schemas) {
      // Dynamic: deny all tools parent actually has (structured_output is scoped, not here)
      const availableTools = parentTools.schemas()
      denyList = availableTools.map(t => t.name)
    } else {
      throw new Error('no schemas')
    }
  } catch {
    // Fallback: deny the candidate pool if introspection fails
    denyList = [
      'ask_user_question', 'bash', 'dsh_im_return_file', 'describe_image',
      'edit', 'get_goal', 'glob', 'grep', 'interrupt_agent', 'job_kill',
      'job_list', 'job_output', 'list_agents', 'memos_get', 'memos_search',
      'memos_skill_get', 'memos_skill_list', 'memos_timeline', 'plugin_install',
      'plugin_search', 'plugin_status', 'plugin_uninstall', 'read', 'read_image',
      'ralph', 'ssh_cluster', 'ssh_download', 'ssh_exec', 'ssh_list',
      'ssh_tunnel', 'ssh_upload', 'subagent', 'subagent_fork', 'todo_write',
      'update_goal', 'web_search', 'weknora_ask', 'weknora_list_knowledge_bases',
      'weknora_read_document', 'weknora_search', 'workflow', 'write',
    ]
  }

  let run: {
    id: string
    localAgent?: { session?: { header?: SessionHeader } }
    result: Promise<unknown>
    dispose: () => Promise<void>
  } | undefined

  try {
    // Start the review subagent with zero execution permissions
    // outputSchema automatically registers `structured_output` tool in child's scope
    // toolFilter denies all parent tools (structured_output is scoped, not restricted)
    run = await subagents.start('spawn', {
      label: 'ai-approval-reviewer',
      prompt: [{ type: 'text', text: request.prompt }],
      parent,
      signal: controller.signal,
      // toolFilter is a TOP-LEVEL field of SubagentStartRequest
      // Use deny-list to block all dangerous tools inherited from parent
      toolFilter: { deny: denyList },
      agentOptions: {
        ...(request.provider ? { provider: request.provider } : {}),
        ...(request.model ? { model: request.model } : {}),
        maxTokens: request.maxTokens,
      },
      outputSchema: {
        type: 'object' as const,
        required: ['approve', 'reason'] as const,
        properties: {
          approve: {
            type: 'boolean',
            description: '是否批准该工具调用执行。true=批准，false=拒绝。',
          },
          reason: {
            type: 'string',
            description: '批准或拒绝的原因，使用中文，简明扼要，不超过50字。',
          },
        },
        additionalProperties: false,
      },
    })

    // Wait for the subagent to complete
    const result = await run.result

    return extractDecision(result as { structured?: unknown; output?: ContentBlock[] })
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        approve: false,
        reason: `审核超时（>${request.timeoutMs}ms），已拒绝`,
      }
    }
    return {
      approve: false,
      reason: `审核服务异常：${String(error).slice(0, 100)}`,
    }
  } finally {
    clearTimeout(timeoutId)
    // Capture the child session header BEFORE dispose: dispose tears down the
    // agent scope, after which `localAgent.session.header` may be unreachable.
    const header = run?.localAgent?.session?.header
    // Always dispose to prevent session persistence
    // dispose() is idempotent — safe to call even if already settled
    if (run !== undefined) {
      try {
        await run.dispose()
      } catch {
        // Non-fatal: session will be cleaned up on next GC or profile restart
      }
    }
    // Optionally delete the review subagent's persisted session from disk.
    if (request.deleteSession && header !== undefined) {
      await removeReviewerSession(ctx, header)
    }
  }
}

/**
 * Extract the structured approval decision from a subagent result.
 *
 * The `outputSchema` contract normally ensures the child called
 * `structured_output` with matching args. Older/weaker models may instead
 * emit the decision as free-form text (raw JSON, fenced JSON, or key-value
 * lines), so this falls back through increasingly lenient parsers before
 * giving up.
 */
function extractDecision(result: {
  structured?: unknown
  output?: ContentBlock[]
  stopReason?: string
}): ReviewDecision {
  // Priority 1: structured output (guaranteed by outputSchema)
  const s = result.structured
  if (s !== undefined && typeof s === 'object' && s !== null) {
    const fromStructured = decisionFromRecord(s as Record<string, unknown>)
    if (fromStructured !== undefined) return fromStructured
  }

  // Priority 2: free-form text output (older models that don't tool-call)
  const text = collectDecisionText(result.output)
  if (text !== '') {
    const fromText = decisionFromText(text)
    if (fromText !== undefined) return fromText
  }

  // Priority 3: parse failure — fall back to human approval instead of hard-deny
  return { approve: false, reason: '无法解析审批结果，回退人工审批', fallback: true }
}

/** Join every text/reasoning block in order (raw-JSON models may split output). */
function collectDecisionText(output?: ContentBlock[]): string {
  if (!Array.isArray(output)) return ''
  const parts: string[] = []
  for (const block of output) {
    if (!block || typeof block !== 'object') continue
    const { type } = block
    const raw = (block as { text?: unknown }).text
    if ((type === 'text' || type === 'reasoning') && typeof raw === 'string') {
      parts.push(raw)
    }
  }
  return parts.join('\n').trim()
}

/** Normalise every common boolean-ish representation to `true` / `false`. */
function normalizeApprove(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0 ? value > 0 : false
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  const truthful = ['true', 'yes', 'y', 'ok', 'okay', '1', '是', '允许', '批准', '通过', '同意', '可以', '安全', '正确', 'approve', 'approved', 'allow', 'allowed', 'safe', 'pass', 'execute']
  const falsy = ['false', 'no', 'n', '0', '否', '拒绝', '驳回', '不允许', '不通过', '不同意', '不可以', '不安全', '错误', 'reject', 'rejected', 'deny', 'denied', 'unsafe', 'block', 'refuse']
  if (truthful.includes(v)) return true
  if (falsy.includes(v)) return false
  return undefined
}

/** Normalise a reason value to a bounded string, or `undefined`. */
function normalizeReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  let s: string
  if (typeof value === 'string') {
    s = value
  } else {
    const json = JSON.stringify(value)
    if (json === undefined) return undefined
    s = json
  }
  s = s.trim()
  return s === '' ? undefined : s.slice(0, 200)
}

/** Field-name variants accepted as the approve flag (JSON or key-value). */
const APPROVE_KEYS = ['approve', 'approved', 'allow', 'allowed', 'safe', 'is_safe', 'isSafe', 'can_execute', 'canExecute', 'should_execute', 'shouldExecute', 'decision', '批准', '是否批准', '是否允许', '是否执行', '是否安全']
/** Field-name variants accepted as the reason. */
const REASON_KEYS = ['reason', 'reasoning', 'explanation', 'why', '说明', '原因', '理由', '备注']

/** Try to read `{approve, reason}` from an already-parsed plain object. */
function decisionFromRecord(obj: Record<string, unknown>): ReviewDecision | undefined {
  const approve = pickApprove(obj)
  if (approve === undefined) return undefined
  const reason = pickReason(obj)
  return { approve, reason: reason ?? '（模型未提供原因）' }
}

/** Scan a record's keys (case/normalised) for the approve flag. */
function pickApprove(obj: Record<string, unknown>): boolean | undefined {
  for (const key of APPROVE_KEYS) {
    const value = lookupKey(obj, key)
    if (value === undefined) continue
    const normalized = normalizeApprove(value)
    if (normalized !== undefined) return normalized
  }
  return undefined
}

/** Scan a record's keys (case/normalised) for the reason. */
function pickReason(obj: Record<string, unknown>): string | undefined {
  for (const key of REASON_KEYS) {
    const value = lookupKey(obj, key)
    const normalized = normalizeReason(value)
    if (normalized !== undefined) return normalized
  }
  return undefined
}

/** Case-insensitive key lookup across the record's own keys. */
function lookupKey(obj: Record<string, unknown>, want: string): unknown {
  const target = want.toLowerCase()
  for (const [key, value] of Object.entries(obj)) {
    if (key.trim().toLowerCase() === target) return value
  }
  return undefined
}

/**
 * Parse a decision out of free-form text. Tries, in order: a JSON object
 * (possibly fenced or surrounded by prose), then key-value lines. Returns
 * `undefined` when nothing recognisable is found.
 */
function decisionFromText(text: string): ReviewDecision | undefined {
  // Strategy A: walk the balanced `{...}` objects in REVERSE order (the
  // trailing object first) and return the FIRST one that yields a decision.
  // This is a security boundary: the verdict is the last thing the model
  // writes, so we must never let an earlier JSON (a copied tool argument, a
  // command body) outrank it.
  for (const jsonCandidate of extractJsonObjectsReverse(text)) {
    const parsed = safeJsonParse(jsonCandidate)
    if (parsed !== undefined && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const fromJson = decisionFromRecord(parsed as Record<string, unknown>)
      if (fromJson !== undefined) return fromJson
    }
  }

  // Strategy B: key-value lines — `approve: true` / `reason: ...` (incl. 中文).
  return decisionFromKeyValueLines(text)
}

/**
 * Extract every balanced `{...}` span from `text`, in REVERSE order (last
 * first). The model's authoritative decision JSON sits at the very end of its
 * reply; everything before it — thinking preamble, a copy of the tool's JSON
 * arguments, a `bash` command body that itself embeds JSON — is noise that must
 * never be mistaken for the verdict. Returning last-first lets the caller try
 * the trailing object first and walk backwards only when it fails to yield a
 * decision.
 */
function extractJsonObjectsReverse(text: string): string[] {
  const result: string[] = []
  let searchEnd = text.length
  for (;;) {
    const open = text.lastIndexOf('{', searchEnd - 1)
    if (open === -1) break
    const candidate = scanBalancedObject(text, open)
    if (candidate !== undefined) result.push(candidate)
    searchEnd = open
  }
  return result
}

/** Scan from `start` to its matching `}`, honouring strings; undefined if unbalanced. */
function scanBalancedObject(text: string, start: number): string | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** Fold raw newlines inside string literals into spaces so multi-line values parse. */
function foldInnerNewlines(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
        continue
      }
      if (ch === '\\') {
        escaped = true
        out += ch
        continue
      }
      if (ch === '"') {
        inString = false
        out += ch
        continue
      }
      // A raw newline inside a string value is illegal JSON; fold it to a
      // space so the (Chinese, single-line-ish) reason survives without
      // breaking the parse. Structural newlines stay untouched.
      if (ch === '\n' || ch === '\r') {
        out += ' '
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    out += ch
  }
  return out
}

/** `JSON.parse` with tolerant preprocessing for non-standard encodings. */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Fall through to permissive forms.
  }
  // Normalise CJK full-width punctuation that Chinese-facing models commonly
  // emit in place of ASCII JSON syntax: curly double/single quotes, full-width
  // colon and comma. Then fold raw newlines inside string values.
  const normalized = foldInnerNewlines(
    text
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\uFF1A/g, ':')
      .replace(/\uFF0C/g, ','),
  )
  const attempts = [
    normalized,
    // Unquoted keys → quoted keys (`approve:` → `"approve":`).
    normalized.replace(/([{,]\s*)([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*:/g, '$1"$2":'),
    // Single-quoted strings → double-quoted.
    normalized.replace(/'([^']*)'/g, '"$1"'),
  ]
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try next
    }
  }
  return undefined
}

/** Parse `approve: ...` / `reason: ...` (and 中文 equivalents) from key-value lines. */
function decisionFromKeyValueLines(text: string): ReviewDecision | undefined {
  const approveLine = new RegExp(
    `(${APPROVE_KEYS.map(escapeRegExp).join('|')})\\s*[:：=]\\s*(.+)`,
    'i',
  )
  const reasonLine = new RegExp(
    `(${REASON_KEYS.map(escapeRegExp).join('|')})\\s*[:：=]\\s*(.+)`,
    'i',
  )
  let approve: boolean | undefined
  let reason: string | undefined
  // Walk lines in REVERSE order: the model's final verdict is the trailing
  // one, so the last `approve`/`reason` seen wins — an earlier copied key-value
  // (e.g. a quoted tool argument re-emitted verbatim) must never outrank it.
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    if (approve === undefined) {
      const m = line.match(approveLine)
      if (m) approve = normalizeApprove((m[2] ?? '').trim())
    }
    if (reason === undefined) {
      const n = line.match(reasonLine)
      if (n) reason = normalizeReason((n[2] ?? '').trim())
    }
    if (approve !== undefined && reason !== undefined) break
  }
  if (approve === undefined) return undefined
  return { approve, reason: reason ?? '（模型未提供原因）' }
}

/** Escape a literal for embedding in a `RegExp`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Type for content blocks in subagent result
interface ContentBlock {
  type: string
  text?: string
}