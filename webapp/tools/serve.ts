// Minimal static file server (used by smoke.ts / e2e.ts; production serving is
// any static host, e.g. `python3 -m http.server 8321` from webapp/).
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};

// Optional CSP header, matching the one served in production: set BS_CSP to
// the policy string to verify the app runs clean under it. Off by default so
// normal test runs are unaffected.
const CSP = process.env.BS_CSP || null;

// Optional overlay mounts: BS_EXTRA_ROOT is a colon-separated list of extra
// directories. Requests resolve against the primary root first; on a miss,
// each extra root is tried in order. Lets a dev serve generated data trees
// (or any sibling directory) without copying them into webapp/.
const EXTRA_ROOTS = (process.env.BS_EXTRA_ROOT || '')
  .split(':')
  .filter(Boolean)
  .map((p) => path.resolve(p));

export function serve(root: string, port = 0): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
      let rel = path.normalize(urlPath).replace(/^([/\\])+/, '');
      if (rel === '' || rel === '.') rel = 'index.html';
      let data: Buffer | null = null;
      let file = '';
      for (const base of [root, ...EXTRA_ROOTS]) {
        const candidate = path.join(base, rel);
        if (!candidate.startsWith(base)) { res.writeHead(403); res.end(); return; }
        try {
          data = await fs.readFile(candidate);
          file = candidate;
          break;
        } catch { /* miss, try the next root */ }
      }
      if (data === null) throw new Error('not found in any root');
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        ...(CSP ? { 'content-security-policy': CSP } : {}),
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port });
    });
  });
}

// CLI: `npm run serve` / `node tools/serve.ts [port]`. Serves webapp/ for dev.
if (import.meta.url === new URL(process.argv[1], 'file://').href
    || process.argv[1]?.endsWith('serve.ts')) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const want = Number(process.argv[2] || process.env.PORT || 8321);
  const { port } = await serve(root, want);
  console.log(`Brighter Atlas dev server: http://localhost:${port}/  (root: ${root})`);
  if (EXTRA_ROOTS.length) console.log(`  extra roots: ${EXTRA_ROOTS.join(', ')}`);
}
