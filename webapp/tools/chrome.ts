// Cross-platform Chrome/Chromium resolution for the puppeteer-core tools.
// Override with the CHROME env var (or PUPPETEER_EXECUTABLE_PATH); otherwise
// the first existing per-platform default wins, falling back to a browser
// installed by `npx puppeteer browsers install chrome` (the WSL/Linux path).
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

function puppeteerCacheChrome(): string | null {
  const base = `${homedir()}/.cache/puppeteer/chrome`;
  try {
    for (const v of readdirSync(base).sort().reverse()) {
      for (const sub of ['chrome-linux64/chrome',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-win64/chrome.exe']) {
        const p = `${base}/${v}/${sub}`;
        if (existsSync(p)) return p;
      }
    }
  } catch { /* no cache */ }
  return null;
}

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

// Resolved eagerly but WITHOUT throwing at import time: a test that only skips
// (via env.ts requireBundles) must be able to import this and exit cleanly
// before it ever needs Chrome. null → the caller surfaces the missing-Chrome
// error only if a suite actually tries to launch.
export const CHROME: string | null = process.env.CHROME
  || process.env.PUPPETEER_EXECUTABLE_PATH
  || (CANDIDATES[process.platform] || []).find((p) => p && existsSync(p))
  || puppeteerCacheChrome()
  || null;   // set CHROME=/path/to/chrome, or: npx puppeteer browsers install chrome

// WebGL-capable launch args per platform. macOS gets ANGLE-on-Metal; headless
// Linux/WSL has no GPU, so SwiftShader must be allowed explicitly (Chrome 139+
// gates the software-WebGL fallback behind --enable-unsafe-swiftshader).
export const GL_ARGS: string[] = process.platform === 'darwin'
  ? ['--use-gl=angle', '--use-angle=metal']
  : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
