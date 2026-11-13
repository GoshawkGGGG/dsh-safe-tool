/**
 * AI Approval header button: a session-header action showing this session's
 * cumulative approval stats. Stats are served by the plugin's own bridge and
 * delivered here as a bound `useApprovalStats` hook. The header shows one
 * borderless stats chip; the enable switch and the four counts live inside
 * the popover. The switch writes through the shared `configForms` service
 * (the 0.1.x describe/mutate bridge for config is gone in 0.2.x). All colors
 * use the `--dsw-*` design tokens so light/dark follows the active skin.
 *
 * dsh 0.2.2-rc.1 adaptation: the session header's title cluster clips and
 * fades overflow (`overflow: clip` plus `container-type: inline-size`, whose
 * layout containment also makes it the containing block for `position: fixed`
 * descendants), and the `conversation.session.header.actions` slot contract
 * now states that overlays MUST portal. The popover therefore portals to
 * `document.body` and positions itself from the trigger's rect, clamped to
 * the viewport — the same anchored-placement pattern the shipped header
 * actions use. Escape closes it, matching the host's modal behavior.
 * @module dsh-safe-tool/client/HeaderButton
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from './store.ts'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

/** One session's cumulative approval tally, as the Host stores it. */
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

/** Registration-side injected face: the live stats store plus the config form. */
export interface HeaderButtonInjected {
  /** Translate this bundle's locale keys (bound by the Client locale service). */
  t: (key: string) => string
  hooks: {
    /** Live per-session stats, bound by the renderer as `useApprovalStats`. */
    approvalStats: SnapshotStore<ApprovalHeaderState>
  }
  /** The row's config form; the enable switch writes `enabled` through it. */
  form: ConfigForm<Record<string, unknown>>
}

/** Full component props assembled by the session-header slot renderer. */
export type ApprovalHeaderButtonProps =
  PropsRuntime<'conversation.session.header.actions'>
  & InjectFace<HeaderButtonInjected>

/** Minimum gap kept between the popover and the viewport edges. */
const VIEWPORT_MARGIN = 12
/** Distance between the trigger's bottom edge and the popover. */
const MENU_GAP = 5

/** One placed popover position, in viewport coordinates. */
interface AnchoredPosition {
  left: number
  top: number
}

/**
 * Position the popover below the trigger, right-aligned with it, clamped to
 * the viewport. Measures the laid-out panel (rendered hidden until the first
 * placement), then re-places on scroll and resize while open. Plugin-owned:
 * the harness Client primitives are not requirable from a third-party bundle.
 */
function useAnchoredPosition(
  open: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
  panelRef: RefObject<HTMLDivElement | null>,
): AnchoredPosition | null {
  const [position, setPosition] = useState<AnchoredPosition | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const root = rootRef.current
    const panel = panelRef.current
    if (root === null || panel === null) return
    const place = (): void => {
      const rect = root.getBoundingClientRect()
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      const viewportWidth = document.documentElement.clientWidth
      const viewportHeight = document.documentElement.clientHeight
      const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.right - width, viewportWidth - VIEWPORT_MARGIN - width))
      const top = Math.max(VIEWPORT_MARGIN, Math.min(rect.bottom + MENU_GAP, viewportHeight - VIEWPORT_MARGIN - height))
      setPosition(previous => previous !== null && previous.left === left && previous.top === top ? previous : { left, top })
    }
    place()
    const reposition = (): void => { place() }
    document.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, rootRef, panelRef])
  return position
}

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
 * @param props - framework kit (sessionId, useApprovalStats) and the config form.
 * @returns the header button; the open popover portals to `document.body`.
 */
export function ApprovalHeaderButton({
  t, sessionId, useApprovalStats, form,
}: ApprovalHeaderButtonProps): ReactNode {
  const headerState = useApprovalStats(s => s)
  const [open, setOpen] = useState(false)
  const [pendingToggle, setPendingToggle] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const position = useAnchoredPosition(open, rootRef, panelRef)

  // Subscribe to the shared config form so the switch reflects Host state.
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const snapshot = useSyncExternalStore(subscribe, () => form.getSnapshot(), () => form.getSnapshot())
  const enabled = snapshot.status === 'ready' && snapshot.value !== undefined
    ? (snapshot.value as { enabled?: boolean }).enabled !== false
    : true

  const toggleEnabled = useCallback(async () => {
    if (pendingToggle) return
    setPendingToggle(true)
    try {
      await form.set('enabled', !enabled)
    } catch {
      // Toggle failed — leave the switch where it was.
    } finally {
      setPendingToggle(false)
    }
  }, [pendingToggle, enabled, form])

  // Escape closes the popover — the dismissal users know from host menus.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  if (sessionId === undefined) return null

  const stats = headerState.sessions[String(sessionId)]
  const total = stats?.total ?? 0
  const approved = stats?.approved ?? 0
  const denied = stats?.denied ?? 0
  const errorDenied = stats?.errorDenied ?? 0
  const rejectedTotal = denied + errorDenied

  // Portal target: undefined only in a non-DOM render (SSR/tests); the popover
  // is closed there anyway, so the branch below never engages.
  const portalTarget = typeof document === 'undefined' ? null : document.body

  const popover = open && portalTarget !== null
    ? createPortal(
      <>
        {/* Click-away backdrop: covers the viewport, closes on any press. */}
        <div
          style={{ position: 'fixed', inset: '0', zIndex: 999 }}
          onClick={() => setOpen(false)}
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t('t47')}
          style={{
            position: 'fixed',
            left: `${position?.left ?? 0}px`,
            top: `${position?.top ?? 0}px`,
            visibility: position === null ? 'hidden' : 'visible',
            minWidth: '240px',
            background: 'var(--dsw-alias-bg-layer-3)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: '8px',
            boxShadow: 'var(--dsw-elevation-panel)',
            zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          {/* Enable switch — same tier as the stats, inside the popover. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
            <span style={{ flex: 1, fontSize: '12px', fontWeight: '600', color: 'var(--dsw-alias-label-primary)' }}>{t('t54')}</span>
            <button
              type="button"
              onClick={() => void toggleEnabled()}
              disabled={pendingToggle || snapshot.status !== 'ready' || !snapshot.writable}
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
              aria-label={enabled ? t('t48') : t('t49')}
              aria-pressed={enabled}
            >
              {enabled ? t('t6') : t('t7')}
            </button>
          </div>

          {/* Four counts — same tier, borderless rows. */}
          <div style={{ padding: '6px 0' }}>
            <Row glyph="📊" glyphColor="var(--dsw-alias-label-primary)" label={t('t50')} value={total} valueColor="var(--dsw-alias-label-primary)" />
            <Row glyph="✓" glyphColor="var(--dsw-alias-state-success-primary)" label={t('t51')} value={approved} valueColor="var(--dsw-alias-state-success-primary)" />
            <Row glyph="✗" glyphColor="var(--dsw-alias-state-error-primary)" label={t('t52')} value={denied} valueColor="var(--dsw-alias-state-error-primary)" />
            <Row glyph="⚠" glyphColor="var(--dsw-alias-state-warn-primary)" label={t('t53')} value={errorDenied} valueColor="var(--dsw-alias-state-warn-primary)" />
          </div>
        </div>
      </>,
      portalTarget,
    )
    : null

  return (
    <div ref={rootRef} style={{ display: 'inline-flex', alignItems: 'center', position: 'relative' }}>
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
        aria-label={t('t47')}
        aria-expanded={open}
      >
        <span style={{ color: 'var(--dsw-alias-state-success-primary)', fontWeight: '600', fontVariantNumeric: 'tabular-nums' }}>{fmt(approved)}</span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>+</span>
        <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontWeight: '600', fontVariantNumeric: 'tabular-nums' }}>{fmt(rejectedTotal)}</span>
      </button>
      {popover}
    </div>
  )
}
