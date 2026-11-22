import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('built plugin embeds pinned renderers and keeps only SDK imports external', async () => {
  const source = await readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  assert.match(source, /renderAsync/)
  assert.match(source, /SheetNames/)
  assert.ok(source.includes('from "@hermes/plugin-sdk"'))
  assert.ok(source.includes('from "react/jsx-runtime"'))
  assert.ok(!source.includes("from 'docx-preview'"))
  assert.ok(!source.includes("from 'xlsx'"))
  assert.ok(!source.includes('https://cdnjs.cloudflare.com'))
  assert.ok(!source.includes('https://unpkg.com'))
  assert.ok(!source.includes('https://cdn.jsdelivr.net'))
})
