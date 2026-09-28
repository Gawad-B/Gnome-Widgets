// Bundles src/extension.ts and src/prefs.ts into dist/ and copies the static files.
// gi://, resource:// and GJS built-in modules stay external: GJS resolves them at runtime.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DIST = 'dist';

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync('metadata.json', `${DIST}/metadata.json`);
cpSync('stylesheet.css', `${DIST}/stylesheet.css`);
cpSync('schemas', `${DIST}/schemas`, { recursive: true });
execFileSync('glib-compile-schemas', ['--strict', `${DIST}/schemas`]);

await esbuild.build({
  entryPoints: ['src/extension.ts', 'src/prefs.ts'],
  outdir: DIST,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: false,
  external: ['gi://*', 'resource:///*', 'cairo', 'system', 'gettext'],
  logLevel: 'info',
});
