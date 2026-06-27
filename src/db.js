// lens — persistence. node:sqlite + FTS5, zero external dependencies.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.LENS_DB || './.lens/index.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
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

export const get = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
export { DB_PATH };
