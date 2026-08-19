// Builds the GitHub Pages site into docs/.
//
// Deliberately dependency-free beyond the esbuild already present for
// check:browser-bundle. This package's whole claim is a small audited surface
// on one runtime dependency; a demo site is not a reason to add a frontend
// toolchain to it.
import { build } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const site = resolve(root, 'site')
const out = resolve(root, 'docs')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

// The bench imports ../src directly, so the page runs the same code the package
// publishes rather than a copy that can drift. The conformance vectors are
// imported as JSON and bundled in, which is what lets the page run them without
// a network request: the CSP sets connect-src 'none'.
const result = await build({
  entryPoints: [resolve(site, 'bench.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  sourcemap: false,
  outfile: resolve(out, 'bench.js'),
  logLevel: 'error',
  metafile: true,
})

for (const file of ['index.html', 'styles.css', 'favicon.svg']) {
  await cp(resolve(site, file), resolve(out, file))
}

// The three faces are served from this domain because the page's own CSP
// forbids a third-party request and the colophon says so out loud.
await cp(resolve(site, 'fonts'), resolve(out, 'fonts'), { recursive: true })

// Plain static files. This only matters if the output is ever handed to GitHub
// Pages as a fallback, which would otherwise run it through Jekyll and strip
// anything beginning with an underscore.
await writeFile(resolve(out, '.nojekyll'), '')

const html = await readFile(resolve(site, 'index.html'), 'utf8')
if (!html.includes('bench.js')) throw new Error('index.html does not load the bench bundle')

const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0
console.log(`site → docs/ (bench.js ${(bytes / 1024).toFixed(1)} KB)`)
