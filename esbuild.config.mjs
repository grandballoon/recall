/* Two builds from one config.
   `production` / default emits the plugin bundle; `test` transpiles the
   suite so `node --test` can run it on a Node without type stripping. */
import esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/* Found rather than listed: a test file that is never built is a test file
   that silently never runs, and the list is not the kind of thing anyone
   remembers to update. */
function findTests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return findTests(path);
    return entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const mode = process.argv[2];

/* Node builtins are left as bare requires rather than bundled: they exist in
   Obsidian's desktop runtime and not on mobile, and the key file asks for them
   inside a try/catch so a phone gets a plugin that loads and simply cannot
   store a key. */
const external = ['obsidian', 'electron', 'fs', 'os', 'path',
  '@codemirror/state', '@codemirror/view', '@codemirror/language'];

if (mode === 'test') {
  await esbuild.build({
    entryPoints: findTests('src'),
    outdir: 'build-test',
    format: 'esm',
    platform: 'node',
    target: 'node18',
    bundle: true,
    outExtension: { '.js': '.mjs' },
  });
} else {
  const ctx = await esbuild.context({
    entryPoints: ['src/main.ts'],
    outfile: 'main.js',
    bundle: true,
    format: 'cjs',
    target: 'es2020',
    platform: 'browser',
    external,
    sourcemap: mode === 'production' ? false : 'inline',
    minify: mode === 'production',
    logLevel: 'info',
  });
  if (mode === 'production') { await ctx.rebuild(); await ctx.dispose(); }
  else await ctx.watch();
}
