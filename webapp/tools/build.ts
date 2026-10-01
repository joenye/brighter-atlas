// Build: bundle each runtime entry point with esbuild to the exact paths the
// app expects at runtime (index.html, the one page, loads js/app.js, which fetches each tool's code as a
// chunk of its own under js/chunks/ when its page first opens; the service worker
// must sit at the app root so its scope covers the page; workers are spawned
// by path string).
//
// Production (default): fully minified, no legal comments, no sourcemaps,
// NODE_ENV baked to "production", per-entry size summary.
// Watch (--watch): unminified with inline sourcemaps, rebuild on change.
import { build, context, type BuildOptions, type Metafile } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes('--watch');

const common: BuildOptions = {
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !watch && !process.env.BS_NO_MINIFY,                       // whitespace + identifiers + syntax
  sourcemap: watch ? 'inline' : false,
  metafile: !watch,
  logLevel: 'info',
  jsx: 'automatic',
  ...(watch ? {} : {
    legalComments: 'none' as const,
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
};

const jobs: BuildOptions[] = [
  {
    ...common,
    entryPoints: {
      'js/satellite': 'src/satellite/main.ts',
      'js/extract/worker': 'src/extract/worker.ts',
      'js/extract/pool-worker': 'src/extract/pool-worker.ts',
      'js/extract/maps-worker': 'src/extract/maps/worker.ts',
      'js/viewers/fit-worker': 'src/viewers/fit-worker.ts',
      'js/viewers/world/bake-worker': 'src/viewers/world/bake-worker.ts',
      'js/fashion/levels-worker': 'src/fashion/levels-worker.ts',
    },
    outdir: '.',
    splitting: false,
  },
  { ...common, entryPoints: { sw: 'src/sw.ts' }, outdir: '.' },
  // the site (index.html): the shell, and each tool (and Fashion's 3D scenes' renderer) a chunk of its own,
  // fetched when first needed; chunk names carry their content's hash
  { ...common, entryPoints: { 'js/app': 'src/app/main.tsx' }, outdir: '.', splitting: true, chunkNames: 'js/chunks/[name]-[hash]' },
];

if (watch) {
  for (const job of jobs) (await context(job)).watch();
} else {
  const results = await Promise.all(jobs.map(build));
  // js/preloads.json: what each page can ask for at once instead of finding it one import at a time: the site's
  // own chunks (every page), and each tool's chunk with the chunks only it needs (a host may name them in the page)
  const site = results[2].metafile!.outputs;
  const staticOf = (file: string, into = new Set<string>()): Set<string> => {
    for (const im of site[file]?.imports ?? []) if (im.kind === 'import-statement' && !into.has(im.path)) { into.add(im.path); staticOf(im.path, into); }
    return into;
  };
  const shell = staticOf('js/app.js');
  const TOOL_ENTRIES: Record<string, string> = { fashion: 'src/fashion/Fashion.tsx', maps: 'src/world-atlas/WorldMap.tsx', data: 'src/DataTool.tsx' };
  const tools: Record<string, string[]> = {};
  for (const [tool, entry] of Object.entries(TOOL_ENTRIES)) {
    const out = Object.keys(site).find((f) => site[f].entryPoint === entry);
    if (!out) throw new Error(`no chunk for ${entry}`);
    tools[tool] = [out, ...[...staticOf(out)].filter((f) => !shell.has(f))].map((f) => '/' + f);
  }
  writeFileSync(path.join(root, 'js/preloads.json'), JSON.stringify({ shell: [...shell].map((f) => '/' + f), tools }, null, 1) + '\n');
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
