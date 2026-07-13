// lens serve — a zero-dependency HTTP server exposing the index for the
// web explorer: FTS search, repo map, symbol outline and surgical reads.
// Node's built-in http only. Read-only; outline/read are guarded to indexed paths.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize, sep } from 'node:path';
import { search, references, outline, readLines, map, stats, isIndexed, fileMeta, freshness, indexPath } from './core.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '..', 'public');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

// Endpoints only run against the index; outline/read reject non-indexed paths.
// Where cortex's web view lives, so the reader can send a passage to the brain.
// The capture itself is cortex's POST /api/capture — lens never writes.
const CORTEX_URL = (process.env.LENS_CORTEX_URL || 'http://localhost:7800').replace(/\/$/, '');

const api = {
  '/api/stats': () => ({ ...stats(), cortex: CORTEX_URL }),
  '/api/map': () => map({ limit: 2000 }),
  '/api/search': (q) => search(q.q || '', { k: q.k ? +q.k : 12, max_tokens: q.tokens ? +q.tokens : 2400, path_glob: q.glob || undefined }),
  '/api/references': (q) => references(q.symbol || '', { limit: q.limit ? +q.limit : 400 }),
  '/api/outline': (q) => {
    if (!q.path || !isIndexed(q.path)) throw new Error('path not in index');
    return outline(q.path);
  },
  '/api/read': (q) => {
    if (!q.path || !isIndexed(q.path)) throw new Error('path not in index');
    const r = readLines(q.path, q.start ? +q.start : 1, q.end ? +q.end : undefined);
    return { ...r, meta: fileMeta(q.path) };
  },
  // Is the index still true? The web view asks so it can say "3 files changed"
  // rather than quietly serving a stale answer.
  '/api/freshness': () => freshness('.'),
  '/api/health': () => ({ ok: true, service: 'lens', ts: new Date().toISOString() }),
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(PUBLIC, rel));
  // startsWith(PUBLIC) alone lets a SIBLING directory through: if PUBLIC is /app/public, then
  // /app/public-secrets/keys.txt also startsWith('/app/public'). A request path of
  // `/../public-secrets/keys.txt` resolves to exactly that and sailed past the guard. Require the
  // path separator, so "inside PUBLIC" means inside it and not merely next to something spelled
  // like it. (iris had the same bug one file over; this is the same fix, kit-wide.)
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + sep)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    try {
      const data = await readFile(join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  }
}

export function createLensServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

    // Re-index. Everything else here is read-only over the index; this rebuilds it,
    // so it is a POST — a GET must never be able to make the server walk your disk.
    // It indexes the directory the server was started in, which is the directory the
    // index's paths are relative to.
    if (url.pathname === '/api/index') {
      if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
      try {
        const full = url.searchParams.get('reindex') === '1';
        const r = indexPath('.', { reindex: full });
        // NB: don't spread freshness() over this — it has its own `removed` (the list
        // of paths), which would clobber indexPath's `removed` (how many it forgot).
        const f = freshness('.');
        return json(res, 200, { ...r, stale: f.stale, counts: f.counts });
      } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }

    const handler = api[url.pathname];
    if (handler) {
      const q = Object.fromEntries(url.searchParams.entries());
      try { return json(res, 200, await handler(q)); }
      catch (e) { return json(res, 400, { error: String(e.message || e) }); }
    }
    return serveStatic(res, url.pathname);
  });
}

export function serve({ port = process.env.LENS_PORT || 7900 } = {}) {
  const server = createLensServer();
  server.listen(port, () => {
    const s = stats();
    console.log(`\n  ⌕ lens serve → http://localhost:${port}`);
    console.log(`    ${s.files} files · ${s.total_lines.toLocaleString()} lines · ${s.chunks} chunks indexed\n`);
  });
  return server;
}
