/**
 * drive-pane: a right sidebar tab with stacked, read-only file browsers for
 * folders on the gateway host, independent of which chat is focused. The
 * sections come from the plugin's `roots` setting (Settings > Plugins >
 * drive-pane; default Google Drive and Uranium) and are split by draggable
 * dividers. Click a folder to open it; click a file to insert its path into
 * the focused chat's composer. Right-click for more: open the item on this
 * computer in its default app, reveal it in Explorer/Finder, copy paths.
 * Those two need the root's `local` mapping (where the same files appear on
 * this machine, e.g. an SMB share).
 *
 * Disk plugins load uncompiled: no JSX, only @hermes/plugin-sdk, react and
 * react/jsx-runtime resolve.
 */

import { host } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useRef, useState } from 'react'
import { renderAsync as renderDocx } from 'docx-preview'
import * as XLSX from 'xlsx'

const ID = 'drive-pane'

// Used until /roots answers, and if it never does (older backend).
const FALLBACK_ROOTS = [{ key: 'drive', label: 'Google Drive', local: {} }]
const MIN_SHARE = 0.08 // smallest fraction of the pane a section can be dragged to

const OS = (() => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || ''
  if (/Windows/i.test(ua)) return 'windows'
  if (/Mac/i.test(ua)) return 'macos'
  return 'linux'
})()
const REVEAL_LABEL = { windows: 'Show in Explorer', macos: 'Show in Finder', linux: 'Show in file manager' }[OS]
const NO_LOCAL = 'No local path for this folder on this computer. Add one under the root\'s "local" setting (Settings > Plugins > drive-pane).'

function fmtSize(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

function unwrap(res) {
  // ctx.rest may resolve the JSON body directly or a { ok, data } envelope.
  if (res && typeof res === 'object' && 'data' in res && 'ok' in res) {
    if (!res.ok) throw new Error(res.error || res.message || 'request failed')
    return res.data
  }
  return res
}

// Paths go into the composer quoted when needed: Drive and share names are
// full of spaces and apostrophes.
const quote = (p) => (/[\s'"`$\\]/.test(p) ? `"${p.replace(/(["\\$`])/g, '\\$1')}"` : p)

/** Where `rel` (a path inside the root, '' for the root) lives on this
 *  computer, from the root's {os: {prefix: localPath}} map; longest prefix
 *  wins. null when nothing maps it. */
function toLocal(local, rel) {
  const map = local && local[OS]
  if (!map) return null
  const segs = rel ? rel.split('/') : []
  let best = null
  let bestLen = -1
  for (const prefix of Object.keys(map)) {
    const p = prefix ? prefix.split('/') : []
    if (p.length > segs.length || p.length <= bestLen) continue
    if (p.every((s, i) => s === segs[i])) { best = prefix; bestLen = p.length }
  }
  if (best === null) return null
  const base = map[best]
  const rest = segs.slice(bestLen)
  if (!rest.length) return base
  const sep = /^(\\\\|[A-Za-z]:)/.test(base) ? '\\' : '/'
  return base.replace(/[\\/]+$/, '') + sep + rest.join(sep)
}

// Pinned to the composer helpers so every action reports failure the same way.
async function insertPath(abs) {
  const ok = await host.composer.insertText(null, quote(abs), { mode: 'inline' })
  if (!ok) host.notify({ kind: 'info', message: abs })
}

function evenWeights(n) {
  return Array.from({ length: n }, () => 1 / n)
}

function storedWeights(raw, n) {
  if (!Array.isArray(raw) || raw.length !== n) return evenWeights(n)
  const w = raw.map(Number)
  const sum = w.reduce((a, b) => a + b, 0)
  if (!w.every((x) => Number.isFinite(x) && x > 0) || !(sum > 0)) return evenWeights(n)
  return w.map((x) => x / sum)
}

// The Drive section keeps the original 'path' key so it reopens where it was.
const pathKeyFor = (key) => (key === 'drive' ? 'path' : `path:${key}`)

const rowStyle = {
  display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 8px',
  cursor: 'pointer', borderRadius: '4px', whiteSpace: 'nowrap', overflow: 'hidden'
}

function ContextMenu({ menu, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  // Keep the menu on screen once its real size is known.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4))
    })
  }, [menu])

  useEffect(() => {
    const away = (ev) => { if (!ref.current?.contains(ev.target)) onClose() }
    const key = (ev) => { if (ev.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return jsx('div', {
    ref,
    role: 'menu',
    onContextMenu: (ev) => ev.preventDefault(),
    style: {
      position: 'fixed', left: `${pos.left}px`, top: `${pos.top}px`, zIndex: 10000, minWidth: '190px',
      padding: '4px', borderRadius: '6px', fontSize: '12.5px',
      background: 'var(--ui-bg-elevated, var(--ui-bg-secondary, #1d2128))',
      border: '1px solid var(--ui-stroke-secondary)', boxShadow: '0 6px 20px rgba(0,0,0,.35)'
    },
    children: menu.items.map((it, i) => (it === '-'
      ? jsx('div', { style: { height: '1px', margin: '4px 6px', background: 'var(--ui-stroke-secondary)' } }, `sep${i}`)
      : jsx('div', {
        role: 'menuitem',
        'aria-disabled': it.disabled ? 'true' : undefined,
        title: it.disabled ? it.why : it.hint,
        onClick: () => { if (it.disabled) return; onClose(); it.run() },
        onMouseEnter: (ev) => { if (!it.disabled) ev.currentTarget.style.background = 'var(--ui-stroke-secondary)' },
        onMouseLeave: (ev) => { ev.currentTarget.style.background = 'transparent' },
        style: {
          padding: '5px 10px', borderRadius: '4px', whiteSpace: 'nowrap',
          cursor: it.disabled ? 'default' : 'pointer',
          color: it.disabled ? 'var(--ui-text-quaternary)' : 'var(--ui-text-primary, inherit)'
        },
        children: it.label
      }, it.label)))
  })
}

function DocumentPreview({ ctx, root, path, name, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const docHost = useRef(null)
  useEffect(() => {
    let cancelled = false
    const q = `?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
    ctx.rest(`/preview${q}`).then((res) => {
      const raw = unwrap(res)
      if (!raw?.content || typeof raw.content !== 'string') throw new Error('invalid preview response')
      const binary = atob(raw.content)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes.buffer
    }).then(async (bytes) => {
      if (cancelled) return
      if (name.toLowerCase().endsWith('.pdf')) {
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
        setData({ url })
      } else if (name.toLowerCase().endsWith('.docx')) {
        setData({ docx: bytes })
      } else {
        const book = XLSX.read(bytes, { type: 'array', cellFormula: true, cellText: true, cellStyles: false })
        const sheets = book.SheetNames.map((sheet) => { const ws = book.Sheets[sheet]; const range = XLSX.utils.decode_range(ws['!ref'] || 'A1'); const rows = []; for (let r = range.s.r; r <= range.e.r; r++) { const row = []; for (let c = range.s.c; c <= range.e.c; c++) { const cell = ws[XLSX.utils.encode_cell({ r, c })]; row.push(cell ? { value: cell.w ?? cell.v ?? '', formula: cell.f || '' } : { value: '', formula: '' }) } rows.push(row) } return { name: sheet, rows } })
        setData({ sheets, active: 0 })
      }
    }).catch((e) => { if (!cancelled) setError(String(e?.message || e)) })
    return () => { cancelled = true; if (data?.url) URL.revokeObjectURL(data.url) }
  }, [ctx, root, path, name])
  useEffect(() => {
    if (data?.docx && docHost.current) {
      renderDocx(data.docx, docHost.current, undefined, { inWrapper: false, ignoreWidth: true, ignoreHeight: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true })
        .catch((e) => setError(String(e?.message || e)))
    }
  }, [data])
  const isXlsx = name.toLowerCase().endsWith('.xlsx')
  const activeSheet = data?.sheets?.[data.active]
  return jsxs('div', { role: 'dialog', 'aria-label': `Preview ${name}`, style: { position: 'fixed', inset: '5vh 5vw', zIndex: 10001, display: 'flex', flexDirection: 'column', background: 'var(--ui-bg-primary, #fff)', color: 'var(--ui-text-primary, #111)', border: '1px solid var(--ui-stroke-secondary)', borderRadius: '8px', boxShadow: '0 8px 36px #0008', overflow: 'hidden' }, children: [
    jsxs('div', { style: { padding: '8px 12px', display: 'flex', gap: '12px', borderBottom: '1px solid var(--ui-stroke-secondary)' }, children: [jsx('strong', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }, children: name }), jsx('button', { onClick: onClose, children: 'Close' })] }),
    data?.url ? jsx('iframe', { title: name, src: data.url, sandbox: '', referrerPolicy: 'no-referrer', style: { flex: 1, border: 0 } }) : null,
    data?.docx ? jsx('div', { ref: docHost, style: { flex: 1, overflow: 'auto', padding: '16px' } }) : null,
    isXlsx && activeSheet ? jsxs('div', { style: { flex: 1, minHeight: 0, overflow: 'auto' }, children: [jsx('div', { role: 'tablist', children: data.sheets.map((sheet, i) => jsx('button', { role: 'tab', 'aria-selected': i === data.active, onClick: () => setData((d) => ({ ...d, active: i })), children: sheet.name }, sheet.name)) }), jsx('table', { style: { borderCollapse: 'collapse', fontSize: '12px' }, children: activeSheet.rows.map((row, ri) => jsx('tr', { children: row.map((v, ci) => jsx('td', { title: v.formula ? `=${v.formula}` : '', style: { border: '1px solid #aaa', padding: '3px 6px', whiteSpace: 'pre-wrap' }, children: String(v.value) }, ci)) }, ri)) })] }) : null,
    !data && !error ? jsx('div', { style: { padding: 20 }, children: 'Loading preview…' }) : null,
    error ? jsx('div', { role: 'alert', style: { padding: 20 }, children: `Could not preview file: ${error}` }) : null
  ] })
}

function Browser({ ctx, root, label, local, onRefresh, style }) {
  const pathKey = pathKeyFor(root)
  const [path, setPath] = useState(() => ctx.storage.get(pathKey) || '')
  const [hidden, setHidden] = useState(false)
  const [state, setState] = useState({ loading: true })
  const [menu, setMenu] = useState(null)
  const [preview, setPreview] = useState(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  // Monotonic request id: only the newest listing may land, so a slow reply
  // for a folder you already clicked past can't overwrite the current one.
  const reqId = useRef(0)

  const load = useCallback(async (p) => {
    const id = ++reqId.current
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const q = `?root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}${hidden ? '&hidden=true' : ''}`
      const data = unwrap(await ctx.rest(`/list${q}`))
      if (id !== reqId.current) return
      setState({ loading: false, data })
      ctx.storage.set(pathKey, data.path || '')
    } catch (err) {
      if (id !== reqId.current) return
      setState({ loading: false, error: String(err?.message || err) })
    }
  }, [ctx, root, pathKey, hidden])

  useEffect(() => { load(path) }, [path, load])

  const crumbs = (path ? path.split('/') : [])
  const go = (p) => setPath(p)
  const up = () => setPath(crumbs.slice(0, -1).join('/'))

  const openLocal = async (lp) => {
    const ok = await ctx.os.openExternal(lp)
    if (!ok) host.notify({ kind: 'error', message: `Could not open ${lp} on this computer` })
  }
  const revealLocal = async (lp) => {
    const ok = await ctx.os.revealPath(lp)
    if (!ok) host.notify({ kind: 'error', message: `Could not find ${lp} on this computer` })
  }
  const copy = async (text) => {
    const ok = await ctx.os.writeClipboard(text)
    host.notify({ kind: ok ? 'info' : 'error', message: ok ? `Copied ${text}` : 'Could not copy to the clipboard' })
  }

  /** Menu for one item: `rel` is its path inside the root ('' = the root);
   *  `here` marks the folder being shown (right-click on empty space). */
  const openMenu = (ev, { rel, abs, dir, here }) => {
    ev.preventDefault()
    ev.stopPropagation()
    const lp = toLocal(local, rel)
    const why = NO_LOCAL
    const items = []
    if (dir && !here) items.push({ label: 'Open', run: () => go(rel) })
    items.push(
      { label: 'Open on this computer', disabled: !lp, why, hint: lp, run: () => openLocal(lp) },
      { label: REVEAL_LABEL, disabled: !lp, why, hint: lp, run: () => revealLocal(lp) },
      '-',
      { label: 'Insert path in chat', hint: abs, run: () => insertPath(abs) },
      { label: 'Copy path', hint: abs, run: () => copy(abs) },
      { label: 'Copy local path', disabled: !lp, why, hint: lp, run: () => copy(lp) }
    )
    if (here) items.push('-', { label: 'Refresh', run: () => { load(path); onRefresh?.() } })
    setMenu({ x: ev.clientX, y: ev.clientY, items })
  }

  const header = jsxs('div', {
    style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', flexShrink: 0,
      padding: '6px 8px', borderBottom: '1px solid var(--ui-stroke-secondary)', fontSize: '12px' },
    children: [
      jsx('span', { style: { cursor: 'pointer', fontWeight: 600 }, onClick: () => go(''), children: label }),
      ...crumbs.map((c, i) => jsxs('span', {
        style: { color: 'var(--ui-text-secondary)' },
        children: [
          ' / ',
          jsx('span', { style: { cursor: 'pointer' }, onClick: () => go(crumbs.slice(0, i + 1).join('/')), children: c })
        ]
      }, i)),
      jsx('span', { style: { flex: 1 } }),
      jsx('span', {
        title: 'Show hidden files', style: { cursor: 'pointer', color: hidden ? 'var(--ui-accent)' : 'var(--ui-text-quaternary)' },
        onClick: () => setHidden((h) => !h), children: '.*'
      }),
      jsx('span', {
        title: 'Refresh', style: { cursor: 'pointer', color: 'var(--ui-text-tertiary)' },
        onClick: () => { load(path); onRefresh?.() }, children: '↻'
      })
    ]
  })

  let body
  if (state.error) {
    body = jsx('div', { style: { padding: '8px', color: 'var(--ui-text-secondary)', fontSize: '12px' },
      children: `Could not list folder: ${state.error}` })
  } else if (!state.data) {
    body = jsx('div', { style: { padding: '8px', color: 'var(--ui-text-tertiary)', fontSize: '12px' }, children: 'Loading…' })
  } else {
    const base = state.data.abs
    const rows = state.data.entries.map((e) => {
      const rel = path ? `${path}/${e.name}` : e.name
      const abs = `${base}/${e.name}`
      const broken = e.link === 'broken'
      return jsxs('div', {
        style: { ...rowStyle, cursor: broken ? 'default' : 'pointer', opacity: broken ? 0.5 : 1 },
        title: broken ? `${abs} (link to a place outside ${label})` : abs,
        onClick: () => { if (broken) return; if (e.dir) go(rel); else if (/\.(docx|xlsx|pdf)$/i.test(e.name)) setPreview({ rel, name: e.name }); else insertPath(abs) },
        onContextMenu: (ev) => (broken ? ev.preventDefault() : openMenu(ev, { rel, abs, dir: e.dir })),
        onMouseEnter: (ev) => { if (!broken) ev.currentTarget.style.background = 'var(--ui-stroke-secondary)' },
        onMouseLeave: (ev) => { ev.currentTarget.style.background = 'transparent' },
        children: [
          jsx('span', { style: { width: '14px', color: e.dir ? 'var(--ui-accent)' : 'var(--ui-text-quaternary)' },
            children: e.dir ? '▸' : broken ? '↪' : '·' }),
          jsx('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }, children: e.name }),
          jsx('span', { style: { color: 'var(--ui-text-quaternary)', fontSize: '11px' }, children: broken ? 'link' : fmtSize(e.size) })
        ]
      }, e.name)
    })
    body = jsxs('div', {
      style: { fontSize: '12.5px', padding: '4px 0', minHeight: '100%' },
      onContextMenu: (ev) => openMenu(ev, { rel: path, abs: base, dir: true, here: true }),
      children: [
        path ? jsx('div', { style: rowStyle, onClick: up, onContextMenu: (ev) => ev.preventDefault(),
          children: jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: '‹ ..' }) }) : null,
        ...rows,
        state.data.truncated ? jsx('div', { style: { padding: '6px 8px', color: 'var(--ui-text-quaternary)' }, children: 'List truncated' }) : null
      ]
    })
  }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', ...style },
    children: [
      header,
      jsx('div', { style: { flex: 1, minHeight: 0, overflow: 'auto' }, onScroll: closeMenu, children: body }),
      menu ? jsx(ContextMenu, { menu, onClose: closeMenu }) : null,
      preview ? jsx(DocumentPreview, { ctx, root, path: preview.rel, name: preview.name, onClose: () => setPreview(null) }) : null
    ]
  })
}

function Divider({ onDrag, onReset }) {
  const [hot, setHot] = useState(false)
  const onPointerDown = (ev) => {
    ev.preventDefault()
    const bar = ev.currentTarget
    bar.setPointerCapture(ev.pointerId)
    setHot(true)
    const move = (e) => onDrag(e.clientY)
    const done = (e) => {
      bar.releasePointerCapture(e.pointerId)
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', done)
      bar.removeEventListener('pointercancel', done)
      setHot(false)
      onDrag(e.clientY, true)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', done)
    bar.addEventListener('pointercancel', done)
  }
  return jsx('div', {
    title: 'Drag to resize, double-click to reset',
    onPointerDown,
    onDoubleClick: onReset,
    onMouseEnter: () => setHot(true),
    onMouseLeave: (ev) => { if (!ev.buttons) setHot(false) },
    style: { flexShrink: 0, height: '6px', cursor: 'row-resize', touchAction: 'none', display: 'flex', alignItems: 'center' },
    children: jsx('div', {
      style: { width: '100%', height: hot ? '2px' : '1px', transition: 'background 120ms, height 120ms',
        background: hot ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)' }
    })
  })
}

function DrivePane({ ctx }) {
  const [roots, setRoots] = useState(FALLBACK_ROOTS)
  // Section sizes are remembered per set of sections, so changing the
  // configuration starts that layout evenly instead of reusing stale sizes.
  const splitKey = `split:${roots.map((r) => r.key).join('|')}`
  const [weights, setWeights] = useState(() => evenWeights(roots.length))
  const box = useRef(null)
  const live = useRef(weights)
  live.current = weights

  const loadRoots = useCallback(async () => {
    try {
      const data = unwrap(await ctx.rest('/roots'))
      const next = Array.isArray(data?.roots) && data.roots.length ? data.roots : FALLBACK_ROOTS
      setRoots((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next))
    } catch {
      // Keep whatever is showing; each section reports its own errors.
    }
  }, [ctx])

  // Settings edits apply when the window regains focus (coming back from
  // Settings) or on any section's refresh, without reloading the plugin.
  useEffect(() => {
    loadRoots()
    const onFocus = () => loadRoots()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadRoots])

  useEffect(() => {
    setWeights(storedWeights(ctx.storage.get(splitKey), roots.length))
  }, [ctx, splitKey, roots.length])

  // Divider i sits between sections i and i+1 and trades size between only
  // those two, so the rest of the layout stays put.
  const onDrag = (i, clientY, final) => {
    const r = box.current?.getBoundingClientRect()
    if (!r || r.height <= 0) return
    const w = live.current.slice()
    const start = w.slice(0, i).reduce((a, b) => a + b, 0)
    const pair = w[i] + w[i + 1]
    const at = (clientY - r.top) / r.height - start
    w[i] = Math.min(pair - MIN_SHARE, Math.max(MIN_SHARE, at))
    w[i + 1] = pair - w[i]
    setWeights(w)
    if (final) ctx.storage.set(splitKey, w)
  }
  const onReset = () => {
    const w = evenWeights(roots.length)
    setWeights(w)
    ctx.storage.set(splitKey, w)
  }

  const children = []
  roots.forEach((r, i) => {
    if (i > 0) {
      children.push(jsx(Divider, {
        onDrag: (y, final) => onDrag(i - 1, y, final), onReset
      }, `div:${r.key}`))
    }
    children.push(jsx(Browser, {
      ctx, root: r.key, label: r.label, local: r.local || {}, onRefresh: loadRoots,
      style: { flex: `${weights[i] ?? 1 / roots.length} 1 0` }
    }, r.key))
  })

  return jsx('div', {
    ref: box,
    style: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
    children
  })
}

export default {
  id: ID,
  name: 'Drive',
  register(ctx) {
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Drive',
      data: { placement: 'right', width: '300px' },
      render: () => jsx(DrivePane, { ctx })
    })
  }
}
