/**
 * Web UI settings card for the AI approval plugin, rendered inside the
 * Plugins page through the `plugins.row.config` slot (dsh 0.2.x).
 *
 * - `view: 'summary'` renders the row's one-liner description.
 * - `view: 'page'` renders the full editor. Values and writes come from the
 *   page owner's `ConfigPageForm` face - DATA (`{ state: ConfigFormSnapshot,
 *   mutate }`), materialized once per page render, NOT a subscribable
 *   `ConfigForm`. The page owner re-dispatches this entry with a fresh
 *   `state` when the underlying view changes, so this card must never call
 *   `subscribe`/`getSnapshot` on it - doing so throws and the slot owner
 *   abdicates the entry (the card silently disappears).
 * - Per-session tally management still rides the plugin's own bridge. The
 *   tallies live in this plugin's own settings document (the entry that also
 *   holds the config), written by the Host half through `settings.mutate`.
 */

import { useState, useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from './store.ts'
import type { ApprovalStats } from './HeaderButton.tsx'

/** Client-side view of the plugin config (arrays flattened to editable strings). */
interface ApprovalConfigView {
  enabled: boolean
  provider: string
  model: string
  maxTokens: number
  timeoutMs: number
  humanTimeoutMs: number
  filterMode: 'deny-list' | 'allow-list'
  tools: string
  autoAllowPatterns: string
  deleteReviewerSessions: boolean
  reviewerPreset: string
}

/** Join a string array (if present) or return the fallback. */
function joinArray(value: unknown, fallback: string): string {
  if (Array.isArray(value)) return value.join(', ')
  return typeof value === 'string' ? value : fallback
}

/** Decode the Host-resolved section into the editable view (defaults kept). */
function decodeConfig(value: Record<string, unknown> | undefined): ApprovalConfigView {
  return {
    enabled: value?.enabled !== false,
    provider: typeof value?.provider === 'string' ? value.provider : '',
    model: typeof value?.model === 'string' ? value.model : '',
    maxTokens: typeof value?.maxTokens === 'number' ? value.maxTokens : 2048,
    timeoutMs: typeof value?.timeoutMs === 'number' ? value.timeoutMs : 30000,
    humanTimeoutMs: typeof value?.humanTimeoutMs === 'number' ? value.humanTimeoutMs : 30000,
    filterMode: value?.filterMode === 'allow-list' ? 'allow-list' : 'deny-list',
    tools: joinArray(value?.tools, 'bash, write'),
    autoAllowPatterns: joinArray(value?.autoAllowPatterns, ''),
    deleteReviewerSessions: value?.deleteReviewerSessions !== false,
    reviewerPreset: typeof value?.reviewerPreset === 'string' && value.reviewerPreset !== ''
      ? value.reviewerPreset
      : 'minimal',
  }
}

/** Turn the editable view back into revision-fenced path ops. */
function configToOps(c: ApprovalConfigView): SettingsPathOpView[] {
  return [
    { op: 'set', path: ['enabled'], value: c.enabled },
    c.provider === '' ? { op: 'unset' as const, path: ['provider'] } : { op: 'set' as const, path: ['provider'], value: c.provider },
    c.model === '' ? { op: 'unset' as const, path: ['model'] } : { op: 'set' as const, path: ['model'], value: c.model },
    { op: 'set', path: ['maxTokens'], value: c.maxTokens },
    { op: 'set', path: ['timeoutMs'], value: c.timeoutMs },
    { op: 'set', path: ['humanTimeoutMs'], value: c.humanTimeoutMs },
    { op: 'set', path: ['filterMode'], value: c.filterMode },
    { op: 'set', path: ['tools'], value: c.tools.split(',').map(s => s.trim()).filter(s => s.length > 0) },
    { op: 'set', path: ['autoAllowPatterns'], value: c.autoAllowPatterns.split('\n').map(s => s.trim()).filter(s => s.length > 0) },
    { op: 'set', path: ['deleteReviewerSessions'], value: c.deleteReviewerSessions },
    c.reviewerPreset === '' ? { op: 'unset' as const, path: ['reviewerPreset'] } : { op: 'set' as const, path: ['reviewerPreset'], value: c.reviewerPreset },
  ]
}

/** Owner props of the `plugins.row.config` slot (subset the card consumes). */
export interface ApprovalCardProps {
  /** Translate this bundle's locale keys (bound by the Client locale service). */
  t: (key: string) => string
  view: 'summary' | 'page'
  form: ConfigPageForm | undefined
  /** Stats bridge face for the tally manager. */
  stats: {
    fetchStats: () => Promise<Record<string, ApprovalStats>>
    /** Shared "unsaved" flag (the row summary and the editor are two mounts). */
    unsaved: SnapshotStore<boolean>
  }
}

const CSS = {
  card: 'dshst-card',
  body: 'dshst-body',
  footer: 'dshst-footer',
  footerRight: 'dshst-footerRight',
  failed: 'dshst-failed',
  field: 'dshst-field',
  label: 'dshst-label',
  select: 'dshst-select',
  input: 'dshst-input',
  textarea: 'dshst-input',
  hint: 'dshst-hint',
  btn: 'dshst-btn',
  save: 'dshst-save',
  discard: 'dshst-discard',
  summary: 'dshst-summary',
  pending: 'dshst-pending',
}

/** Whether two decoded views carry the same editable values. */
function sameView(a: ApprovalConfigView, b: ApprovalConfigView): boolean {
  return a.enabled === b.enabled
    && a.provider === b.provider
    && a.model === b.model
    && a.maxTokens === b.maxTokens
    && a.timeoutMs === b.timeoutMs
    && a.humanTimeoutMs === b.humanTimeoutMs
    && a.filterMode === b.filterMode
    && a.tools === b.tools
    && a.autoAllowPatterns === b.autoAllowPatterns
    && a.deleteReviewerSessions === b.deleteReviewerSessions
    && a.reviewerPreset === b.reviewerPreset
}

/**
 * The one-liner the Plugins page renders as the row's description fallback.
 */
export function ApprovalCardSummary({ t, unsaved }: { t: (key: string) => string; unsaved?: boolean }): ReactNode {
  return (
    <span className={CSS.summary}>
      {t('t55')}
      {unsaved === true ? <span className={CSS.pending}>{t('t1')}</span> : null}
    </span>
  )
}

export function ApprovalCard({ t, view, form, stats }: ApprovalCardProps): ReactNode {
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [draft, setDraft] = useState<ApprovalConfigView | null>(null)

  // Mirror the dirty flag into the shared store so the row summary can show the
  // t('t1') marker that 0.1.x rendered in its own header.
  const unsaved = useSyncExternalStore(
    useCallback((listener: () => void) => stats.unsaved.subscribe(listener), [stats]),
    () => stats.unsaved.getSnapshot(),
    () => stats.unsaved.getSnapshot(),
  )

  // Stats management state: the per-session tallies the Host keeps in this
  // plugin's settings document, plus which rows the user selected for clearing.
  const [statsState, setStatsState] = useState<{
    sessions: Record<string, ApprovalStats>
    loading: boolean
    selected: Record<string, boolean>
  }>({ sessions: {}, loading: true, selected: {} })

  // Available agent presets for the review subagent's dedicated parent.
  const [presets, setPresets] = useState<Array<{ id: string; name: string; description: string }>>([])

  const loadPresets = useCallback(async () => {
    try {
      const response = await fetch('/api/dsh-safe-tool-settings/list-presets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const result = await response.json()
      if (result.ok && Array.isArray(result.presets)) {
        setPresets(result.presets)
      }
    } catch {
      // Non-fatal: leave the dropdown empty; the field still shows the saved id.
    }
  }, [])

  const loadStats = useCallback(async () => {
    try {
      const sessions = await stats.fetchStats()
      setStatsState(s => ({ ...s, sessions, loading: false }))
    } catch {
      setStatsState(s => ({ ...s, loading: false }))
    }
  }, [stats])

  const clearStats = useCallback(async (sessionIds?: string[]) => {
    try {
      await fetch('/api/dsh-safe-tool-settings/stats-clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sessionIds === undefined ? {} : { sessionIds }),
      })
      await loadStats()
      if (sessionIds === undefined) setStatsState(s => ({ ...s, selected: {} }))
    } catch {
      // Non-fatal: clearing is best-effort.
    }
  }, [loadStats])

  const toggleSelect = useCallback((sessionId: string) => {
    setStatsState(s => ({
      ...s,
      selected: { ...s.selected, [sessionId]: !s.selected[sessionId] },
    }))
  }, [])

  // The page owner re-dispatches this entry with a fresh `form.state` object
  // whenever the underlying Host view changes; re-sync the draft from it
  // (unless the user has unsaved local edits). NEVER subscribe to this face:
  // it is data, not a store.
  const snapshot = form?.state

  // The summary mount renders a static one-liner: it must not drive bridge
  // traffic (the page mounts both views for the same row).
  const isSummary = view === 'summary'
  useEffect(() => {
    if (isSummary) return
    stats.unsaved.set(dirty)
  }, [isSummary, dirty, stats])

  // Load the bridge data EXACTLY once per mount. The ref guard is a
  // structural safety net: even if a future edit gives `loadStats`/`loadPresets`
  // an unstable identity, this effect cannot re-run and cannot storm the Host.
  const bridgeLoaded = useRef(false)
  useEffect(() => {
    if (isSummary) return
    if (bridgeLoaded.current) return
    bridgeLoaded.current = true
    void loadStats()
    void loadPresets()
  }, [isSummary, loadStats, loadPresets])

  useEffect(() => {
    if (dirty) return
    if (snapshot?.status === 'ready') {
      const next = decodeConfig(snapshot.value)
      // Re-setting an equal draft would schedule a pointless render; the page
      // owner re-dispatches with a fresh object on every Host view change.
      setDraft(prev => (prev !== null && sameView(prev, next) ? prev : next))
    } else {
      setDraft(prev => (prev === null ? prev : null))
    }
  }, [snapshot, dirty])

  const update = useCallback((key: keyof ApprovalConfigView, value: unknown) => {
    setDraft(d => (d ? { ...d, [key]: value } : d))
    setDirty(true)
    setFailed(false)
  }, [])

  const save = useCallback(async () => {
    if (!form || !draft || !dirty) return
    setSaving(true)
    setFailed(false)
    try {
      // No expected revision: the plugin writes a tally into this same entry's
      // document, so a revision captured at render time can already be stale.
      // The form controller resolves the current revision itself.
      const ok = await form.mutate(configToOps(draft))
      if (ok) {
        setDirty(false)
      } else {
        setFailed(true)
      }
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }, [form, draft, dirty])

  const discard = useCallback(() => {
    if (snapshot?.status === 'ready') setDraft(decodeConfig(snapshot.value))
    setDirty(false)
    setFailed(false)
  }, [snapshot])

  if (view === 'summary') {
    return <ApprovalCardSummary t={t} unsaved={unsaved} />
  }

  if (form === undefined || snapshot === undefined || snapshot.status !== 'ready' || draft === null) {
    return (
      <div className={CSS.card} style={{ padding: '12px 14px' }}>
        {/* Visible wording matches 0.1.x; the Host-side reason stays available
            as a tooltip so a broken settings surface is still diagnosable. */}
        <p
          className={CSS.hint}
          title={form === undefined
            ? t('t2')
            : snapshot?.status === 'unavailable'
              ? t('t3')
              : undefined}
        >
          {form === undefined || snapshot?.status === 'unavailable'
            ? t('t4')
            : t('t5')}
        </p>
      </div>
    )
  }

  const c = draft
  const writable = snapshot.writable

  return (
    <div className={CSS.card}>
      <div className={CSS.body}>
        <div className={CSS.field}>
          <label className={CSS.label}>{t('t18')}</label>
          <div>
            <button
              type="button"
              className={`${CSS.btn} ${c.enabled ? CSS.save : CSS.discard}`}
              disabled={!writable}
              onClick={() => update('enabled', !c.enabled)}
            >
              {c.enabled ? t('t6') : t('t7')}
            </button>
          </div>
          <p className={CSS.hint}>{t('t19')}</p>
        </div>

        <div className={CSS.field}>
          <label className={CSS.label}>{t('t20')}</label>
          <div>
            <button
              type="button"
              className={`${CSS.btn} ${c.deleteReviewerSessions ? CSS.save : CSS.discard}`}
              disabled={!writable}
              onClick={() => update('deleteReviewerSessions', !c.deleteReviewerSessions)}
            >
              {c.deleteReviewerSessions ? t('t8') : t('t9')}
            </button>
          </div>
          <p className={CSS.hint}>
            {c.deleteReviewerSessions
              ? t('t10')
              : t('t11')}
          </p>
        </div>

        <div className={CSS.field}>
          <label className={CSS.label}>{t('t21')}</label>
          <select
            className={CSS.select}
            value={c.reviewerPreset}
            disabled={!writable}
            onChange={(e) => update('reviewerPreset', e.target.value)}
          >
            {!presets.some(p => p.id === c.reviewerPreset) ? (
              <option value={c.reviewerPreset}>{c.reviewerPreset}</option>
            ) : null}
            {presets.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <p className={CSS.hint}>{t('t22')}</p>
        </div>

        <div className={CSS.field}>
          <label className={CSS.label}>{t('t23')}</label>
          <input
            type="text"
            className={CSS.input}
            placeholder={t('t12')}
            value={c.provider}
            disabled={!writable}
            onChange={(e) => update('provider', e.target.value)}
          />
          <p className={CSS.hint}>{t('t24')}</p>
        </div>

        <div className={CSS.field}>
          <label className={CSS.label}>{t('t25')}</label>
          <input
            type="text"
            className={CSS.input}
            placeholder={t('t13')}
            value={c.model}
            disabled={!writable}
            onChange={(e) => update('model', e.target.value)}
          />
          <p className={CSS.hint}>{t('t26')}</p>
        </div>

        <div className={CSS.field}>
          <label className={CSS.label}>{t('t27')}</label>
          <input
            type="number"
            className={CSS.input}
            value={c.maxTokens}
            disabled={!writable}
            onChange={(e) => update('maxTokens', Number(e.target.value))}
          />
        </div>

        <div className={CSS.field}>
          <label className={CSS.label}>{t('t28')}</label>
          <input
            type="number"
            className={CSS.input}
            value={c.timeoutMs}
            disabled={!writable}
            onChange={(e) => update('timeoutMs', Number(e.target.value))}
          />
          <p className={CSS.hint}>{t('t29')}</p>
        </div>

        <div className={CSS.field}>
          <label className={CSS.label}>{t('t30')}</label>
          <input
            type="number"
            className={CSS.input}
            value={c.humanTimeoutMs}
            disabled={!writable}
            onChange={(e) => update('humanTimeoutMs', Number(e.target.value))}
          />
          <p className={CSS.hint}>{t('t31')}</p>
        </div>

        <div className={CSS.field}>
          <label className={CSS.label}>{t('t32')}</label>
          <select
            className={CSS.select}
            value={c.filterMode}
            disabled={!writable}
            onChange={(e) => update('filterMode', e.target.value as 'deny-list' | 'allow-list')}
          >
            <option value="deny-list">{t('t33')}</option>
            <option value="allow-list">{t('t34')}</option>
          </select>
          <p className={CSS.hint}>
            {c.filterMode === 'deny-list'
              ? t('t14')
              : t('t15')}
          </p>
        </div>

        <div className={CSS.field}>
          <label className={CSS.label}>{t('t35')}</label>
          <input
            type="text"
            className={CSS.input}
            value={c.tools}
            disabled={!writable}
            onChange={(e) => update('tools', e.target.value)}
          />
          <p className={CSS.hint}>{t('t36')}</p>
        </div>

        <div className={CSS.field}>
          <label className={CSS.label}>{t('t37')}</label>
          <textarea
            className={CSS.textarea}
            rows={3}
            value={c.autoAllowPatterns}
            disabled={!writable}
            onChange={(e) => update('autoAllowPatterns', e.target.value)}
          />
          <p className={CSS.hint}>{t('t38')}</p>
        </div>

        <div className={CSS.field}>
          <label className={CSS.label}>{t('t39')}</label>
          {statsState.loading ? (
            <p className={CSS.hint}>{t('t40')}</p>
          ) : Object.keys(statsState.sessions).length === 0 ? (
            <p className={CSS.hint}>{t('t41')}</p>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '180px', overflowY: 'auto' }}>
                {Object.entries(statsState.sessions).map(([sessionId, stat]) => (
                  <label key={sessionId} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--dsw-alias-label-primary)' }}>
                    <input
                      type="checkbox"
                      checked={!!statsState.selected[sessionId]}
                      onChange={() => toggleSelect(sessionId)}
                    />
                    <span style={{ fontFamily: 'monospace' }}>{sessionId.slice(0, 8)}…</span>
                    <span style={{ flex: 1, color: 'var(--dsw-alias-label-secondary)' }}>{t('t50')} {stat.total}</span>
                    <button
                      type="button"
                      className={CSS.discard}
                      onClick={() => void clearStats([sessionId])}
                    >{t('t42')}</button>
                  </label>
                ))}
              </div>
              <div className={CSS.footerRight} style={{ marginTop: '6px' }}>
                <button
                  type="button"
                  className={CSS.discard}
                  disabled={!Object.values(statsState.selected).some(Boolean)}
                  onClick={() => void clearStats(Object.keys(statsState.selected).filter(id => statsState.selected[id]))}
                >{t('t43')}</button>
                <button
                  type="button"
                  className={CSS.discard}
                  onClick={() => void clearStats(undefined)}
                >{t('t44')}</button>
              </div>
            </>
          )}
        </div>

        <div className={CSS.footer}>
          {failed ? <span className={CSS.failed}>{t('t45')}</span> : null}
          <div className={CSS.footerRight}>
            <button
              type="button"
              className={CSS.discard}
              disabled={!dirty || saving || !writable}
              onClick={discard}
            >{t('t46')}</button>
            <button
              type="button"
              className={CSS.save}
              disabled={!dirty || saving || !writable}
              onClick={() => void save()}
            >
              {saving ? t('t16') : t('t17')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
