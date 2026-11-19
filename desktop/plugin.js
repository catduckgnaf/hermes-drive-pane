/**
 * drive-pane: a right sidebar tab that always lists the Google Drive mirror
 * root (/mnt/google-drive on the gateway host), independent of which chat is
 * focused. Read-only. Click a folder to open it; click a file to insert its
 * path into the focused chat's composer.
 *
 * Disk plugins load uncompiled: no JSX, only @hermes/plugin-sdk, react and
 * react/jsx-runtime resolve.
 */

import { host } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useState } from 'react'

const ID = 'drive-pane'

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

function DrivePane({ ctx }) {
  const [path, setPath] = useState(() => ctx.storage.get('path') || '')
  const [hidden, setHidden] = useState(false)
  const [state, setState] = useState({ loading: true })

  const load = useCallback(async (p) => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const q = `?path=${encodeURIComponent(p)}${hidden ? '&hidden=true' : ''}`
      const data = unwrap(await ctx.rest(`/list${q}`))
      setState({ loading: false, data })
      ctx.storage.set('path', data.path || '')
    } catch (err) {
      setState({ loading: false, error: String(err?.message || err) })
    }
  }, [ctx, hidden])

  useEffect(() => { load(path) }, [path, load])

  const crumbs = (path ? path.split('/') : [])
  const go = (p) => setPath(p)
  const up = () => setPath(crumbs.slice(0, -1).join('/'))

  const insert = async (abs) => {
    const ok = await host.composer.insertText(null, abs, { mode: 'inline' })
    if (!ok) host.notify({ kind: 'info', message: abs })
  }

  const rowStyle = {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 8px',
    cursor: 'pointer', borderRadius: '4px', whiteSpace: 'nowrap', overflow: 'hidden'
  }

  const header = jsxs('div', {
    style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px',
      padding: '6px 8px', borderBottom: '1px solid var(--ui-stroke-secondary)', fontSize: '12px' },
    children: [
      jsx('span', { style: { cursor: 'pointer', fontWeight: 600 }, onClick: () => go(''), children: 'Google Drive' }),
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
        onClick: () => load(path), children: '↻'
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
    const rows = state.data.entries.map((e) => jsxs('div', {
      style: rowStyle,
      title: `${state.data.abs}/${e.name}`,
      onClick: () => (e.dir ? go(path ? `${path}/${e.name}` : e.name) : insert(`${state.data.abs}/${e.name}`)),
      onMouseEnter: (ev) => { ev.currentTarget.style.background = 'var(--ui-stroke-secondary)' },
      onMouseLeave: (ev) => { ev.currentTarget.style.background = 'transparent' },
      children: [
        jsx('span', { style: { width: '14px', color: e.dir ? 'var(--ui-accent)' : 'var(--ui-text-quaternary)' }, children: e.dir ? '▸' : '·' }),
        jsx('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }, children: e.name }),
        jsx('span', { style: { color: 'var(--ui-text-quaternary)', fontSize: '11px' }, children: fmtSize(e.size) })
      ]
    }, e.name))
    body = jsxs('div', {
      style: { fontSize: '12.5px', padding: '4px 0' },
      children: [
        path ? jsx('div', { style: rowStyle, onClick: up, children: jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: '‹ ..' }) }) : null,
        ...rows,
        state.data.truncated ? jsx('div', { style: { padding: '6px 8px', color: 'var(--ui-text-quaternary)' }, children: 'List truncated' }) : null
      ]
    })
  }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' },
    children: [header, jsx('div', { style: { flex: 1, overflow: 'auto' }, children: body })]
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
