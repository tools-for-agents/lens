// lens — persistence. node:sqlite + FTS5, zero external dependencies.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.LENS_DB || './.lens/index.db';

// ── A READ MUST NOT CREATE THE THING IT IS READING ──────────────────────────────
//
// This module used to open the database AT IMPORT — mkdir, create the file, run the
// schema — so merely ASKING A QUESTION brought the store into existence. Run a search in
// someone's home directory and you left a .lens/ index behind in it. And the empty store you
// just created then answered the question, confidently, with nothing:
//
//     — 0 hits —
//
// which an agent reads as "that is not in your codebase", when the truth is that there was
// never anything there to look in. A tool should not litter, and it should not invent the
// evidence for its own answer.
//
// So: reads (get/all) open what is there and return NOTHING when there is nothing —
// they never create. Writes (run/writeDb) create, because a write is a statement of
// intent. `storeExists()` lets the caller tell the two apart and say so out loud.
export const storeExists = () => existsSync(DB_PATH);

let _db = null;
function open(create) {
  if (_db) return _db;
  if (!existsSync(DB_PATH)) {
    if (!create) return null;                     // nothing here, and we will not invent it
    mkdirSync(dirname(DB_PATH), { recursive: true });
  }
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec(`
-- one row per indexed file (for incremental reindex + repo map)
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  lang       TEXT,
  lines      INTEGER,
  bytes      INTEGER,
  mtime      INTEGER,
  indexed_at TEXT
);

-- full-text searchable chunks. start/end/path/lang stored but not tokenized.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  path, body, lang UNINDEXED, start UNINDEXED, "end" UNINDEXED,
  tokenize = 'porter unicode61'
);
`);
  return _db;
}

/** A write is a statement of intent, so it may bring the store into being. */
export const writeDb = () => open(true);

export const get = (sql, ...a) => { const d = open(false); return d ? d.prepare(sql).get(...a) : undefined; };
export const all = (sql, ...a) => { const d = open(false); return d ? d.prepare(sql).all(...a) : []; };
export const run = (sql, ...a) => open(true).prepare(sql).run(...a);
export { DB_PATH };
