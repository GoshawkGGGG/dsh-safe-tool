/**
 * Main plugin entry point for dsh-safe-tool.
 *
 * Registers a `tools/pre-execute` waterfall listener that intercepts tool
 * calls, optionally reviews them via a read-only subagent, and returns an
 * allow or deny decision.
 *
 * 0.2.x adaptation notes (dsh 0.2.1-rc.2):
 * - The settings UI derives from the row's `Config` schema automatically
 *   (`SettingsForms` projects every active entry); the removed
 *   `installSettingsSection` helper is gone. Config edits reload the entry,
 *   so `apply` always sees the current values.
 * - Per-session tallies live in this plugin's OWN entry document, under the
 *   `sessions` field (see `./stats.ts`). 0.1.x kept them in a dedicated
 *   settings namespace; 0.2.x addresses Loader entry ids only, so the same
 *   `sessions` dict rides the entry — and a tally write raises the same
 *   `settings/document-updated` event the browser half refreshes on.
 * - Review subagents start through `subagents.startActivation` (the old
 *   `subagents.start` + `toolFilter` seam is gone); tool safety is enforced
 *   by the `tools/pre-execute` guard below, which denies every execution tool
 *   for reviewer children.
 *
 * @module dsh-safe-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { hasReviewerDescriptor, PLUGIN_REVIEWER_LABEL } from './descriptor.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
// Type-only augmentation import (erased): registers the `tools/pre-execute`
// waterfall in the cordis Events map.
import type {} from '@deepseek-ai/dsh-tools'
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { needsReview, isAutoAllowed, hashArgs } from './filter.ts'
import { startReviewer, removeReviewerSession } from './reviewer.ts'
import { ApprovalCache } from './cache.ts'
import { bindStatsSettings, clearStats, recordStats, deleteStats, readAllStats, sessionsSchema, type StatsSettings } from './stats.ts'
import type { ApprovalConfig, ReviewDecision } from './types.ts'

export const name = 'dsh-safe-tool'
export const inject = ['tools', 'subagents', 'approval', 'webServer'] as const

const BRIDGE_PREFIX = '/api/dsh-safe-tool-settings'

// ─── Configuration ────────────────────────────────────────────

// Every field is declared volatile: the loader commits form edits into the
// running fiber's config references WITHOUT remounting the entry — the 0.2.x
// equivalent of the 0.1.x settings-source live read (every setting took
// effect immediately, no restart). The review path re-reads through
// `readConfig` on every tool call.
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  // Optional strings: `.required(false)` marks the field absent-able in the
  // projected schema (0.1.x spelled this `.default(undefined)`).
  provider: Schema.string().required(false).volatile(),
  model: Schema.string().required(false).volatile(),
  maxTokens: Schema.number().default(2048).volatile(),
  timeoutMs: Schema.number().default(30000).volatile(),
  humanTimeoutMs: Schema.number().default(30000).volatile(),
  filterMode: Schema.union(['deny-list', 'allow-list']).default('deny-list').volatile(),
  tools: Schema.array(Schema.string()).default(['bash', 'write']).volatile(),
  autoAllowPatterns: Schema.array(Schema.string()).default([]).volatile(),
  deleteReviewerSessions: Schema.boolean().default(true).volatile(),
  reviewerPreset: Schema.string().default('minimal').volatile(),
  // Per-session approval tallies. 0.1.x kept them in a dedicated settings
  // namespace; 0.2.x has no custom namespaces, so they ride this entry's own
  // document — the same `sessions` dict, written the same way.
  sessions: sessionsSchema.volatile(),
})

/** Unwrap one possibly-volatile config reference to its current value. */
function unwrapField<T>(value: T | { get(): T }): T {
  if (value !== null && typeof value === 'object' && 'get' in (value as object) && typeof (value as { get: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}

/**
 * Snapshot the current config for one review call. Volatile fields are read
 * live — exactly what the 0.1.x `setSource` thunk provided. Absent optional
 * fields (provider/model) stay undefined, matching `ApprovalConfig`.
 */
function readConfig(raw: Record<string, unknown> | ApprovalConfig): ApprovalConfig {
  const read = <T>(key: string): T => unwrapField((raw as Record<string, unknown>)[key] as T | { get(): T })
  return {
    enabled: read<boolean>('enabled'),
    provider: read<string | undefined>('provider'),
    model: read<string | undefined>('model'),
    maxTokens: read<number>('maxTokens'),
    timeoutMs: read<number>('timeoutMs'),
    humanTimeoutMs: read<number>('humanTimeoutMs'),
    filterMode: read<'deny-list' | 'allow-list'>('filterMode'),
    tools: read<string[]>('tools'),
    autoAllowPatterns: read<string[]>('autoAllowPatterns'),
    deleteReviewerSessions: read<boolean>('deleteReviewerSessions'),
    reviewerPreset: read<string>('reviewerPreset'),
  }
}

// ─── Plugin ───────────────────────────────────────────────────

export function apply(ctx: Context, config: ApprovalConfig): void {
  // The live config source: volatile fields are committed into this fiber's
  // config references by the loader, so `readConfig(config)` re-reads the
  // CURRENT values on every call — the 0.1.x `setSource` live view, without
  // any restart.
  const currentConfig = (): ApprovalConfig => readConfig(config)

  // Bind the host settings service under a nested inject: the tallies are path
  // edits on this plugin's own document, and the platform raises
  // `settings/document-updated` for the entry on every such write — the exact
  // live trigger the 0.1.x stats namespace produced. Best effort: without the
  // service the review path still runs, and every tally write reports instead
  // of disappearing.
  ctx.inject(['settings'], (sctx) => {
    const service = sctx.get('settings') as unknown as StatsSettings
    bindStatsSettings(service, sctx.logger('dsh-safe-tool'))
    sctx.effect(() => () => bindStatsSettings(undefined), 'dsh-safe-tool: stats binding')
  })

  // Drop a session's tally when it is disposed (closed/deleted).
  ctx.on('session/disposed', (session) => {
    deleteStats(String(session.id))
  })

  // Late-bound context carrying the services the review path needs lazily
  // (agent creation + preset mounting). Binding them through `inject` gives
  // guaranteed ordering and legal property access; until they appear, the
  // review path falls back to the calling agent (never a silent failure).
  let reviewCtx = ctx
  ctx.inject(['agents', 'agentPresets'], (sctx) => {
    reviewCtx = sctx
  })

  // Filter context injections out of the reviewer subagent's turn. Registered
  // here (root) with `prepend` so it runs BEFORE every producer's own
  // `agent/pre-step` injection: it awaits `next()` (letting skill catalog,
  // memos, workspace instructions, and the default runtime-context tail all
  // land), then drops the non-`user` messages for reviewer children only.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || !decision.messages) return decision
    if (!isPluginReviewer(payload.agent)) return decision
    const filtered = decision.messages.filter(m => m.source.kind === 'user')
    if (filtered.length === decision.messages.length) return decision
    return { ...decision, messages: filtered }
  }, { prepend: true })

  // Bridge API for the browser half: stats read/clear and the agent-preset
  // roster. Configuration reads/writes ride the settings/configForms transport
  // directly (the plugins.row.config card receives a live form face), so no
  // describe/mutate bridge is needed anymore.
  ctx.inject(['webServer'], (sctx) => {
    const webServer = sctx.get('webServer')

    const guard = (req: { method: string }, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'method not allowed' }))
        return false
      }
      return true
    }

    const writeJson = (res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }, code: number, data: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }

    // Request bodies are tiny (a session-id list). Cap the buffered size so a
    // malformed or hostile request on the loopback port cannot grow it without
    // bound; the routes are POST-only and carry no secrets.
    const MAX_BODY_BYTES = 64 * 1024
    /** Upper bound on one clear request's id list. */
    const MAX_CLEAR_IDS = 1000
    const readJsonBody = async (req: { headers: Record<string, string>; on: (event: string, handler: (chunk: Buffer) => void) => void }) => {
      return new Promise<unknown>((resolve, reject) => {
        let body = ''
        let size = 0
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            resolve(undefined)
            return
          }
          body += chunk.toString()
        })
        req.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            resolve(undefined)
          }
        })
        req.on('error', reject)
      })
    }

    const routes = [
      {
        kind: 'exact',
        path: `${BRIDGE_PREFIX}/stats-list`,
        handler: async (req: { method: string }, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }) => {
          if (!guard(req, res)) return
          try {
            writeJson(res, 200, { ok: true, sessions: readAllStats() })
          } catch (error) {
            writeJson(res, 200, { ok: false, code: 'internal', message: String(error) })
          }
        },
      },
      {
        kind: 'exact',
        path: `${BRIDGE_PREFIX}/stats-clear`,
        handler: async (req: { method: string }, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }) => {
          if (!guard(req, res)) return
          const body = await readJsonBody(req as unknown as { headers: Record<string, string>; on: (event: string, handler: (chunk: Buffer) => void) => void })
          const raw = (body !== null && typeof body === 'object' && Array.isArray((body as { sessionIds?: unknown }).sessionIds))
            ? (body as { sessionIds: unknown[] }).sessionIds
            : undefined
          // Each id becomes a path segment of a settings op, so only strings are
          // admissible and the batch is bounded: a malformed body must not reach
          // the path-op layer or grow the document without limit.
          if (raw !== undefined && (raw.length > MAX_CLEAR_IDS || raw.some(entry => typeof entry !== 'string' || entry.length === 0))) {
            writeJson(res, 400, { ok: false, code: 'bad-request', message: 'sessionIds must be an array of non-empty strings' })
            return
          }
          const sessionIds = raw as string[] | undefined
          try {
            await clearStats(sessionIds)
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 200, { ok: false, code: 'internal', message: String(error) })
          }
        },
      },
      {
        kind: 'exact',
        path: `${BRIDGE_PREFIX}/list-presets`,
        handler: async (req: { method: string }, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }) => {
          if (!guard(req, res)) return
          try {
            const presets = reviewCtx.get('agentPresets') as {
              list?: () => Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>>
            } | undefined
            const all = presets?.list ? await presets.list() : []
            const usable = all
              .filter(p => p.broken === undefined)
              .map(p => ({ id: p.id, name: p.name ?? p.id, description: p.description ?? '' }))
            writeJson(res, 200, { ok: true, presets: usable })
          } catch (error) {
            writeJson(res, 200, { ok: false, code: 'internal', message: String(error) })
          }
        },
      },
    ]

    sctx.effect(() => routes.map(route => webServer.register(route)), 'dsh-safe-tool: settings bridge')
  })

  // Resolve plugin data directory relative to DSH_HOME. All plugin-owned files
  // (the approval criteria and the review agent's workspace) live under one
  // `dsh-safe-tool` folder.
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '/tmp', '.dsh')
  const criteriaDir = join(home, 'dsh-safe-tool')
  const criteriaPath = join(criteriaDir, 'approval-criteria.md')

  // Dedicated review parent agent: a permanent, blank agent that mounts the
  // reviewer preset, so every review subagent inherits a minimal,
  // permission-poor composition instead of the main agent's full preset.
  // Its session never runs a turn, so it stays `blank` and is hidden from the
  // session list by the workspace tree. The working directory is the plugin
  // data folder's `safe-tool-log` sub-directory.
  const REVIEWER_PARENT_SESSION = 'dsh-safe-tool-reviewer-parent'
  const reviewerWorkspaceDir = join(criteriaDir, 'safe-tool-log')
  try {
    mkdirSync(reviewerWorkspaceDir, { recursive: true })
  } catch {
    // Non-fatal: agent creation validates cwd existence and will fail loud if unusable.
  }

  // A minimal "empty turn" seed (turn/start + turn/end, no step, no message)
  // that marks the parent session non-blank so dsh's session list renders it.
  // A turn with no step is explicitly legal, and a balanced log needs no
  // crash-repair, so this seed neither triggers a model call nor synthesises
  // any repair events.
  function emptyTurnSeed(): Array<Record<string, unknown>> {
    const t = Date.now()
    return [
      { type: 'turn/start', seq: 0, time: t, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: t, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
  }

  /**
   * Delete every persisted review-subagent session whose durable parent is the
   * review parent agent. Called when the visibility flips to "invisible"
   * (delete mode) so records accumulated while it was visible don't linger.
   *
   * `sessionPersistence.list()` yields snapshots (`{ header, revision, … }`),
   * never bare headers, so the durable parent/child fields must be read off
   * `snapshot.header`.
   */
  async function cleanupReviewerSessions(): Promise<void> {
    try {
      const persistence = ctx.get('sessionPersistence', false) as {
        list?: () => Promise<Array<{ header: SessionHeader }>>
      } | undefined
      if (typeof persistence?.list !== 'function') return
      const snapshots = await persistence.list()
      const children = snapshots
        .map((snapshot) => snapshot.header)
        .filter(h =>
          h.parentSession === REVIEWER_PARENT_SESSION && h.origin === 'subagent',
        )
      for (const header of children) {
        await removeReviewerSession(ctx, { id: String(header.id), cwd: header.cwd })
      }
    } catch {
      // Best-effort: leftover records are inert (hidden with the parent).
    }
  }

  /**
   * Read the persisted header of the dedicated review parent, when one exists.
   *
   * A fixed session id can only be created once: `agents.create` routes to
   * `sessionPersistence.create`, which throws as soon as a log for that id
   * exists. Existence must therefore be checked before deciding between resume
   * and create. `stat(id)` reports both a materialized log and an
   * unmaterialized in-process one.
   *
   * @returns the stored header, or `undefined` when absent or unreadable.
   */
  async function storedReviewerParentHeader(): Promise<SessionHeader | undefined> {
    try {
      const persistence = ctx.get('sessionPersistence', false) as {
        stat?: (id: string) => Promise<{ header: SessionHeader } | undefined>
      } | undefined
      return (await persistence?.stat?.(REVIEWER_PARENT_SESSION))?.header
    } catch {
      return undefined
    }
  }

  /**
   * Whether a stored review-parent session already carries the exact creation
   * configuration this call asks for. Any difference (visibility, preset, or
   * working directory) means the stored session cannot be reused as-is.
   */
  function parentConfigMatches(
    h: SessionHeader,
    visible: boolean,
    presetId: string,
    cwd: string,
  ): boolean {
    return (h.origin === 'subagent') === !visible
      && h.agentPreset === presetId
      && h.cwd === cwd
  }

  // Cached reviewer parent: the handle owns `dispose` (the registry returns a
  // bare Agent), so rebuilding on a visibility flip can tear the old one down.
  let reviewerParent: { handle: { agent: Agent; dispose: () => Promise<void> }; visible: boolean } | undefined
  let reviewerParentPending: Promise<Agent> | undefined

  /**
   * Lazily create (or rebuild) the dedicated review parent agent.
   *
   * `visible` mirrors `!deleteReviewerSessions`: when the caller keeps review
   * subagent sessions, the parent must be a normal, non-blank session so it
   * shows in the session list as the entry point to inspect those subagents.
   * When the caller deletes them, the parent stays an `origin: 'subagent'`,
   * blank session that remains hidden (the current behaviour).
   *
   * The parent is a singleton under a fixed id, reused across calls and across
   * restarts: a stored session carrying this exact configuration is resumed,
   * never recreated. Only a MISSING session is created, and a stored session
   * whose configuration no longer matches is discarded first — the parent never
   * runs a turn, so its session holds no history worth keeping.
   */
  function ensureReviewerParent(presetId: string, visible: boolean): Promise<Agent> {
    if (reviewerParent !== undefined && reviewerParent.visible === visible) {
      return Promise.resolve(reviewerParent.handle.agent)
    }
    if (reviewerParentPending !== undefined) return reviewerParentPending
    reviewerParentPending = (async () => {
      const agents = reviewCtx.get('agents') as unknown as {
        create: (opts: Record<string, unknown>) => Promise<{ agent: Agent; dispose: () => Promise<void> }>
        resume: (opts: Record<string, unknown>) => Promise<{ agent: Agent; dispose: () => Promise<void> }>
      }
      // Rebuild in-process: tear down the previous agent (its session is empty,
      // so no history is lost), then reuse or recreate the singleton below.
      if (reviewerParent !== undefined) {
        const wasVisible = reviewerParent.visible
        const old = reviewerParent
        reviewerParent = undefined
        try {
          await old.handle.dispose()
        } catch {
          // Best-effort: the registry clears the id on teardown.
        }
        // Flipping visible → invisible switches to "delete review records";
        // drop the subagent sessions that accumulated while it was visible.
        if (wasVisible && !visible) {
          await cleanupReviewerSessions()
        }
      }
      // Shared creation/resume composition: mount the reviewer preset.
      const setup = async (agentCtx: Context): Promise<void> => {
        const presets = agentCtx.get('agentPresets') as {
          mount: (ctx: Context, id: string) => Promise<unknown>
        }
        await presets.mount(agentCtx, presetId)
      }

      let stored = await storedReviewerParentHeader()
      if (stored !== undefined && !parentConfigMatches(stored, visible, presetId, reviewerWorkspaceDir)) {
        // Stale config (visibility flip, preset change, or moved workspace):
        // the parent's session is empty, so discarding it loses no history.
        await removeReviewerSession(ctx, { id: String(stored.id), cwd: stored.cwd })
        stored = undefined
      }
      if (stored === undefined) {
        // Best-effort removal of pre-0.2 artifacts (the old jsonl backend
        // stored sessions directly under its root, which the current backend
        // no longer reads — a leftover would make `create` throw
        // SessionAlreadyExistsError and silently fall back to the main agent).
        removeLegacyReviewerParentArtifacts(REVIEWER_PARENT_SESSION)
      }

      let handle: { agent: Agent; dispose: () => Promise<void> }
      try {
        handle = stored !== undefined
          ? await agents.resume({
              resumeSessionId: REVIEWER_PARENT_SESSION,
              agentOptions: {},
              setup,
            })
          : await agents.create({
              sessionId: REVIEWER_PARENT_SESSION,
              meta: {
                cwd: reviewerWorkspaceDir,
                agentPreset: presetId,
                ...(visible ? {} : { origin: 'subagent' }),
              },
              seed: visible ? emptyTurnSeed() : undefined,
              agentOptions: {},
              setup,
            })
      } catch (error) {
        // Reported once, at the fallback site in the review path.
        throw error
      }
      reviewerParent = { handle, visible }
      return handle.agent
    })().catch((error: unknown) => {
      throw error
    }).finally(() => {
      reviewerParentPending = undefined
    })
    return reviewerParentPending
  }

  // Auto-create criteria file if not exists
  if (!existsSync(criteriaPath)) {
    try {
      mkdirSync(criteriaDir, { recursive: true })
      writeFileSync(criteriaPath, DEFAULT_CRITERIA, 'utf-8')
    } catch {
      // Non-fatal: cannot create file, will use inline default
    }
  }

  // Shared cache instance — disposed with the plugin scope (reload-safe; the
  // cleanup timer is unref'd so it never pins the process).
  const cache = new ApprovalCache()
  ctx.effect(() => () => cache.dispose(), 'dsh-safe-tool: decision cache')

  // Reviewer children may not execute tools. 0.1.x expressed this as the
  // start-time `toolFilter: { deny: [all tools] }`; 0.2.x exposes no such field,
  // so the same effect is composed from the two current mechanisms:
  //
  //   1. `tools.restrict({ deny })` on the CHILD's scope hides every global tool
  //      from that agent (presentation, lookup and dispatch stay aligned) while
  //      leaving its agent-scoped `structured_output` — the decision channel —
  //      untouched, exactly like the old filter.
  //   2. `tools.guard()` is monotonic and order-independent, so a denial cannot
  //      be turned back into permission by another plugin's listener.
  //
  // Restrictions are installed once per child and released with this plugin's
  // scope, so no per-session bookkeeping survives a child.
  const reviewerRestrictions = new Map<string, () => void>()

  const restrictReviewer = (agent: unknown): void => {
    const id = (agent as { id?: string } | undefined)?.id
    if (id === undefined || reviewerRestrictions.has(id)) return
    const scoped = (agent as { ctx?: { tools?: { restrict?: (f: { deny: string[] }) => () => void } } } | undefined)
      ?.ctx?.tools
    if (scoped?.restrict === undefined) return
    try {
      const deny = ctx.tools.schemas().map(schema => schema.name)
      if (deny.length === 0) return
      reviewerRestrictions.set(id, scoped.restrict({ deny }))
    } catch (error) {
      // A child that cannot be restricted is still denied by the guard below.
      ctx.logger('dsh-safe-tool').warn('reviewer tool restriction unavailable: %C', error)
    }
  }

  // The child is ready for per-agent initialization here, before its first turn.
  ctx.on('agent/created', (payload) => {
    try {
      if (isPluginReviewer(payload?.agent)) restrictReviewer(payload.agent)
    } catch {
      // A listener throw fails creation; classification never blocks a child.
    }
    return undefined
  })

  ctx.tools.guard((exec) => {
    if (!currentConfig().enabled) return undefined
    if (!isPluginReviewer(exec.agent)) return undefined
    if (isStructuredOutput(exec.name)) return undefined
    // Align visibility on the first classified call if the child was created
    // before its descriptor was readable.
    restrictReviewer(exec.agent)
    return '[审批插件] 审核子代理不允许执行工具调用'
  })

  // Release every per-child restriction with the plugin scope.
  ctx.effect(() => () => {
    for (const dispose of reviewerRestrictions.values()) dispose()
    reviewerRestrictions.clear()
  }, 'dsh-safe-tool: reviewer tool restrictions')

  // Register the pre-execute interception hook
  // 'tools/pre-execute' is a waterfall: listeners receive (exec, next)
  // and return PreToolDecision or delegate to next()
  ctx.on('tools/pre-execute', async (exec, next) => {
    // The enable switch is read live here: turning it off immediately lets
    // every tool through, without touching the dsh plugin enable/disable
    // config (which would need a restart).
    const cfg = currentConfig()
    if (!cfg.enabled) {
      return next()
    }

    // Guard: exec.agent is required for review (spawn parent + cwd); without it skip
    if (!exec.agent) {
      return next()
    }

    // Reviewer children never enter the review path. In `allow-list` mode
    // `needsReview` is true for every tool OUTSIDE the list, so without this
    // early return the reviewer's own `structured_output` decision call would be
    // sent for review — spawning another reviewer, whose `structured_output` is
    // reviewed again: unbounded recursion. In `deny-list` mode the same hole
    // would spawn one useless review before the guard denied the call.
    // `structured_output` is the child's only decision channel, so it passes.
    // The monotonic guard below still backstops this denial independently of
    // listener order.
    if (isPluginReviewer(exec.agent)) {
      if (isStructuredOutput(exec.name)) {
        return next()
      }
      return {
        kind: 'deny' as const,
        reason: '[审批插件] 审核子代理不允许执行工具调用',
      }
    }

    // Fast path 1: tool not in filter scope → allow
    if (!needsReview({ mode: cfg.filterMode, tools: cfg.tools }, exec.name)) {
      return next()
    }

    // Fast path 2: auto-allow regex match → allow
    if (isAutoAllowed(exec.arguments, cfg.autoAllowPatterns)) {
      return next()
    }

    // Cache lookup: same (agent, tool, args) within 60s → reuse decision
    const agentId = exec.agent?.id
    const argsHash = hashArgs(exec.name, exec.arguments)
    if (agentId) {
      const cached = cache.get(agentId, exec.name, argsHash)
      if (cached !== undefined) {
        if (cached.approve) {
          return next()
        }
        return { kind: 'deny' as const, reason: `[AI审批缓存] ${cached.reason}` }
      }
    }

    // Validate the CONFIGURED reviewer provider/model against dsh BEFORE
    // launching the review subagent. A configured provider/model that dsh
    // does not know would otherwise make every review subagent fail to
    // resolve and silently surface as a misleading "[人工审批] 用户拒绝".
    // Fail fast with an actionable message instead.
    const invalidRoute = await checkReviewerModelRoute(ctx, cfg, exec.agent)
    if (invalidRoute !== undefined) {
      // A config error is a review error: the review subagent never ran, so
      // record it as an error-denied so the header stats reflect the failure
      // instead of silently dropping the intercept.
      const sessionId = exec.agent?.session?.id ?? exec.agent?.id ?? 'default'
      recordStats(String(sessionId), true, false)
      return { kind: 'deny' as const, reason: invalidRoute }
    }

    // Read latest approval criteria on every call (supports live editing)
    const criteriaText = existsSync(criteriaPath)
      ? readFileSync(criteriaPath, 'utf-8')
      : DEFAULT_CRITERIA

    // Build the review prompt
    const prompt = buildReviewPrompt({
      toolName: exec.name,
      toolDescription: extractToolDescription(ctx, exec.name),
      args: JSON.stringify(exec.arguments, null, 2),
      workspace: exec.agent?.session?.header?.cwd ?? process.cwd(),
      criteria: criteriaText,
    })

    // Launch review subagent (exec.agent is guaranteed non-null by guard above)
    let decision: ReviewDecision
    try {
      // The review subagent is spawned under a dedicated parent agent that
      // mounts the reviewer preset (default `minimal`), so it inherits a
      // minimal composition instead of the main agent's full preset. If the
      // configured preset is unknown or fails to mount, fall back to the main
      // agent as the parent and pin the reviewer preset ON THE SPAWN REQUEST
      // instead, so the child still composes from it (spawn supports
      // per-request agentPreset in 0.2.x).
      let reviewerParent: Agent
      let parentIsFallback = false
      try {
        // visible = !deleteReviewerSessions: when we keep review subagent
        // records, the parent shows in the session list as their entry point.
        reviewerParent = await ensureReviewerParent(cfg.reviewerPreset, !cfg.deleteReviewerSessions)
      } catch (error) {
        ctx.logger('dsh-safe-tool').warn('the review parent agent failed; falling back to the main agent as parent: %C', error)
        reviewerParent = exec.agent
        parentIsFallback = true
      }
      decision = await startReviewer(ctx, {
        prompt,
        // Use the main agent's provider/model — the web session agent carries
        // the deployment's default route in its options.
        ...(cfg.provider !== undefined || exec.agent.options.provider !== undefined
          ? { provider: cfg.provider ?? exec.agent.options.provider }
          : {}),
        ...(cfg.model !== undefined || exec.agent.options.model !== undefined
          ? { model: cfg.model ?? exec.agent.options.model }
          : {}),
        maxTokens: cfg.maxTokens,
        timeoutMs: cfg.timeoutMs,
        deleteSession: cfg.deleteReviewerSessions,
        // Every reviewer child runs in the plugin's private workspace.
        cwd: reviewerWorkspaceDir,
        // On the fallback parent (full main-agent composition), pin the child's
        // composition to the reviewer preset explicitly.
        ...(parentIsFallback ? { agentPreset: cfg.reviewerPreset } : {}),
      }, reviewerParent)
    } catch (error) {
      // Subagent start failed — fail closed for security
      decision = { approve: false, reason: `审核启动失败，默认拒绝: ${String(error).slice(0, 80)}` }
    }

    // Cache the result for 60s (same agent, same tool, same args)
    if (agentId) {
      cache.set(agentId, exec.name, argsHash, decision)
    }

    // Record the settled review outcome into this plugin's settings document.
    const sessionId = exec.agent?.session?.id ?? exec.agent?.id ?? 'default'
    recordStats(String(sessionId), decision.fallback ?? false, decision.approve)

    // Fallback: AI review could not produce a deterministic decision
    // → ask the human for approval (timeout, then deny)
    if (decision.fallback) {
      const approval = ctx.get('approval') as ApprovalService | undefined
      if (approval) {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), cfg.humanTimeoutMs)
        try {
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: exec.name,
            reason: `[AI审批回退] ${decision.reason}。请人工确认是否执行此命令：\n\`\`\`\n${exec.name} ${JSON.stringify(exec.arguments)}\n\`\`\`\n`,
            signal: controller.signal,
          })
          clearTimeout(timeoutId)
          // 'allowed-once' → allow; everything else → deny
          if (outcome === 'allowed-once') {
            return next()
          }
          return {
            kind: 'deny' as const,
            reason: `[人工审批] ${outcome === 'cancelled' ? '审批超时' : outcome === 'rejected' ? '用户拒绝' : '审批超时或不可用，已拒绝'}`,
          }
        } catch {
          clearTimeout(timeoutId)
          return {
            kind: 'deny' as const,
            reason: '[人工审批] 审批服务异常，拒绝执行',
          }
        }
      }
      // No approval service available — hard deny
      return {
        kind: 'deny' as const,
        reason: `[AI审批回退] ${decision.reason}，无人工审批通道，已拒绝`,
      }
    }

    // Apply AI decision
    if (decision.approve) {
      return next() // Approved → let the tool execute normally
    } else {
      return {
        kind: 'deny' as const,
        reason: `[AI审批拒绝] ${decision.reason}`,
      }
    }
  })
}

/** structured_output is the only tool reviewer subagents are allowed to call. */
const STRUCTURED_OUTPUT_TOOL = 'structured_output'

/** Check if the tool name is the structured_output helper. */
function isStructuredOutput(toolName: string): boolean {
  return toolName === STRUCTURED_OUTPUT_TOOL
}

/** Creation label every reviewer spawn carries, and the identity the 0.1.x
 * implementation folded from `subagent/descriptor` events. */

/**
 * Check whether an agent is a plugin reviewer subagent.
 *
 * The 0.1.x implementation read the child's `subagent/descriptor` event and
 * compared `label` against {@link PLUGIN_REVIEWER_LABEL}. 0.2.x prohibits those
 * synchronous session reads (`session.snapshotEvents`/`ownEvents` are
 * deprecated for new calls), so the same identity is resolved two ways, both
 * exact:
 *
 *   1. Ids this runtime instance spawned — recorded from the activation handle,
 *      which is the identity the plugin itself created.
 *   2. The child's durable descriptor label, folded through the subagent
 *      catalog (`listChildren`), which covers a child created by an earlier
 *      runtime instance (e.g. resumed after a restart).
 *
 * Detection deliberately does NOT key off the working directory: the reviewer
 * workspace is a real path a user could open a session in, and treating such a
 * session as a reviewer child would deny every tool it calls.
 *
 * @param ctx - plugin context carrying the `subagents` service.
 * @param agent - the agent whose session is classified.
 * @returns whether the agent is one of the plugin's own reviewer subagents.
 */
function isPluginReviewer(agent: Agent | undefined): boolean {
  // The 0.1.x classifier, unchanged: the establishing provider appends a
  // `subagent/descriptor` event (carrying the creation label) to the CHILD's own
  // session, so the child's own events are the authority. dsh 0.2.x exposes them
  // as `Session.ownEvents()`. No per-review bookkeeping is needed, and the answer
  // is the same before and after the child is disposed.
  try {
    const session = (agent as { session?: { ownEvents?: () => readonly unknown[] } } | undefined)?.session
    if (session === undefined || typeof session.ownEvents !== 'function') return false
    return hasReviewerDescriptor(session.ownEvents() as readonly unknown[], PLUGIN_REVIEWER_LABEL)
  } catch {
    // An unreadable session leaves the child unclassified; the pre-execute
    // review still guards the call, so this never opens an unreviewed path.
    return false
  }
}

/**
 * Remove pre-0.2 session artifacts for one fixed id, best-effort. The 0.1.x
 * jsonl backend stored sessions directly under its root
 * (`<root>/<id>/session.jsonl.zstd`); the 0.2.x backend nests them under a
 * project directory and never reads the legacy layout, so a leftover only
 * blocks re-creating the id.
 */
function removeLegacyReviewerParentArtifacts(id: string): void {
  // The caller passes the fixed reviewer-parent id, but a recursive delete must
  // never depend on that: accept only one plain path segment.
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') return
  try {
    const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '/tmp', '.dsh')
    const legacyRoots = [join(home, 'sessions'), join(home, 'profiles', process.env.DSH_PROFILE ?? 'web', 'sessions')]
    for (const root of legacyRoots) {
      rmSync(join(root, id), { recursive: true, force: true })
    }
  } catch {
    // Best-effort.
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function buildReviewPrompt(input: {
  toolName: string
  toolDescription: string
  args: string
  workspace: string
  criteria: string
}): string {
  return `请审查以下工具调用请求是否安全可执行。

## 工具信息
- 工具名称：${input.toolName}
- 工具描述：${input.toolDescription}
- 调用参数：\`\`\`json
${input.args}
\`\`\`
- 工作目录：${input.workspace}

## 审批标准
\`\`\`
${input.criteria}
\`\`\`

## 你的任务
根据以上标准判断该命令是否应被允许执行。

调用 \`structured_output\` 工具，参数格式：
{ "approve": true/false, "reason": "简短原因（中文）" }

只输出 JSON，不要有其他内容。`
}

function extractToolDescription(ctx: Context, toolName: string): string {
  // Access the tools service through the declared inject binding
  try {
    const tools = (ctx as unknown as Record<string, unknown>).tools as {
      get?: (name: string, scope?: unknown) => { description?: string } | undefined
    }
    const desc = tools?.get?.(toolName, undefined)?.description
    if (typeof desc === 'string' && desc.length > 0) return desc
  } catch {
    // Ignore — tool description is optional
  }
  return '(无描述)'
}

/**
 * Verify that a CONFIGURED reviewer provider/model actually exists in dsh.
 *
 * The reviewer route is `cfg.provider ?? agent.options.provider` (and the
 * model analogue). Inherited values are valid by construction — the main
 * agent is already running on them — so only explicitly configured values are
 * checked here.
 *
 * @returns an error message when the route is invalid, or `undefined` when it
 *   is usable (or when nothing is configured / the LLM registry is absent).
 */
async function checkReviewerModelRoute(
  ctx: Context,
  cfg: ApprovalConfig,
  agent: Agent,
): Promise<string | undefined> {
  // Nothing configured → the route is fully inherited, valid by construction.
  if (cfg.provider === undefined && cfg.model === undefined) return undefined

  const llm = ctx.get('llm', false) as {
    listProviders?: () => Array<{ id: string }>
    resolveModelInfo?: (provider: string, model: string) => Promise<unknown>
  } | undefined
  // No LLM registry to validate against — nothing here can be confirmed wrong.
  if (llm === undefined) return undefined

  // The provider the reviewer will actually route through.
  const provider = cfg.provider ?? agent.options.provider

  if (cfg.provider !== undefined) {
    const providers = llm.listProviders?.() ?? []
    if (!providers.some((p) => p.id === cfg.provider)) {
      return '审核模型配置无效，请检查模型配置'
    }
  }

  if (cfg.model !== undefined && provider !== undefined) {
    try {
      await llm.resolveModelInfo?.(provider, cfg.model)
    } catch {
      return '审核模型配置无效，请检查模型配置'
    }
  }

  return undefined
}

const DEFAULT_CRITERIA = `## 允许执行
- 只读文件操作：cat, head, tail, grep, find, ls, wc, diff
- 项目构建和测试：npm install, pnpm build, tsc, pnpm test, pnpm dev
- Git 查看操作：git status, git log, git diff（非 push/force push）
- 系统状态查看：ps, docker ps, df, free, top

## 拒绝执行
- 删除操作：rm -rf, rm -r, unlink, truncate
- 高危网络请求：curl POST 含 token/key/password, nc/nmap 端口扫描
- 系统级修改：写入 /etc/, /usr/, /sbin/
- 权限提升：sudo, su, chmod 777, chown root
- 加密货币/挖矿相关命令
- 数据库 DROP/TRUNCATE/DELETE 无 WHERE 条件
- 写入敏感文件：.env, .ssh/, id_rsa, authorized_keys
- 任何包含 base64 编码后疑似恶意负载的命令
- 读取、修改、删除审批标准文件：$DSH_HOME/dsh-safe-tool/approval-criteria.md`
