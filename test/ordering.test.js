// lens ordering test — search orders by bm25 score, which is not unique: two chunks with the same
// term frequencies and length score identically (two files with the same content is the simplest
// case), and ORDER BY a tie falls back to rowid. lens re-indexes changed files incrementally, so
// re-indexing ONE file gives its chunks new, higher rowids — and among score-tied results it jumps
// position, though it is no better a match than before. Search tie-breaks on (path, start), a
// chunk's stable identity. Run with `node --test`.
//
// db.js reads LENS_DB at import, so set it BEFORE importing core (see the header of lens.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'lens-order-'));
process.env.LENS_DB = join(work, 'index.db');
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });

const src = join(work, 'src');
mkdirSync(src, { recursive: true });
const lens = await import('../src/core.js');

// two files with IDENTICAL content — their matching chunks score identically
const CONTENT = 'function zqxwidget(a, b) {\n  return zqxwidget(a) + zqxwidget(b);\n}\n';
for (const n of ['aaa.js', 'zzz.js']) writeFileSync(join(src, n), CONTENT);
lens.indexPath(src);

const order = () => lens.search('zqxwidget', { max_tokens: 800 }).results.map((r) => `${r.path.split('/').pop()}:${r.start}`);

test('score-tied search results are stable when one file is re-indexed', () => {
  const before = order();
  assert.deepEqual(before, ['aaa.js:1', 'zzz.js:1'], `tied hits should order by path: got ${before}`);

  // re-index only aaa.js — its chunk is deleted and re-added with a new, higher rowid. Under a bare
  // ORDER BY score that flips the tie to zzz, aaa; the tie-break on (path, start) holds it.
  lens.indexPath(join(src, 'aaa.js'), { reindex: true });
  assert.deepEqual(order(), before,
    `re-indexing one file must not reorder equally-scored hits — was ${before}, now ${order()}`);
});
