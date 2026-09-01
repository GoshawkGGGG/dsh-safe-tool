/**
 * AI Approval header button: a session-header action showing this session's
 * cumulative approval stats. Stats live in the host settings namespace and
 * refresh through the `settings/document-updated` WSS event, delivered here as
 * a bound `useApprovalStats` hook. The header shows one borderless stats chip;
 * the enable switch, the four counts, and the settings jump all live inside
 * the popover. All colors use the `--dsw-*` design tokens so light/dark
 * follows the active skin.
 * @module dsh-safe-tool/client/HeaderButton
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

const NS = 'dsh-safe-tool'
const BRIDGE_PREFIX = '/api/dsh-safe-tool-settings'

/** One session's cumulative approval tally, as stored in the host settings. */
export interface ApprovalStats {
  total: number
  approved: number
  denied: number
  errorDenied: number
}

/** The shared live state for the header button: per-session stats. */
export interface ApprovalHeaderState {
  loading: boolean
  sessions: Record<string, ApprovalStats>
}

/** Registration-side injected face: the live stats store plus the enable face. */
export interface HeaderButtonInjected {
  hooks: {
    /** Live per-session stats, bound by the renderer as `useApprovalStats`. */
    approvalStats: SnapshotStore<ApprovalHeaderState>
  }
  /** Read the current enable flag. */
  getEnabled: () => Promise<boolean>
  /** Persist the enable/disable switch and return the settled value. */
  setEnabled: (enabled: boolean) => Promise<boolean>
}

/** Full component props assembled by the session-header slot renderer. */
export type ApprovalHeaderButtonProps =
  PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<HeaderButtonInjected>

/** Compact badge label for large counts. */
function fmt(n: number): string {
  return n > 999 ? `${(n / 1e3).toFixed(1)}k` : String(n)
}

/** One popover row: an emoji/state glyph, a label, and a value. */
function Row({ glyph, glyphColor, label, value, valueColor }: {
  glyph: string
  glyphColor: string
  label: string
  value: number
  valueColor: string
}): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', fontSize: '12px', color: 'var(--dsw-alias-label-primary)' }}>
      <span style={{ color: glyphColor }}>{glyph}</span>
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ fontWeight: '600', color: valueColor, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

/**
 * Render the header approval button with its stats popover.
 * @param props - framework kit (sessionId, useApprovalStats) and the enable face.
 * @returns the header button plus its dropdown.
 */
export function ApprovalHeaderButton({
  sessionId, useApprovalStats, getEnabled, setEnabled,
}: ApprovalHeaderButtonProps): ReactNode {
  const headerState = useApprovalStats(s => s)
  const [open, setOpen] = useState(false)
  const [enabled, setEnabledState] = useState(true)
  const [pendingToggle, setPendingToggle] = useState(false)

  useEffect(() => {
    let cancelled = false
    getEnabled().then(value => {
      if (!cancelled) setEnabledState(value)
    }).catch(() => {
      // Read failed — keep the default.
    })
    return () => { cancelled = true }
  }, [getEnabled])

  const toggleEnabled = useCallback(async () => {
    if (pendingToggle) return
    setPendingToggle(true)
    try {
      const next = await setEnabled(!enabled)
      setEnabledState(next)
    } catch {
      // Toggle failed — leave the switch where it was.
    } finally {
      setPendingToggle(false)
    }
  }, [pendingToggle, enabled, setEnabled])

  if (sessionId === undefined) return null

  const stats = headerState.sessions[String(sessionId)]
  const total = stats?.total ?? 0
  const approved = stats?.approved ?? 0
  const denied = stats?.denied ?? 0
  const errorDenied = stats?.errorDenied ?? 0
  const rejectedTotal = denied + errorDenied

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          height: '28px',
          padding: '0 10px',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '6px',
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          font: 'inherit',
          fontSize: '12px',
          fontWeight: '500',
          cursor: 'pointer',
          transition: 'background 0.15s ease, border-color 0.15s ease',
        }}
        aria-label="审批统计"
        aria-expanded={open}
      >
        <span style={{ color: 'var(--dsw-alias-state-success-primary)', fontWeight: '600', fontVariantNumeric: 'tabular-nums' }}>{fmt(approved)}</span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>+</span>
        <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontWeight: '600', fontVariantNumeric: 'tabular-nums' }}>{fmt(rejectedTotal)}</span>
      </button>

      {open && (
        <>
          <div
            style={{ position: 'fixed', inset: '0', zIndex: '999' }}
            onClick={() => setOpen(false)}
          />
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              right: '0',
              minWidth: '240px',
              background: 'var(--dsw-alias-bg-layer-3)',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '8px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.16)',
              zIndex: '1000',
              overflow: 'hidden',
            }}
          >
            {/* Enable switch — same tier as the stats, inside the popover. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
              <span style={{ flex: 1, fontSize: '12px', fontWeight: '600', color: 'var(--dsw-alias-label-primary)' }}>AI 审批</span>
              <button
                type="button"
                onClick={() => void toggleEnabled()}
                disabled={pendingToggle}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  height: '24px',
                  padding: '0 8px',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: '5px',
                  background: 'transparent',
                  color: enabled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)',
                  font: 'inherit',
                  fontSize: '12px',
                  cursor: 'pointer',
                  opacity: pendingToggle ? 0.6 : 1,
                  transition: 'background 0.15s ease, color 0.15s ease',
                }}
                aria-label={enabled ? '禁用 AI 审批' : '启用 AI 审批'}
                aria-pressed={enabled}
              >
                {enabled ? '已启用' : '已禁用'}
              </button>
            </div>

            {/* Four counts — same tier, borderless rows. */}
            <div style={{ padding: '6px 0' }}>
              <Row glyph="📊" glyphColor="var(--dsw-alias-label-primary)" label="总计" value={total} valueColor="var(--dsw-alias-label-primary)" />
              <Row glyph="✓" glyphColor="var(--dsw-alias-state-success-primary)" label="批准" value={approved} valueColor="var(--dsw-alias-state-success-primary)" />
              <Row glyph="✗" glyphColor="var(--dsw-alias-state-error-primary)" label="拒绝" value={denied} valueColor="var(--dsw-alias-state-error-primary)" />
              <Row glyph="⚠" glyphColor="var(--dsw-alias-state-warn-primary)" label="错误拒绝" value={errorDenied} valueColor="var(--dsw-alias-state-warn-primary)" />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// Reference the NS/BRIDGE_PREFIX so the injected enable face can be built in
// index.ts without duplicating the constants.
export { NS, BRIDGE_PREFIX }