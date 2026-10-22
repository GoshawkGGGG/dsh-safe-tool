/**
 * Real-DOM render tests for the built browser half.
 *
 * These mount the slot components with REAL React (`react-dom/client`) into a
 * REAL DOM (`jsdom`), because the failure modes that matter here only appear
 * once effects run:
 *
 * 1. Request storm: an unstable prop identity flowing into a hook dependency
 *    makes the mount effect re-run on every render, and each run fetches →
 *    setState → re-render → fetch … hundreds of Host requests per second.
 *    Asserted by counting `fetch` calls over a real time window.
 * 2. Slot abdication: throwing during render makes the slot owner drop the
 *    entry, so the settings card silently disappears. Covered by
 *    `client-render.test.mjs` (SSR) and by rendering here for real.
 *
 * @module dsh-safe-tool/test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import { requireBuiltArtifact } from './helpers/preconditions.mjs'

/** Faithful Client locale stand-in: records dictionaries and translates zh. */
function fakeLocale() {
  const dicts = new Map()
  return {
    register(ns, locale, dict) {
      dicts.set(`${ns}:${locale}`, dict)
      return () => {}
    },
    bind(ns) {
      return (key) => dicts.get(`${ns}:zh`)?.[key] ?? key
    },
    getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }),
    subscribe: () => () => {},
  }
}

/** One stub shared by the mount helper and the injected `t` face. */
const sharedLocale = fakeLocale()
const translateZh = sharedLocale.bind('dsh-safe-tool')

const nodeRequire = createRequire(import.meta.url)
const CLIENT = new URL('../lib/client.js', import.meta.url)
requireBuiltArtifact(new URL('../lib/client.js', import.meta.url), 'lib/client.js')

// React and the DOM must be shared between the bundle and the driver, so the
// bundle's `require('react')` resolves to the same instance we render with.
const React = nodeRequire('react')
const ReactDOMClient = nodeRequire('react-dom/client')

/** Flush React work + timers without act (production React rejects act). */
async function settle(ms = 0) {
  await new Promise(r => setTimeout(r, ms))
}

/** Install fresh jsdom globals; returns a teardown. */
function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
    pretendToBeVisual: true,
  })
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  const define = (key, value) => {
    // Some globals (navigator) are accessor-only on modern Node; define
    // explicitly instead of assigning.
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  }
  define('window', dom.window)
  define('document', dom.window.document)
  define('navigator', dom.window.navigator)
  define('HTMLElement', dom.window.HTMLElement)
  define('Node', dom.window.Node)
  define('Event', dom.window.Event)
  define('MouseEvent', dom.window.MouseEvent)
  define('IS_REACT_ACT_ENVIRONMENT', false)
  return () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
    }
    dom.window.close()
  }
}

/** Minimal SnapshotStore replacement is NOT used: the real one is loaded. */
function loadClientModule() {
  const src = readFileSync(CLIENT, 'utf8')
  const loaded = []
  globalThis.window.__ModuleLoader__ = { load: (def) => loaded.push(def) }
  new Function('window', src)(globalThis.window)
  assert.equal(loaded.length, 1)
  const def = loaded[0]
  const requireShim = (name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return nodeRequire('react/jsx-runtime')
    if (name === 'react-dom') return nodeRequire('react-dom')
    if (name === 'react-dom/client') return ReactDOMClient
    if (name === '@deepseek-ai/cordis') return {}
    if (name === '@deepseek-ai/dsh-client-store') return nodeRequire('@deepseek-ai/dsh-client-store')
    throw new Error(`module not in fake table: ${name}`)
  }
  return def.factory(requireShim)
}

/** Count fetch calls; serves the plugin bridge + presets endpoints. */
function installFetchCounter() {
  const state = { urls: [] }
  globalThis.fetch = async (url) => {
    state.urls.push(String(url))
    const u = String(url)
    if (u.endsWith('/stats-list')) {
      return { json: async () => ({ ok: true, sessions: { s1: { total: 1, approved: 1, denied: 0, errorDenied: 0 } } }) }
    }
    if (u.endsWith('/list-presets')) {
      return { json: async () => ({ ok: true, presets: [{ id: 'minimal', name: 'minimal', description: '' }] }) }
    }
    return { json: async () => ({ ok: true }) }
  }
  return state
}

/** A ConfigForm fake with the contract the header button relies on. */
function makeConfigForm(initial = { enabled: true }) {
  let value = { ...initial }
  let snapshot = { status: 'ready', value, base: undefined, user: undefined, revision: 1, writable: true }
  const subs = new Set()
  const publish = () => {
    snapshot = { ...snapshot, revision: snapshot.revision + 1, value: { ...value } }
    for (const fn of subs) fn()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn) },
    set: async (field, v) => { value = { ...value, [field]: v }; publish(); return true },
    unset: async (field) => { const next = { ...value }; delete next[field]; value = next; publish(); return true },
    mutate: async (ops) => { for (const op of ops) { if (op.op === 'set') value = { ...value, [op.path[0]]: op.value } } publish(); return true },
  }
}

/** A ConfigPageForm face as the plugin-manager page builds it. */
function makePageForm(value) {
  return {
    state: { status: 'ready', value, base: undefined, user: undefined, revision: 5, writable: true },
    mutate: async () => true,
  }
}

/** One stable snapshot store per test process, as the renderer binds one per hook. */
// The real store package is loaded here so the DOM test exercises the Host's
// actual observable contract. It is also why `zustand` and `immer` stay declared
// as devDependencies: the package requires them at load time under pnpm's strict
// layout, even though this plugin's own client sources no longer import it.
React.__testStore = nodeRequire('@deepseek-ai/dsh-client-store').createSnapshotStore({ loading: false, sessions: {} })

const READY_CONFIG = {
  enabled: true, provider: '', model: '', maxTokens: 2048, timeoutMs: 30000,
  humanTimeoutMs: 30000, filterMode: 'deny-list', tools: ['bash', 'write'],
  autoAllowPatterns: [], deleteReviewerSessions: true, reviewerPreset: 'minimal',
  // The tallies live in the same settings document; the card must ignore them.
  sessions: { 'sess-1': { total: 2, approved: 1, denied: 1, errorDenied: 0 } },
}

/**
 * Mount one slot entry for real and let effects run for `ms`.
 * @returns the fetch counter, captured slot registrations, and the unmount.
 */
async function mount(ms, pick, props, configForm) {
  const teardownDom = installDom()
  const counter = installFetchCounter()
  const modExports = loadClientModule()

  const live = []
  const form = configForm ?? makeConfigForm()
  // Track plugin-scope disposers: the real client scope disposes them, and an
  // undisposed timer would keep this test process alive forever.
  const disposers = []
  // Faithful stand-in for the forwarded-event face the client injects
  // (`ctx.remote.$on`), so tests can emit the very events the Host forwards.
  const listeners = new Map()
  const remote = {
    $on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
  }
  const emitForwarded = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  const fakeCtx = {
    slots: {
      inject: (slot, cb) => live.push({ slot, cb }),
      register: (spec, component) => ({ spec, component }),
    },

    locale: sharedLocale,
    configForms: { get: () => form },
    remote,
    effect: (fn) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      else if (Array.isArray(d)) for (const item of d) if (typeof item === 'function') disposers.push(item)
      return d
    },
  }
  modExports.apply(fakeCtx)

  const entry = live.find(l => l.slot === pick)
  assert.ok(entry, `slot ${pick} registered`)
  const reg = entry.cb()

  const container = globalThis.document.getElementById('root')
  const root = ReactDOMClient.createRoot(container)
  root.render(React.createElement(reg.component, props))
  // Let the mount effects and any storm play out in real time.
  await settle(ms)

  return {
    counter,
    live,
    form,
    listeners,
    emitForwarded,
    /** Render another instance of the same registration (the page does this twice). */
    async render(props, ms = 200) {
      const holder = globalThis.document.createElement('div')
      globalThis.document.body.appendChild(holder)
      const next = ReactDOMClient.createRoot(holder)
      next.render(React.createElement(reg.component, props))
      await settle(ms)
      return () => { next.unmount(); holder.remove() }
    },
    async unmount() {
      root.unmount()
      await settle(20)
      // Simulate plugin-scope disposal so no timer outlives the test.
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* best-effort */ }
      }
      teardownDom()
    },
  }
}

test('settings card does not storm the Host with requests on mount', async () => {
  const mounted = await mount(
    1000,
    'plugins.row.config',
    { view: 'page', form: makePageForm(READY_CONFIG) },
  )
  try {
    const statsCalls = mounted.counter.urls.filter(u => u.endsWith('/stats-list'))
    const presetCalls = mounted.counter.urls.filter(u => u.endsWith('/list-presets'))
    assert.ok(
      statsCalls.length <= 3,
      `stats-list must be fetched a bounded number of times, got ${statsCalls.length} in 1s`,
    )
    assert.ok(
      presetCalls.length <= 3,
      `list-presets must be fetched a bounded number of times, got ${presetCalls.length} in 1s`,
    )
    assert.ok(
      mounted.counter.urls.length <= 6,
      `total Host requests must stay tiny, got ${mounted.counter.urls.length} in 1s`,
    )
  } finally {
    await mounted.unmount()
  }
})

test('saving the settings card does not storm the Host with requests', async () => {
  // The reported failure was exactly this: press Save and the Host receives
  // hundreds of requests. A save updates the page's config mirror, which
  // re-renders the card with fresh prop identities — any effect that depends on
  // such an identity re-runs, and with a fetch inside it, that is a storm.
  let mutations = 0
  let savedOps
  const pageForm = {
    state: { status: 'ready', value: READY_CONFIG, base: undefined, user: undefined, revision: 7, writable: true },
    mutate: async (ops) => { mutations += 1; savedOps = ops; return true },
  }
  const mounted = await mount(300, 'plugins.row.config', { view: 'page', form: pageForm })
  try {
    const before = mounted.counter.urls.length
    const click = (el) => el.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }))

    // Dirty the draft through a real field, then save.
    const toggle = [...globalThis.document.querySelectorAll('button')].find(b => /已启用|已禁用/.test(b.textContent ?? ''))
    assert.ok(toggle, 'enable switch rendered')
    click(toggle)
    await new Promise(r => setTimeout(r, 30))

    const save = [...globalThis.document.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '保存')
    assert.ok(save, 'save button rendered')
    click(save)
    await new Promise(r => setTimeout(r, 400))

    assert.equal(mutations, 1, 'exactly one write for one save')
    assert.equal(savedOps.length, 11, 'only the 11 user fields are written')
    assert.ok(
      !savedOps.some(op => op.path[0] === 'sessions'),
      'the card never writes the tallies field it does not own',
    )
    const after = mounted.counter.urls.length
    assert.ok(
      after - before <= 3,
      `a save must not storm the Host: ${after - before} requests in 400ms after Save`,
    )
  } finally {
    await mounted.unmount()
  }
})

test('a tally write refreshes once, a foreign settings write does not, and idle costs nothing', async () => {
  // 0.1.x refreshed on the platform's forwarded `settings/document-updated`
  // filtered by namespace. The plugin's tallies now live in its own entry
  // document, so the filter is the entry id — the trigger, the frequency and
  // the latency are the ones the 0.1.x stats namespace produced.
  const mounted = await mount(300, 'conversation.session.header.actions', { t: translateZh,
    sessionId: 'sess-1',
    form: makeConfigForm({ enabled: true }),
    refreshStats: () => {},
    useApprovalStats: (selector) => selector(React.useSyncExternalStore(
      (cb) => React.__testStore.subscribe(cb),
      () => React.__testStore.getSnapshot(),
    )),
  })
  try {
    const afterMount = mounted.counter.urls.length
    assert.ok(afterMount >= 1, 'the store is seeded once on mount')

    // Idle window: nothing may drive traffic.
    await new Promise(r => setTimeout(r, 1200))
    assert.equal(mounted.counter.urls.length, afterMount, 'no requests while idle')

    // A write to ANOTHER entry's document must not refresh the tallies.
    mounted.emitForwarded('settings/document-updated', 'some-other-plugin', 3)
    await new Promise(r => setTimeout(r, 100))
    assert.equal(mounted.counter.urls.length, afterMount, 'a foreign namespace is ignored')

    // A write to this plugin's own document refreshes exactly once, at once.
    mounted.emitForwarded('settings/document-updated', 'dsh-safe-tool', 4)
    await new Promise(r => setTimeout(r, 100))
    assert.equal(mounted.counter.urls.length, afterMount + 1, 'one tally write costs exactly one read, immediately')

    // Repeated writes each cost one read — no coalescing window (0.1.x had none).
    mounted.emitForwarded('settings/document-updated', 'dsh-safe-tool', 5)
    mounted.emitForwarded('settings/document-updated', 'dsh-safe-tool', 6)
    await new Promise(r => setTimeout(r, 100))
    assert.equal(mounted.counter.urls.length, afterMount + 3, 'each write refreshes')
  } finally {
    await mounted.unmount()
  }
})

test('settings card renders its fields and a summary for real', async () => {
  const page = await mount(200, 'plugins.row.config', { view: 'page', form: makePageForm(READY_CONFIG) })
  try {
    const html = globalThis.document.getElementById('root').innerHTML
    assert.match(html, /启用审批插件/)
    assert.match(html, /拦截模式/)
    assert.match(html, /审批统计存储/)
  } finally {
    await page.unmount()
  }

  const summary = await mount(50, 'plugins.row.config', { view: 'summary', form: makePageForm(READY_CONFIG) })
  try {
    const html = globalThis.document.getElementById('root').innerHTML
    assert.match(html, /AI 子代理审查/)
  } finally {
    await summary.unmount()
  }
})

test('header button renders, toggles the enable switch, and does not storm', async () => {
  const statsStore = nodeRequire('@deepseek-ai/dsh-client-store').createSnapshotStore({ loading: true, sessions: {} })
  const form = makeConfigForm({ enabled: true })

  // The renderer binds `hooks` into `use<Name>`; emulate that binding.
  const boundProps = { t: translateZh,
    sessionId: 'sess-1',
    form,
    refreshStats: () => { void globalThis.fetch('/api/dsh-safe-tool-settings/stats-list', { method: 'POST' }) },
    useApprovalStats: (selector) => {
      const snapshot = React.useSyncExternalStore(
        (cb) => statsStore.subscribe(cb),
        () => statsStore.getSnapshot(),
      )
      return selector(snapshot)
    },
  }
  const mounted = await mount(800, 'conversation.session.header.actions', boundProps)
  try {
    const html = globalThis.document.getElementById('root').innerHTML
    assert.match(html, /审批统计/)

    // Toggle the switch through the real DOM.
    const click = (el) => el.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }))
    const chip = globalThis.document.querySelector('button')
    click(chip)
    await settle(20)
    const toggle = [...globalThis.document.querySelectorAll('button')].find(b => /已启用|已禁用/.test(b.textContent ?? ''))
    assert.ok(toggle, 'enable toggle present in the popover')
    click(toggle)
    await settle(50)
    assert.equal(form.getSnapshot().value.enabled, false, 'toggle wrote through the config form')

    assert.ok(
      mounted.counter.urls.length <= 6,
      `header button must not storm, got ${mounted.counter.urls.length} requests`,
    )
  } finally {
    await mounted.unmount()
  }
})

test('the row summary costs no bridge traffic and mirrors the editor\'s unsaved marker', async () => {
  // The page mounts this card twice for one row: `view:'summary'` for the row
  // line and `view:'page'` for the editor. The summary is static text, so it must
  // not fetch anything — and the 0.1.x "未保存" marker has to reach it, which only
  // works because both instances read one shared flag.
  const mounted = await mount(
    300,
    'plugins.row.config',
    { view: 'summary' },
  )
  try {
    // `apply` seeds the header store once; the summary mount itself must add
    // nothing — most tellingly, no preset list, which only the editor reads.
    assert.equal(
      mounted.counter.urls.filter(u => u.endsWith('/list-presets')).length, 0,
      'the summary never reads the preset list',
    )
    assert.ok(
      mounted.counter.urls.filter(u => u.endsWith('/list-presets')).length === 0
        && mounted.counter.urls.length <= 1,
      `the summary mount adds no bridge traffic beyond the startup seed (got ${mounted.counter.urls.length})`,
    )

    // The editor instance mounts, loads once, and the user edits a field.
    const unmountEditor = await mounted.render({ view: 'page', form: makePageForm(READY_CONFIG) })
    const afterEditor = mounted.counter.urls.length
    assert.ok(afterEditor >= 2, 'the editor loads the tallies and the preset list')

    const editorDoc = globalThis.document
    const card = editorDoc.querySelector('[class="dshst-card"]') ?? editorDoc.body
    // Toggling a control is the proven way to make the editor dirty (a
    // controlled text input needs React's value tracker, a switch does not).
    const enableToggle = [...card.querySelectorAll('button')]
      .find(button => /已启用|已禁用/.test(button.textContent))
    assert.ok(enableToggle, 'the editor rendered its enable switch')
    enableToggle.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }))
    await settle(150)

    // The summary instance now shows the unsaved marker, without new traffic.
    const summaryText = globalThis.document.body.textContent
    assert.match(summaryText, /未保存/, 'the row summary mirrors the unsaved state')
    assert.equal(mounted.counter.urls.length, afterEditor, 'the marker costs no request')

    await unmountEditor()
  } finally {
    await mounted.unmount()
  }
})

test('a carrier that cannot forward events still gets the card and the header button', async () => {
  // `ctx.remote.$on` throws when the carrier has no interactive approval
  // (`forwarded events require interactions=answer`). That must not abort the
  // rest of the client half.
  const teardownDom = installDom()
  const modExports = loadClientModule()
  const live = []
  const fakeCtx = {
    slots: {
      inject: (slot, cb) => live.push({ slot, cb }),
      register: (spec, component) => ({ spec, component }),
    },
    locale: sharedLocale,
    configForms: { get: () => makeConfigForm() },
    remote: {
      $on() {
        throw new Error('client api: forwarded events require interactions=answer')
      },
    },
    logger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
    effect: (fn) => fn(),
  }
  try {
    modExports.apply(fakeCtx)
    const slots = live.map(entry => entry.slot).sort()
    assert.deepEqual(slots, ['conversation.session.header.actions', 'plugins.row.config'],
      'both slots still register when forwarded events are unavailable')
  } finally {
    teardownDom()
  }
})
