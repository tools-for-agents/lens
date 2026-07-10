// lens tests — run with `node --test`. Indexes a throwaway fixture tree into a
// temp DB and exercises search / outline / read / stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'lens-test-'));
process.env.LENS_DB = join(work, 'index.db');
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

const src = join(work, 'src');
mkdirSync(src, { recursive: true });
writeFileSync(join(src, 'auth.js'),
  `export function parseAuthHeader(req) {\n  const h = req.headers.authorization || '';\n  return h.startsWith('Bearer ') ? h.slice(7) : null;\n}\n\nexport class TokenStore {\n  constructor() { this.map = new Map(); }\n}\n`);
writeFileSync(join(src, 'notes.md'), `# Design\n\nWe validate the websocket reconnect backoff here.\n`);

const lens = await import('../src/core.js');

test('indexPath indexes the fixture files', () => {
  const r = lens.indexPath(src);
  assert.ok(r.indexed >= 2, 'indexed at least the two files');
  assert.ok(r.chunks >= 2);
});

test('search returns ranked snippets within a token budget', () => {
  const r = lens.search('parse auth header', { max_tokens: 800 });
  assert.ok(r.results.length >= 1);
  assert.ok(r.results.some((x) => /parseAuthHeader/.test(x.body)));
  assert.ok(r.tokens <= 800);
});

test('search can restrict by path glob', () => {
  const r = lens.search('websocket reconnect', { path_glob: '*notes.md' });
  assert.ok(r.results.every((x) => x.path.endsWith('notes.md')));
});

test('outline extracts symbols with line numbers', () => {
  const o = lens.outline(join(src, 'auth.js'));
  const names = o.symbols.map((s) => s.text).join(' ');
  assert.match(names, /parseAuthHeader/);
  assert.match(names, /TokenStore/);
  assert.ok(o.symbols.every((s) => typeof s.line === 'number'));
});

test('readLines returns an exact, numbered range', () => {
  const r = lens.readLines(join(src, 'auth.js'), 1, 2);
  assert.equal(r.start, 1);
  assert.equal(r.end, 2);
  assert.match(r.body, /1\t/);
});

test('stats reports indexed files and languages', () => {
  const s = lens.stats();
  assert.ok(s.files >= 2);
  assert.ok(s.languages.some((l) => l.lang === 'javascript'));
});

test('empty query returns no results, not an error', () => {
  const r = lens.search('   ');
  assert.equal((r.results || []).length, 0);
});

test('serve: HTTP endpoints expose the index and guard path traversal', async () => {
  const { createLensServer } = await import('../src/server.js');
  const server = createLensServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const stats = await fetch(base + '/api/stats').then((r) => r.json());
    assert.ok(stats.files >= 2, 'stats reports indexed files');

    const hits = await fetch(base + '/api/search?q=parseAuthHeader').then((r) => r.json());
    assert.ok(hits.results.some((x) => /parseAuthHeader/.test(x.body)), 'search returns the symbol');

    const guard = await fetch(base + '/api/read?path=' + encodeURIComponent('../../etc/passwd')).then((r) => r.json());
    assert.equal(guard.error, 'path not in index', 'read rejects non-indexed / traversal paths');

    const notFound = await fetch(base + '/api/nope');
    assert.equal(notFound.status, 200, 'unknown paths fall through to the SPA, not a crash');
  } finally { server.close(); }
});
