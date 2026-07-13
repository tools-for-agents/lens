// lens tests — run with `node --test`. Indexes a throwaway fixture tree into a
// temp DB and exercises search / outline / read / stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/db.js';

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

// A budget that hides hits while reporting itself complete is worse than no
// budget. Whatever it squeezes out, it must OWN — say how many, and say WHICH
// ceiling did it, because raising the wrong one changes nothing.
test('search owns up to what the budget squeezed out — and names the ceiling that did it', () => {
  // Eight files that all match one rare term, so `matched` is exactly knowable.
  const many = join(work, 'many');
  mkdirSync(many, { recursive: true });
  for (let i = 0; i < 8; i++) {
    writeFileSync(join(many, `svc${i}.js`),
      `// zephyrquota service ${i}\nexport function quota${i}(user) {\n  const limit = lookupZephyrquota(user);\n  return limit ?? DEFAULT;\n}\n`);
  }
  lens.indexPath(many);

  const tight = lens.search('zephyrquota', { k: 12, max_tokens: 30 });
  assert.equal(tight.matched, 8, 'all eight chunks matched — that is the truth of the index');
  assert.equal(tight.count, 1, 'a 30-token budget fits one chunk (the top hit is always let through)');
  assert.equal(tight.withheld, 7, 'withheld is the honest difference, not silence');
  assert.equal(tight.limited_by, 'budget', 'the budget bound — raising k would change nothing');
  assert.equal(tight.budget, 30, 'the budget it used comes back, so the UI can offer to double it');

  // Widen it and the withheld chunks come back — the offer the UI makes is real.
  const wide = lens.search('zephyrquota', { k: 12, max_tokens: 20000 });
  assert.equal(wide.count, 8, 'widening the budget returns every match');
  assert.equal(wide.withheld, 0);
  assert.equal(wide.limited_by, null, 'nothing withheld → no ceiling to name, no crying wolf');

  // Budget generous, cap tight: a DIFFERENT ceiling, and a different fix.
  const capped = lens.search('zephyrquota', { k: 3, max_tokens: 20000 });
  assert.equal(capped.count, 3);
  assert.equal(capped.withheld, 5);
  assert.equal(capped.limited_by, 'k', 'nothing was squeezed by tokens — the result cap is the ceiling');
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

test('serve: stats advertises where cortex lives, so the reader can capture to it', async () => {
  const { createLensServer } = await import('../src/server.js');
  const server = createLensServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const s = await fetch(base + '/api/stats').then((r) => r.json());
    // lens never writes: it only tells the page which brain to POST to
    assert.equal(s.cortex, 'http://localhost:7800', 'defaults to cortex serve');
    assert.ok(s.files > 0, 'and still carries the index stats');
  } finally { server.close(); }
});

test('freshness sees the tree drift, and re-indexing forgets what is gone', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { freshness, indexPath, search, map } = await import('../src/core.js');

  const dir = mkdtempSync(join(tmpdir(), 'lens-fresh-'));
  const prevCwd = process.cwd();
  process.chdir(dir);                       // the index stores paths relative to cwd
  t.after(() => { process.chdir(prevCwd); try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'keep.js'), 'export const keep = () => "unicorn-keep";\n');
  writeFileSync(join(dir, 'src', 'doomed.js'), 'export const doomed = () => "unicorn-doomed";\n');

  const first = indexPath('.');
  assert.ok(first.indexed >= 2);
  assert.equal(freshness('.').stale, 0, 'a fresh index is not stale');
  assert.ok(search('unicorn-doomed').results.length > 0, 'the doomed file is findable');

  // the tree drifts underneath the index
  await new Promise((r) => setTimeout(r, 1100));                 // mtime has 1s granularity on some fs
  writeFileSync(join(dir, 'src', 'keep.js'), 'export const keep = () => "unicorn-changed";\n');
  writeFileSync(join(dir, 'src', 'fresh.js'), 'export const fresh = () => 1;\n');
  rmSync(join(dir, 'src', 'doomed.js'));

  const f = freshness('.');
  assert.equal(f.counts.changed, 1, 'it sees the edited file');
  assert.equal(f.counts.added, 1, 'and the new one');
  assert.equal(f.counts.removed, 1, 'and the deleted one');
  assert.equal(f.stale, 3);

  // re-index: the edit lands, the new file lands, and the deleted one is FORGOTTEN
  const second = indexPath('.');
  assert.equal(second.removed, 1, 'the deleted file was pruned from the index');
  assert.equal(freshness('.').stale, 0, 'the index tells the truth again');
  assert.ok(search('unicorn-changed').results.some((r) => r.path === 'src/keep.js'), 'the edit is searchable');
  // NB: lens tokenizes, so "unicorn-doomed" is an OR of [unicorn, doomed] and will
  // still match keep.js — the point is that no hit can come from the deleted FILE.
  assert.ok(!search('unicorn-doomed').results.some((r) => r.path === 'src/doomed.js'),
    'the deleted file is gone from search, not just from disk');
  assert.ok(!map().tree.some((f) => f.path === 'src/doomed.js'), 'and gone from the file tree');
});

test('search can be scoped to a directory — the glob the UI now sends', async (t) => {
  const { createLensServer } = await import('../src/server.js');
  const { freshness, indexPath } = await import('../src/core.js');

  // paths are stored relative to cwd, so build the tree under one we control
  const dir = mkdtempSync(join(tmpdir(), 'lens-scope-'));
  const prevCwd = process.cwd();
  process.chdir(dir);
  t.after(() => { process.chdir(prevCwd); try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.js'), 'export function widget() { return "kiwi"; }\n');
  writeFileSync(join(dir, 'src', 'deep', 'b.js'), 'export function widget2() { return "kiwi"; }\n');
  writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide\n\nThe widget returns a kiwi.\n');
  indexPath('.');

  const server = createLensServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const paths = (r) => [...new Set(r.results.map((x) => x.path))].sort();
  try {
    const all = await fetch(base + '/api/search?q=kiwi&k=30').then((r) => r.json());
    assert.deepEqual(paths(all), ['docs/guide.md', 'src/a.js', 'src/deep/b.js'], 'unscoped, it searches everything');

    // "src/*" is a GLOB, so it covers the SUBTREE, not just the immediate children
    const scoped = await fetch(base + '/api/search?q=kiwi&k=30&glob=' + encodeURIComponent('src/*')).then((r) => r.json());
    assert.deepEqual(paths(scoped), ['src/a.js', 'src/deep/b.js'], 'the scope covers the subtree and nothing outside it');
    assert.ok(scoped.count < all.count, 'a scope narrows the answer');

    // a scope that matches nothing must find NOTHING — silently searching the whole
    // repo instead would be the dangerous failure
    const none = await fetch(base + '/api/search?q=kiwi&k=30&glob=' + encodeURIComponent('nowhere/*')).then((r) => r.json());
    assert.equal(none.count, 0, 'a scope with no files finds nothing, not everything');
  } finally { server.close(); }
});

// ── A schema that promises a check nobody performs is worse than no schema ───────
test('lens_search with no query says so, instead of crashing three layers down', async () => {
  const { spawn } = await import('node:child_process');
  const out = await new Promise((resolve) => {
    const p = spawn('node', ['mcp/mcp-server.js'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const done = (v) => { try { p.kill('SIGKILL'); } catch {} resolve(v); };
    setTimeout(() => done({}), 10000);
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.id === 3) done(m);
      }
    });
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lens_search', arguments: {} } });
  });

  // It used to answer: "Cannot read properties of undefined (reading 'match')" — a
  // TypeError from inside search(), handed to a model as if it were an answer.
  const msg = out.error?.message || '';
  assert.match(msg, /missing required argument/, 'it names the problem');
  assert.match(msg, /"query"/, 'and the argument');
  assert.match(msg, /looking for/, "and quotes the schema's own description of it, so the fix is in the sentence");
  assert.doesNotMatch(msg, /Cannot read propert|is not a function/, 'and does not leak an internal crash');
});

// ── A confident wrong answer is worse than an error ──────────────────────────────
test('searching before indexing is an ERROR, not "no matches"', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'lens-noidx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // A fresh process with a database that does not exist. Opening it CREATES it — which
  // is why `lens_search` used to answer, cheerfully and authoritatively:
  //     { "count": 0, "results": [] }
  // An agent that forgot to index is told its codebase does not contain the thing it is
  // looking for. It believes that, and moves on. Nothing about a confident empty result
  // invites a second look.
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('node', ['src/cli.js', 'search', 'sqlite'], {
    encoding: 'utf8', env: { ...process.env, LENS_DB: join(dir, 'index.db') },
  });
  const said = r.stdout + r.stderr;
  assert.match(said, /nothing is indexed/i, 'it says the index is empty');
  assert.match(said, /NOT "no matches"/, 'and says explicitly that this is not the same as no matches');
  assert.match(said, /lens index/, 'and names the command that fixes it');
  assert.notEqual(r.status, 0, 'and it is an error, so a caller cannot mistake it for a result');
});

test('...but a genuine zero-result search still says zero', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');

  const dir = mkdtempSync(join(tmpdir(), 'lens-idx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, LENS_DB: join(dir, 'index.db') };

  spawnSync('node', ['src/cli.js', 'index', 'src'], { encoding: 'utf8', env });
  const r = spawnSync('node', ['src/cli.js', 'search', 'zzzznotarealtokenanywhere'], { encoding: 'utf8', env });

  // The guard must not turn an honest "I looked, and it is not there" into an error.
  // That would be the same lie in the other direction.
  assert.equal(r.status, 0, 'an indexed search that finds nothing is a result, not a failure');
  assert.match(r.stdout, /0 hits/, 'and it says so plainly');
});

// ── stdout IS the protocol ──────────────────────────────────────────────────────
// An MCP server speaks newline-delimited JSON-RPC on stdout and NOTHING else.
//
// One console.log anywhere in a code path a tool can reach — a leftover debug line, a
// helpful progress message — puts a line on that stream which is not a message. The
// client desyncs. It does not fail loudly: the call simply never comes back, or comes
// back as the wrong reply to the wrong request, and the agent is left holding a session
// that has quietly stopped working. It is the single easiest way to break an MCP server,
// and the hardest to notice, because everything still LOOKS fine.
//
// A dynamic check cannot cover this: it only sees the code paths it happens to exercise,
// and a debug line inside `search()` is invisible until someone searches. So walk the
// import graph from the server itself and refuse the whole class.
//
// `cli.js` and `server.js` are the CLI and the `serve` command — they are meant to print,
// and the MCP server never imports them. If that ever changes, this test is what tells you.
test('nothing the MCP server can reach is allowed to print to stdout', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { dirname, resolve, relative } = await import('node:path');

  const entry = resolve(import.meta.dirname, '..', 'mcp', 'mcp-server.js');
  const seen = new Set();
  const offenders = [];

  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');

    // The server itself writes the protocol — that is its job. Everything it pulls in must not.
    if (file !== entry) {
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;                       // a comment about it is fine
        if (/console\.(log|info|debug|dir|table)\s*\(|process\.stdout\.write\s*\(/.test(line)) {
          offenders.push(`${relative(process.cwd(), file)}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    }
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      walk(resolve(dirname(file), m[1]));
    }
  };
  walk(entry);

  // agent-hq's MCP server imports nothing local — it is a thin HTTP client over the
  // platform's API — so for it this walk finds only the entry file, and there is genuinely
  // nothing to check. That is not a vacuous pass: it is the guard that fires the day
  // somebody wires the server straight into services.js, which does print.
  assert.ok(seen.size >= 1, 'the entry point was found');
  assert.deepEqual(offenders, [],
    'stdout is the protocol — one stray print desyncs every agent session:\n  ' + offenders.join('\n  '));
});

// ── lens was indexing .env and handing the keys back ────────────────────────────────
test('a repo with secrets in it: lens indexes the code and NOT the credentials', () => {
  // This is the main path, not an edge case: pointing an agent at a repo is the entire
  // purpose of lens. The walk skipped ignored DIRECTORIES but yielded every FILE it met,
  // and a dotfile is just a file — so `lens index .` swallowed .env and `lens search`
  // served it back, in the terminal, in the web UI, and through MCP into a model's
  // context. Twenty green tests never saw it, because no test had ever indexed a repo
  // with a secret in it, and the kit's own repos have no .env.
  const repo = mkdtempSync(join(tmpdir(), 'lens-secrets-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'app.js'), 'export const handler = () => "hello";\n');
  writeFileSync(join(repo, '.env'), 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIexampleKEY\n');
  writeFileSync(join(repo, '.env.production'), 'STRIPE_SECRET=sk_live_51H8xample\n');
  writeFileSync(join(repo, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_sekrit\n');
  writeFileSync(join(repo, 'server.pem'), '-----BEGIN PRIVATE KEY-----\nMIIEv\n');
  writeFileSync(join(repo, 'credentials.json'), '{"private_key":"-----BEGIN PRIVATE KEY-----"}\n');

  const db = join(work, 'secrets.db');
  process.env.LENS_DB = db;
  lens.indexPath(repo);

  // Nothing that looks like a credential may be in the index, under any query.
  for (const q of ['SECRET', 'sk_live', 'authToken', 'PRIVATE KEY', 'AWS']) {
    const { results } = lens.search(q, { max_tokens: 2000 });
    const leaked = results.filter((h) => /\.env|\.npmrc|\.pem|credentials/.test(h.path));
    assert.deepEqual(leaked.map((h) => h.path), [], `searching "${q}" surfaced a credentials file`);
  }

  // …and the actual code is still there, or the fix is just a broken tool.
  const { results: code } = lens.search('handler', { max_tokens: 2000 });
  assert.ok(code.some((h) => h.path.endsWith('app.js')), 'the real source file is still indexed');

  // And it refuses to read one out loud even when asked for by name — `read` is an MCP
  // tool, and "the model asked for it" is not consent from the person whose key it is.
  assert.throws(() => lens.readLines(join(repo, '.env')), /refusing to read/,
    'reading a credentials file by name is refused');

  rmSync(repo, { recursive: true, force: true });
});

test('an index poisoned by the OLD lens is cleaned up on the next run', () => {
  // Fixing the walk protects the next index. It does nothing for the one already on disk:
  // anyone who ran the old lens has their .env sitting in .lens/index.db, and it will keep
  // answering searches with it forever. A fix that only protects new users is half a fix.
  const db = join(work, 'poisoned.db');
  process.env.LENS_DB = db;

  // Forge exactly what the old walk would have left behind.
  run('INSERT OR REPLACE INTO files (path, lang, lines, bytes, mtime, indexed_at) VALUES (?,?,?,?,?,?)',
    '/repo/.env', 'text', 1, 40, 0, new Date(0).toISOString());
  run('INSERT INTO chunks (path, body, lang, start, "end") VALUES (?,?,?,?,?)',
    '/repo/.env', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIexampleKEY', 'text', 1, 1);
  assert.ok(lens.search('wJalrXUtnFEMIexampleKEY', { max_tokens: 500 }).results.length >= 1,
    'precondition: the forged index really does surface the key');

  // Indexing anything at all — even an unrelated directory — must clean it out.
  const other = mkdtempSync(join(tmpdir(), 'lens-other-'));
  writeFileSync(join(other, 'x.js'), 'export const x = 1;\n');
  lens.indexPath(other);

  assert.deepEqual(lens.search('wJalrXUtnFEMIexampleKEY', { max_tokens: 500 }).results, [],
    'the key an earlier lens swallowed is gone from the index');
  rmSync(other, { recursive: true, force: true });
});

// THE DENYLIST IS THE EASY HALF. This is the other one.
//
// Every credential file in the test above (.env, .npmrc, *.pem, credentials.json) is caught
// by NAME. But the rule that actually protects you is the one underneath: a dotfile is
// skipped unless it is explicitly known-safe — "because the next secret filename has not
// been invented yet".
//
// Nothing was guarding that rule. A canary mutant deleted the default-deny outright
// (`name.startsWith('.') && !DOT_ALLOW.has(name)` -> false) and the ENTIRE SUITE STAYED
// GREEN, because every secret in it was on the list anyway. So the half of the fix that
// covers the unknown was covered by nothing.
//
// These three are real credential files, and NOT ONE of them is named by SECRET_FILES or
// matched by SECRET_RE. The default-deny is the only thing standing between them and a
// model's context window.
test('a credential dotfile NOBODY put on the denylist is still not indexed', () => {
  const repo = mkdtempSync(join(tmpdir(), 'lens-unknown-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repo, 'src', 'app.js'), 'export const handler = () => "hello";\n');
  writeFileSync(join(repo, '.pypirc'), '[pypi]\nusername = __token__\npassword = pypi-AgEIcHlwaSZEKRET\n');
  writeFileSync(join(repo, '.dockercfg'), '{"auths":{"registry.io":{"auth":"aGVsbG86ZG9ja2VyU0VLUklU"}}}\n');
  writeFileSync(join(repo, '.terraformrc'), 'credentials "app.terraform.io" { token = "SEKRETtfcloud" }\n');
  // …and a dotfile that IS known-safe must still be read, or the rule is just a broken tool.
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci\njobs:\n  test:\n    runs-on: ubuntu-latest\n');

  process.env.LENS_DB = join(work, 'unknown-dotfiles.db');
  lens.indexPath(repo);

  for (const q of ['SEKRET', 'pypi-AgEIcHlwaSZEKRET', 'token', 'auths', 'password']) {
    const { results } = lens.search(q, { max_tokens: 2000 });
    const leaked = results.filter((h) => /\.pypirc|\.dockercfg|\.terraformrc/.test(h.path));
    assert.deepEqual(leaked.map((h) => h.path), [],
      `searching "${q}" surfaced a credential dotfile that is on no denylist`);
  }

  const { results: code } = lens.search('handler', { max_tokens: 2000 });
  assert.ok(code.some((h) => h.path.endsWith('app.js')), 'the real source is still indexed');

  const { results: yml } = lens.search('ubuntu-latest', { max_tokens: 2000 });
  assert.ok(yml.some((h) => h.path.includes('.github')),
    'a KNOWN-SAFE dotdir is still indexed — default-deny must not mean deny-everything');

  rmSync(repo, { recursive: true, force: true });
});

// lens EXISTS TO GIVE AN AGENT *YOUR* CODE — not the code of four hundred strangers.
//
// The walk skips node_modules, dist, build, .git and friends. NOTHING WAS GUARDING THAT: a
// canary deleted the IGNORE_DIRS check outright and the whole suite stayed green, because no
// test had ever indexed a tree that HAD a node_modules in it.
//
// Note which entries actually prove the rule. `.git` is caught anyway by the dotfile
// default-deny, so it proves nothing here. `node_modules` and `dist` have NO DOT: the ignore
// list is the only thing standing between them and every search result an agent ever gets.
//
// Without it lens indexes a few thousand vendor files, every query comes back full of library
// internals, and the token budget — the entire point of the tool — is spent on somebody else's
// code.
test('a repo with node_modules and build output: lens indexes YOUR code and not the vendors', () => {
  const repo = mkdtempSync(join(tmpdir(), 'lens-vendors-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'left-pad'), { recursive: true });
  mkdirSync(join(repo, 'dist'), { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });

  writeFileSync(join(repo, 'src', 'app.js'), 'export const ZZMINE = () => "the code I wrote";\n');
  writeFileSync(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = function ZZVENDOR() {};\n');
  writeFileSync(join(repo, 'dist', 'bundle.js'), 'var ZZVENDOR=function(){};\n');
  writeFileSync(join(repo, '.git', 'COMMIT_EDITMSG'), 'ZZVENDOR wip\n');

  process.env.LENS_DB = join(work, 'vendors.db');
  lens.indexPath(repo);

  const { results: mine } = lens.search('ZZMINE', { max_tokens: 2000 });
  assert.ok(mine.some((h) => h.path.endsWith('app.js')), 'your own source is indexed');

  const { results: theirs } = lens.search('ZZVENDOR', { max_tokens: 2000 });
  assert.deepEqual(theirs.map((h) => h.path), [],
    'node_modules, dist and .git are not your code and must never reach a search result');

  // NB: the tests share one index, so a bare stats().files count measures the wrong
  // population (my first cut asserted 1 and got 8 — other tests' trees). Assert the property
  // itself: NOTHING from a vendor directory may be in the index, under any path.
  const indexed = lens.map().tree.map((f) => f.path);
  const vendored = indexed.filter((p) => /(^|\/)(node_modules|dist|build|\.git)(\/|$)/.test(p));
  assert.deepEqual(vendored, [], 'not one vendor or build-output file is in the index');
  assert.ok(indexed.some((p) => p.endsWith('app.js')), 'and your own file is');
  rmSync(repo, { recursive: true, force: true });
});
