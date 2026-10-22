/**
 * Real-cordis assembly test for the host half.
 *
 * The plugin is mounted inside a REAL `@deepseek-ai/cordis` `Context` next to a
 * service-provider plugin and driven through a real
 * `waterfall('tools/pre-execute')` dispatch. What this establishes:
 *
 *   1. The plugin activates with real inject/effect semantics, and its nested
 *      `ctx.inject(['settings'], …)` scope resolves the tallies' transport.
 *   2. A settled review writes exactly one tally op — addressed to the plugin's
 *      own entry document, in the 0.1.x op shape — and that write is what raises
 *      the platform's `document-updated` edge the browser half listens for.
 *   3. The bridge serves that document back, and clearing it reaches the same
 *      store.
 *
 * @module dsh-safe-tool/test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { withRealStack, fakeAgent } from './helpers/real-stack.mjs'

test('real cordis: a settled review writes one tally op to the plugin entry document', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-cordis-'))
  const stack = await withRealStack(t, { home })

  const exec = {
    name: 'bash',
    arguments: { command: 'ls -la' },
    agent: fakeAgent('sess-real-1', '/workspaces/main'),
    signal: new AbortController().signal,
  }
  const verdict = await stack.root.waterfall(
    stack.root,
    'tools/pre-execute',
    exec,
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.equal(verdict.kind, 'allow', 'an approved call passes through')
  assert.equal(stack.calls.startActivation.length, 1, 'the reviewer was spawned exactly once')

  assert.equal(stack.settings.mutations.length, 1, 'one settings write per settled decision')
  const [mutation] = stack.settings.mutations
  assert.equal(mutation.ns, 'dsh-safe-tool', 'written to the plugin entry document')
  assert.deepEqual(mutation.ops, [{
    op: 'set',
    path: ['sessions', 'sess-real-1'],
    value: { total: 1, approved: 1, denied: 0, errorDenied: 0 },
  }], 'the 0.1.x op shape, addressed under `sessions`')
  assert.deepEqual(stack.settings.notifications, ['dsh-safe-tool'],
    'the write raised the forwarded document-updated edge for this entry')

  // The bridge serves the same document back to the browser half.
  const listed = await stack.bridge('/api/dsh-safe-tool-settings/stats-list', {})
  assert.equal(listed.ok, true)
  assert.equal(listed.sessions['sess-real-1'].total, 1)
  assert.equal(listed.sessions['sess-real-1'].approved, 1)

  // Clearing one session reaches the same store (one unset op).
  const cleared = await stack.bridge('/api/dsh-safe-tool-settings/stats-clear', { sessionIds: ['sess-real-1'] })
  assert.equal(cleared.ok, true)
  const afterClear = await stack.bridge('/api/dsh-safe-tool-settings/stats-list', {})
  assert.equal(afterClear.sessions['sess-real-1'], undefined, 'the tally is gone')

  await stack.teardown()
})

test('real cordis: a denied review is tallied as denied, and clear-all resets the dict', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dshst-cordis-deny-'))
  const stack = await withRealStack(t, {
    home,
    structured: { output: [], structured: { approve: false, reason: '危险操作' }, stopReason: 'completed' },
  })

  const exec = {
    name: 'bash',
    arguments: { command: 'rm -rf /' },
    agent: fakeAgent('sess-deny', '/workspaces/main'),
    signal: new AbortController().signal,
  }
  const verdict = await stack.root.waterfall(
    stack.root,
    'tools/pre-execute',
    exec,
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.equal(verdict.kind, 'deny', 'a rejected review blocks the call')
  assert.match(verdict.reason, /危险操作/, 'the model reason reaches the caller')

  const listed = await stack.bridge('/api/dsh-safe-tool-settings/stats-list', {})
  assert.deepEqual(listed.sessions['sess-deny'], { total: 1, approved: 0, denied: 1, errorDenied: 0 })

  // Clear-all is the 0.1.x one-shot: set the whole dict to {}.
  const cleared = await stack.bridge('/api/dsh-safe-tool-settings/stats-clear', {})
  assert.equal(cleared.ok, true)
  const afterClear = await stack.bridge('/api/dsh-safe-tool-settings/stats-list', {})
  assert.deepEqual(afterClear.sessions, {}, 'clear-all emptied the dict')
  const lastMutation = stack.settings.mutations.at(-1)
  assert.deepEqual(lastMutation.ops, [{ op: 'set', path: ['sessions'], value: {} }],
    'clear-all matches the 0.1.x op')

  await stack.teardown()
})

test('the review session artifact is really deleted from disk', async (t) => {
  // The failure this pins down: a disposed session is already gone from
  // `stat()`/`list()`, so a cleanup that re-reads the identity afterwards
  // silently skips the delete and review sessions accumulate under the session
  // root forever. The child here is a REAL persisted session (real backend,
  // real append + flush, real file), and the test records the exact artifact
  // directory the backend created before asserting it is gone.
  const home = mkdtempSync(join(tmpdir(), 'dshst-cleanup-'))
  const stack = await withRealStack(t, { home })

  const exec = {
    name: 'bash',
    arguments: { command: 'ls -la' },
    agent: fakeAgent('sess-clean-1', '/workspaces/main'),
    signal: new AbortController().signal,
  }
  await stack.root.waterfall(stack.root, 'tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))

  assert.deepEqual(stack.calls.spawnErrors, [], 'the child session was persisted')
  assert.equal(stack.root.get('sessionPersistence').root, stack.sessionRootDir,
    'the plugin deleted from the backend it was configured with')
  assert.equal(stack.calls.childArtifactDirs.length, 1, 'the backend really created one artifact directory')
  const artifactDir = stack.calls.childArtifactDirs[0]
  // The child's cwd is the plugin's reviewer workspace, so the artifact lands
  // under that project directory — exactly the layout the backend uses.
  assert.match(artifactDir, /dsh-safe-tool-safe-tool-log--\/child-\d+-\d+$/, 'nested under the reviewer workspace project directory')

  assert.equal(existsSync(artifactDir), false, 'the review child artifact is deleted from disk')
  // Only the child's session directory goes away: the project directory that
  // holds it survives, so nothing outside this one review session was touched.
  const projectDir = artifactDir.slice(0, artifactDir.lastIndexOf(sep))
  assert.equal(existsSync(projectDir), true, 'the enclosing project directory is untouched')
  assert.deepEqual(readdirSync(projectDir), [], 'nothing else was left in it')
  assert.deepEqual(stack.settings.mutations.length, 1, 'the review still recorded its tally')

  await stack.teardown()
})

test('deleteReviewerSessions:false keeps the artifact (control)', async (t) => {
  // Negative control: the same run with deletion switched off must LEAVE the
  // child directory behind, which proves the assertion above is not vacuous.
  const home = mkdtempSync(join(tmpdir(), 'dshst-keep-'))
  const stack = await withRealStack(t, { home, config: { deleteReviewerSessions: false } })

  const exec = {
    name: 'bash',
    arguments: { command: 'ls -la' },
    agent: fakeAgent('sess-keep-1', '/workspaces/main'),
    signal: new AbortController().signal,
  }
  await stack.root.waterfall(stack.root, 'tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))

  assert.equal(stack.calls.childArtifactDirs.length, 1, 'the backend created the artifact')
  assert.equal(existsSync(stack.calls.childArtifactDirs[0]), true,
    'with deletion off the child artifact stays on disk')

  await stack.teardown()
})
