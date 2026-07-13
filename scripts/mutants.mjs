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

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CANARIES = [
  {
    why: 'a credential file must never be indexed — lens served .env back through MCP, into a model',
    file: 'src/core.js',
    find: '  if (isSecretPath(name)) return true;',
    into: '  if (false) return true;',
  },
  {
    why: 'a dotfile is default-deny — the next secret filename has not been invented yet',
    file: 'src/core.js',
    find: "  if (name.startsWith('.') && !DOT_ALLOW.has(name)) return true;",
    into: '  if (false) return true;',
  },
  {
    why: 'searching an unindexed tree is an ERROR, not "your code does not contain that"',
    file: 'src/core.js',
    find: '  if (n > 0) return;',
    into: '  if (n >= 0) return;',
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
];

// spawnSync returns status:null when IT kills the child for exceeding the timeout — a TIMEOUT,
// not a test failure. Reading that as "the suite is already red" turns a slow suite into a broken
// one. Distinguish them: a suite that never finished has not answered, and a mutant that makes the
// suite hang has not been "killed". (Only iris is slow enough to hit this, but the bug was latent
// in every copy of this helper.)
const TIMEOUT_MS = 600_000;
const run = () => {
  const r = spawnSync('npm', ['test'], { encoding: 'utf8', timeout: TIMEOUT_MS });
  return { failed: r.status !== 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT' };
};

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
const base = run();
if (base.timedOut) {
  console.error(`THE SUITE DID NOT FINISH within ${TIMEOUT_MS / 1000}s — a timeout, not a failure. `
    + 'Raise TIMEOUT_MS or speed up the suite; do not read a slow suite as a broken one.');
  process.exit(1);
}
if (base.failed) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
console.log('baseline: green\n');

let dead = 0;
for (const c of CANARIES) {
  const orig = readFileSync(c.file, 'utf8');
  const hits = orig.split(c.find).length - 1;
  if (hits !== 1) {
    console.error(`✗ ANCHOR DRIFTED in ${c.file}: found ${hits}×\n    ${c.find}\n  ` +
      'A canary whose anchor has moved is not watching anything. Re-point it.');
    dead++; continue;
  }
  writeFileSync(c.file, orig.replace(c.find, c.into));
  const res = run();
  writeFileSync(c.file, orig);

  // A timeout on a mutant is NOT a kill: a broken mutant can hang instead of failing fast.
  if (res.timedOut) {
    console.error(`✗ INCONCLUSIVE — the suite timed out with this broken, so we cannot say it was killed:\n    ${c.why}`);
    dead++;
  } else if (!res.failed) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n` +
      `    ${c.file}:  ${c.find}  ->  ${c.into}\n` +
      '  Nothing is guarding that line any more.');
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);
