/**
 * Browser half of `dsh-safe-tool`: registers the settings card
 * (`settings.plugin.item`, free-search pattern) and the session-header
 * approval button (`conversation.session.header.actions`). Approval stats live
 * in the host settings namespace and refresh live through the
 * `settings/document-updated` WSS event — no session-log events, no polling.
 * @module dsh-safe-tool/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  ApprovalHeaderButton,
  type ApprovalHeaderState,
  type ApprovalStats,
  type HeaderButtonInjected,
} from './HeaderButton.tsx'
import { ApprovalCard } from './ApprovalCard.tsx'

export const inject = ['slots', 'remote'] as const

const NS = 'dsh-safe-tool'
const STATS_NS = 'dsh-safe-tool-stats'
const BRIDGE_PREFIX = '/api/dsh-safe-tool-settings'

/** Read the current enable flag through the settings bridge. */
async function getEnabled(): Promise<boolean> {
  const response = await fetch(`${BRIDGE_PREFIX}/describe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const result = await response.json()
  if (!result.ok) throw new Error(result.message ?? 'describe failed')
  return result.value?.value?.enabled ?? true
}

/** Persist the enable/disable switch through the settings bridge and return the settled value. */
async function setEnabled(enabled: boolean): Promise<boolean> {
  const response = await fetch(`${BRIDGE_PREFIX}/mutate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ns: NS,
      ops: [{ op: 'set', path: ['enabled'], value: enabled }],
    }),
  })
  const result = await response.json()
  if (!result.ok) throw new Error(result.message ?? 'mutate failed')
  return enabled
}

/** Fetch the per-session stats from the host settings and return them ({} when unavailable). */
async function fetchStats(): Promise<Record<string, ApprovalStats>> {
  const response = await fetch(`${BRIDGE_PREFIX}/describe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ns: STATS_NS }),
  })
  const result = await response.json()
  if (!result.ok) return {}
  return result.value?.value?.sessions ?? {}
}

/** Inject CSS into the document head. */
function injectCss(css: string): void {
  if (typeof document === 'undefined') return
  const tagId = 'dsh-safe-tool/card.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-safe-tool'
  tag.dataset.pluginCss = tagId
  tag.textContent = css
  document.head.appendChild(tag)
}

// CSS 内联
const css = [
  '.dshst-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;min-width:0;list-style:none;transition:border-color .16s,background .16s;overflow:hidden;margin-bottom:8px}',
  '.dshst-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
  '.dshst-header{width:100%;color:inherit;cursor:pointer;text-align:left;font:inherit;background:0 0;border:0;align-items:center;gap:8px;padding:10px 14px;display:flex}',
  '.dshst-header:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dshst-headText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex;overflow:hidden}',
  '.dshst-name{color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;font-weight:600;overflow:hidden}',
  '.dshst-description{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;font-size:12px;overflow:hidden}',
  '.dshst-pending{color:var(--dsw-alias-state-warn-primary);white-space:nowrap;flex:none;font-size:12px}',
  '.dshst-chevron{color:var(--dsw-alias-label-tertiary);flex:none;font-size:13px;transition:transform .12s}',
  '.dshst-chevronOpen{transform:rotate(180deg)}',
  '.dshst-body{flex-direction:column;gap:14px;padding:0 14px 14px;display:flex}',
  '.dshst-footer{justify-content:space-between;align-items:center;gap:8px;display:flex;flex-wrap:wrap}',
  '.dshst-footerRight{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.dshst-failed{color:var(--dsw-alias-state-error-primary);font-size:12px}',
  '.dshst-field{flex-direction:column;gap:4px;min-width:0;display:flex}',
  '.dshst-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}',
  '.dshst-select{border:1px solid var(--dsw-alias-border-l2);font:inherit;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border-radius:6px;padding:6px 8px;font-size:13px;transition:border-color .13s,box-shadow .13s;width:100%}',
  '.dshst-input{border:1px solid var(--dsw-alias-border-l2);font:inherit;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border-radius:6px;padding:6px 8px;font-size:13px;transition:border-color .13s,box-shadow .13s;width:100%}',
  '.dshst-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
  '.dshst-input:disabled{opacity:.6;cursor:default}',
  '.dshst-hint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px}',
  '.dshst-btn{font:inherit;cursor:pointer;border-radius:6px;padding:5px 12px;font-size:13px;transition:background-color .13s,border-color .13s,color .13s}',
  '.dshst-save{border:1px solid var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}',
  '.dshst-save:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}',
  '.dshst-save:disabled{opacity:.5;cursor:default}',
  '.dshst-discard{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}',
  '.dshst-discard:hover:not(:disabled){background:var(--dsw-alias-bg-hover)}',
  '.dshst-discard:disabled{opacity:.5;cursor:default}',
].join('')

export function apply(ctx: ClientContext): void {
  injectCss(css)

  // Live stats store: seeded once, then refreshed on every
  // `settings/document-updated` WSS event for the stats namespace (no polling).
  const statsStore = createSnapshotStore<ApprovalHeaderState>({ loading: true, sessions: {} })
  const refreshStats = (): void => {
    void fetchStats().then(sessions => {
      statsStore.set({ loading: false, sessions })
    }).catch(() => {
      statsStore.set(s => ({ ...s, loading: false }))
    })
  }
  ctx.effect(
    () => ctx.remote.$on('settings/document-updated', (ns: string) => {
      if (ns === STATS_NS) refreshStats()
    }),
    'dsh-safe-tool: stats subscription',
  )
  refreshStats()

  // Settings card (free-search pattern: keyed by namespace, plain useState + fetch).
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: 'dsh-safe-tool',
        id: 'dsh-safe-tool',
        order: 120,
        inject: () => ({}),
      },
      ApprovalCard,
    ),
  )

  // Session-header approval button: live stats via the inject `hooks`
  // compartment, enable/disable write via the inject callbacks.
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'dsh-safe-tool-header-btn',
        order: 50,
        inject: (_sessionId: SessionId): HeaderButtonInjected => ({
          hooks: { approvalStats: statsStore },
          getEnabled,
          setEnabled,
        }),
      },
      ApprovalHeaderButton,
    ),
  )
}