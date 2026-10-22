/**
 * Review subagent launcher.
 *
 * 0.2.x adaptation (dsh 0.2.1-rc.2):
 * - Children start through `subagents.startActivation({ provider: 'spawn',
 *   label, request, signal, delivery: 'caller' })`. The old
 *   `subagents.start(name, request)` seam and its top-level `toolFilter`
 *   field are gone; the reviewer's tool allowlist is enforced by the plugin's
 *   `tools/pre-execute` guard (reviewer children may only call
 *   `structured_output`), and the tool composition comes from the dedicated
 *   reviewer parent's preset.
 * - The child identity arrives as `activation.childId`; its durable header is
 *   read back through `sessionPersistence.stat(childId)` AFTER disposal for
 *   the optional disk cleanup.
 * - The result promise never rejects on child-level failure — it resolves
 *   `SubagentResult { output, structured?, diagnostic?, stopReason }` — so
 *   time-outs and model failures are classified from `stopReason`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ReviewDecision } from './types.ts'

export interface ReviewerRequest {
  /** Fully-built review prompt text, ready to send to the subagent. */
  prompt: string
  provider?: string | undefined
  model?: string | undefined
  maxTokens: number
  timeoutMs: number
  /** When true, delete the review subagent's persisted session after settling. */
  deleteSession: boolean
  /** Working directory for the reviewer child (the plugin's private workspace). */
  cwd: string
  /**
   * Pin the child's composition to an agent preset. Unnecessary when the
   * parent already mounts the preset (the child joins the parent's current
   * generation); used on the fallback parent so the child still composes
   * minimally.
   */
  agentPreset?: string | undefined
}

/**
 * How long to wait after `dispose()` before physically removing the review
 * subagent's persisted session. The session-persistence coordinator flushes a
 * session's buffered events on `session/disposed` (fire-and-forget), batched
 * with a `maxDelayMs` window (200ms in the shipped jsonl backend). This
 * settle delay lets that final flush complete so we delete the finished
 * artifact instead of racing a write that would recreate it.
 */
const DELETE_SETTLE_DELAY_MS = 300

/** Yield the event loop for `ms` without blocking. */
function settle(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Artifact path resolution (0.2.x jsonl backend layout) ─────────────

/**
 * Encode one path segment exactly as the 0.2.x jsonl backend does
 * (`encodeSegment`): safe characters pass through, everything else becomes
 * `~XXXX` (uppercase hex code unit).
 */
function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  // Dot segments are the one traversal a character-wise encoder still lets
  // through; the platform backend neutralizes them and so must we, because the
  // cleanup path deletes `join(root, encodeSegment(id))` recursively.
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Encode the project directory key exactly as the 0.2.x jsonl backend does
 * (`projectKey`): separators collapse to `-`, unsafe code units become
 * `~XXXX`, bounded to 251 characters.
 */
function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Resolve the persistence backend's session root. The public
 * `SessionPersistence` contract exposes no path seam, but the shipped jsonl
 * backend keeps its configured root on the instance; read it defensively and
 * give up quietly when absent.
 */
function sessionRoot(ctx: Context): string | undefined {
  const persistence = ctx.get('sessionPersistence', false) as
    | { root?: unknown }
    | undefined
  const root = (persistence as { root?: unknown } | undefined)?.root
  return typeof root === 'string' && root.length > 0 ? root : undefined
}

/**
 * Physically remove the review subagent's persisted session from disk.
 *
 * The 0.2.x jsonl layout is `<root>/<projectKey(cwd)>/<encodeSegment(id)>/`;
 * the whole per-session directory is removed. The 0.1.x layout
 * (`<root>/<id>/`) is removed too, so an upgrade leftover cannot linger.
 *
 * Also deletes the session's projection-cache record (`session_projcache`
 * domain, `sessions` table): the cache checkpoints a session on
 * `session/disposed`, so a disposed review subagent would otherwise leave a
 * ghost row in the sidebar session list.
 *
 * Best-effort: any failure is swallowed, leaving the record behind rather
 * than failing the review.
 */
export async function removeReviewerSession(
  ctx: Context,
  target: ReviewerSessionTarget,
): Promise<void> {
  const id = String(target.id)
  if (id.length === 0) return

  // Wait for the disposal-time writes to settle: both session-persistence
  // (`session/disposed` → retire → flush) and the projection cache
  // (`session/disposed` → write) drain on the fire-and-forget dispose path.
  await settle(DELETE_SETTLE_DELAY_MS)

  // 1. Remove the session's persistence artifact directories.
  //
  // The address is derived from the identity captured while the session was
  // still live (id + cwd). It must NOT be re-resolved from the backend here:
  // a disposed session is already gone from `stat()`/`list()` — reading it back
  // afterwards yields nothing and silently skips the delete, which is exactly
  // how review sessions used to accumulate on disk.
  try {
    const root = sessionRoot(ctx)
    if (root === undefined) {
      ctx.logger('dsh-safe-tool').warn('the session backend exposes no root; the review session artifact was left on disk')
    } else {
      const idSegment = encodeSegment(id)
      // Current layout: nested under the project directory.
      const current = target.cwd === undefined
        ? join(root, '_no-cwd', idSegment)
        : join(root, projectKey(target.cwd), idSegment)
      rmSync(current, { recursive: true, force: true })
      // Legacy (0.1.x) layout: directly under the root.
      rmSync(join(root, idSegment), { recursive: true, force: true })
    }
  } catch (error) {
    // Best-effort: a transient lock or race leaves the record behind.
    ctx.logger('dsh-safe-tool').warn('failed to remove the review session artifact %s: %C', id, error)
  }

  // 2. Remove the session's projection-cache record.
  try {
    const facility = ctx.get('storageDomain', false) as {
      get?: (name: string) => {
        table?: (name: string) => { delete?: (key: string) => Promise<unknown> } | undefined
      } | undefined
    } | undefined
    const table = facility?.get?.('session_projcache')?.table?.('sessions')
    if (table && typeof table.delete === 'function') {
      await table.delete(id)
    }
  } catch {
    // Best-effort: the cache is never an authority, so a stale ghost row only
    // costs a discarded cold read, not correctness.
  }
}

/**
 * The durable identity of one review session artifact, captured while the
 * session was still live. `cwd` selects the backend's project directory.
 */
export interface ReviewerSessionTarget {
  /** Durable session id. */
  id: string
  /** The session's working directory, when known (the reviewer workspace). */
  cwd?: string | undefined
}

/** Subset of the activation the launcher consumes. */
interface ReviewActivation {
  childId: string
  result: Promise<{ output?: unknown; structured?: unknown; diagnostic?: unknown; stopReason?: string }>
  dispose: () => Promise<void>
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
    startActivation?: (spec: Record<string, unknown>) => Promise<ReviewActivation>
    getProvider?: (name: string) => { name: string } | undefined
    list?: () => string[]
  }
  if (!subagents?.startActivation) {
    throw new Error(
      'dsh-safe-tool: subagents.startActivation not available — '
      + 'ensure @deepseek-ai/dsh-subagent-spawn-in-process is composed in the profile.',
    )
  }
  const providerName = subagents.getProvider?.('spawn') !== undefined || subagents.list?.().includes('spawn')
    ? 'spawn'
    : undefined
  if (providerName === undefined) {
    throw new Error('dsh-safe-tool: no `spawn` subagent provider registered')
  }

  // Build abort signal with timeout
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), request.timeoutMs)

  let run: ReviewActivation | undefined

  try {
    // Start the review subagent with zero execution permissions:
    // - `cwd` pins the child into the plugin's private workspace, which the
    //   `tools/pre-execute` guard uses to identify reviewer children.
    // - `agentPreset` (when supplied) composes the child from the reviewer
    //   preset; without it the child joins the reviewer parent's current
    //   generation — 0.2.x routes tool composition through presets; the
    //   start-time `toolFilter` field no longer exists.
    // - `outputSchema` registers the child-scoped `structured_output` tool.
    run = await subagents.startActivation({
      provider: providerName,
      label: 'ai-approval-reviewer',
      request: {
        cwd: request.cwd,
        ...(request.agentPreset !== undefined ? { agentPreset: request.agentPreset } : {}),
        prompt: [{ type: 'text', text: request.prompt }],
        parent,
        agentOptions: {
          ...(request.provider !== undefined ? { provider: request.provider } : {}),
          ...(request.model !== undefined ? { model: request.model } : {}),
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
      },
      signal: controller.signal,
      delivery: 'caller',
    })

    // Wait for the subagent to complete. The promise resolves (never rejects)
    // with the terminal SubagentResult; a model/transport failure arrives as
    // `stopReason: 'error'` (plus `diagnostic`), a cancellation as
    // `'aborted'`.
    const result = await run.result

    if (controller.signal.aborted && result?.stopReason !== 'completed') {
      return {
        approve: false,
        reason: `审核超时（>${request.timeoutMs}ms），已拒绝`,
      }
    }
    if (result?.stopReason === 'error') {
      // A model/transport failure is the 0.2.x form of the 0.1.x rejection:
      // `run.result` now RESOLVES on child-level failure instead of rejecting,
      // so this branch is the old `catch` — which denied unconditionally, even
      // when a partial structured block had already been produced.
      const detail = typeof result.diagnostic === 'string' && result.diagnostic.length > 0
        ? result.diagnostic.slice(0, 80)
        : '模型或传输失败'
      return { approve: false, reason: `审核服务异常：${detail}` }
    }
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
    // Capture the child's identity BEFORE dispose. A disposed session is already
    // gone from the backend (`stat()`/`list()` stop resolving it), so anything
    // the cleanup needs must be read while it is still live — the cwd selects
    // the artifact's project directory, and the id names its segment.
    const childId = run?.childId
    let childCwd = request.cwd
    if (request.deleteSession && childId !== undefined) {
      try {
        const persistence = ctx.get('sessionPersistence', false) as {
          stat?: (id: string) => Promise<{ header?: SessionHeader } | undefined>
        } | undefined
        const live = (await persistence?.stat?.(childId))?.header
        if (typeof live?.cwd === 'string' && live.cwd.length > 0) childCwd = live.cwd
      } catch {
        // Fall back to the spawn cwd, which is the same directory.
      }
    }
    // Always dispose to prevent session persistence
    // dispose() is idempotent — safe to call even if already settled
    if (run !== undefined) {
      try {
        await run.dispose()
      } catch {
        // Non-fatal: the artifact is still removed below by its known identity.
      }
    }
    // Optionally delete the review subagent's persisted session from disk.
    if (request.deleteSession && childId !== undefined) {
      await removeReviewerSession(ctx, { id: String(childId), cwd: childCwd })
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
 * reply; everything before it is noise that must never be mistaken for the
 * verdict.
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
