// CAN THE TEST SUITE STILL FAIL?
//
// Every other gate here asks "is the code right". This one asks the question underneath it:
// IS ANYTHING STILL WATCHING. A suite that has quietly stopped covering a property goes green
// for exactly the same reason as a suite that is passing honestly, and there is no way to tell
// the two apart by looking at the green.
//
// It has happened here more than once. anvil's Docker tests were SKIPPED for months — 11 pass,
// 0 fail, 9 skipped, green every run — while the tool was completely broken on Linux. lens's
// own file walk swallowed .env files, and twenty green tests never saw it, because no test had
// ever indexed a repo with a secret in it.
//
// So: break the code ON PURPOSE, in the exact places whose breakage would cost the most, and
// demand the suite goes RED. If it stays green, the canary is dead and this job fails — the
// test that was guarding that line has stopped guarding it, and you find out today rather than
// the morning after it matters.
//
//   node scripts/mutants.mjs
//
// Each canary must have EXACTLY ONE anchor in the file. An anchor that has drifted is a canary
// that silently stopped watching, so a missing or ambiguous anchor is a hard failure — never a
// skip. (A check that quietly covers less than it claims is the same bug as a tool that quietly
// answers less than it claims.)

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CANARIES = [
  {
    why: 'a credential file must never be indexed — lens served .env back through MCP, into a model',
    file: 'src/core.js',
    find: '  if (isSecretPath(name)) return true;',
    into: '  if (false) return true;',
  },
  {
    why: 'a .p8 is an Apple App Store Connect / APNs PRIVATE KEY — .pem/.key were covered, .p8 was the gap, and lens indexed + served it',
    file: 'src/core.js',
    find: '\\.(pem|key|p8|pk8|p12|pfx|keystore|jks|ppk)$',
    into: '\\.(pem|key|p12|pfx|keystore|jks|ppk)$',
  },
  {
    why: 'a dotfile is default-deny — the next secret filename has not been invented yet',
    file: 'src/core.js',
    find: "  if (name.startsWith('.') && !DOT_ALLOW.has(name)) return true;",
    into: '  if (false) return true;',
  },
  {
    // anchored WITH its COUNT query: requireGlobMatches guards the same shape one level in ("a filter
    // that matched nothing"), so a bare `if (n > 0) return;` now matches twice and watches neither.
    why: 'searching an unindexed tree is an ERROR, not "your code does not contain that"',
    file: 'src/core.js',
    find: '  const n = get(`SELECT COUNT(*) n FROM files`)?.n ?? 0;\n  if (n > 0) return;',
    into: '  const n = get(`SELECT COUNT(*) n FROM files`)?.n ?? 0;\n  if (n >= 0) return;',
  },
  {
    why: 'node_modules is not your code — without IGNORE_DIRS every search comes back full of vendor internals',
    file: 'src/core.js',
    find: '  if (IGNORE_DIRS.has(name)) return true;',
    into: '  if (IGNORE_DIRS.has(name)) return false;',
  },
  {
    why: 'pointing lens DIRECTLY at a credential file (lens index .env) must be refused — the walk-skip never runs for a single file',
    file: 'src/core.js',
    find: '  if (!st.isDirectory() && isSecretPath(root.split(sep).pop())) {',
    into: '  if (false && isSecretPath(root.split(sep).pop())) {',
  },
  {
    why: 'the budget is a CEILING — its "always return one" hatch let a 350,003-token chunk through a 1,800-token budget',
    file: 'src/core.js',
    find: '    const cut = Math.max(0, max_tokens - tokens) * 4;',
    into: '    const cut = Infinity;',
  },
  {
    why: 'a minified bundle is ONE line, so it chunks to ONE blob that IS the whole file — lens exists to avoid exactly that',
    file: 'src/core.js',
    find: 'const MINIFIED_AVG_LINE = 2000;',
    into: 'const MINIFIED_AVG_LINE = Infinity;',
  },
  {
    why: 'a line-window is not a byte-window — ONE line of a minified file is 350,000 tokens, and lens_read handed it over',
    file: 'src/core.js',
    find: 'const READ_MAX_TOKENS = 4000;   // ~16KB: generous for 60 lines of real code, fatal to nothing real',
    into: 'const READ_MAX_TOKENS = Infinity;',
  },
  {
    why: 'two quiet greys nobody can tell apart are ONE grey, and the spare is the twin that fails AA where the other passes: --dim #77808d sat 20.2 from --muted #7d8794 (iris calls a game palette "indistinct" below 30) and measured 4.46:1 on --panel — including the search placeholder, on every page load, which the eye cannot even report because a placeholder is not a text node',
    file: 'public/index.html',
    find: '    --txt:#dfe4ec; --muted:#7d8794;',
    into: '    --txt:#dfe4ec; --muted:#7d8794; --dim:#77808d;',
  },
  {
    why: 'the highlighter must never EAT a character — its tokenizer loop appends only what it matches, and exec() with /g skips forward past anything unmatchable, so `#4fd6be` rendered as `#fd6be` and `padding: 12px 16px` as `padding: px px`. lens exists to show an agent the code; the one thing it may never do is show code the file does not contain',
    file: 'public/highlight.js',
    find: '|([^\\w\\s\'"`]+|\\s+)|([\\s\\S])/g;',
    into: '|([^\\w\\s\'"`]+|\\s+)/g;',
  },
  {
    why: 'a path_glob matching NO indexed file is a MISTAKE, not "no matches" — SQLite GLOB has no {a,b} braces, so `*.{js,ts}` (the glob every JS tool teaches) matched nothing and lens answered "0 hits", which an agent reads as "your code does not contain that"',
    file: 'src/core.js',
    find: '  if (path_glob) requireGlobMatches(path_glob);',
    into: '  /* glob unchecked */',
  },
  {
    why: 'a REINDEX must not make a file VANISH — split apart, DELETE-then-INSERT lets a search see ZERO chunks and answer "your code does not contain that"',
    file: 'src/db.js',
    find: '  if (_txDepth++ === 0) d.exec(\'BEGIN IMMEDIATE;\');',
    into: '  if (false) d.exec(\'BEGIN IMMEDIATE;\');',
  },
  {
    why: 'a freshness check aimed at a SUBDIR must not call files outside it "removed" — unscoped, freshness(\'src\') on a repo-wide index reports every non-src file as vanished, a false staleness telling the agent to reindex for nothing',
    file: 'src/core.js',
    find: "    const under = !prefix || prefix === '' || path === prefix || path.startsWith(prefix + '/');",
    into: '    const under = true;',
  },
  {
    why: 'map reports the TRUE file count, not the capped page length — returning rows.length AS `files` is a silent truncation, so an agent sizing up a 5,000-file repo was handed "400" (the default limit) with nothing to say the other 4,600 existed',
    file: 'src/core.js',
    find: '  return { files: total, shown: rows.length, truncated: total > rows.length, by_lang: byLang, tree: rows };',
    into: '  return { files: rows.length, shown: rows.length, truncated: total > rows.length, by_lang: byLang, tree: rows };',
  },
];

// spawnSync returns status:null when IT kills the child for exceeding the timeout — a TIMEOUT,
// not a test failure. Reading that as "the suite is already red" turns a slow suite into a broken
// one. Distinguish them: a suite that never finished has not answered, and a mutant that makes the
// suite hang has not been "killed". (Only iris is slow enough to hit this, but the bug was latent
// in every copy of this helper.)
const TIMEOUT_MS = 600_000;
const run = () => {
  const r = spawnSync('npm', ['test'], { encoding: 'utf8', timeout: TIMEOUT_MS });
  // A SKIPPED test cannot kill a canary — it did not run. So the skip count is not trivia here:
  // it is the difference between "nothing guards this line" and "the guard never got to look".
  const skipped = +(`${r.stdout || ''}${r.stderr || ''}`.match(/^\s*(?:ℹ|#)\s*skipped\s+(\d+)/m)?.[1] || 0);
  return { failed: r.status !== 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT', skipped };
};

// 🔑 AND IT MUST NOT RUN TWICE AT ONCE. This tool EDITS YOUR SOURCE IN PLACE, so two concurrent runs
// do not merely confuse each other — they can make a planted bug PERMANENT:
//
//     run B plants a mutation in core.js
//     run A reads core.js as its "original"      ← the original now CONTAINS B's bug
//     run B restores its own copy
//     run A restores ITS "original"              ← re-plants B's bug, and A believes it cleaned up
//
// The sabotage is now in your tree, no process is left to undo it, and the tool that put it there
// reports success. It is not theoretical: two overlapping runs turned this repo's suite red, and the
// only message was "THE SUITE IS ALREADY RED" — which names neither the file nor the line.
// An exclusive lock, taken BEFORE the baseline (a concurrent run poisons the baseline too).
const LOCK = new URL('../.mutants.lock', import.meta.url);
try {
  writeFileSync(LOCK, String(process.pid), { flag: 'wx' });   // wx = fail if it already exists
} catch {
  let holder = '?';
  try { holder = readFileSync(LOCK, 'utf8').trim(); } catch { /* raced with a clean exit */ }
  const alive = holder !== '?' && (() => { try { process.kill(+holder, 0); return true; } catch { return false; } })();
  if (alive) {
    console.error(`another mutants run (pid ${holder}) is already editing this source tree. `
      + 'Two at once can make a planted bug PERMANENT — see the note above. Wait for it, or kill it.');
    process.exit(1);
  }
  // The holder is gone (killed before it could clean up). Its restore-on-exit ran, so the tree is
  // sound; the lock is just litter. Take it.
  writeFileSync(LOCK, String(process.pid));
}
const dropLock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', dropLock);

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
const base = run();
if (base.timedOut) {
  console.error(`THE SUITE DID NOT FINISH within ${TIMEOUT_MS / 1000}s — a timeout, not a failure. `
    + 'Raise TIMEOUT_MS or speed up the suite; do not read a slow suite as a broken one.');
  process.exit(1);
}
if (base.failed) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
// 🔑 A canary cannot be killed by a test that DID NOT RUN. If the baseline skipped tests, then any
// canary those tests guard will "survive" — and it will look exactly like a coverage hole, sending
// you to write a test that already exists instead of to the one-line fix (start Docker / install
// Chrome). Two different facts, two different fixes; they must not print the same sentence.
// This is anvil's cycle-13 lesson one layer up: in CI a skipped test is a FAILED test, so CI never
// sees this — it is the LOCAL run that lies, and the local run is where you do the work.
if (base.skipped) {
  console.log(`⚠ the baseline SKIPPED ${base.skipped} test(s) — those cannot kill a canary, because they `
    + 'do not run. A survivor below is far more likely to be a missing dependency than a missing test.');
}
console.log('baseline: green\n');

// 🔑 THE MUTATION IS WRITTEN INTO YOUR SOURCE FILE and undone once the suite has run. If this
// process dies in between — Ctrl-C, SIGTERM, a cancelled CI job, an OOM kill — the planted bug is
// LEFT IN YOUR TREE: a deliberately subtle one-character sabotage, sitting exactly where your real
// fix was, ready for the next `git add -A`. It is not hypothetical — a killed run left
// `raw && !isHtml` in scout's core.js, silently reverting a real fix, and the next mutants run said
// only "THE SUITE IS ALREADY RED", which names neither the file nor the line.
//
// A TOOL THAT PLANTS BUGS ON PURPOSE MUST BE THE ONE THING THAT ALWAYS CLEANS UP AFTER ITSELF.
// writeFileSync is synchronous, so it is safe in an exit handler.
let planted = null;                       // { file, orig } while a mutation is on disk
const restore = () => { if (planted) { writeFileSync(planted.file, planted.orig); planted = null; } };
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(sig, () => { restore(); process.exit(130); });
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

let dead = 0;
for (const c of CANARIES) {
  const orig = readFileSync(c.file, 'utf8');
  const hits = orig.split(c.find).length - 1;
  if (hits !== 1) {
    console.error(`✗ ANCHOR DRIFTED in ${c.file}: found ${hits}×\n    ${c.find}\n  ` +
      'A canary whose anchor has moved is not watching anything. Re-point it.');
    dead++; continue;
  }
  planted = { file: c.file, orig };
  writeFileSync(c.file, orig.replace(c.find, c.into));
  const res = run();
  restore();

  // A timeout on a mutant is NOT a kill: a broken mutant can hang instead of failing fast.
  if (res.timedOut) {
    console.error(`✗ INCONCLUSIVE — the suite timed out with this broken, so we cannot say it was killed:\n    ${c.why}`);
    dead++;
  } else if (!res.failed) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n` +
      `    ${c.file}:  ${c.find}  ->  ${c.into}`);
    console.error(res.skipped
      ? `  …but ${res.skipped} test(s) were SKIPPED. A test that did not run cannot kill a canary, so this\n`
        + '  is most likely a MISSING DEPENDENCY (docker down? no chrome?), not a missing test.\n'
        + '  Provide it and re-run — do not go writing a test that may already exist.'
      : '  Nothing is guarding that line any more.');
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);
