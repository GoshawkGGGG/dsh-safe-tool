/**
 * Behavior tests for the BUILT dsh-safe-tool bundle (lib/index.js).
 *
 * The plugin is driven through a minimal in-memory Cordis-context fake, so
 * every wiring surface the plugin touches is exercised end to end:
 * tools/pre-execute waterfall, reviewer spawn (startActivation), structured /
 * free-text / failed review outcomes, human-approval fallback, the stats
 * storage domain, the HTTP bridge routes, the agent/pre-step context filter,
 * the reviewer-parent lifecycle, and session-artifact cleanup.
 *
 * Run: node --test test/
 * @module dsh-safe-tool/test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { requireBuiltArtifact } from './helpers/preconditions.mjs'

/** The platform's own descriptor version, as the real provider writes it. */
const { SUBAGENT_DESCRIPTOR_VERSION } = createRequire(import.meta.url)('@deepseek-ai/dsh-subagent')

const BUNDLE = new URL('../lib/index.js', import.meta.url).href
const BUNDLE_PATH = fileURLToPath(new URL('../lib/index.js', import.meta.url))
requireBuiltArtifact(new URL('../lib/index.js', import.meta.url), 'lib/index.js')
const CLIENT = new URL('../lib/client.js', import.meta.url)
requireBuiltArtifact(new URL('../lib/client.js', import.meta.url), 'lib/client.js')

// ─── Fakes ──────────────────────────────────────────────────────

/** Minimal fake of the cordis Context surface the plugin uses. */
class FakeCtx {
  constructor(services = {}) {
    this.services = new Map(Object.entries(services))
    this.handlers = new Map()
    this.effects = []
    this.injectCalls = []
    this.log = []
    // Real cordis exposes services BOTH as `ctx.get(name)` and as property
    // accessors (`ctx.subagents`); the plugin uses both spellings.
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) return target[prop]
        if (target.services.has(prop)) return target.services.get(prop)
        return undefined
      },
    })
  }

  /**
   * The real cordis logging service: `ctx.logger` is callable to mint a named
   * logger, and every logger carries the four severity methods. Diagnostics
   * recorded here let a test assert what the plugin reported.
   */
  logger(name) {
    const record = (type) => (format, ...args) => {
      this.log.push({ name, type, format, args })
    }
    return { error: record('error'), warn: record('warn'), info: record('info'), debug: record('debug') }
  }

  get(name) {
    return this.services.get(name)
  }

  on(event, handler, opts) {
    if (!this.handlers.has(event)) this.handlers.set(event, [])
    this.handlers.get(event).push({ handler, opts })
    return () => {}
  }

  effect(execute, label) {
    const promise = Promise.resolve().then(execute).catch((error) => {
      this.log.push(`effect ${label} FAILED: ${error}`)
      return async () => {}
    })
    this.effects.push({ label, promise })
    return promise
  }

  inject(deps, cb) {
    this.injectCalls.push(deps)
    // Real cordis: a nested-inject scope exposes each injected service BOTH as
    // `scope.get(name)` and as a property (`scope.storageDomain`), and the
    // property read is legal precisely because the name is in the inject list.
    const services = this.services
    const scoped = new Proxy(
      {
        get: (name) => services.get(name),
        effect: (e, l) => this.effect(e, l),
        // A cordis scope is a Context view: logger, events and lifecycle come
        // from the owning context, only the inject list is narrowed.
        logger: (name) => this.logger(name),
        on: (event, handler, opts) => this.on(event, handler, opts),
      },
      {
        get(target, prop) {
          if (prop in target) return target[prop]
          return services.get(prop)
        },
      },
    )
    cb(scoped)
  }

  async settle() {
    await Promise.allSettled(this.effects.map(e => e.promise))
  }

  listeners(event) {
    return this.handlers.get(event) ?? []
  }
}

/** Fake storage-domain facility backed by plain Maps. */
/**
 * Faithful stand-in for the host settings service (`SettingsForms`), reduced to
 * what the tallies use: a document per Loader entry id, a describe projection of
 * that document, and ordered path ops (`set` / `unset`) applied the way
 * `applyPathOp` applies them (plain-object traversal, `unset` deletes the key).
 *
 * Every accepted `mutate` is recorded, plus a `document-updated` notification so
 * tests can prove a write is what raises the platform event.
 */
class FakeSettings {
  constructor(initial = {}) {
    this.documents = new Map([['dsh-safe-tool', structuredClone(initial)]])
    this.mutations = []
    this.notifications = []
  }

  /** Apply one path op to a plain-object document. */
  static apply(document, op) {
    const edit = (input, path) => {
      const [head, ...rest] = path
      if (head === undefined) return op.op === 'set' ? structuredClone(op.value) : undefined
      const value = input ?? {}
      const result = (typeof value === 'object' && value !== null && !Array.isArray(value)) ? { ...value } : {}
      const child = edit(result[head], rest)
      if (child === undefined) delete result[head]
      else result[head] = child
      return result
    }
    return edit(document, op.path)
  }

  describe() {
    return [...this.documents.entries()].map(([ns, value]) => ({ ns, value: structuredClone(value) }))
  }

  async mutate(ns, ops, expectedRevision) {
    const document = this.documents.get(String(ns))
    if (document === undefined) throw new Error(`No configurable plugin entry "${String(ns)}"`)
    this.mutations.push({ ns: String(ns), ops: structuredClone(ops), expectedRevision })
    this.documents.set(String(ns), ops.reduce((doc, op) => FakeSettings.apply(doc, op), document))
    // SettingsForms.write ends by calling describe(), which is what raises the
    // forwarded event for a changed document.
    this.notifications.push(String(ns))
  }
}

class FakeWebServer {
  constructor() {
    this.routes = new Map()
  }

  register(route) {
    this.routes.set(route.path, route)
    return () => {}
  }

  async post(path, body) {
    const route = this.routes.get(path)
    if (route === undefined) throw new Error(`no route ${path}`)
    let ended
    const res = {
      code: undefined,
      body: undefined,
      writeHead(code, headers) { this.code = code },
      end(payload) { this.body = payload; ended() },
    }
    const promise = new Promise(resolve => { ended = resolve })
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      on(event, handler) {
        if (event === 'data') handler(Buffer.from(JSON.stringify(body ?? {})))
        if (event === 'end') setImmediate(handler)
      },
    }
    await route.handler(req, res)
    await promise
    return { code: res.code, json: JSON.parse(res.body) }
  }
}

/** Build a full fake agent. */
/**
 * An agent whose OWN session events carry the durable `subagent/descriptor` —
 * where the real spawn provider records it (`child.session.append(...)`) and
 * where the reviewer guard folds it from (`Session.ownEvents()`).
 */
function reviewerAgent(id, cwd, label = 'ai-approval-reviewer') {
  const agent = fakeAgent(id, cwd)
  agent.session.ownEvents = () => [
    {
      type: 'subagent/descriptor',
      // The platform's own descriptor version: a mismatched version makes the
      // fold reject the event, so it is read from the platform, never guessed.
      data: { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'one-shot', provider: 'spawn', label },
    },
  ]
  return agent
}

function fakeAgent(id, cwd, extra = {}) {
  return {
    id,
    session: { id, header: { id, cwd } },
    options: { provider: 'ai', model: 'glm-5.3-flash' },
    ...extra,
  }
}

/**
 * Bootstrap one plugin instance in a temp DSH_HOME. Returns the ctx, the
 * pre-execute invoker, the fake web server, and every recorded fake call.
 */
async function bootstrap(t, { home }) {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  })

  const calls = {
    startActivation: [],
    dispose: [],
    approvalRequests: [],
    stat: [],
    agentsCreate: [],
    agentsResume: [],
    removedProjcache: [],
    removedDirs: [],
    mount: [],
  }

  const REVIEWER_WORKSPACE = join(home, 'dsh-safe-tool', 'safe-tool-log')
  const settings = new FakeSettings()
  const webServer = new FakeWebServer()

  const sessionPersistence = {
    stat: async (id) => {
      calls.stat.push(id)
      // Report reviewer children/parent as stored sessions with the plugin workspace.
      if (id === 'dsh-safe-tool-reviewer-parent' || String(id).startsWith('child-')) {
        return { header: { id, cwd: REVIEWER_WORKSPACE, origin: 'subagent' } }
      }
      return undefined
    },
    list: async () => [],
  }

  const subagents = {
    // Durable child identity, as the real catalog folds it from
    // `subagent/descriptor` events. Tests set `subagents.children[label]`.
    childrenByParent: new Map(),
    async listChildren(parentSessionId) {
      return subagents.childrenByParent.get(String(parentSessionId)) ?? []
    },
    getProvider: (name) => (name === 'spawn' ? { name: 'spawn' } : undefined),
    list: () => ['spawn'],
    spawnedChildIds: [],
    startActivation: async (spec) => {
      calls.startActivation.push(spec)
      const childId = `child-${calls.startActivation.length}`
      subagents.spawnedChildIds.push(childId)
      const signal = spec.signal
      const result = new Promise((resolve) => {
        if (subagents.nextResult instanceof Promise) {
          // A pending run that settles on abort (mirrors the real backend).
          const timer = setTimeout(() => resolve({ output: [], stopReason: 'error', diagnostic: 'mock hang' }), 5000)
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve({ output: [], stopReason: 'aborted' }) })
          subagents.nextResult.then(resolve)
        } else {
          resolve(subagents.nextResult ?? { output: [], structured: { approve: true, reason: '通过' }, stopReason: 'completed' })
        }
      })
      return {
        childId,
        result,
        dispose: async () => { calls.dispose.push(childId) },
      }
    },
  }

  let ctxRef = null
  const runSetup = async (opts) => {
    // The real agent factory awaits the setup callback with the agent context.
    if (typeof opts?.setup === 'function') {
      await opts.setup({ get: (name) => ctxRef?.services.get(name) })
    }
  }
  const agents = {
    create: async (opts) => {
      calls.agentsCreate.push(opts)
      await runSetup(opts)
      return { agent: fakeAgent(opts.sessionId, opts.meta?.cwd), dispose: async () => {} }
    },
    resume: async (opts) => {
      calls.agentsResume.push(opts)
      await runSetup(opts)
      return { agent: fakeAgent(opts.resumeSessionId, REVIEWER_WORKSPACE), dispose: async () => {} }
    },
  }

  const agentPresets = {
    list: async () => [{ id: 'minimal', name: '极简' }, { id: 'standard', broken: 'x' }],
    mount: async (ctx, id) => { calls.mount.push(id) },
  }

  const approval = {
    request: async (req) => {
      calls.approvalRequests.push(req)
      return approval.nextOutcome ?? 'rejected'
    },
  }

  const tools = {
    get: (name) => (name === 'bash' ? { description: 'Run commands in a bash shell' } : undefined),
    // Every global tool the reviewer child must not see.
    schemas: () => [{ name: 'bash' }, { name: 'write' }, { name: 'read' }],
    guards: [],
    guard(guard) {
      tools.guards.push(guard)
      return () => {}
    },
  }

  // The review-session cleanup deletes the projection-cache row; the tallies
  // themselves ride the settings service below.
  const projcacheDeletes = []
  const storageDomain = {
    get: (name) => (name === 'session_projcache'
      ? { table: () => ({ delete: async (key) => { projcacheDeletes.push(key); return true } }) }
      : undefined),
  }

  const ctx = new FakeCtx({
    settings,
    storageDomain,
    webServer,
    sessionPersistence,
    subagents,
    agents,
    agentPresets,
    approval,
    tools,
  })
  ctx.projcacheDeletes = projcacheDeletes
  ctx.settings = settings
  ctx.REVIEWER_WORKSPACE = REVIEWER_WORKSPACE
  ctx.web = webServer
  ctxRef = ctx

  const { apply } = await import(BUNDLE)
  const config = {
    enabled: true,
    provider: undefined,
    model: undefined,
    maxTokens: 2048,
    timeoutMs: 200,
    humanTimeoutMs: 100,
    filterMode: 'deny-list',
    tools: ['bash', 'write'],
    autoAllowPatterns: [],
    deleteReviewerSessions: true,
    reviewerPreset: 'minimal',
    // The tallies field, as the plugin declares it (0.1.x kept this same dict
    // in its own settings namespace).
    sessions: {},
  }
  apply(ctx, structuredClone(config))
  await ctx.settle()
  return { ctx, calls, config, settings, REVIEWER_WORKSPACE }
}

/** Invoke the registered tools/pre-execute waterfall head. */
function preExecute(ctx, exec) {
  const [head] = ctx.listeners('tools/pre-execute')
  assert.ok(head, 'tools/pre-execute listener must be registered')
  return head.handler(exec, async () => ({ kind: 'allow' }))
}

/** Evaluate the registered monotonic guards, as the runtime does after the waterfall. */
function guardVerdict(ctx, exec) {
  const guards = ctx.tools?.guards ?? []
  assert.ok(guards.length > 0, 'tools.guard must be registered')
  for (const guard of guards) {
    const reason = guard(exec)
    if (typeof reason === 'string') return { kind: 'deny', reason }
  }
  return { kind: 'allow' }
}

function makeExec(agent, name = 'bash', args = { command: 'ls -la' }) {
  return { name, arguments: args, agent, signal: new AbortController().signal }
}

// ─── Registration & config ──────────────────────────────────────

test('the shipped artifact loads with no node_modules present (deployment shape)', async (t) => {
  // The fatal defect this pins down: the bundle used to import a host package
  // (`@deepseek-ai/dsh-subagent`). A plugin installed under a profile has no
  // node_modules resolving host packages, so the import threw
  // ERR_MODULE_NOT_FOUND and the plugin could not load AT ALL — while every
  // in-repo test passed, because the repo has node_modules.
  const src = readFileSync(BUNDLE_PATH, 'utf8')

  // 1. Static guarantee: only Node builtins may remain as bare specifiers.
  const specifiers = [...src.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1])
  const bare = specifiers.filter(specifier => !specifier.startsWith('node:') && !specifier.startsWith('.'))
  assert.deepEqual(bare, [], `the artifact must not import host packages, found: ${bare.join(', ')}`)

  // 2. Behavioural guarantee: import a copy from a directory with no node_modules.
  const dir = mkdtempSync(join(tmpdir(), 'dshst-deploy-'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'index.js'), src)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-safe-tool', type: 'module', main: 'lib/index.js' }))
  assert.equal(existsSync(join(dir, 'node_modules')), false, 'the copy deliberately has no node_modules')

  const loaded = await import(pathToFileURL(join(dir, 'lib', 'index.js')).href)
  assert.equal(loaded.name, 'dsh-safe-tool')
  assert.equal(typeof loaded.apply, 'function')
  assert.deepEqual([...loaded.inject], ['tools', 'subagents', 'approval', 'webServer'])
  assert.ok(loaded.Config !== undefined, 'Config is exported')
})

test('bundle exports the host plugin form (apply/name/inject/Config)', async () => {
  const mod = await import(BUNDLE)
  assert.equal(mod.name, 'dsh-safe-tool')
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual([...mod.inject], ['tools', 'subagents', 'approval', 'webServer'])
  assert.ok(mod.Config, 'Config schema exported')
})

test('apply registers pre-execute, pre-step, session/disposed and bridge routes', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx } = await bootstrap(t, { home })
  assert.ok(ctx.listeners('tools/pre-execute').length > 0)
  assert.ok(ctx.listeners('agent/pre-step').length > 0)
  assert.ok(ctx.listeners('session/disposed').length > 0)
  assert.equal(ctx.tools.guards.length, 1, 'exactly one monotonic guard is registered')
  assert.equal(ctx.listeners('agent/created').length, 1, 'the per-agent restriction hook is registered')
  for (const route of ['/api/dsh-safe-tool-settings/stats-list', '/api/dsh-safe-tool-settings/stats-clear', '/api/dsh-safe-tool-settings/list-presets']) {
    assert.ok(ctx.web.routes.has(route), `bridge route ${route} registered`)
  }
})

test('criteria file is auto-created under $DSH_HOME', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  await bootstrap(t, { home })
  const criteria = join(home, 'dsh-safe-tool', 'approval-criteria.md')
  assert.ok(existsSync(criteria), 'criteria file created')
  assert.match(readFileSync(criteria, 'utf8'), /允许执行/)
})

// ─── Pre-execute flow ───────────────────────────────────────────

test('disabled config passes every call through', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx, calls } = await bootstrap(t, { home })
  // Fresh instance with enabled: false sharing the same fakes.
  const { apply } = await import(BUNDLE)
  const disabledCtx = new FakeCtx(Object.fromEntries(ctx.services))
  apply(disabledCtx, { enabled: false, filterMode: 'deny-list', tools: ['bash'], autoAllowPatterns: [], timeoutMs: 50, humanTimeoutMs: 50, maxTokens: 100, deleteReviewerSessions: true, reviewerPreset: 'minimal' })
  await disabledCtx.settle()
  const verdict = await preExecute(disabledCtx, makeExec(fakeAgent('s1', '/workspaces/main')))
  assert.deepEqual(verdict, { kind: 'allow' })
  assert.equal(calls.startActivation.length, 0, 'no reviewer spawned while disabled')
})

test('the plugin\'s own reviewer child is denied every tool except structured_output', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx } = await bootstrap(t, { home })

  // A real review registers the child it spawned; that child is then guarded.
  const reviewed = await preExecute(ctx, makeExec(fakeAgent('parent-1', '/workspaces/main'), 'bash'))
  assert.deepEqual(reviewed, { kind: 'allow' }, 'review passes for the parent')
  const childId = ctx.services.get('subagents').spawnedChildIds[0]

  const denied = await guardVerdict(ctx, makeExec(reviewerAgent(childId, '/workspaces/main'), 'bash'))
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /审核子代理不允许执行工具调用/)

  const allowed = await guardVerdict(ctx, makeExec(reviewerAgent(childId, '/workspaces/main'), 'structured_output', { approve: true, reason: 'ok' }))
  assert.equal(allowed.kind, 'allow')
})

test('a reviewer child from an earlier runtime is identified by its descriptor label', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx } = await bootstrap(t, { home })

  // A child this instance never spawned: the descriptor in its own durable
  // session log is what marks it.
  const resumed = reviewerAgent('child-resumed', '/workspaces/main')
  resumed.session.header.parentSession = 'parent-9'

  const denied = await guardVerdict(ctx, makeExec(resumed, 'bash'))
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /审核子代理不允许执行工具调用/)
})

test('a descriptor whose version moved on still classifies (guard cannot silently vanish)', async (t) => {
  // The host's descriptor version is an internal constant and already moved
  // 2 → 3. Keying the guard on it would have silently turned the reviewer guard
  // OFF with no error, so classification reads the label and only validates the
  // shape.
  const home = mkdtempSync(join(tmpdir(), 'dshst-desc-'))
  const { ctx } = await bootstrap(t, { home })

  for (const [index, version] of [2, 3, 99, undefined].entries()) {
    const agent = fakeAgent(`child-ver-${index}`, '/workspaces/main')
    agent.session.ownEvents = () => [{
      type: 'subagent/descriptor',
      data: {
        ...(version === undefined ? {} : { version }),
        mode: 'one-shot',
        provider: 'spawn',
        label: 'ai-approval-reviewer',
      },
    }]
    const verdict = await guardVerdict(ctx, makeExec(agent, 'bash'))
    assert.equal(verdict.kind, 'deny', `descriptor version ${String(version)} must still identify the reviewer`)
    assert.match(verdict.reason, /审核子代理不允许执行工具调用/)
  }
})

test('a reviewer child never triggers a review of its own call (no recursive spawn)', async (t) => {
  // Regression: `needsReview` in allow-list mode is true for every tool OUTSIDE
  // the list, so the reviewer child's `structured_output` decision call used to
  // be reviewed — spawning another reviewer whose `structured_output` was
  // reviewed again. The reviewer branch must return before the review path.
  const home = mkdtempSync(join(tmpdir(), 'dshst-rec-'))
  const { ctx, calls, config } = await bootstrap(t, { home })

  // allow-list mode: only `bash` would be reviewed, everything else passes —
  // which is exactly why `structured_output` must be exempted for a reviewer.
  const { apply } = await import(BUNDLE)
  const ctx2 = new FakeCtx(Object.fromEntries(ctx.services))
  apply(ctx2, { ...structuredClone(config), filterMode: 'allow-list', tools: ['bash'] })
  await ctx2.settle()

  const child = reviewerAgent('child-rec', '/workspaces/main')
  const decision = await preExecute(ctx2, makeExec(child, 'structured_output', { approve: true, reason: 'ok' }))
  assert.equal(decision.kind, 'allow', 'the reviewer decision channel is never reviewed')
  assert.equal(calls.startActivation.length, 0, 'no reviewer may be spawned for a reviewer child')

  // deny-list mode: a reviewed tool on the reviewer child is denied outright,
  // again without spawning a review first.
  const denied = await preExecute(ctx2, makeExec(child, 'bash', { command: 'rm -rf /' }))
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /审核子代理不允许执行工具调用/)
  assert.equal(calls.startActivation.length, 0, 'the guard path must not spawn a review either')
})

test('a subagent with a DIFFERENT descriptor label stays reviewable', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx } = await bootstrap(t, { home })

  // Same descriptor shape, different label: an ordinary subagent is reviewed
  // like any other caller rather than denied everything.
  const other = reviewerAgent('child-other', '/workspaces/main', 'explore')
  other.session.header.parentSession = 'parent-8'

  const verdict = await guardVerdict(ctx, makeExec(other, 'bash'))
  assert.equal(verdict.kind, 'allow', 'an ordinary subagent is reviewed, not denied')
})

test('a session that merely shares the reviewer workspace is NOT treated as a reviewer child', async (t) => {
  // Regression guard: identifying reviewer children by working directory would
  // deny every tool of a user session opened in the plugin's private folder.
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx, REVIEWER_WORKSPACE } = await bootstrap(t, { home })
  const bystander = fakeAgent('user-session-1', REVIEWER_WORKSPACE)

  const verdict = await guardVerdict(ctx, makeExec(bystander, 'bash'))
  assert.deepEqual(verdict, { kind: 'allow' }, 'an unrelated session in that directory is reviewed normally, not blocked')
})

test('a settled decision writes exactly one tally op to this plugin\'s own document', async (t) => {
  // The 0.1.x contract, preserved call-for-call: one `settings.mutate` per
  // settled review, addressed to the tallies' namespace, carrying one path op.
  // 0.2.x has no custom namespaces, so the namespace is this plugin's entry id.
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx, settings } = await bootstrap(t, { home })
  settings.mutations.length = 0

  await preExecute(ctx, makeExec(fakeAgent('sess-op', '/w')))

  assert.equal(settings.mutations.length, 1, 'exactly one settings write per settled decision')
  const [mutation] = settings.mutations
  assert.equal(mutation.ns, 'dsh-safe-tool', 'written to the plugin entry document')
  assert.equal(mutation.ops.length, 1)
  assert.deepEqual(mutation.ops[0], {
    op: 'set',
    path: ['sessions', 'sess-op'],
    value: { total: 1, approved: 1, denied: 0, errorDenied: 0 },
  })
  assert.equal(mutation.expectedRevision, undefined, 'a tally never asserts a revision')
  // The platform raises `settings/document-updated` from its own describe pass,
  // which is what the browser half listens for; the fake records the same edge.
  assert.deepEqual(settings.notifications, ['dsh-safe-tool'])

  // A second, DIFFERENT decision accumulates on the stored document (identical
  // calls would hit the 60s decision cache and rightly skip the tally).
  await preExecute(ctx, makeExec(fakeAgent('sess-op', '/w'), 'write', { path: '/tmp/a', content: 'b' }))
  const stored = settings.describe().find(row => row.ns === 'dsh-safe-tool').value
  assert.deepEqual(stored.sessions['sess-op'], { total: 2, approved: 2, denied: 0, errorDenied: 0 })
})

test('tools outside the filter list pass through without review', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx, calls } = await bootstrap(t, { home })
  const verdict = await preExecute(ctx, makeExec(fakeAgent('s1', '/w'), 'read', { path: '/x' }))
  assert.equal(verdict.kind, 'allow')
  assert.equal(calls.startActivation.length, 0)
})

test('autoAllowPatterns skip review', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx, calls } = await bootstrap(t, { home })
  process.env.DSH_HOME = home
  const { apply } = await import(BUNDLE)
  const ctx2 = new FakeCtx(Object.fromEntries(ctx.services))
  apply(ctx2, { enabled: true, filterMode: 'deny-list', tools: ['bash'], autoAllowPatterns: ['^\\{\\s*"command"\\s*:\\s*"ls'], timeoutMs: 50, humanTimeoutMs: 50, maxTokens: 100, deleteReviewerSessions: true, reviewerPreset: 'minimal' })
  await ctx2.settle()
  const verdict = await preExecute(ctx2, makeExec(fakeAgent('s1', '/w'), 'bash', { command: 'ls -la' }))
  assert.equal(verdict.kind, 'allow')
  assert.equal(calls.startActivation.length, 0)
})

test('approve decision lets the call through and records stats', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx, calls } = await bootstrap(t, { home })
  const verdict = await preExecute(ctx, makeExec(fakeAgent('sess-1', '/w')))
  assert.equal(verdict.kind, 'allow')
  assert.equal(calls.startActivation.length, 1)

  const spec = calls.startActivation[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'ai-approval-reviewer')
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.request.cwd, ctx.REVIEWER_WORKSPACE, 'reviewer child cwd pinned to plugin workspace')
  assert.equal(spec.request.agentPreset, undefined, 'dedicated parent already mounts the preset')
  assert.ok(spec.request.prompt[0].text.includes('Run commands in a bash shell'), 'tool description embedded in prompt')
  assert.ok(spec.request.outputSchema.properties.approve, 'outputSchema declares approve')

  // Stats recorded through the storage domain and served by the bridge.
  const listed = await ctx.web.post('/api/dsh-safe-tool-settings/stats-list')
  assert.equal(listed.json.ok, true)
  assert.equal(listed.json.sessions['sess-1'].total, 1)
  assert.equal(listed.json.sessions['sess-1'].approved, 1)
})

test('deny decision blocks the call with the model reason', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx } = await bootstrap(t, { home })
  ctx.services.get('subagents').nextResult = { output: [], structured: { approve: false, reason: '包含 rm -rf' }, stopReason: 'completed' }
  const verdict = await preExecute(ctx, makeExec(fakeAgent('sess-2', '/w')))
  assert.equal(verdict.kind, 'deny')
  assert.match(verdict.reason, /rm -rf/)
})

test('free-form JSON text output is parsed (lenient path)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx } = await bootstrap(t, { home })
  ctx.services.get('subagents').nextResult = {
    output: [{ type: 'text', text: '好的，我认为 {"approve": false, "reason": "高危命令"} 就是这样。' }],
    stopReason: 'completed',
  }
  const verdict = await preExecute(ctx, makeExec(fakeAgent('sess-3', '/w')))
  assert.equal(verdict.kind, 'deny')
  assert.match(verdict.reason, /高危命令/)
})

test('unparseable output falls back to human approval', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx, calls } = await bootstrap(t, { home })
  const approval = ctx.services.get('approval')

  // Human allows once.
  approval.nextOutcome = 'allowed-once'
  ctx.services.get('subagents').nextResult = { output: [{ type: 'text', text: '我觉得没问题' }], stopReason: 'completed' }
  const allowed = await preExecute(ctx, makeExec(fakeAgent('sess-4', '/w')))
  assert.equal(allowed.kind, 'allow')
  assert.equal(calls.approvalRequests.length, 1)
  assert.match(calls.approvalRequests[0].reason, /AI审批回退/)

  // Human rejects.
  approval.nextOutcome = 'rejected'
  const denied = await preExecute(ctx, makeExec(fakeAgent('sess-4', '/w'), 'bash', { command: 'ls /etc' }))
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /人工审批/)
})

test('child error result denies with the diagnostic', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx } = await bootstrap(t, { home })
  ctx.services.get('subagents').nextResult = { output: [], stopReason: 'error', diagnostic: 'model overloaded' }
  const verdict = await preExecute(ctx, makeExec(fakeAgent('sess-5', '/w')))
  assert.equal(verdict.kind, 'deny')
  assert.match(verdict.reason, /model overloaded/)
})

test('every terminal stop reason maps to the 0.1.x outcome', async (t) => {
  // run.result resolves for ALL terminal outcomes in 0.2.x (it never rejects on
  // child-level failure), so each stop reason must land where the 0.1.x flow put
  // it: a model/transport failure is the old rejection (deny), a completed run
  // is parsed, and a partial/unparseable run falls back to human approval.
  const cases = [
    { stopReason: 'error', result: { output: [], diagnostic: 'provider 500' }, expect: 'deny', matches: /审核服务异常.*provider 500/ },
    { stopReason: 'error', result: { output: [], structured: { approve: true, reason: '看起来没问题' } }, expect: 'deny', matches: /审核服务异常/ },
    { stopReason: 'completed', result: { output: [], structured: { approve: true, reason: '只读操作' } }, expect: 'allow', matches: null },
    { stopReason: 'max-tokens', result: { output: [], structured: { approve: false, reason: '输出被截断' } }, expect: 'deny', matches: /输出被截断/ },
    { stopReason: 'max-tokens', result: { output: [], diagnostic: 'hit ceiling' }, expect: 'human', matches: null },
    { stopReason: 'refusal', result: { output: [], diagnostic: 'declined' }, expect: 'human', matches: null },
  ]
  for (const [index, testCase] of cases.entries()) {
    const home = mkdtempSync(join(tmpdir(), `dshst-stop-${index}-`))
    const { ctx, calls } = await bootstrap(t, { home })
    ctx.services.get('subagents').nextResult = { ...testCase.result, stopReason: testCase.stopReason }
    const outcome = await preExecute(ctx, makeExec(fakeAgent(`sess-stop-${index}`, '/workspaces/main')))
    if (testCase.expect === 'allow') {
      assert.equal(outcome.kind, 'allow', `${testCase.stopReason}: allowed`)
    } else if (testCase.expect === 'deny') {
      assert.equal(outcome.kind, 'deny', `${testCase.stopReason}: denied`)
      if (testCase.matches) assert.match(outcome.reason, testCase.matches)
    } else {
      // Fallback asks the human; the fake approval answerer rejects.
      assert.equal(calls.approvalRequests.length >= 1, true, `${testCase.stopReason}: human approval requested`)
      assert.equal(outcome.kind, 'deny', `${testCase.stopReason}: unresolved human request denies`)
    }
  }
})

test('review timeout denies', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx } = await bootstrap(t, { home })
  // nextResult as a never-resolving promise → abort path settles it as 'aborted'.
  ctx.services.get('subagents').nextResult = new Promise(() => {})
  const verdict = await preExecute(ctx, makeExec(fakeAgent('sess-6', '/w')))
  assert.equal(verdict.kind, 'deny')
  assert.match(verdict.reason, /审核超时/)
})

test('startActivation failure fails closed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx } = await bootstrap(t, { home })
  ctx.services.get('subagents').startActivation = async () => { throw new Error('spawn unavailable') }
  const verdict = await preExecute(ctx, makeExec(fakeAgent('sess-7', '/w')))
  assert.equal(verdict.kind, 'deny')
  assert.match(verdict.reason, /spawn unavailable/)
})

test('reviewer preset mount failure falls back to the main agent with agentPreset pinned', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx, calls } = await bootstrap(t, { home })
  // agents.create fails → ensureReviewerParent throws → fallback path.
  ctx.services.get('agents').create = async () => { throw new Error('SessionAlreadyExistsError') }
  ctx.services.get('agents').resume = async () => { throw new Error('not resumable') }
  const verdict = await preExecute(ctx, makeExec(fakeAgent('main-1', '/workspaces/main')))
  assert.equal(verdict.kind, 'allow')
  const spec = calls.startActivation.at(-1)
  assert.equal(spec.request.parent.id, 'main-1', 'spawned under the main agent')
  assert.equal(spec.request.agentPreset, 'minimal', 'child composition pinned to the reviewer preset')
})

test('60s cache reuses a settled decision (no second spawn)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx, calls } = await bootstrap(t, { home })
  ctx.services.get('subagents').nextResult = { output: [], structured: { approve: false, reason: '不行' }, stopReason: 'completed' }
  const agent = fakeAgent('sess-8', '/w')
  const first = await preExecute(ctx, makeExec(agent, 'bash', { command: 'identical' }))
  const second = await preExecute(ctx, makeExec(agent, 'bash', { command: 'identical' }))
  assert.equal(first.kind, 'deny')
  assert.equal(second.kind, 'deny')
  assert.match(second.reason, /AI审批缓存/)
  assert.equal(calls.startActivation.length, 1)
})

// ─── Reviewer parent lifecycle ──────────────────────────────────

test('dedicated reviewer parent is created once with the right meta', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx, calls } = await bootstrap(t, { home })
  await preExecute(ctx, makeExec(fakeAgent('s1', '/w')))
  await preExecute(ctx, makeExec(fakeAgent('s1', '/w'), 'bash', { command: 'other' }))
  assert.equal(calls.agentsCreate.length, 1, 'parent is a singleton')
  const opts = calls.agentsCreate[0]
  assert.equal(opts.sessionId, 'dsh-safe-tool-reviewer-parent')
  assert.equal(opts.meta.cwd, ctx.REVIEWER_WORKSPACE)
  assert.equal(opts.meta.agentPreset, 'minimal')
  assert.equal(opts.meta.origin, 'subagent', 'hidden parent when records are deleted')
  assert.equal(opts.seed, undefined, 'no seed in hidden mode')
  assert.deepEqual(calls.mount, ['minimal'], 'preset mounted in setup')
})

// ─── Stats domain & disposal ────────────────────────────────────

test('stats-clear removes one and all sessions', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx } = await bootstrap(t, { home })
  ctx.services.get('subagents').nextResult = { output: [], structured: { approve: true, reason: 'ok' }, stopReason: 'completed' }
  await preExecute(ctx, makeExec(fakeAgent('sa', '/w')))
  await preExecute(ctx, makeExec(fakeAgent('sb', '/w')))

  await ctx.web.post('/api/dsh-safe-tool-settings/stats-clear', { sessionIds: ['sa'] })
  const afterOne = await ctx.web.post('/api/dsh-safe-tool-settings/stats-list')
  assert.equal(afterOne.json.sessions.sa, undefined)
  assert.ok(afterOne.json.sessions.sb)

  await ctx.web.post('/api/dsh-safe-tool-settings/stats-clear', {})
  const afterAll = await ctx.web.post('/api/dsh-safe-tool-settings/stats-list')
  assert.deepEqual(afterAll.json.sessions, {})
})

test('session/disposed drops the session tally', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx } = await bootstrap(t, { home })
  ctx.services.get('subagents').nextResult = { output: [], structured: { approve: true, reason: 'ok' }, stopReason: 'completed' }
  await preExecute(ctx, makeExec(fakeAgent('sess-gone', '/w')))
  let listed = await ctx.web.post('/api/dsh-safe-tool-settings/stats-list')
  assert.ok(listed.json.sessions['sess-gone'])

  const [disposed] = ctx.listeners('session/disposed')
  disposed.handler({ id: 'sess-gone' })
  await new Promise(r => setImmediate(r))
  listed = await ctx.web.post('/api/dsh-safe-tool-settings/stats-list')
  assert.equal(listed.json.sessions['sess-gone'], undefined)
})

test('list-presets filters broken presets', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx } = await bootstrap(t, { home })
  const res = await ctx.web.post('/api/dsh-safe-tool-settings/list-presets')
  assert.equal(res.json.ok, true)
  assert.deepEqual(res.json.presets, [{ id: 'minimal', name: '极简', description: '' }])
})

// ─── agent/pre-step context filter ──────────────────────────────

test('pre-step strips non-user context for reviewer children only', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx, REVIEWER_WORKSPACE } = await bootstrap(t, { home })
  const [preStep] = ctx.listeners('agent/pre-step')
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [] },
    { role: 'system', source: { kind: 'system-prompt' }, content: [] },
    { role: 'assistant', source: { kind: 'model', attemptId: 1 }, content: [] },
  ]
  const next = async () => ({ kind: 'enter', messages })

  // A reviewer child: its own session log carries the descriptor that the
  // spawn provider recorded.
  const reviewerChild = reviewerAgent('c1', REVIEWER_WORKSPACE)
  reviewerChild.session.header.parentSession = 'p-rev'
  const forReviewer = await preStep.handler({ agent: reviewerChild }, next)
  assert.equal(forReviewer.messages.length, 1, 'reviewer child keeps only user messages')
  assert.equal(forReviewer.messages[0].source.kind, 'user')

  // A user session that happens to sit in the same directory is untouched.
  const bystander = fakeAgent('m2', REVIEWER_WORKSPACE)
  const forBystander = await preStep.handler({ agent: bystander }, next)
  assert.equal(forBystander.messages.length, 3, 'an unrelated session in that directory keeps every message')

  const forMain = await preStep.handler({ agent: fakeAgent('m1', '/workspaces/main') }, next)
  assert.equal(forMain.messages.length, 3, 'main agent keeps every message')
})

// ─── Artifact cleanup ───────────────────────────────────────────

test('a disposed review child is deleted even though stat() no longer resolves it', async (t) => {
  // The defect this pins down: the cleanup used to read the child's header back
  // from the backend AFTER dispose. A disposed session is already gone from
  // `stat()`/`list()`, so that read returned nothing and the artifact stayed on
  // disk forever. The identity is now captured while the session is still live.
  const home = mkdtempSync(join(tmpdir(), 'dshst-'))
  const { ctx, calls, REVIEWER_WORKSPACE } = await bootstrap(t, { home })
  const root = join(home, 'sessions')
  const persistence = ctx.services.get('sessionPersistence')
  persistence.root = root
  // The child ran in the plugin's reviewer workspace, so its artifact sits under
  // that cwd's project directory. The key below is checked against a directory
  // this host's real backend actually produced, so the expected path is not a
  // guess about the encoding.
  const projectKey = raw => '--' + raw.replace(/[/\\:]+/g, '-').replace(/^-+/, '') + '--'
  assert.equal(
    projectKey('/root/.dsh/dsh-safe-tool/safe-tool-log'),
    '--root-.dsh-dsh-safe-tool-safe-tool-log--',
    'the project-key derivation matches a real on-disk artifact',
  )
  const projectDir = join(root, projectKey(REVIEWER_WORKSPACE))
  const childDir = join(projectDir, 'child-1')
  mkdirSync(childDir, { recursive: true })
  writeFileSync(join(childDir, 'session.v4.jsonl.zstd'), 'x')
  const legacyDir = join(root, 'child-1')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'session.jsonl.zstd'), 'x')

  calls.stat.length = 0
  persistence.stat = async (id) => {
    calls.stat.push(String(id))
    // Live call (captured pre-dispose) resolves; anything after does not.
    return calls.dispose.includes(String(id)) ? undefined : { header: { id, cwd: REVIEWER_WORKSPACE, origin: 'subagent' } }
  }

  ctx.services.get('subagents').nextResult = { output: [], structured: { approve: true, reason: 'ok' }, stopReason: 'completed' }
  await preExecute(ctx, makeExec(fakeAgent('sess-clean', REVIEWER_WORKSPACE)))

  assert.ok(calls.dispose.includes('child-1'), 'the child activation was disposed')
  assert.equal(existsSync(childDir), false, 'the current-layout artifact is removed')
  assert.equal(existsSync(legacyDir), false, 'the legacy-layout artifact is removed too')
  assert.ok(ctx.projcacheDeletes.includes('child-1'), 'the projection-cache ghost row is deleted')
})



// ─── Client bundle static checks ────────────────────────────────

test('client bundle is a well-formed ModuleLoader factory with new slots', () => {
  const src = readFileSync(CLIENT, 'utf8')
  assert.ok(src.startsWith('window.__ModuleLoader__.load({'), 'wrapped for the browser module table')
  assert.ok(src.includes('plugins.row.config'), 'registers the 0.2.x settings slot')
  assert.ok(src.includes('${ENTRY_ID}#${ENTRY_ID}'), 'keyed by <package>#<row id> (ENTRY_ID assembly)')
  assert.ok(src.includes('conversation.session.header.actions'), 'header button slot kept')
  assert.ok(src.includes('configForms'), 'writes through the shared config form service')
  assert.ok(!src.includes('settings.plugin.item'), 'removed 0.1.x slot not referenced')
  new Function(src.replace('window.__ModuleLoader__', '({ load(){} })')) // syntax check
})
