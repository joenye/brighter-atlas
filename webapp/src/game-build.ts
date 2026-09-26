// The game's own build string, as its console prints it: the version players
// see and a 16-hex build hash ("0.99.3-278abe752c42bda0"). It comes with the
// per-build decode data (its `build` section) and names builds throughout the
// app after their date ("build 21-Sep-2026 (v0.99.3)"); the hash only shows
// in details.
const BUILD_STRING = /^(\d+\.\d+\.\d+)-([0-9a-f]{16})$/;

export function parseBuildString(s: unknown): { version: string; hash: string } | null {
  const m = typeof s === 'string' ? BUILD_STRING.exec(s) : null;
  return m ? { version: m[1], hash: m[2] } : null;
}

/** The version part ("0.99.3"), or null when the string is absent or malformed. */
export function gameVersion(s: unknown): string | null {
  return parseBuildString(s)?.version ?? null;
}
