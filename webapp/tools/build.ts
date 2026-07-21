// Build: bundle each runtime entry point with esbuild to the exact paths the
// app expects at runtime (index.html loads js/main.js; the service worker
// must sit at the app root so its scope covers the page; workers are spawned
// by path string).
//
// Production (default): fully minified, no legal comments, no sourcemaps,
// NODE_ENV baked to "production", per-entry size summary.
// Watch (--watch): unminified with inline sourcemaps, rebuild on change.
import { build, context, type BuildOptions, type Metafile } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes('--watch');

const common: BuildOptions = {
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !watch,                       // whitespace + identifiers + syntax
  sourcemap: watch ? 'inline' : false,
  metafile: !watch,
  logLevel: 'info',
  ...(watch ? {} : {
    legalComments: 'none' as const,
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
};

const jobs: BuildOptions[] = [
  {
    ...common,
    entryPoints: {
      'js/main': 'src/main.ts',
      'js/extract/worker': 'src/extract/worker.ts',
      'js/extract/pool-worker': 'src/extract/pool-worker.ts',
      'js/viewers/fit-worker': 'src/viewers/fit-worker.ts',
      'js/viewers/world/bake-worker': 'src/viewers/world/bake-worker.ts',
    },
    outdir: '.',
    splitting: false,
  },
  { ...common, entryPoints: { sw: 'src/sw.ts' }, outdir: '.' },
];

if (watch) {
  for (const job of jobs) (await context(job)).watch();
} else {
  const results = await Promise.all(jobs.map(build));
  // per-entry size summary (production only)
  const rows: Array<[string, number]> = [];
  for (const r of results) {
    const outputs: Metafile['outputs'] = r.metafile?.outputs ?? {};
    for (const [file, info] of Object.entries(outputs)) {
      if (info.entryPoint) rows.push([file, info.bytes]);
    }
  }
  const width = Math.max(...rows.map(([f]) => f.length)) + 2;
  const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
  console.log('\nbundle sizes (minified):');
  for (const [file, bytes] of rows) console.log(`  ${file.padEnd(width)}${kb(bytes).padStart(10)}`);
  console.log(`  ${'total'.padEnd(width)}${kb(rows.reduce((s, [, b]) => s + b, 0)).padStart(10)}`);
}
