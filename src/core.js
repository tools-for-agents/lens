// lens core — index, search, outline and surgical read. Built so an agent can
// pull *just enough* context instead of reading whole files. Token-budgeted.
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, relative, resolve, sep } from 'node:path';
import { writeDb, get, all, run, DB_PATH, storeExists, atomically } from './db.js';

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.lens', 'dist', 'build', 'out',
  '.next', 'coverage', 'vendor', 'target', '.venv', 'venv', '__pycache__', 'data', '.cache']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip',
  '.gz', '.tar', '.mp4', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.eot', '.so', '.dylib',
  '.o', '.a', '.bin', '.exe', '.class', '.jar', '.lock', '.db', '.wasm']);
// LENS WAS INDEXING YOUR .env AND HANDING THE KEYS BACK IN SEARCH RESULTS.
//
// The walk skipped ignored DIRECTORIES, but it yielded every FILE it met — and a dotfile
// is just a file. So `lens index .` on any ordinary repo swallowed .env, .env.local,
// .npmrc, id_rsa, credentials — and then `lens search secret` served them up, in the
// terminal, in the web UI, and through MCP straight into a model's context window.
//
//     ▸ /repo/.env:1-3  [text]  ~24tok
//     AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
//     STRIPE_SECRET=sk_live_51H8xample
//
// That is the whole point of lens — pointing an agent at a repo — so this was not an edge
// case, it was the main path. Twenty green tests and seven CI gates never saw it, because
// no test had ever indexed a repo with a secret in it. The kit's own repos have no .env,
// so it worked perfectly on the only trees it was ever run against.
//
// Rule: a secret is not "code an agent needs to read". Dotfiles are skipped unless they are
// explicitly known-safe, and known credential filenames are skipped whether or not they
// carry a dot. This is a denylist AND a default-deny on dotfiles, because the next secret
// filename has not been invented yet.
const DOT_ALLOW = new Set(['.github', '.gitlab', '.vscode', '.config']);
const SECRET_FILES = new Set([
  '.env', '.npmrc', '.netrc', '.pgpass', '.htpasswd', 'credentials', 'id_rsa', 'id_dsa',
  'id_ecdsa', 'id_ed25519', 'secrets.json', 'secrets.yaml', 'secrets.yml',
  'credentials.json', 'service-account.json', 'serviceaccount.json',
]);
const SECRET_RE = /^\.env(\..*)?$|^\.?secrets?[-_.]|\.(pem|key|p8|pk8|p12|pfx|keystore|jks|ppk)$|(^|[-_.])credentials?([-_.]|$)/i;

export function isSecretPath(name) {
  const n = String(name);
  return SECRET_FILES.has(n) || SECRET_RE.test(n);
}

// A dotfile is skipped unless it is on the allow list. `.env.production` is a dotfile;
// so is the next one somebody invents.
function skipEntry(name, isDir) {
  if (IGNORE_DIRS.has(name)) return true;
  if (isSecretPath(name)) return true;
  if (name.startsWith('.') && !DOT_ALLOW.has(name)) return true;
  return false;
}

const MAX_BYTES = 1_500_000;
// Average line length at or past which a file is generated, not written. Measured, not guessed: the
// highest average in any real file across all 7 repos of this kit is 106 chars (a README); a minified
// bundle runs to hundreds of thousands. 2000 leaves a 19× margin and is not a close call in either
// direction, on purpose — a checker that fires on correct work teaches you to skim past it.
const MINIFIED_AVG_LINE = 2000;
const CHUNK_LINES = 50;
const OVERLAP = 6;

const LANG = { '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.rb': 'ruby', '.php': 'php', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp', '.swift': 'swift', '.kt': 'kotlin', '.sh': 'shell', '.sql': 'sql',
  '.md': 'markdown', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.html': 'html', '.css': 'css', '.scss': 'css', '.vue': 'vue', '.svelte': 'svelte' };

export const estTokens = (s) => Math.ceil(s.length / 4);
const langOf = (p) => LANG[extname(p).toLowerCase()] || 'text';

function isBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function* walk(dir, root) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    // One rule, applied to files and directories alike. The old code had TWO checks — a
    // dead one for dotfiles that only ever consulted the directory ignore-list, and a real
    // one that ran for directories only. Files walked straight through both.
    if (skipEntry(e.name, e.isDirectory())) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, root);
    else if (e.isFile()) yield full;
  }
}

// ── Indexing ────────────────────────────────────────────────────────────────
export function indexPath(target, { reindex = false } = {}) {
  const root = resolve(target);
  let st;
  try { st = statSync(root); } catch { throw new Error(`path not found: ${target}`); }
  // Naming a secret file directly gets the same refusal as reading one. Fixing the walk
  // stops lens FINDING them; this stops it being handed one.
  if (!st.isDirectory() && isSecretPath(root.split(sep).pop())) {
    throw new Error(`refusing to index ${root.split(sep).pop()}: that looks like a credentials file.`);
  }
  const files = st.isDirectory() ? [...walk(root, root)] : [root];
  let indexed = 0, skipped = 0, chunks = 0;
  const generated = [];   // minified/generated files lens declined to chunk — reported, never silent

  const d = writeDb();
  const tx = d.prepare.bind(d);

  // AND EVICT THE SECRETS AN EARLIER LENS ALREADY SWALLOWED.
  //
  // Fixing the walk protects the next index. It does nothing for the one already on disk:
  // anyone who ran the old lens has an .lens/index.db with their .env inside it, and it
  // will keep answering searches with it forever. A fix that only protects new users is
  // half a fix. So every index run also cleans up after the version that came before it.
  // No blanket catch here. The first cut of this had one, and it swallowed my own bug:
  // `run` is variadic, I passed an array, it threw "Unknown named parameter", and the
  // catch ate it — so the eviction silently did nothing and the secrets stayed searchable
  // while the code claimed to be removing them. A cleanup that fails quietly is worse than
  // no cleanup: it is a promise that the keys are gone when they are not.
  let evicted = 0;
  for (const row of all('SELECT DISTINCT path FROM files')) {
    if (!isSecretPath(String(row.path).split(sep).pop())) continue;
    run('DELETE FROM chunks WHERE path = ?', row.path);
    run('DELETE FROM files WHERE path = ?', row.path);
    evicted++;
  }
  if (evicted) {
    process.stderr.write(`lens: evicted ${evicted} credential file(s) that an earlier version had indexed. `
      + `They were searchable until now — rotate anything that was in them.\n`);
  }
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    if (BINARY_EXT.has(ext)) { skipped++; continue; }
    let s;
    try { s = statSync(file); } catch { continue; }
    if (s.size > MAX_BYTES || s.size === 0) { skipped++; continue; }
    const rel = relative(process.cwd(), file) || file;

    const prev = get(`SELECT mtime FROM files WHERE path=?`, rel);
    if (!reindex && prev && prev.mtime === Math.floor(s.mtimeMs)) { skipped++; continue; }

    let buf;
    try { buf = readFileSync(file); } catch { continue; }
    if (isBinary(buf)) { skipped++; continue; }
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    const lang = langOf(file);

    // 🔑 LENS CHUNKS BY LINES. For a minified bundle, a line is not a meaningful unit — the whole
    // file is ONE line — so the chunker yields ONE chunk that IS THE WHOLE FILE: precisely the thing
    // lens exists to keep out of your context window. A 1.4MB bundle.min.js (legal — under MAX_BYTES)
    // became a single 350,003-token chunk that tied on bm25 with the real code and won the tiebreak
    // by luck, so a search either got you useful code or a blob of minified junk, at random.
    //
    // The budget truncation in search() is the hard guarantee and holds for ANY pathological file.
    // This is the root cause: generated output is not your code, exactly as node_modules is not your
    // code. Validated against all 7 repos of this kit before shipping — 176 files, zero flagged.
    // And it is REPORTED, never silent: "I did not index that" and "your code does not contain that"
    // are opposite facts, and the second is the one thing lens must never say by accident.
    if (lines.length && s.size / lines.length >= MINIFIED_AVG_LINE) {
      generated.push(rel); skipped++; continue;
    }

    // DELETE-then-INSERT, as ONE transaction. Apart, a search landing between them sees this file
    // with ZERO chunks and answers "your code does not contain that" — for code that is right there.
    // A reader sees the OLD chunks or the NEW ones, never neither. (See `atomically` in db.js.)
    atomically(() => {
      run(`DELETE FROM chunks WHERE path=?`, rel);
      for (let i = 0; i < lines.length; i += (CHUNK_LINES - OVERLAP)) {
        const slice = lines.slice(i, i + CHUNK_LINES);
        if (!slice.join('').trim()) continue;
        const body = slice.join('\n');
        run(`INSERT INTO chunks (path, body, lang, start, "end") VALUES (?,?,?,?,?)`,
          rel, body, lang, i + 1, Math.min(i + CHUNK_LINES, lines.length));
        chunks++;
        if (i + CHUNK_LINES >= lines.length) break;
      }
      run(`INSERT INTO files (path,lang,lines,bytes,mtime,indexed_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(path) DO UPDATE SET lang=excluded.lang, lines=excluded.lines,
             bytes=excluded.bytes, mtime=excluded.mtime, indexed_at=excluded.indexed_at`,
        rel, lang, lines.length, s.size, Math.floor(s.mtimeMs), new Date().toISOString());
    });
    indexed++;
  }

  // Forget files that are gone. Indexing only ever added or updated, so a deleted
  // file stayed in the index forever — still listed in the tree, still returned by
  // search, pointing at nothing. An index that never forgets is an index that lies.
  let removed = 0;
  if (st.isDirectory()) {
    const onDisk = new Set(files.map((f) => relative(process.cwd(), f) || f));
    const prefix = relative(process.cwd(), root);
    for (const r of all(`SELECT path FROM files`)) {
      const under = !prefix || prefix === '' || r.path === prefix || r.path.startsWith(prefix + '/');
      if (!under || onDisk.has(r.path)) continue;
      run(`DELETE FROM chunks WHERE path=?`, r.path);
      run(`DELETE FROM files WHERE path=?`, r.path);
      removed++;
    }
  }
  // Never silent. A file lens declined is a file lens will answer "not found" about, and
  // "I did not index that" and "your code does not contain that" are opposite facts.
  if (generated.length) {
    process.stderr.write(`lens: skipped ${generated.length} generated/minified file(s) — a line is not a `
      + `meaningful unit in them, so they chunk to one enormous blob:\n  ${generated.slice(0, 5).join('\n  ')}\n`
      + (generated.length > 5 ? `  …and ${generated.length - 5} more\n` : ''));
  }
  return { indexed, skipped, removed, chunks, generated, total_files: stats().files };
}

// Is the index still telling the truth about the tree? Compares what was indexed
// against what is on disk now — so the web view can say "3 files changed since you
// indexed" instead of quietly serving a stale answer.
export function freshness(target = '.') {
  const root = resolve(target);
  let st;
  try { st = statSync(root); } catch { return { ok: false, error: `path not found: ${target}` }; }

  const onDisk = new Map();
  const files = st.isDirectory() ? [...walk(root, root)] : [root];
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (BINARY_EXT.has(ext)) continue;
    let s; try { s = statSync(f); } catch { continue; }
    if (s.size > MAX_BYTES || s.size === 0) continue;
    onDisk.set(relative(process.cwd(), f) || f, Math.floor(s.mtimeMs));
  }

  const indexed = new Map(all(`SELECT path, mtime FROM files`).map((r) => [r.path, r.mtime]));
  const changed = [], added = [], removed = [];
  for (const [path, mtime] of onDisk) {
    if (!indexed.has(path)) added.push(path);
    else if (indexed.get(path) !== mtime) changed.push(path);
  }
  // `added`/`changed` come from onDisk, which is already only the files under `root` — but `removed`
  // iterates the WHOLE index, so it must be scoped the same way, or a freshness check aimed at a
  // subdirectory reports every file OUTSIDE it as "removed since you indexed": a false "N files vanished",
  // naming files that are right there, and (per this tool's own advice) telling the agent to reindex for
  // nothing. A file outside `target` is not removed — it is out of scope. This is the SAME prefix guard
  // indexPath uses before it evicts (it must not delete files outside the path it was given); the read
  // side has to agree with the write side.
  const prefix = relative(process.cwd(), root);
  for (const path of indexed.keys()) {
    const under = !prefix || prefix === '' || path === prefix || path.startsWith(prefix + '/');
    if (under && !onDisk.has(path)) removed.push(path);
  }

  return {
    ok: true,
    stale: changed.length + added.length + removed.length,
    changed: changed.slice(0, 50), added: added.slice(0, 50), removed: removed.slice(0, 50),
    counts: { changed: changed.length, added: added.length, removed: removed.length },
    indexed_files: indexed.size,
  };
}

// ── Search ──────────────────────────────────────────────────────────────────
// FTS5 MATCH with bm25 ranking. Returns token-budgeted, ranked snippets.
function ftsQuery(q) {
  // turn a free-text query into a safe FTS5 OR query of bare terms. \p{L}\p{N} (not
  // [A-Za-z0-9]) so a query in any script — Turkish, Cyrillic, CJK — tokenizes the SAME
  // way unicode61 indexed the code; ASCII-only stripped every non-Latin term to nothing.
  const terms = q.match(/[\p{L}\p{N}_]+/gu) || [];
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"`).join(' OR ');
}

// "Nothing is indexed" and "your code does not contain that" are the same sentence to a
// caller, and they could not be more different. Opening a missing database CREATES it, so
// a search before an index answered — cheerfully, authoritatively —
//
//     { "count": 0, "results": [] }
//
// An agent that forgets to index is told its codebase does not contain the thing it is
// looking for, and believes it, and moves on. A confident wrong answer is worse than an
// error, because nothing about it invites a second look.
function requireIndex() {
  const n = get(`SELECT COUNT(*) n FROM files`)?.n ?? 0;
  if (n > 0) return;
  throw new Error(
    `nothing is indexed (${DB_PATH}), so there is nothing to search — this is NOT "no matches". `
    + `Index a directory first:  lens index <path>   (MCP: lens_index { path })`);
}

// A GLOB THAT MATCHES NO INDEXED FILE IS A MISTAKE, NOT AN ANSWER.
//
// The same reasoning as requireIndex above, one level in. `path_glob` is a FILTER, and a filter that is
// wrong looks EXACTLY like code that is not there: both are "0 hits". The difference matters — one means
// "look elsewhere", the other means "your search was malformed" — and lens said the same thing for both.
//
// 🔑 SQLITE GLOB IS NOT MINIMATCH. There is no {a,b} brace expansion, so `src/**/*.{js,ts}` — the glob
// every JS tool (minimatch, globby, gitignore) teaches an agent to write — matches NOTHING. Measured:
// `*.{js,md}` returned 0 hits over a tree where `*.js` returned 2, and the two answers were identical.
// An agent reads that as "your code does not contain that" and stops looking at code that is right there.
//
// Globs are infinite, but the INDEXED PATHS ARE A KNOWABLE FINITE SET — which is exactly what lets us
// tell a wrong filter from an honest absence. Note the check is against the indexed paths, NOT the query
// results: scoping to a real subtree that holds no match is a legitimate "no matches" and stays quiet.
function requireGlobMatches(path_glob) {
  const n = get(`SELECT COUNT(*) n FROM files WHERE path GLOB ?`, path_glob)?.n ?? 0;
  if (n > 0) return;
  const sample = all(`SELECT path FROM files ORDER BY path LIMIT 3`).map((r) => r.path);
  const braces = /[{}]/.test(path_glob)
    ? ' SQLite GLOB has no {a,b} brace expansion — use one glob per search, or a prefix like "src/*".'
    : '';
  throw new Error(
    `no indexed file matches path_glob "${path_glob}" — this is NOT "no matches", the FILTER is wrong.${braces}`
    + ` Indexed paths look like: ${sample.join(', ')}`);
}

export function search(query, { k = 8, max_tokens = 1800, path_glob } = {}) {
  requireIndex();
  // before the query is even parsed: a filter that can match nothing makes every later answer a lie
  if (path_glob) requireGlobMatches(path_glob);
  // Harden numeric args: bad input (NaN from a non-numeric query param, ≤0)
  // falls back to the default. Unguarded, NaN k makes the SQL `LIMIT ?` bind
  // fail (→ error result) and `results.length >= NaN` never break / the budget
  // check `tokens + t > NaN` never skip — so the whole index over-returns.
  k = Number.isFinite(+k) && +k > 0 ? Math.floor(+k) : 8;
  max_tokens = Number.isFinite(+max_tokens) && +max_tokens > 0 ? Math.floor(+max_tokens) : 1800;
  const m = ftsQuery(query);
  if (!m) return { query, results: [], tokens: 0 };
  let sql = `SELECT path, body, lang, start, "end", bm25(chunks) AS score
             FROM chunks WHERE chunks MATCH ?`;
  const args = [m];
  if (path_glob) { sql += ` AND path GLOB ?`; args.push(path_glob); }
  // 🔑 bm25 score IS NOT UNIQUE — two chunks with the same term frequencies and length score
  // identically, and ORDER BY a tie falls to rowid, which a re-index changes. Tie-break on the
  // chunk's stable identity, (path, start): unique, and the same across a re-index (chunking is
  // deterministic), which rowid is not. Same class of fix as the timestamp orderings elsewhere.
  sql += ` ORDER BY score, path, start LIMIT ?`; args.push(Math.max(k * 3, 24));
  let rows;
  try { rows = all(sql, ...args); } catch (e) { return { query, error: String(e.message), results: [] }; }

  const results = [];
  let tokens = 0, squeezed = 0;
  for (const r of rows) {
    const t = estTokens(r.body);
    if (results.length >= k) break;
    if (tokens + t > max_tokens && results.length > 0) { squeezed++; continue; }
    // 🔑 `results.length > 0` is the budget's ONE escape hatch: never come back empty just because
    // the top hit is a little over. That is right for an ordinary ~200-token chunk — and it is the
    // hatch a 350,000-TOKEN RESULT WALKS THROUGH. lens chunks by LINES, and a minified bundle is
    // ONE LINE, so a 1.4MB file (legal: under MAX_BYTES) is ONE 1.4MB chunk. bm25 ranks it FIRST
    // (35,278 hits of the term), so it is always the one taking the free pass, and it evicts every
    // useful result behind it: a 1,800-token budget returned 350,003 tokens — 194× over — and the
    // small, actually-useful hit never came back at all.
    //
    // lens exists to keep whole files OUT of the context window. Handing back MORE tokens than the
    // file you were avoiding is not a slow search; it is the tool doing the opposite of its purpose.
    // The hatch must return SOMETHING, not EVERYTHING: cut the body to the budget, and SAY SO — a
    // chunk cut in half must never claim to be whole (the same contract as scout's page truncation).
    const cut = Math.max(0, max_tokens - tokens) * 4;
    const over = t > estTokens(r.body.slice(0, cut));
    const body = over ? r.body.slice(0, cut) : r.body;
    const hit = { path: r.path, start: r.start, end: r.end, lang: r.lang,
      score: Math.round(r.score * 1000) / 1000, tokens: estTokens(body), body };
    if (over) { hit.truncated = true; hit.chunk_tokens = t; }
    results.push(hit);
    tokens += hit.tokens;
  }

  // How many chunks actually matched — not how many survived. Without this a
  // caller cannot tell "6 hits exist" from "6 of 40 hits fit the budget", and a
  // budget that hides results while claiming to be complete is worse than no
  // budget at all. Counted over the same MATCH (+glob), so it is the whole truth,
  // not just the k*3 candidate window.
  let matched = results.length;
  try {
    let csql = `SELECT COUNT(*) n FROM chunks WHERE chunks MATCH ?`;
    const cargs = [m];
    if (path_glob) { csql += ` AND path GLOB ?`; cargs.push(path_glob); }
    matched = get(csql, ...cargs)?.n ?? 0;
  } catch { /* keep the floor */ }

  const withheld = Math.max(0, matched - results.length);
  // Which ceiling actually bound? Raising the wrong one changes nothing, so say
  // it plainly: if the budget squeezed anything out it is the budget; otherwise
  // we stopped because we hit k.
  const limited_by = withheld === 0 ? null : squeezed > 0 ? 'budget' : 'k';
  return { query, count: results.length, tokens, results,
    matched, withheld, limited_by, budget: max_tokens, k };
}

// ── Find references ───────────────────────────────────────────────────────────
// Every line across the index that mentions a symbol, grouped by file. FTS finds
// candidate chunks; we then scan their lines for a whole-word match (deduping the
// overlap between adjacent chunks). Cheap, exact, and clickable — code navigation.
export function references(symbol, { limit = 400 } = {}) {
  requireIndex();   // "no references to that symbol" and "nothing is indexed" are not the same answer
  // bad limit (NaN → never truncates; 0 → truncates on the first ref) → default
  limit = Number.isFinite(+limit) && +limit > 0 ? Math.floor(+limit) : 400;
  const term = (String(symbol).match(/[\p{L}\p{N}_]+/u) || [])[0];
  if (!term) return { symbol: null, count: 0, files: [] };
  let rows;
  try { rows = all(`SELECT path, body, lang, start FROM chunks WHERE chunks MATCH ? ORDER BY path, start`, `"${term}"`); }
  catch (e) { return { symbol: term, count: 0, files: [], error: String(e.message) }; }

  const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const byFile = new Map();
  const seen = new Set();          // path:line — adjacent chunks overlap, so dedupe
  let count = 0, truncated = false;
  for (const r of rows) {
    const lines = r.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const lineNo = r.start + i;
      const key = r.path + ':' + lineNo;
      if (seen.has(key)) continue;
      seen.add(key);
      if (count >= limit) { truncated = true; break; }
      if (!byFile.has(r.path)) byFile.set(r.path, { path: r.path, lang: r.lang, refs: [] });
      byFile.get(r.path).refs.push({ line: lineNo, text: lines[i].trim().slice(0, 200) });
      count++;
    }
    if (truncated) break;
  }
  const files = [...byFile.values()]
    .map((f) => ({ ...f, refs: f.refs.sort((a, b) => a.line - b.line) }))
    .sort((a, b) => b.refs.length - a.refs.length || a.path.localeCompare(b.path));
  return { symbol: term, count, files: files.length, groups: files, truncated };
}

// ── Outline ─────────────────────────────────────────────────────────────────
const OUTLINE_RE = {
  javascript: [/^\s*(export\s+)?(default\s+)?(async\s+)?(function\*?)\s+([\w$]+)/,
    /^\s*(export\s+)?(abstract\s+)?class\s+([\w$]+)/,
    /^\s*(export\s+)?(const|let|var)\s+([\w$]+)\s*=\s*(async\s*)?\(/,
    /^\s*(export\s+)?(interface|type|enum)\s+([\w$]+)/,
    /^\s*([\w$]+)\s*\([^)]*\)\s*\{/],
  python: [/^\s*(async\s+)?def\s+\w+/, /^\s*class\s+\w+/],
  go: [/^func\s/, /^type\s+\w+\s/],
  rust: [/^\s*(pub\s+)?(async\s+)?(fn|struct|enum|trait|impl|mod)\s/],
  java: [/^\s*(public|private|protected|static|\s)*(class|interface|enum|void|[\w<>\[\]]+)\s+\w+\s*\(/,
    /^\s*(public|private|protected)?\s*(class|interface|enum)\s+\w+/],
  ruby: [/^\s*(def|class|module)\s+\w+/],
  markdown: [/^#{1,6}\s+\S/],
  sql: [/^\s*(CREATE|ALTER)\s+(TABLE|VIEW|INDEX|FUNCTION)/i],
};
OUTLINE_RE.typescript = OUTLINE_RE.javascript;
OUTLINE_RE.cpp = OUTLINE_RE.c = OUTLINE_RE.java;

const CTRL_KW = /^\s*(if|for|while|switch|catch|return|else|do|try|with|await|throw)\b/;

// Classify an outline symbol by its declaration line — powers the web outline's
// kind filter (function / class / type / const / heading / …). Best-effort, cross-language.
export function symbolKind(text, lang) {
  const s = String(text);
  if (lang === 'markdown' || /^#{1,6}\s/.test(s)) return 'heading';
  if (/^\s*(CREATE|ALTER)\s+/i.test(s)) return 'table';
  if (/^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s/.test(s)) return 'class';
  if (/^\s*(pub\s+)?(export\s+)?(interface|type|enum|struct|trait)\s/.test(s)) return 'type';
  if (/^\s*(module|mod)\s/.test(s)) return 'module';
  if (/^\s*(pub\s+)?(export\s+)?(default\s+)?(async\s+)?(function|def|func|fn)\b/.test(s)) return 'function';
  if (/^\s*(export\s+)?(const|let|var)\s/.test(s)) {
    return (/=>/.test(s) || /=\s*(async\s+)?function\b/.test(s) || /=\s*(async\s*)?\(/.test(s)) ? 'function' : 'const';
  }
  if (/^\s*(public|private|protected|static|[\w$<>[\].]+)\s+[\w$]+\s*\(/.test(s)) return 'function';  // typed / java-ish method
  if (/^\s*[\w$]+\s*\([^)]*\)\s*\{/.test(s)) return 'function';                                        // bare method
  return 'other';
}

export function outline(path) {
  let text;
  try { text = readFileSync(resolve(path), 'utf8'); } catch { throw new Error(`cannot read ${path}`); }
  const lang = langOf(path);
  const res = OUTLINE_RE[lang] || [/^\s*(function|def|class|func|fn|type|interface|module)\s/];
  const lines = text.split('\n');
  const symbols = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 240) continue;
    if (CTRL_KW.test(line)) continue;        // skip control-flow that looks like a call
    if (res.some((re) => re.test(line))) symbols.push({ line: i + 1, text: line.trim().slice(0, 160), kind: symbolKind(line, lang) });
  }
  return { path, lang, lines: lines.length, symbols };
}

// ── Surgical read ─────────────────────────────────────────────────────────────
// 🔑 A LINE-WINDOW IS NOT A BYTE-WINDOW. readLines bounds how many LINES it returns (60 by default),
// which silently assumes a line is small. In generated output it is not: `lens_read('bundle.min.js',
// 1, 1)` — the SMALLEST possible read, a single line — returned 350,000 TOKENS, with no truncated
// flag. And the index-time skip does not protect this path: readLines reads from DISK BY PATH, so an
// agent that got the path any other way (ls, a stack trace, a grep) walks straight in. Two doors,
// one guard. Bound the bytes too, and SAY when it was cut.
const READ_MAX_TOKENS = 4000;   // ~16KB: generous for 60 lines of real code, fatal to nothing real

export function readLines(path, start = 1, end, { max_tokens = READ_MAX_TOKENS } = {}) {
  max_tokens = Number.isFinite(+max_tokens) && +max_tokens > 0 ? Math.floor(+max_tokens) : READ_MAX_TOKENS;
  // bad start/end (NaN from a non-numeric query param) would make Math.max(1,NaN)
  // NaN → NaN line numbers and a broken slice; coerce to sane integers first.
  start = Number.isFinite(+start) && +start >= 1 ? Math.floor(+start) : 1;
  end = Number.isFinite(+end) && +end >= 1 ? Math.floor(+end) : undefined;
  // And refuse to read one out loud even when asked by name. Keeping secrets out of the
  // INDEX stops lens volunteering them; this stops it handing them over on request. `read`
  // is an MCP tool — the caller is a model, which can be talked into asking for anything,
  // and "the agent asked for it" is not consent from the person whose key it is.
  const base = resolve(path).split(sep).pop();
  if (isSecretPath(base)) {
    throw new Error(`refusing to read ${base}: that looks like a credentials file, and lens hands what it `
      + `reads to a model. If you truly need it, open it yourself — this tool will not be the one that leaks it.`);
  }

  let text;
  try { text = readFileSync(resolve(path), 'utf8'); } catch { throw new Error(`cannot read ${path}`); }
  const lines = text.split('\n');
  const s = Math.max(1, start);
  let e = Math.min(lines.length, end || start + 60);
  if (e < s) e = Math.min(lines.length, s + 60);   // an end before start → a default window from start, not an empty read
  const full = lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join('\n');
  const over = estTokens(full) > max_tokens;
  // Never a silent cut. A read that was truncated and does not say so is a read the caller believes
  // is the whole thing — and it will reason about the code it cannot see as though it were not there.
  const body = over
    ? full.slice(0, max_tokens * 4) + `\n\n…[truncated at ${max_tokens} tokens — raise max_tokens, or narrow the line range]`
    : full;
  const out = { path, start: s, end: e, total_lines: lines.length, tokens: estTokens(body), body };
  if (over) { out.truncated = true; out.full_tokens = estTokens(full); }
  return out;
}

// ── Repo map + stats ──────────────────────────────────────────────────────────
export function map({ limit = 400 } = {}) {
  // bad limit (NaN → SQLite `LIMIT ?` bind throws "datatype mismatch"; −1 → LIMIT −1 dumps every file) → default
  limit = Number.isFinite(+limit) && +limit > 0 ? Math.floor(+limit) : 400;
  const total = get(`SELECT COUNT(*) n FROM files`)?.n ?? 0;
  const rows = all(`SELECT path, lang, lines, bytes FROM files ORDER BY path LIMIT ?`, limit);
  // token estimate per file (≈4 chars/token, same ratio as estTokens) — the web
  // tree sizes a weight bar by it so heavy-to-read files stand out
  for (const r of rows) r.tokens = Math.ceil((r.bytes || 0) / 4);
  // by_lang counts EVERY indexed file, not just the page shown. Counting only the first `limit` rows made
  // the language breakdown a wrong summary of the repo the moment the tree was capped — and it is cheap to
  // get right with its own GROUP BY.
  const byLang = {};
  for (const r of all(`SELECT lang, COUNT(*) n FROM files GROUP BY lang`)) byLang[r.lang] = r.n;
  // `files` is the TRUE count; `shown` is how many rows are in the tree. Capping the tree is fine — but
  // reporting the capped length AS the file count was a silent truncation: an agent sizing up a 5,000-file
  // repo was handed "400" with nothing to say the other 4,600 existed. Say the total, and flag the cut.
  return { files: total, shown: rows.length, truncated: total > rows.length, by_lang: byLang, tree: rows };
}

export function stats() {
  return {
    files: get(`SELECT COUNT(*) n FROM files`)?.n ?? 0,
    chunks: get(`SELECT COUNT(*) n FROM chunks`)?.n ?? 0,
    total_lines: get(`SELECT COALESCE(SUM(lines),0) n FROM files`)?.n ?? 0,
    languages: all(`SELECT lang, COUNT(*) n FROM files GROUP BY lang ORDER BY n DESC`),
  };
}

// Is this path part of the current index? Guards the serve endpoints so
// outline/read can only touch files lens actually indexed (no path traversal).
export function isIndexed(path) {
  return !!get(`SELECT 1 FROM files WHERE path=?`, path);
}

export function fileMeta(path) {
  return get(`SELECT path, lang, lines, bytes, indexed_at FROM files WHERE path=?`, path);
}
