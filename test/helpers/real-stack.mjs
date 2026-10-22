/**
 * Real-cordis assembly harness for the host half.
 *
 * A REAL `Context` from `@deepseek-ai/cordis` mounts the plugin under test next
 * to a service-provider plugin, so a run exercises real inject ordering, real
 * `ctx.inject` scoping, real effect disposal and a real
 * `waterfall('tools/pre-execute')` dispatch — not a hand-rolled event loop.
 *
 * The collaborators are stand-ins (the real ones need a full profile, a model
 * route and a session store); what the tests assert is the plugin's own contract
 * with them: the exact activation request, the settings path ops, the bridge
 * routes and the review decision.
 *
 * @module dsh-safe-tool/test/helpers
 */

import assert from 'node:assert/strict'
import { requirePlatformPackages } from './preconditions.mjs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

export const DSH_AI = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
export const BUNDLE = new URL('../../lib/index.js', import.meta.url).href

/** Current on-disk session format, read from the platform catalog. */
export const SESSION_FORMAT_VERSION = 4

export const loadFromDsh = (pkg) =>
  import(pathToFileURL(join(DSH_AI, pkg, 'lib/index.js')).href)

/** Poll until `fn()` is truthy or the deadline passes. */
export async function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) return undefined
    await new Promise(r => setTimeout(r, 25))
  }
}

/** A minimal live agent shape the approval path reads. */
export function fakeAgent(id, cwd) {
  return {
    id,
    session: { id, header: { id, cwd } },
    options: { provider: 'ai', model: 'glm-5.3-flash' },
  }
}

/** Apply one ordered path op to a plain-object document (`applyPathOp` shape). */
function applyPathOp(document, op) {
  const walk = (input, path) => {
    const [head, ...rest] = path
    if (head === undefined) return op.op === 'set' ? structuredClone(op.value) : undefined
    const value = input ?? {}
    const result = (typeof value === 'object' && value !== null && !Array.isArray(value)) ? { ...value } : {}
    const child = walk(result[head], rest)
    if (child === undefined) delete result[head]
    else result[head] = child
    return result
  }
  return walk(document, op.path)
}

/**
 * Mount the plugin in a real Cordis context.
 *
 * @param t - node:test context (registers env restoration).
 * @param options - `home` to use as DSH_HOME; `structured` to fix the review result.
 * @returns handles the assertions need, plus a teardown.
 */
export async function withRealStack(t, { home, structured, config } = {}) {
  // Fail loudly when the harness packages this stack borrows are absent.
  requirePlatformPackages()
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  })

  const reviewWorkspace = join(home, 'dsh-safe-tool', 'safe-tool-log')
  const calls = { startActivation: [], bridgeRoutes: [], childHandles: [], childArtifactDirs: [], spawnErrors: [] }

  // Faithful stand-in for the host settings service (`SettingsForms`), reduced
  // to what the tallies use: one document per entry id, a describe projection,
  // and ordered path ops. `notifications` records the platform edge that the
  // browser half listens for.
  const settings = {
    documents: new Map([['dsh-safe-tool', { sessions: {} }]]),
    mutations: [],
    notifications: [],
    describe() {
      return [...settings.documents.entries()].map(([ns, value]) => ({ ns, value: structuredClone(value) }))
    },
    async mutate(ns, ops, expectedRevision) {
      const document = settings.documents.get(String(ns))
      if (document === undefined) throw new Error(`No configurable plugin entry "${String(ns)}"`)
      settings.mutations.push({ ns: String(ns), ops: structuredClone(ops), expectedRevision })
      settings.documents.set(
        String(ns),
        ops.reduce((accumulated, op) => applyPathOp(accumulated, op), document),
      )
      settings.notifications.push(String(ns))
    },
  }

  const routes = new Map()
  const webServer = {
    register(route) {
      calls.bridgeRoutes.push(route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }

  const subagents = {
    getProvider: (name) => (name === 'spawn' ? { name: 'spawn' } : undefined),
    list: () => ['spawn'],
    startActivation: async (spec) => {
      calls.startActivation.push(spec)
      const childId = `child-${calls.startActivation.length}-${Date.now()}`
      // Persist the child the way the real spawn provider does: a durable
      // session under the configured root, with the reviewer identity.
      let handle
      try {
        const { materializeCreateHeader } = await loadFromDsh('dsh-session-persistence')
        handle = await root.get('sessionPersistence').create(materializeCreateHeader({
          version: SESSION_FORMAT_VERSION,
          id: childId,
          createdAt: Date.now(),
          cwd: spec.request.cwd,
          parentSession: String(spec.request.parent.session.id),
          isSeeded: false,
          origin: 'subagent',
          delegationDepth: 1,
          ...(spec.request.agentPreset !== undefined ? { agentPreset: spec.request.agentPreset } : {}),
        }))
        // `create` alone persists nothing: a real review child appends events and
        // flushes, which is what materializes its artifact directory.
        await handle.append([{ seq: 0, type: 'message/user', data: { text: 'review this call' } }])
        await handle.flush()
        calls.childHandles.push(handle)
        const artifactDir = readdirSync(sessionRootDir, { recursive: true })
          .map(String)
          .find(name => name.split('/').includes(childId))
        if (artifactDir !== undefined) calls.childArtifactDirs.push(join(sessionRootDir, artifactDir))
      } catch (error) {
        // A failure here still leaves the review path testable.
        calls.spawnErrors.push(String(error))
      }
      return {
        childId,
        result: Promise.resolve(structured ?? { output: [], structured: { approve: true, reason: 'ok' }, stopReason: 'completed' }),
        dispose: async () => { await handle?.close?.().catch(() => {}) },
      }
    },
  }

  const parentHandles = []
  const agents = {
    create: async (opts) => {
      if (typeof opts.setup === 'function') await opts.setup(root)
      const handle = { agent: fakeAgent(opts.sessionId, reviewWorkspace), dispose: async () => {} }
      parentHandles.push(handle)
      return handle
    },
    resume: async (opts) => {
      if (typeof opts.setup === 'function') await opts.setup(root)
      const handle = { agent: fakeAgent('dsh-safe-tool-reviewer-parent', reviewWorkspace), dispose: async () => {} }
      parentHandles.push(handle)
      return handle
    },
  }

  const agentPresets = { list: async () => [{ id: 'minimal', name: 'minimal' }], mount: async () => {} }
  const approval = { request: async () => 'rejected' }
  // The real ToolRuntime surface this plugin uses (`guard` is the monotonic
  // denial path; `schemas` enumerates global tools; `restrict` hides them from
  // one agent scope). A stub without them hides real contract breaks.
  const guards = []
  const restrictions = []
  const tools = {
    get: () => ({ description: 'Run commands in a bash shell' }),
    schemas: () => [{ name: 'bash' }, { name: 'write' }, { name: 'read' }],
    guard(guard) {
      guards.push(guard)
      const disposer = () => {
        const index = guards.indexOf(guard)
        if (index >= 0) guards.splice(index, 1)
      }
      return disposer
    },
    restrict(filter) {
      restrictions.push(filter)
      return () => {}
    },
  }

  const collaborators = {
    name: 'test-collaborators',
    apply(c) {
      c.provide('subagents', subagents)
      c.provide('agents', agents)
      c.provide('agentPresets', agentPresets)
      c.provide('approval', approval)
      c.provide('tools', tools)
      c.provide('webServer', webServer)
      c.provide('settings', settings)
    },
  }

  const root = new Context()
  // The REAL session backend, pointed at this test's temp root. A review child
  // is a real persisted session here, so the cleanup path deletes a real
  // directory instead of a double's idea of one.
  const sessionRootDir = join(home, 'sessions')
  root.plugin(await loadFromDsh('dsh-session-persistence-jsonl'), { root: sessionRootDir })
  root.plugin(collaborators)

  const plugin = await import(BUNDLE)
  root.plugin(plugin, {
    enabled: true,
    provider: undefined,
    model: undefined,
    maxTokens: 2048,
    timeoutMs: 2000,
    humanTimeoutMs: 1000,
    filterMode: 'deny-list',
    tools: ['bash', 'write'],
    autoAllowPatterns: [],
    deleteReviewerSessions: true,
    reviewerPreset: 'minimal',
    sessions: {},
    // Applied last: a test that overrides one field must actually win.
    ...(config ?? {}),
  })

  const backendReady = await waitFor(() => root.get('sessionPersistence') !== undefined)
  assert.ok(backendReady, 'the real session backend became available')
  const ready = await waitFor(() => root.get('webServer') !== undefined && calls.bridgeRoutes.length >= 3)
  assert.ok(ready, 'the plugin became active and registered its bridge routes')

  return {
    root,
    calls,
    settings,
    reviewWorkspace,
    sessionRootDir,
    /** The directory the backend would use for one session id, or undefined. */
    sessionDir(id, cwd) {
      const persistence = root.get('sessionPersistence')
      return typeof persistence?.root === 'string' ? { backendRoot: persistence.root } : undefined
    },
    async bridge(path, body) {
      const route = routes.get(path)
      assert.ok(route, `bridge route ${path} registered`)
      return dispatchBridge(route, body)
    },
    async teardown() {
      for (const handle of parentHandles) await handle.dispose().catch(() => {})
      try { await root.fiber.dispose() } catch { /* already disposed */ }
    },
  }
}

/** Drive one registered bridge route's handler with synthetic req/res. */
export async function dispatchBridge(route, body) {
  let done
  const finished = new Promise(resolve => { done = resolve })
  const res = {
    code: undefined,
    payload: undefined,
    writeHead(code) { this.code = code },
    end(payload) { this.payload = payload; done() },
  }
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(JSON.stringify(body ?? {})))
      if (event === 'end') setImmediate(() => handler())
    },
  }
  await route.handler(req, res)
  await finished
  return JSON.parse(res.payload)
}
