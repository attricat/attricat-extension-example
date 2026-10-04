// Bundles every client contribution into one self-contained ES module per
// manifest artifact. Catalog imports each artifact into its own opaque-origin
// iframe with network access denied, so nothing may be imported at runtime.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const entryPoints = {};
for (const artifact of manifest.artifacts.filter((item) => item.kind === 'client_component')) {
  const source = [`client/${artifact.id}.jsx`, `client/${artifact.id}.js`].find(existsSync);
  if (!source) throw new Error(`No client source for artifact '${artifact.id}'`);
  entryPoints[artifact.path.replace(/^dist\//, '').replace(/\.js$/, '')] = source;
}
await build({
  entryPoints,
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsxFactory: 'h',
  jsxFragment: 'Fragment',
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
});
