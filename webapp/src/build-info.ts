// The build version shown in the UI. webapp/version.json ships a "dev"
// placeholder in git; the deploy script overwrites it with the real Git tag +
// commit at deploy time (then restores the placeholder). So it always exists
// (no 404) and reads "dev build" everywhere except a real deployment.

export interface BuildInfo { version?: string; commit?: string; [k: string]: any }

let info: BuildInfo | null = null;

export const buildInfoReady: Promise<BuildInfo | null> = fetch('./version.json', { cache: 'no-cache' })
  .then((r) => (r.ok ? r.json() : null))
  .then((v) => { info = v && v.version ? v : null; return info; })
  .catch(() => null);

// "v1.2.3 · a1b2c3d" for a deployed build, else "dev build".
export function buildLabel(): string {
  if (!info || info.version === 'dev') return 'dev build';
  return `${info.version}${info.commit ? ` · ${info.commit}` : ''}`;
}

// Just the version tag (no commit), for the compact topbar badge.
export function buildVersionLabel(): string {
  if (!info || info.version === 'dev') return 'dev build';
  return info.version!;
}

export function buildInfo(): BuildInfo | null { return info; }
