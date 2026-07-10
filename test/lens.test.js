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

test('outline classifies each symbol by kind (drives the web kind filter)', () => {
  const o = lens.outline(join(src, 'auth.js'));
  assert.ok(o.symbols.every((s) => typeof s.kind === 'string'), 'every symbol has a kind');
  assert.equal(o.symbols.find((s) => /parseAuthHeader/.test(s.text)).kind, 'function', 'a function declaration → function');
  assert.equal(o.symbols.find((s) => /class TokenStore/.test(s.text)).kind, 'class', 'a class declaration → class');
  assert.ok(lens.outline(join(src, 'notes.md')).symbols.some((s) => s.kind === 'heading'), 'markdown headings → heading');
  // the classifier directly, on the tricky cases
  assert.equal(lens.symbolKind('export const fetchUser = async (id) => {', 'javascript'), 'function', 'arrow-assigned const → function');
  assert.equal(lens.symbolKind('const MAX_RETRIES = 5;', 'javascript'), 'const', 'plain const → const');
  assert.equal(lens.symbolKind('export interface Opts {', 'typescript'), 'type', 'interface → type');
});

test('readLines returns an exact, numbered range', () => {
  const r = lens.readLines(join(src, 'auth.js'), 1, 2);
  assert.equal(r.start, 1);
  assert.equal(r.end, 2);
  assert.match(r.body, /1\t/);
});

test('bad numeric args are coerced, not propagated as NaN (search / references / readLines)', () => {
  // search: an unguarded NaN k errors on `LIMIT ?` or over-returns (budget check
  // `tokens + t > NaN` never skips); all bad values recover the default result
  const good = lens.search('req');
  assert.ok(typeof good.count === 'number' && good.count >= 1, 'baseline search has a count');
  for (const bad of [NaN, 0, -3, 'abc']) {
    const r = lens.search('req', { k: bad });
    assert.equal(r.count, good.count, `search k=${String(bad)} recovers the default count`);
  }
  assert.ok(lens.search('req', { max_tokens: 'xyz' }).tokens <= 1800, 'bad max_tokens falls back to the default budget');

  // references: limit=0 used to truncate on the first ref; NaN never truncated
  const refGood = lens.references('req');
  for (const bad of [0, NaN, 'abc', -1]) {
    assert.equal(lens.references('req', { limit: bad }).count, refGood.count, `references limit=${String(bad)} recovers the default`);
  }

  // readLines: NaN start/end must not yield NaN line numbers or a broken slice
  const rl = lens.readLines(join(src, 'auth.js'), 'abc', 'xyz');
  assert.equal(rl.start, 1, 'bad start falls back to line 1');
  assert.ok(Number.isFinite(rl.end) && rl.end >= rl.start, 'end is a finite line >= start');
  assert.ok(!/NaN/.test(rl.body), 'no NaN line numbers in the body');
  const inv = lens.readLines(join(src, 'auth.js'), 5, 2);   // end < start
  assert.ok(inv.end >= inv.start && inv.body.length > 0, 'an inverted range yields a sane window, not empty');
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

test('map exposes per-file size + a token estimate (drives the tree weight bar)', () => {
  const m = lens.map();
  assert.ok(Array.isArray(m.tree) && m.tree.length >= 2, 'the tree lists files');
  for (const f of m.tree) {
    assert.ok(typeof f.lines === 'number' && f.lines > 0, 'each file has a line count');
    assert.ok(typeof f.bytes === 'number' && f.bytes > 0, 'each file has a byte size');
    assert.equal(f.tokens, Math.ceil(f.bytes / 4), 'tokens is the ≈4-chars/token estimate of bytes');
  }
  // the bar scales to the heaviest file, so the max must be positive
  assert.ok(Math.max(...m.tree.map((f) => f.tokens)) > 0, 'there is a heaviest file to scale against');
});

test('references finds every line that mentions a symbol, grouped by file', () => {
  const r = lens.references('req');
  assert.ok(r.count >= 2, 'req appears on at least two lines');
  const g = r.groups.find((x) => x.path.endsWith('auth.js'));
  assert.ok(g, 'grouped under auth.js');
  assert.ok(g.refs.every((x) => typeof x.line === 'number' && x.text), 'each ref has a line + text');
  // whole-word matching: the function name is defined once
  assert.equal(lens.references('parseAuthHeader').count, 1);
  // a non-word / empty symbol is handled, not thrown
  assert.equal(lens.references('   ').count, 0);
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

    const refs = await fetch(base + '/api/references?symbol=parseAuthHeader').then((r) => r.json());
    assert.equal(refs.symbol, 'parseAuthHeader');
    assert.ok(refs.count >= 1 && refs.groups[0].refs[0].line > 0, 'references returns file:line groups');

    const guard = await fetch(base + '/api/read?path=' + encodeURIComponent('../../etc/passwd')).then((r) => r.json());
    assert.equal(guard.error, 'path not in index', 'read rejects non-indexed / traversal paths');

    const notFound = await fetch(base + '/api/nope');
    assert.equal(notFound.status, 200, 'unknown paths fall through to the SPA, not a crash');
  } finally { server.close(); }
});
