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

// Block this thread for `ms`. Opening the database is synchronous, so a retry has to be too.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const SCHEMA = `
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
`;

let _db = null;
function open(create) {
  if (_db) return _db;
  if (!existsSync(DB_PATH)) {
    if (!create) return null;                     // nothing here, and we will not invent it
    mkdirSync(dirname(DB_PATH), { recursive: true });
  }

  // 🔑 WAL LETS READERS AND A WRITER COEXIST. IT DOES NOTHING FOR TWO WRITERS.
  // Without busy_timeout the second writer does not WAIT for the lock — it fails INSTANTLY with
  // SQLITE_BUSY. Measured on cortex, whose store has exactly this shape: two agents writing at once
  // lost 45 of 60 writes ("database is locked"), a 75% failure rate. SQLite's default answer to
  // contention is to give up immediately, and a write that gives up is data that never existed —
  // on a kit built for MANY AGENTS sharing one store, that default is exactly the wrong one.
  //
  // AND busy_timeout DOES NOT SAVE THE OPEN ITSELF. `PRAGMA journal_mode = WAL` needs a brief
  // exclusive lock and SQLite answers SQLITE_BUSY for it IMMEDIATELY rather than invoking the busy
  // handler — so the timeout that protects every later write does nothing for the call that sets it
  // up. Four processes starting on a fresh store lost a write EVERY round, always the first one.
  //
  // And the schema must go up ATOMICALLY: two processes opening a fresh store at the same instant
  // raced, one creating the file while the other opened it BEFORE the tables existed, and then every
  // call died with `no such table` — not a lock error, just a store that does not work.
  for (let attempt = 0; ; attempt++) {
    let db;
    try {
      db = new DatabaseSync(DB_PATH);
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('BEGIN IMMEDIATE;');
      db.exec(SCHEMA);
      db.exec('COMMIT;');
      _db = db;
      return _db;
    } catch (e) {
      try { db?.close(); } catch { /* already gone */ }
      // Only a lock is worth retrying. Anything else is a real fault and must not be swallowed —
      // a retry loop that hides a genuine error is worse than the error.
      if (attempt >= 40 || !/lock|busy/i.test(e.message)) throw e;
      sleepSync(25);
    }
  }
}

/** A write is a statement of intent, so it may bring the store into being. */
export const writeDb = () => open(true);

export const get = (sql, ...a) => { const d = open(false); return d ? d.prepare(sql).get(...a) : undefined; };
export const all = (sql, ...a) => { const d = open(false); return d ? d.prepare(sql).all(...a) : []; };
export const run = (sql, ...a) => open(true).prepare(sql).run(...a);
export { DB_PATH };
