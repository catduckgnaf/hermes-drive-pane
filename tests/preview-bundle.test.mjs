import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('built plugin embeds pinned renderers and keeps only SDK imports external', async () => {
  const source = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  assert.match(source, /renderAsync/)
  assert.match(source, /SheetNames/)
  assert.match(source, /from "@hermes\/plugin-sdk"/)
  assert.match(source, /from "react\/jsx-runtime"/)
  assert.ok(!source.includes("from 'docx-preview'"))
  assert.ok(!source.includes("from 'xlsx'"))
  assert.ok(!source.includes('https://cdnjs.cloudflare.com'))
  assert.ok(!source.includes('https://unpkg.com'))
  assert.ok(!source.includes('https://cdn.jsdelivr.net'))
})

test('XLSX preview bounds expansion of malicious and oversized declared ranges', async () => {
  const source = await readFile(new URL('../desktop/plugin.src.js', import.meta.url), 'utf8')
  assert.match(source, /sheetRows:\s*MAX_PREVIEW_ROWS/)
  assert.match(source, /MAX_PREVIEW_SHEETS = 32/)
  assert.match(source, /MAX_PREVIEW_ROWS = 1000/)
  assert.match(source, /MAX_PREVIEW_COLUMNS = 200/)
  assert.match(source, /const bounds = previewBounds\(ws\['!ref'\], XLSX\.utils\.decode_range\)/)
  assert.match(source, /for \(let r = bounds\.startRow; r <= bounds\.endRow; r\+\+\)/)
  assert.match(source, /for \(let c = bounds\.startColumn; c <= bounds\.endColumn; c\+\+\)/)
  assert.match(source, /Preview limited to/)
})

test('range bounding caps a full-sheet reference without constructing an unbounded grid', async () => {
  const source = await readFile(new URL('../desktop/plugin.src.js', import.meta.url), 'utf8')
  const fnText = source.slice(source.indexOf('function previewBounds'), source.indexOf('\nfunction fmtSize'))
  const { default: vm } = await import('node:vm')
  const previewBounds = vm.runInNewContext(`(() => { const MAX_PREVIEW_ROWS = 1000, MAX_PREVIEW_COLUMNS = 200; return (${fnText.replace('function previewBounds', 'function')}) })()`)
  const b = previewBounds('A1:XFD1048576', () => ({ s: { r: 0, c: 0 }, e: { r: 1048575, c: 16383 } }))
  assert.deepEqual({ startRow: b.startRow, endRow: b.endRow, startColumn: b.startColumn, endColumn: b.endColumn, truncated: b.truncated },
    { startRow: 0, endRow: 999, startColumn: 0, endColumn: 199, truncated: true })
})
