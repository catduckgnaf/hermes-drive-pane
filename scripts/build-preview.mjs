import { build } from 'esbuild'

await build({
  entryPoints: ['desktop/plugin.src.js'],
  outfile: 'desktop/plugin.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  external: ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'],
  legalComments: 'none',
  sourcemap: false,
  minify: false,
})
console.log('Built desktop/plugin.js with pinned local renderer dependencies')
