/**
 * Main plugin entry point for dsh-safe-tool.
 *
 * Registers a `tools/pre-execute` waterfall listener that intercepts tool
 * calls, optionally reviews them via a read-only subagent, and returns an
 * allow or deny decision.
 *
 * Also registers a settings namespace so the plugin's configuration appears
 * in the Web UI Settings → Plugins page.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { needsReview, isAutoAllowed, hashArgs } from './filter.ts'
import { startReviewer } from './reviewer.ts'
import { ApprovalCache } from './cache.ts'
import type { ApprovalConfig, ReviewDecision } from './types.ts'
import { foldSubagentDescriptor } from './descriptor.ts'

export const name = 'dsh-safe-tool'
export const inject = ['tools', 'subagents', 'approval', 'webServer', 'settings'] as const

const BRIDGE_PREFIX = '/api/dsh-safe-tool-settings'
const NS = 'dsh-safe-tool'
const STATS_NS = 'dsh-safe-tool-stats'

// ─── Session Stats ────────────────────────────────────────────

interface SessionStats {
  total: number
  approved: number
  denied: number
  errorDenied: number
}

// ─── Configuration ────────────────────────────────────────────

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  provider: Schema.string().default(undefined),
  model: Schema.string().default(undefined),
  maxTokens: Schema.number().default(2048),
  timeoutMs: Schema.number().default(30000),
  humanTimeoutMs: Schema.number().default(30000),
  filterMode: Schema.union(['deny-list', 'allow-list']).default('deny-list'),
  tools: Schema.array(Schema.string()).default(['bash', 'write']),
  autoAllowPatterns: Schema.array(Schema.string()).default([]),
  deleteReviewerSessions: Schema.boolean().default(true),
  reviewerPreset: Schema.string().default('minimal'),
})

// ─── Plugin ───────────────────────────────────────────────────

export function apply(ctx: Context, config: ApprovalConfig): void {
  // Live config source: the settings scope's resolved value thunk. The review
  // path reads through this on every tool call, so the enable switch and every
  // other setting take effect immediately (no restart).
  let currentConfig: () => ApprovalConfig = () => config

  // Filter context injections out of the reviewer subagent's turn. Registered
  // here (root) with `prepend` so it runs BEFORE every producer's own
  // `agent/pre-step` injection: it awaits `next()` (letting skill catalog,
  // memos, workspace instructions, and the default runtime-context tail all
  // land), then drops the non-`user` messages for reviewer children only.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next() as { kind?: string; messages?: Array<{ source?: { kind?: string } }> }
    if (decision?.kind !== 'enter' || !decision.messages) return decision
    const agent = (payload as { agent?: { session?: { events?: readonly unknown[] } } }).agent
    if (agent === undefined || !isPluginReviewer({ session: { events: agent.session?.events ?? [] } as never })) return decision
    const filtered = decision.messages.filter(m => m.source?.kind === 'user')
    if (filtered.length === decision.messages.length) return decision
    return { ...decision, messages: filtered }
  }, { prepend: true })

  // Register settings namespace for Web UI configuration card
  installSettingsSection(ctx, settingsNamespace(NS), Config, config, {
    setSource: (source) => {
      currentConfig = source
    },
    onChange: () => {
      // The review path reads `currentConfig()` on every call, so a change is
      // picked up immediately without re-registering anything.
    },
  })

  // Register settings namespace for the per-session approval stats. Writing
  // stats through `settings.mutate` emits a `settings/document-updated` event
  // that the browser half turns into a live refresh — no session-log events,
  // no client polling.
  installSettingsSection(ctx, settingsNamespace(STATS_NS), Schema.object({
    sessions: Schema.dict(Schema.object({
      total: Schema.number().default(0),
      approved: Schema.number().default(0),
      denied: Schema.number().default(0),
      errorDenied: Schema.number().default(0),
    }), Schema.string()).default({}),
  }), { sessions: {} }, {
    setSource: () => {
      // Stats are written by recordStats(); the source thunk is not retained.
    },
    onChange: () => {
      // Stats are written by recordStats().
    },
  })

  // Register bridge API for Web UI settings card
  ctx.inject(['webServer', 'settings'], (sctx) => {
    const settings = sctx.get('settings')
    const webServer = sctx.get('webServer')

    const guard = (req: { method: string; headers: Record<string, string> }, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }) => {
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

    const readJsonBody = async (req: { headers: Record<string, string>; on: (event: string, handler: (chunk: Buffer) => void) => void }) => {
      return new Promise<unknown>((resolve, reject) => {
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
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
        path: `${BRIDGE_PREFIX}/describe`,
        handler: async (req, res) => {
          if (!guard(req as any, res as any)) return
          const body = await readJsonBody(req as any)
          const targetNs = (body && typeof body === 'object' && (body as { ns?: string }).ns) || NS
          if (targetNs !== NS && targetNs !== STATS_NS) {
            writeJson(res as any, 400, { ok: false, code: 'settings-rejected', message: `unknown namespace "${targetNs}"` })
            return
          }
          try {
            const descriptors = settings.describe({ redactSecrets: true })
            const descriptor = descriptors.find(d => String(d.ns) === targetNs)
            if (!descriptor) {
              writeJson(res as any, 200, { ok: false, code: 'settings-not-exposed', message: `namespace "${targetNs}" is not exposed` })
              return
            }
            writeJson(res as any, 200, {
              ok: true,
              value: {
                namespace: targetNs,
                value: descriptor.value,
                revision: descriptor.revision,
              }
            })
          } catch (error) {
            writeJson(res as any, 200, { ok: false, code: 'internal', message: String(error) })
          }
        },
      },
      {
        kind: 'exact',
        path: `${BRIDGE_PREFIX}/mutate`,
        handler: async (req, res) => {
          if (!guard(req as any, res as any)) return
          const body = await readJsonBody(req as any)
          if (!body || typeof body !== 'object') {
            writeJson(res as any, 400, { ok: false, code: 'settings-rejected', message: 'malformed JSON body' })
            return
          }
          const { ns, ops, expectedRevision } = body as { ns: string; ops: unknown[]; expectedRevision?: number }
          if (ns !== NS) {
            writeJson(res as any, 400, { ok: false, code: 'settings-rejected', message: `namespace mismatch: expected "${NS}", got "${ns}"` })
            return
          }
          try {
            const result = await settings.mutate(settingsNamespace(NS), ops as any, expectedRevision)
            writeJson(res as any, 200, { ok: true, value: result })
          } catch (error) {
            writeJson(res as any, 200, { ok: false, code: 'settings-conflict', message: String(error) })
          }
        },
      },
      {
        kind: 'exact',
        path: `${BRIDGE_PREFIX}/stats-list`,
        handler: async (req, res) => {
          if (!guard(req as any, res as any)) return
          try {
            const resolved = settings.get(settingsNamespace(STATS_NS)) as { sessions?: Record<string, SessionStats> } | undefined
            writeJson(res as any, 200, { ok: true, sessions: resolved?.sessions ?? {} })
          } catch (error) {
            writeJson(res as any, 200, { ok: false, code: 'internal', message: String(error) })
          }
        },
      },
      {
        kind: 'exact',
        path: `${BRIDGE_PREFIX}/stats-clear`,
        handler: async (req, res) => {
          if (!guard(req as any, res as any)) return
          const body = await readJsonBody(req as any)
          const sessionIds = (body && typeof body === 'object' && Array.isArray((body as { sessionIds?: unknown }).sessionIds))
            ? (body as { sessionIds: string[] }).sessionIds
            : undefined
          const ns = settingsNamespace(STATS_NS)
          try {
            if (sessionIds === undefined || sessionIds.length === 0) {
              // One-shot clear-all.
              await settings.mutate(ns, [{ op: 'set', path: ['sessions'], value: {} }])
            } else {
              await settings.mutate(ns, sessionIds.map(id => ({ op: 'unset', path: ['sessions', id] })))
            }
            writeJson(res as any, 200, { ok: true })
          } catch (error) {
            writeJson(res as any, 200, { ok: false, code: 'settings-conflict', message: String(error) })
          }
        },
      },
      {
        kind: 'exact',
        path: `${BRIDGE_PREFIX}/list-presets`,
        handler: async (req: { method: string }, res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void }) => {
          if (!guard(req as any, res as any)) return
          try {
            const presets = ctx.get('agentPresets') as {
              list?: () => Promise<Array<{ id: string; name?: string; description?: string; broken?: string }>>
            } | undefined
            const all = presets?.list ? await presets.list() : []
            const usable = all
              .filter(p => p.broken === undefined)
              .map(p => ({ id: p.id, name: p.name ?? p.id, description: p.description ?? '' }))
            writeJson(res as any, 200, { ok: true, presets: usable })
          } catch (error) {
            writeJson(res as any, 200, { ok: false, code: 'internal', message: String(error) })
          }
        },
      },
    ]

    sctx.effect(() => routes.map(route => webServer.register(route)), 'dsh-safe-tool: settings bridge')
  })

  // Record one settled approval decision into the per-session stats namespace.
  // This emits `settings/document-updated`, which the browser half subscribes
  // to for a live refresh.
  function recordStats(sessionId: string, isFallback: boolean, approve: boolean): void {
    const settings = ctx.get('settings')
    if (!settings) return

    const ns = settingsNamespace(STATS_NS)
    const resolved = settings.get(ns) as { sessions?: Record<string, SessionStats> } | undefined
    const prev = resolved?.sessions?.[sessionId] ?? { total: 0, approved: 0, denied: 0, errorDenied: 0 }

    // Build a fresh object — the resolved value is deep-frozen, so adding a
    // field in place would throw; the path-op targets sessions.<sessionId>.
    const stats: SessionStats = {
      total: prev.total + 1,
      approved: prev.approved + (!isFallback && approve ? 1 : 0),
      denied: prev.denied + (!isFallback && !approve ? 1 : 0),
      errorDenied: prev.errorDenied + (isFallback ? 1 : 0),
    }

    settings.mutate(ns, [{ op: 'set', path: ['sessions', sessionId], value: stats }]).catch(() => {
      // Ignore mutation errors — stats are best-effort.
    })
  }

  // Drop a session's stats when it is disposed (closed/deleted): the
  // `session/disposed` event fires when the session leaves the live store, so
  // archived or deleted sessions do not leave their tally behind forever.
  ctx.on('session/disposed', (session) => {
    const settings = ctx.get('settings')
    if (!settings) return

    const sessionKey = String(session.id)
    const ns = settingsNamespace(STATS_NS)
    // Use `unset` at sessions.<sessionId> — the resolved value is deep-frozen,
    // so reading the whole map and rebuilding it would violate immutability.
    settings.mutate(ns, [{ op: 'unset', path: ['sessions', sessionKey] }]).catch(() => {
      // Ignore cleanup errors — stats are best-effort.
    })
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
  // data folder's `workspace` sub-directory.
  const REVIEWER_PARENT_SESSION = 'dsh-safe-tool-reviewer-parent'
  const reviewerWorkspaceDir = join(criteriaDir, 'workspace')
  try {
    mkdirSync(reviewerWorkspaceDir, { recursive: true })
  } catch {
    // Non-fatal: agent creation validates cwd existence and will fail loud if unusable.
  }

  let reviewerParentPromise: Promise<Agent> | undefined

  function ensureReviewerParent(presetId: string): Promise<Agent> {
    if (reviewerParentPromise !== undefined) return reviewerParentPromise
    reviewerParentPromise = (async () => {
      const agents = ctx.get('agents') as unknown as {
        get?: (id: string) => Agent | undefined
        create: (opts: Record<string, unknown>) => Promise<{ agent: Agent }>
      }
      // Reuse an already-published agent (e.g. across HMR reloads).
      const existing = agents.get?.(REVIEWER_PARENT_SESSION)
      if (existing !== undefined) return existing
      const handle = await agents.create({
        sessionId: REVIEWER_PARENT_SESSION,
        meta: {
          cwd: reviewerWorkspaceDir,
          agentPreset: presetId,
          origin: 'subagent',
        },
        agentOptions: {},
        setup: async (agentCtx: Context) => {
          const presets = agentCtx.get('agentPresets') as {
            mount: (ctx: Context, id: string) => Promise<unknown>
          }
          await presets.mount(agentCtx, presetId)
        },
      })
      return handle.agent
    })().catch((error: unknown) => {
      // Reset so a later review can retry instead of caching the failure.
      reviewerParentPromise = undefined
      throw error
    })
    return reviewerParentPromise
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

  // Shared cache instance — survives HMR reloads
  const cache = new ApprovalCache()

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

    // FIX: Reject plugin's own reviewer subagents for EXECUTION tools only.
    // REVIEWER tools (structured_output) must be allowed — the subagent
    // needs structured_output to return its approval decision.
    // Plugin reviewer subagents have label='ai-approval-reviewer' in their descriptor
    if (isPluginReviewer(exec.agent) && !isStructuredOutput(exec.name)) {
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

    // Read latest approval criteria on every call (supports live editing)
    const criteriaText = existsSync(criteriaPath)
      ? readFileSync(criteriaPath, 'utf-8')
      : DEFAULT_CRITERIA

    // Build the review prompt
    const prompt = buildReviewPrompt({
      toolName: exec.name,
      toolDescription: extractToolDescription(ctx, exec.name),
      args: JSON.stringify(exec.arguments, null, 2),
      workspace: exec.agent?.cwd ?? process.cwd(),
      criteria: criteriaText,
    })

    // Launch review subagent (exec.agent is guaranteed non-null by guard at line 78)
    let decision: ReviewDecision
    try {
      // The review subagent is spawned under a dedicated parent agent that
      // mounts the reviewer preset (default `minimal`), so it inherits a
      // minimal composition instead of the main agent's full preset. If the
      // configured preset is unknown or fails to mount (e.g. removed by a
      // future dsh change), fall back to the main agent as the parent so the
      // review keeps working under the inherited composition.
      let reviewerParent: Agent
      try {
        reviewerParent = await ensureReviewerParent(cfg.reviewerPreset)
      } catch {
        reviewerParent = exec.agent
      }
      decision = await startReviewer(ctx, {
        prompt,
        // Use the main agent's provider/model — api-proxy sets these from
        // agentDefaultModel when creating the web session agent.
        provider: cfg.provider ?? exec.agent.options.provider,
        model: cfg.model ?? exec.agent.options.model,
        maxTokens: cfg.maxTokens,
        timeoutMs: cfg.timeoutMs,
        deleteSession: cfg.deleteReviewerSessions,
      }, reviewerParent)
    } catch (error) {
      // Subagent start failed — fail closed for security
      decision = { approve: false, reason: `审核启动失败，默认拒绝: ${String(error).slice(0, 80)}` }
    }

    // Cache the result for 60s (same agent, same tool, same args)
    if (agentId) {
      cache.set(agentId, exec.name, argsHash, decision)
    }

    // Record the settled review outcome into the per-session stats settings
    // namespace. The browser half refreshes via the `settings/document-updated`
    // WSS event — no session-log events, no client polling.
    const sessionId = exec.agent?.session?.id ?? exec.agent?.sessionId ?? 'default'
    recordStats(String(sessionId), decision.fallback ?? false, decision.approve)

    // Fallback: AI review could not produce a deterministic decision
    // → ask the human for approval (30s timeout, then deny)
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

const PLUGIN_REVIEWER_LABEL = 'ai-approval-reviewer'
/** structured_output is the only tool reviewer subagents are allowed to call. */
const STRUCTURED_OUTPUT_TOOL = 'structured_output'

/** Check if the tool name is the structured_output helper. */
function isStructuredOutput(toolName: string): boolean {
  return toolName === STRUCTURED_OUTPUT_TOOL
}

/**
 * Check if an agent is a plugin reviewer subagent by inspecting its session descriptor.
 * Plugin reviewer subagents are created with label='ai-approval-reviewer'.
 */
function isPluginReviewer(agent: { session: { events: readonly unknown[] } }): boolean {
  try {
    const events = agent.session.events as Array<{ type: string; data: unknown }>
    const descriptorEvent = events.find(e => e.type === 'subagent/descriptor')
    if (!descriptorEvent) return false
    const descriptor = foldSubagentDescriptor([descriptorEvent as any])
    return descriptor?.label === PLUGIN_REVIEWER_LABEL
  } catch {
    return false
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
