/** Web UI settings card component for the AI approval plugin. */

import { useState, useCallback, useEffect } from 'react'

const NS = 'dsh-safe-tool'
const BRIDGE_PREFIX = '/api/dsh-safe-tool-settings'

const CSS = {
  card: 'dshst-card',
  cardOpen: 'dshst-cardOpen',
  header: 'dshst-header',
  headText: 'dshst-headText',
  name: 'dshst-name',
  description: 'dshst-description',
  pending: 'dshst-pending',
  chevron: 'dshst-chevron',
  chevronOpen: 'dshst-chevronOpen',
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
}

/** Client-side view of the plugin config (arrays flattened to editable strings). */
interface ApprovalConfig {
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
  return value ?? fallback
}

export function ApprovalCard() {
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error'
    config: ApprovalConfig | null
    dirty: boolean
    saving: boolean
    failed: boolean
  }>({
    status: 'loading',
    config: null,
    dirty: false,
    saving: false,
    failed: false,
  })
  const [open, setOpen] = useState(false)

  // Stats storage management state: the per-session tallies kept in the stats
  // settings namespace, plus which rows the user has selected for clearing.
  const [statsState, setStatsState] = useState<{
    sessions: Record<string, { total: number; approved: number; denied: number; errorDenied: number }>
    loading: boolean
    selected: Record<string, boolean>
  }>({
    sessions: {},
    loading: true,
    selected: {},
  })

  // Available agent presets for the review subagent's dedicated parent.
  const [presets, setPresets] = useState<Array<{ id: string; name: string; description: string }>>([])

  const loadPresets = useCallback(async () => {
    try {
      const response = await fetch(`${BRIDGE_PREFIX}/list-presets`, {
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
      const response = await fetch(`${BRIDGE_PREFIX}/stats-list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const result = await response.json()
      if (result.ok) {
        setStatsState(s => ({ ...s, sessions: result.sessions ?? {}, loading: false }))
      } else {
        setStatsState(s => ({ ...s, loading: false }))
      }
    } catch {
      setStatsState(s => ({ ...s, loading: false }))
    }
  }, [])

  const clearStats = useCallback(async (sessionIds?: string[]) => {
    try {
      await fetch(`${BRIDGE_PREFIX}/stats-clear`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sessionIds === undefined ? {} : { sessionIds }),
      })
      // Refresh after clearing.
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

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${BRIDGE_PREFIX}/describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const result = await response.json()
      if (result.ok && result.value) {
        const v = result.value.value ?? result.value
        setState({
          status: 'ready',
          config: {
            enabled: v.enabled ?? true,
            provider: v.provider ?? '',
            model: v.model ?? '',
            maxTokens: v.maxTokens ?? 2048,
            timeoutMs: v.timeoutMs ?? 30000,
            humanTimeoutMs: v.humanTimeoutMs ?? 30000,
            filterMode: v.filterMode ?? 'deny-list',
            tools: joinArray(v.tools, 'bash, write'),
            autoAllowPatterns: joinArray(v.autoAllowPatterns, ''),
            deleteReviewerSessions: v.deleteReviewerSessions ?? true,
            reviewerPreset: v.reviewerPreset ?? 'minimal',
          },
          dirty: false,
          saving: false,
          failed: false,
        })
      } else {
        setState(s => ({ ...s, status: 'error' }))
      }
    } catch {
      setState(s => ({ ...s, status: 'error' }))
    }
  }, [])

  useEffect(() => {
    load()
    loadStats()
    loadPresets()
  }, [load, loadStats, loadPresets])

  const update = useCallback((key: keyof ApprovalConfig, value: unknown) => {
    setState(s => ({
      ...s,
      config: s.config ? { ...s.config, [key]: value } : null,
      dirty: true,
      failed: false,
    }))
  }, [])

  const save = useCallback(async () => {
    if (!state.config || !state.dirty) return
    const c = state.config
    setState(s => ({ ...s, saving: true, failed: false }))
    try {
      const response = await fetch(`${BRIDGE_PREFIX}/mutate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ns: NS,
          ops: [
            { op: 'set', path: ['enabled'], value: c.enabled },
            { op: 'set', path: ['provider'], value: c.provider === '' ? null : c.provider },
            { op: 'set', path: ['model'], value: c.model === '' ? null : c.model },
            { op: 'set', path: ['maxTokens'], value: c.maxTokens },
            { op: 'set', path: ['timeoutMs'], value: c.timeoutMs },
            { op: 'set', path: ['humanTimeoutMs'], value: c.humanTimeoutMs },
            { op: 'set', path: ['filterMode'], value: c.filterMode },
            { op: 'set', path: ['tools'], value: c.tools.split(',').map(s => s.trim()).filter(s => s.length > 0) },
            { op: 'set', path: ['autoAllowPatterns'], value: c.autoAllowPatterns.split('\n').map(s => s.trim()).filter(s => s.length > 0) },
            { op: 'set', path: ['deleteReviewerSessions'], value: c.deleteReviewerSessions },
            { op: 'set', path: ['reviewerPreset'], value: c.reviewerPreset === '' ? null : c.reviewerPreset },
          ],
        }),
      })
      const result = await response.json()
      if (result.ok) {
        setState(s => ({ ...s, dirty: false, saving: false }))
      } else {
        setState(s => ({ ...s, saving: false, failed: true }))
      }
    } catch {
      setState(s => ({ ...s, saving: false, failed: true }))
    }
  }, [state.config, state.dirty])

  const discard = useCallback(() => {
    load()
  }, [load])

  if (state.status === 'loading') {
    return (
      <li className={CSS.card}>
        <div className={CSS.header}>
          <span className={CSS.headText}>
            <span className={CSS.name}>AI 工具执行审批</span>
            <span className={CSS.description}>加载设置中...</span>
          </span>
        </div>
      </li>
    )
  }

  if (state.status === 'error' || !state.config) {
    return (
      <li className={CSS.card}>
        <div className={CSS.header}>
          <span className={CSS.headText}>
            <span className={CSS.name}>AI 工具执行审批</span>
            <span className={CSS.description}>设置不可用</span>
          </span>
        </div>
      </li>
    )
  }

  const c = state.config

  return (
    <li className={`${CSS.card} ${open ? CSS.cardOpen : ''}`}>
      <button
        type="button"
        className={CSS.header}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={CSS.headText}>
          <span className={CSS.name}>AI 工具执行审批</span>
          <span className={CSS.description}>拦截工具调用，由 AI 子代理审查是否安全可执行</span>
        </span>
        {state.dirty ? <span className={CSS.pending}>未保存</span> : null}
        <svg className={`${CSS.chevron} ${open ? CSS.chevronOpen : ''}`} width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M4.5 6l3.5 4 3.5-4H4.5z"/>
        </svg>
      </button>
      {open ? (
        <div className={CSS.body}>
          <div className={CSS.field}>
            <label className={CSS.label}>启用审批插件</label>
            <div>
              <button
                type="button"
                className={`${CSS.btn} ${c.enabled ? CSS.save : CSS.discard}`}
                onClick={() => update('enabled', !c.enabled)}
              >
                {c.enabled ? '已启用' : '已禁用'}
              </button>
            </div>
            <p className={CSS.hint}>关闭后所有工具调用直接生效，不再审批（实时生效，无需重启）</p>
          </div>

          <div className={CSS.field}>
            <label className={CSS.label}>删除审批子代理会话记录</label>
            <div>
              <button
                type="button"
                className={`${CSS.btn} ${c.deleteReviewerSessions ? CSS.save : CSS.discard}`}
                onClick={() => update('deleteReviewerSessions', !c.deleteReviewerSessions)}
              >
                {c.deleteReviewerSessions ? '开启' : '关闭'}
              </button>
            </div>
            <p className={CSS.hint}>
              {c.deleteReviewerSessions
                ? '每次审批结束后，从磁盘删除审批子代理的会话记录，不留审批痕迹'
                : '保留审批子代理的会话记录，便于事后回溯审批过程'}
            </p>
          </div>

          <div className={CSS.field}>
            <label className={CSS.label}>审批预设（reviewer preset）</label>
            <select
              className={CSS.select}
              value={c.reviewerPreset}
              onChange={(e) => update('reviewerPreset', e.target.value)}
            >
              {!presets.some(p => p.id === c.reviewerPreset) ? (
                <option value={c.reviewerPreset}>{c.reviewerPreset}</option>
              ) : null}
              {presets.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className={CSS.hint}>
              审批子代理继承专属 agent 挂载的预设（默认 minimal 极简模式），与主代理预设无关；更改需重启生效
            </p>
          </div>

          <div className={CSS.field}>
            <label className={CSS.label}>审核模型提供者（provider）</label>
            <input
              type="text"
              className={CSS.input}
              placeholder="留空 = 继承主代理的 provider"
              value={c.provider}
              onChange={(e) => update('provider', e.target.value)}
            />
            <p className={CSS.hint}>留空则继承主代理的 provider</p>
          </div>

          <div className={CSS.field}>
            <label className={CSS.label}>审核模型（model）</label>
            <input
              type="text"
              className={CSS.input}
              placeholder="留空 = 继承主代理的 model"
              value={c.model}
              onChange={(e) => update('model', e.target.value)}
            />
            <p className={CSS.hint}>留空则继承主代理的 model</p>
          </div>

          <div className={CSS.field}>
            <label className={CSS.label}>最大输出 token（maxTokens）</label>
            <input
              type="number"
              className={CSS.input}
              value={c.maxTokens}
              onChange={(e) => update('maxTokens', Number(e.target.value))}
            />
          </div>

          <div className={CSS.field}>
            <label className={CSS.label}>审核超时（毫秒）</label>
            <input
              type="number"
              className={CSS.input}
              value={c.timeoutMs}
              onChange={(e) => update('timeoutMs', Number(e.target.value))}
            />
            <p className={CSS.hint}>子代理审核的最大等待时间</p>
          </div>

          <div className={CSS.field}>
            <label className={CSS.label}>人工审批超时（毫秒）</label>
            <input
              type="number"
              className={CSS.input}
              value={c.humanTimeoutMs}
              onChange={(e) => update('humanTimeoutMs', Number(e.target.value))}
            />
            <p className={CSS.hint}>AI 无法判断时回退人工审批的等待时间</p>
          </div>

          <div className={CSS.field}>
            <label className={CSS.label}>拦截模式</label>
            <select
              className={CSS.select}
              value={c.filterMode}
              onChange={(e) => update('filterMode', e.target.value as 'deny-list' | 'allow-list')}
            >
              <option value="deny-list">deny-list（黑名单：拦截列表中的工具）</option>
              <option value="allow-list">allow-list（白名单：仅放行列表中的工具）</option>
            </select>
            <p className={CSS.hint}>
              {c.filterMode === 'deny-list'
                ? 'deny-list：列表中列出的工具会被拦截审批，其余直接放行'
                : 'allow-list：仅列表中列出的工具会被拦截审批，其余直接放行'}
            </p>
          </div>

          <div className={CSS.field}>
            <label className={CSS.label}>工具列表</label>
            <input
              type="text"
              className={CSS.input}
              value={c.tools}
              onChange={(e) => update('tools', e.target.value)}
            />
            <p className={CSS.hint}>逗号分隔的工具名称，如 bash, write</p>
          </div>

          <div className={CSS.field}>
            <label className={CSS.label}>自动放行正则（每行一个）</label>
            <textarea
              className={CSS.textarea}
              rows={3}
              value={c.autoAllowPatterns}
              onChange={(e) => update('autoAllowPatterns', e.target.value)}
            />
            <p className={CSS.hint}>匹配工具参数 JSON 的正则，命中则跳过审批直接放行</p>
          </div>

          <div className={CSS.field}>
            <label className={CSS.label}>审批统计存储</label>
            {statsState.loading ? (
              <p className={CSS.hint}>加载中...</p>
            ) : Object.keys(statsState.sessions).length === 0 ? (
              <p className={CSS.hint}>暂无统计记录</p>
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
                      <span style={{ flex: 1, color: 'var(--dsw-alias-label-secondary)' }}>总计 {stat.total}</span>
                      <button
                        type="button"
                        className={CSS.discard}
                        onClick={() => void clearStats([sessionId])}
                      >
                        清理
                      </button>
                    </label>
                  ))}
                </div>
                <div className={CSS.footerRight} style={{ marginTop: '6px' }}>
                  <button
                    type="button"
                    className={CSS.discard}
                    disabled={!Object.values(statsState.selected).some(Boolean)}
                    onClick={() => void clearStats(Object.keys(statsState.selected).filter(id => statsState.selected[id]))}
                  >
                    清理选中
                  </button>
                  <button
                    type="button"
                    className={CSS.discard}
                    onClick={() => void clearStats(undefined)}
                  >
                    一键清理全部
                  </button>
                </div>
              </>
            )}
          </div>

          <div className={CSS.footer}>
            {state.failed ? <span className={CSS.failed}>保存失败，请重试</span> : null}
            <div className={CSS.footerRight}>
              <button
                type="button"
                className={CSS.discard}
                disabled={!state.dirty || state.saving}
                onClick={discard}
              >
                放弃
              </button>
              <button
                type="button"
                className={CSS.save}
                disabled={!state.dirty || state.saving}
                onClick={save}
              >
                {state.saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  )
}