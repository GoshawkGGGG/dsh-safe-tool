/**
 * Browser-half render regression tests.
 *
 * Materializes the BUILT client bundle exactly like the harness module
 * loader does (factory(require) over a fake module table), applies it with a
 * fake client context, and server-renders every slot component in the props
 * shapes the owners dispatch.
 *
 * The critical regression guarded here: `plugins.row.config` hands the card
 * a ConfigPageForm face — DATA (`{ state, mutate }`), not a subscribable
 * ConfigForm. Touching `form.subscribe` on it throws, the slot owner
 * abdicates the entry, and the settings card silently disappears from the
 * Plugins page. The fixture's form face therefore has a `subscribe` getter
 * that throws: any regression fails loud with that marker.
 *
 * @module dsh-safe-tool/test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToString } from 'react-dom/server'
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

/** One stub shared by the render helper and the injected `t` face. */
const sharedLocale = fakeLocale()
const translateZh = sharedLocale.bind('dsh-safe-tool')

const nodeRequire = createRequire(import.meta.url)
const CLIENT = new URL('../lib/client.js', import.meta.url)
requireBuiltArtifact(new URL('../lib/client.js', import.meta.url), 'lib/client.js')

/** A minimal SnapshotStore fake for the browser module table. */
function fakeStore(init) {
  let value = init
  const subs = new Set()
  return {
    set: (v) => { value = v; subs.forEach(f => f()) },
    update: (fn) => { value = fn(structuredClone(value)); subs.forEach(f => f()) },
    subscribe: (f) => { subs.add(f); return () => subs.delete(f) },
    getSnapshot: () => value,
  }
}

/** Materialize the client module and apply it with a fake client context. */
function materializeClient() {
  const src = readFileSync(CLIENT, 'utf8')
  const loaded = []
  globalThis.window = { __ModuleLoader__: { load: (def) => loaded.push(def) } }
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {} }),
    head: { appendChild: () => {} },
  }
  new Function('window', src)(globalThis.window)
  assert.equal(loaded.length, 1, 'exactly one ModuleLoader factory registered')
  const def = loaded[0]

  const requireShim = (name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return nodeRequire('react/jsx-runtime')
    if (name === 'react-dom') return nodeRequire('react-dom')
    if (name === 'react-dom/client') return {}
    if (name === '@deepseek-ai/cordis') return {}
    if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: fakeStore }
    throw new Error(`module not in fake table: ${name}`)
  }
  const modExports = def.factory(requireShim)

  const live = []
  modExports.apply({
    slots: {
      inject: (slot, cb) => live.push({ slot, cb }),
      register: (spec, component) => ({ spec, component }),
    },

    locale: sharedLocale,
    configForms: { get: () => undefined },
    // Server rendering never runs effects, so the effect bodies (including the
    // `ctx.remote.$on` subscription) are intentionally not executed here. The
    // live subscription is covered by the real-DOM suite instead.
    effect: () => () => {},
  })
  return { modExports, live }
}

function renderEntry({ slot, cb }, props) {
  const reg = cb()
  assert.equal(reg.spec.name, slot)
  return renderToString(React.createElement(reg.component, props))
}

/** A ready ConfigPageForm face whose `subscribe` getter throws if touched. */
function readyFormFace() {
  const calls = { mutate: 0, revision: undefined }
  const face = {
    state: {
      status: 'ready',
      value: {
        enabled: true, provider: '', model: '', maxTokens: 2048,
        timeoutMs: 30000, humanTimeoutMs: 30000, filterMode: 'deny-list',
        tools: ['bash', 'write'], autoAllowPatterns: [],
        deleteReviewerSessions: true, reviewerPreset: 'minimal',
      },
      base: undefined,
      user: undefined,
      revision: 7,
      writable: true,
    },
    mutate: async (ops, revision) => { calls.mutate++; calls.revision = revision; return true },
  }
  Object.defineProperty(face, 'subscribe', {
    get() { throw new Error('REGRESSION: card must not subscribe to the ConfigPageForm face') },
  })
  Object.defineProperty(face, 'getSnapshot', {
    get() { throw new Error('REGRESSION: card must not call getSnapshot on the ConfigPageForm face') },
  })
  return { face, calls }
}

test('client bundle registers both slots through the module-loader contract', () => {
  const { live } = materializeClient()
  assert.deepEqual(live.map(l => l.slot).sort(), [
    'conversation.session.header.actions',
    'plugins.row.config',
  ])
})

test('plugins.row.config renders summary and page views without touching the form face', () => {
  const { live } = materializeClient()
  const entry = live.find(l => l.slot === 'plugins.row.config')
  const { face } = readyFormFace()

  const summary = renderEntry(entry, { view: 'summary', form: face })
  assert.ok(summary.length > 0)
  assert.match(summary, /AI 子代理审查/)

  // form: undefined (Host not serving the namespace) → the 0.1.x placeholder
  // wording, with the Host-side reason kept as a tooltip, no throw.
  const unavailable = renderEntry(entry, { view: 'page', form: undefined })
  assert.match(unavailable, /设置不可用/)
  assert.match(unavailable, /title="Host/, 'the diagnostic stays available as a tooltip')

  // ready face → renders after mount; SSR shows the loading placeholder but
  // must NOT throw and must NOT touch subscribe/getSnapshot.
  const page = renderEntry(entry, { view: 'page', form: face })
  assert.ok(page.length > 0)
})

test('plugins.row.config tolerates unavailable and loading form states', () => {
  const { live } = materializeClient()
  const entry = live.find(l => l.slot === 'plugins.row.config')
  const unavailable = renderEntry(entry, {
    view: 'page',
    form: { state: { status: 'unavailable', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false }, mutate: async () => false },
  })
  assert.match(unavailable, /设置不可用/)
})

test('header button renders with a real ConfigForm face and the stats hook', () => {
  const { live } = materializeClient()
  const entry = live.find(l => l.slot === 'conversation.session.header.actions')
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { enabled: true }, base: undefined, user: undefined, revision: 3, writable: true }),
    subscribe: (_listener) => () => {},
    set: async () => true,
    unset: async () => true,
    mutate: async () => true,
  }
  const html = renderEntry(entry, {
    t: sharedLocale.bind('dsh-safe-tool'),
    sessionId: 'sess-1',
    form,
    refreshStats: () => {},
    useApprovalStats: (sel) => sel({ loading: false, sessions: { 'sess-1': { total: 4, approved: 3, denied: 1, errorDenied: 0 } } }),
  })
  assert.ok(html.length > 0)
  assert.match(html, /审批统计/)
})
