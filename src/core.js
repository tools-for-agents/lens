// lens core — index, search, outline and surgical read. Built so an agent can
// pull *just enough* context instead of reading whole files. Token-budgeted.
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, relative, resolve, sep } from 'node:path';
import { db, get, all, run } from './db.js';

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.lens', 'dist', 'build', 'out',
  '.next', 'coverage', 'vendor', 'target', '.venv', 'venv', '__pycache__', 'data', '.cache']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip',
  '.gz', '.tar', '.mp4', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.eot', '.so', '.dylib',
  '.o', '.a', '.bin', '.exe', '.class', '.jar', '.lock', '.db', '.wasm']);
const MAX_BYTES = 1_500_000;
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
    if (e.name.startsWith('.') && e.name !== '.github') {
      if (IGNORE_DIRS.has(e.name)) continue;
    }
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      yield* walk(full, root);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

// ── Indexing ────────────────────────────────────────────────────────────────
export function indexPath(target, { reindex = false } = {}) {
  const root = resolve(target);
  let st;
  try { st = statSync(root); } catch { throw new Error(`path not found: ${target}`); }
  const files = st.isDirectory() ? [...walk(root, root)] : [root];
  let indexed = 0, skipped = 0, chunks = 0;

  const tx = db.prepare.bind(db);
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
    indexed++;
  }
  return { indexed, skipped, chunks, total_files: stats().files };
}

// ── Search ──────────────────────────────────────────────────────────────────
// FTS5 MATCH with bm25 ranking. Returns token-budgeted, ranked snippets.
function ftsQuery(q) {
  // turn a free-text query into a safe FTS5 OR query of bare terms
  const terms = q.match(/[A-Za-z0-9_]+/g) || [];
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"`).join(' OR ');
}

export function search(query, { k = 8, max_tokens = 1800, path_glob } = {}) {
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
  sql += ` ORDER BY score LIMIT ?`; args.push(Math.max(k * 3, 24));
  let rows;
  try { rows = all(sql, ...args); } catch (e) { return { query, error: String(e.message), results: [] }; }

  const results = [];
  let tokens = 0;
  for (const r of rows) {
    const t = estTokens(r.body);
    if (results.length >= k) break;
    if (tokens + t > max_tokens && results.length > 0) continue;
    results.push({ path: r.path, start: r.start, end: r.end, lang: r.lang,
      score: Math.round(r.score * 1000) / 1000, tokens: t, body: r.body });
    tokens += t;
  }
  return { query, count: results.length, tokens, results };
}

// ── Find references ───────────────────────────────────────────────────────────
// Every line across the index that mentions a symbol, grouped by file. FTS finds
// candidate chunks; we then scan their lines for a whole-word match (deduping the
// overlap between adjacent chunks). Cheap, exact, and clickable — code navigation.
export function references(symbol, { limit = 400 } = {}) {
  // bad limit (NaN → never truncates; 0 → truncates on the first ref) → default
  limit = Number.isFinite(+limit) && +limit > 0 ? Math.floor(+limit) : 400;
  const term = (String(symbol).match(/[A-Za-z0-9_]+/) || [])[0];
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
    if (res.some((re) => re.test(line))) symbols.push({ line: i + 1, text: line.trim().slice(0, 160) });
  }
  return { path, lang, lines: lines.length, symbols };
}

// ── Surgical read ─────────────────────────────────────────────────────────────
export function readLines(path, start = 1, end) {
  // bad start/end (NaN from a non-numeric query param) would make Math.max(1,NaN)
  // NaN → NaN line numbers and a broken slice; coerce to sane integers first.
  start = Number.isFinite(+start) && +start >= 1 ? Math.floor(+start) : 1;
  end = Number.isFinite(+end) && +end >= 1 ? Math.floor(+end) : undefined;
  let text;
  try { text = readFileSync(resolve(path), 'utf8'); } catch { throw new Error(`cannot read ${path}`); }
  const lines = text.split('\n');
  const s = Math.max(1, start);
  let e = Math.min(lines.length, end || start + 60);
  if (e < s) e = Math.min(lines.length, s + 60);   // an end before start → a default window from start, not an empty read
  const body = lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join('\n');
  return { path, start: s, end: e, total_lines: lines.length, tokens: estTokens(body), body };
}

// ── Repo map + stats ──────────────────────────────────────────────────────────
export function map({ limit = 400 } = {}) {
  const rows = all(`SELECT path, lang, lines, bytes FROM files ORDER BY path LIMIT ?`, limit);
  // token estimate per file (≈4 chars/token, same ratio as estTokens) — the web
  // tree sizes a weight bar by it so heavy-to-read files stand out
  for (const r of rows) r.tokens = Math.ceil((r.bytes || 0) / 4);
  const byLang = {};
  for (const r of rows) byLang[r.lang] = (byLang[r.lang] || 0) + 1;
  return { files: rows.length, by_lang: byLang, tree: rows };
}

export function stats() {
  return {
    files: get(`SELECT COUNT(*) n FROM files`).n,
    chunks: get(`SELECT COUNT(*) n FROM chunks`).n,
    total_lines: get(`SELECT COALESCE(SUM(lines),0) n FROM files`).n,
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
