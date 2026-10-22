/**
 * Browser half of `dsh-safe-tool` for dsh 0.2.x.
 *
 * - The settings card registers into the Plugins page's `plugins.row.config`
 *   slot, keyed by `<package>#<row id>` (`dsh-safe-tool#dsh-safe-tool`). The
 *   page owner supplies a live `ConfigPageForm` face over the Host entry's
 *   configuration; the 0.1.x custom describe/mutate HTTP bridge for config is
 *   gone (`settings.plugin.item` and custom settings namespaces no longer
 *   exist).
 * - The session-header approval button keeps its slot
 *   (`conversation.session.header.actions`); its enable switch writes through
 *   the shared `configForms` service.
 * - Per-session approval tallies live in this plugin's own settings document
 *   (its Loader entry) and are served through the plugin's own HTTP bridge.
 *   Refresh is push-triggered by `settings/document-updated` for that entry —
 *   the same event the 0.1.x stats namespace raised — so one tally write costs
 *   exactly one read. No polling, no session-log events.
 * @module dsh-safe-tool/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from './store.ts'
import { LOCALE_NAMESPACE, UI_DICTIONARIES } from './locale.ts'
// Type-only augmentation imports (erased from the bundle): `ctx.slots`,
// the session-scope `sessionId` standard prop, and the SlotMap entries for
// the slots this plugin contributes into.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  ApprovalHeaderButton,
  type ApprovalHeaderState,
  type ApprovalStats,
  type HeaderButtonInjected,
} from './HeaderButton.tsx'
import { ApprovalCard } from './ApprovalCard.tsx'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'

export const inject = ['slots', 'configForms', 'remote', 'locale'] as const

/** The Loader entry id this bundle's patch declares — also the settings namespace. */
const ENTRY_ID = 'dsh-safe-tool'
/** Keyed slot key: `<package name>#<row id>`. */
const ROW_CONFIG_KEY = `${ENTRY_ID}#${ENTRY_ID}`
const BRIDGE_PREFIX = '/api/dsh-safe-tool-settings'


/** Fetch the per-session stats from the plugin bridge ({} when unavailable). */
async function fetchStats(): Promise<Record<string, ApprovalStats>> {
  const response = await fetch(`${BRIDGE_PREFIX}/stats-list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const result = await response.json()
  if (!result.ok) return {}
  return result.sessions ?? {}
}

// CSS inlined at build time (the 0.1.x lib/style.css companion file).
const css = [
  '.dshst-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;min-width:0;transition:border-color .16s,background .16s;overflow:hidden}',
  '.dshst-body{flex-direction:column;gap:14px;padding:14px 0 0;display:flex}',
  '.dshst-footer{justify-content:space-between;align-items:center;gap:8px;display:flex;flex-wrap:wrap}',
  '.dshst-footerRight{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.dshst-failed{color:var(--dsw-alias-state-error-primary);font-size:12px}',
  '.dshst-field{flex-direction:column;gap:4px;min-width:0;display:flex}',
  '.dshst-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}',
  '.dshst-select{border:1px solid var(--dsw-alias-border-l2);font:inherit;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border-radius:6px;padding:6px 8px;font-size:13px;transition:border-color .13s,box-shadow .13s;width:100%}',
  '.dshst-input{border:1px solid var(--dsw-alias-border-l2);font:inherit;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border-radius:6px;padding:6px 8px;font-size:13px;transition:border-color .13s,box-shadow .13s;width:100%}',
  '.dshst-input:disabled,.dshst-select:disabled{opacity:.6;cursor:default}',
  '.dshst-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
  '.dshst-hint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px}',
  '.dshst-btn{font:inherit;cursor:pointer;border-radius:6px;padding:5px 12px;font-size:13px;transition:background-color .13s,border-color .13s,color .13s}',
  '.dshst-save{border:1px solid var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}',
  '.dshst-save:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}',
  '.dshst-save:disabled{opacity:.5;cursor:default}',
  '.dshst-discard{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}',
  '.dshst-discard:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dshst-discard:disabled{opacity:.5;cursor:default}',
  '.dshst-pending{color:var(--dsw-alias-state-warn-primary);white-space:nowrap;flex:none;font-size:12px;margin-left:6px}',
  '.dshst-summary{color:var(--dsw-alias-label-tertiary);font-size:13px}',
].join('')

function injectCss(cssText: string): void {
  if (typeof document === 'undefined') return
  const tagId = 'dsh-safe-tool/card.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-safe-tool'
  tag.dataset.pluginCss = tagId
  tag.textContent = cssText
  document.head.appendChild(tag)
}

export function apply(ctx: ClientContext): void {
  injectCss(css)

  // Shared config face for this bundle's row: reads derive from the shared
  // describe mirror; writes go through the form controller, which resolves the
  // current revision itself (the tallies write into the same document, so a
  // revision captured at render time can already be stale).
  const form = ctx.configForms.get<Record<string, unknown>>(ENTRY_ID)

  // Live stats store: seeded once, then refreshed by the platform's forwarded
  // `settings/document-updated` for this plugin's own entry — the 0.1.x
  // trigger, with the entry id where the stats namespace used to be. A tally
  // write therefore costs exactly one read, immediately, and nothing at all
  // while idle.
  const statsStore = createSnapshotStore<ApprovalHeaderState>({ loading: true, sessions: {} })
  const refreshStats = (): void => {
    void fetchStats().then(sessions => {
      statsStore.set({ loading: false, sessions })
    }).catch(() => {
      statsStore.update(draft => { draft.loading = false })
    })
  }

  // Subscription first, then the seed read — the 0.1.x order, so a write that
  // lands during startup cannot slip between the two.
  ctx.effect(
    () => {
      try {
        return ctx.remote.$on('settings/document-updated', (ns: unknown) => {
          if (String(ns) === ENTRY_ID) refreshStats()
        })
      } catch (error) {
        // A carrier without interactive approval makes `$on` throw. That must
        // not abort the rest of this half (the card and the header button).
        ctx.logger('dsh-safe-tool').warn('forwarded stats events are unavailable; tallies stay at their last read: %C', error)
        return () => {}
      }
    },
    'dsh-safe-tool: stats live refresh',
  )
  refreshStats()

  // Shared "unsaved" flag: the page renders the row summary and the editor as
  // two separate mounts of this card, so the indicator 0.1.x showed in its own
  // header only works if both read one store.
  const unsavedStore = createSnapshotStore<boolean>(false)

  // Injected faces are built ONCE. Their identity must never change between
  // renders: an inline object literal here becomes a new dependency on every
  // render, which re-runs any effect that depends on it — with a fetch inside
  // that effect, that is an unbounded request storm against the Host.
  // Visible copy flows through the Client locale service (never literals): the
  // dictionaries are registered for this bundle's namespace and every render
  // reads them through the bound translate function.
  for (const [locale, dictionary] of Object.entries(UI_DICTIONARIES)) {
    ctx.locale.register(LOCALE_NAMESPACE, locale, dictionary)
  }
  const t = ctx.locale.bind(LOCALE_NAMESPACE)

  const statsFace = { t, fetchStats, unsaved: unsavedStore }

  // Settings card. `plugins.row.config` is keyed by `<package>#<row id>`; the
  // page owner passes the live form face (`view: 'summary' | 'page'`).
  ctx.slots.inject('plugins.row.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.row.config',
        key: ROW_CONFIG_KEY,
      },
      (props: PluginConfigViewProps) =>
        ApprovalCard({ t, view: props.view, form: props.form, stats: statsFace }),
    ),
  )

  // Session-header approval button: live stats via the inject `hooks`
  // compartment, the enable switch writes through the shared config form.
  // Built once for the same identity-stability reason as `statsFace`.
  const headerFace: HeaderButtonInjected = {
    t,
    hooks: { approvalStats: statsStore },
    form,
  }
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'dsh-safe-tool-header-btn',
        order: 50,
        inject: (_sessionId: SessionId): HeaderButtonInjected => headerFace,
      },
      ApprovalHeaderButton,
    ),
  )
}
