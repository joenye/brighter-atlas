// Shared test-environment helpers: locate the app and the game bundles, and
// SKIP (exit 0) with a clear message when a local-only prerequisite is
// missing — so the smoke suite (which never needs the copyrighted game
// bundles) runs anywhere, and e2e.ts skips cleanly without them.
//
// The game bundles are NOT stored in the repo. To run the local-only suites,
// point BS_BUNDLES at a directory holding assetBundle0..8 (from your own
// Brighter Shores install), or place those files at the repo root.

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, promises as fs } from 'node:fs';

export const TOOLS = path.dirname(fileURLToPath(import.meta.url));
export const WEBAPP = path.resolve(TOOLS, '..');
export const REPO_ROOT = path.resolve(WEBAPP, '..');

// Where the game bundles live: explicit --bundles PATH, $BS_BUNDLES, or the
// repo root. The CLI form matters when Windows node.exe is launched from WSL:
// WSL does not forward an inline environment assignment to a Windows process
// unless WSLENV is configured, which can silently point a run at stale
// repo-root bundles instead of the requested ones.
const bundleArg = process.argv.indexOf('--bundles');
const bundleDirArg = bundleArg >= 0 && process.argv[bundleArg + 1]
  ? process.argv[bundleArg + 1] : null;
export const BUNDLE_DIR = path.resolve(bundleDirArg || process.env.BS_BUNDLES || REPO_ROOT);
export const bundlePath = (n: number): string => path.join(BUNDLE_DIR, `assetBundle${n}`);
export const haveBundles = (): boolean => Array.from({ length: 9 }, (_, n) => existsSync(bundlePath(n))).every(Boolean);

function skip(name: string, why: string): never {
  console.log(`SKIP ${name}: ${why}.`);
  console.log('  (local-only suite — the smoke suite runs without any game data)');
  process.exit(0);
}

/** Skip the suite unless assetBundle0..8 are present (via BS_BUNDLES or repo root). */
export const requireBundles = (name: string): boolean =>
  haveBundles() || skip(name, 'needs the game bundles assetBundle0..8 — pass --bundles PATH, set BS_BUNDLES=/path/to/bundles, or place them at the repo root');

/** Hard precondition: the esbuild output must exist before any browser test. */
export function requireBuild(name: string): void {
  if (existsSync(path.join(WEBAPP, 'js', 'main.js')) && existsSync(path.join(WEBAPP, 'sw.js'))) return;
  console.error(`${name}: webapp/js/main.js or webapp/sw.js is missing — run \`npm run build\` first`);
  process.exit(2);
}

// A disposable copy of the app WITHOUT any served data tree — a truly fresh
// user, so the client-extraction onboarding wizard is what boots. Real copies,
// not symlinks (symlinks need admin rights on Windows). Caller cleans up.
export async function shimWebroot(prefix = 'bs-webroot-'): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  for (const name of ['index.html', 'sw.js', 'js', 'css', 'vendor', 'defaults', 'assets', 'version.json']) {
    const src = path.join(WEBAPP, name);
    if (existsSync(src)) await fs.cp(src, path.join(root, name), { recursive: true });
  }
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
