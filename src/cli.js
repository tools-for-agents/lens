#!/usr/bin/env node
// lens CLI — index a repo and query it from the shell.
//   lens index <path> [--reindex]
//   lens search "<query>" [-k 8] [--tokens 1800] [--glob '*.js']
//   lens refs <symbol>
//   lens outline <file>
//   lens read <file> <start> <end>
//   lens map | lens stats
//   lens serve [--port 7900]
import { indexPath, search, references, outline, readLines, map, stats, indexTerms } from './core.js';

const [, , cmd, ...rest] = process.argv;
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

const HELP = `lens — token-efficient code context for agents

  lens index <path> [--reindex]     build / refresh the index
  lens search "<query>" [-k N] [--tokens N] [--glob PAT]
  lens refs <symbol>                every line that mentions a symbol
  lens outline <file>               symbol map, no full read
  lens read <file> <start> <end>    surgical line read
  lens map | lens stats
  lens serve [--port 7900]          browsable web explorer`;

// ── Arguments ────────────────────────────────────────────────────────────────
// 🔑 A FLAG'S VALUE IS NOT THE QUERY, AND A MISSING QUERY IS NOT AN EMPTY ONE.
//
// Every command in this file used to find its positional argument the same way:
//
//     const q = rest.find((a) => !a.startsWith('-')) || '';   // the first non-dash arg
//
// In `lens search -k 3 "parse auth header"` that argument is `3` — the VALUE of the flag in
// front of it. lens searched the index for the literal string "3", printed
// `— 0 hits, ~0 tokens —`, and exited 0. A flag order every other CLI on the machine accepts
// told an agent its codebase does not contain the thing it was looking for, with nothing on
// stderr and nothing in the exit code to invite a second look.
//
// `--glob 'src/*'` in front was worse, because it did not look like a failure: the query
// became `src/*`, `path` is an indexed FTS column, so lens returned real, ranked,
// syntax-clean snippets out of that directory — under an honest "32 more chunks matched but
// did not fit the 1800-token budget" footer, which makes the answer look MORE trustworthy,
// not less. Measured against this repo: `lens search -k 4 "incremental reindex"` returned
// 1,353 tokens of colour-contrast tests and a syntax highlighter as the ranked answer.
//
// requireIndex() and requireGlobMatches() in core.js exist to make exactly this impossible —
// "a confident wrong answer is worse than an error, because nothing about it invites a second
// look" — and this walked in through the front door, before either guard could run. So the
// parser below knows which flags take a value and steps over it, and EVERY other way a query
// can fail to survive parsing is a loud error with a non-zero exit, never a quiet empty
// result that reads like an answer:
//
//   · an unknown flag        — `--topkens 500` would hand "500" to the search as the query
//   · a value flag with nothing after it — `lens search "auth" -k`
//   · nothing left to search for — `lens search "--reindex"`: a query that IS a flag
//   · more than one loose word — `lens search parse auth header` searched for "parse" alone
//   · an unknown command     — `lens serach "auth"` printed help and exited 0
//
// `--` ends the flags, so text that starts with a dash is still reachable:
// `lens search -- "--reindex"`.
const SPEC = {
  index: { value: [], bool: ['--reindex'], min: 0, max: 1, noun: 'path',
    use: 'lens index <path> [--reindex]', takes: 'ONE path' },
  search: { value: ['-k', '--tokens', '--glob'], bool: [], min: 1, max: 1, noun: 'query',
    use: 'lens search "<query>" [-k N] [--tokens N] [--glob PAT]', takes: 'ONE quoted query' },
  refs: { value: [], bool: [], min: 1, max: 1, noun: 'symbol',
    use: 'lens refs <symbol>', takes: 'ONE symbol' },
  outline: { value: [], bool: [], min: 1, max: 1, noun: 'file',
    use: 'lens outline <file>', takes: 'ONE file' },
  read: { value: [], bool: [], min: 1, max: 3, noun: 'file',
    use: 'lens read <file> <start> <end>', takes: 'a file, and at most a start and an end' },
  map: { value: [], bool: [], min: 0, max: 0, noun: 'argument', use: 'lens map', takes: 'no arguments' },
  stats: { value: [], bool: [], min: 0, max: 0, noun: 'argument', use: 'lens stats', takes: 'no arguments' },
  serve: { value: ['--port'], bool: [], min: 0, max: 0, noun: 'argument',
    use: 'lens serve [--port 7900]', takes: 'no arguments' },
  mcp: { value: [], bool: [], min: 0, max: 0, noun: 'argument', use: 'lens mcp', takes: 'no arguments' },
};
SPEC.references = { ...SPEC.refs, use: 'lens references <symbol>' };

const show = (a) => JSON.stringify(a);
const bad = (m) => { throw new Error(m); };

function parse(name, argv) {
  const spec = SPEC[name];
  const takesValue = new Set(spec.value);
  const isSwitch = new Set(spec.bool);
  const flags = Object.create(null);
  const args = [];
  let literal = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (literal) { args.push(a); continue; }
    if (a === '--') { literal = true; continue; }
    // a bare "-" is a word, not a flag; "-k"/"--glob"/"--glob=src/*" are flags
    if (a.length > 1 && a.startsWith('-')) {
      if (a === '-h' || a === '--help') { out(`${HELP}\n\n  usage: ${spec.use}`); process.exit(0); }
      const eq = a.indexOf('=');
      const f = eq > 0 ? a.slice(0, eq) : a;
      if (takesValue.has(f)) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined)
          bad(`${f} needs a value, and nothing followed it.\n  usage: ${spec.use}`);
        flags[f] = v;
      } else if (isSwitch.has(f)) {
        if (eq > 0) bad(`${f} is a switch and takes no value (got ${show(a)}).\n  usage: ${spec.use}`);
        flags[f] = true;
      } else {
        // Refusing to guess is the whole point: an unknown flag's value is the next
        // argument, and the old parser handed that value to the search as the query.
        const known = [...spec.value.map((v) => `${v} <value>`), ...spec.bool];
        const eaten = argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')
          ? ` lens will not guess: ${show(argv[i + 1])} would silently have become the ${spec.noun}.` : '';
        bad(`unknown flag ${show(f)} for "lens ${name}".${eaten}\n`
          + `  ${known.length ? `known flags: ${known.join(' · ')}` : `"lens ${name}" takes no flags`}\n`
          + `  usage: ${spec.use}\n`
          + `  to pass text that starts with a dash, put it after --:  lens ${name} -- ${show(a)}`);
      }
      continue;
    }
    args.push(a);
  }

  if (args.length < spec.min) {
    // NOT "0 hits": lens never looked. Say what it was given, so the eaten argument is visible.
    bad(`no ${spec.noun} — "lens ${name}" has nothing to work with, and this is NOT an empty result: lens never looked.\n`
      + `  got: ${argv.length ? argv.map(show).join(' ') : '(nothing)'}\n`
      + `  usage: ${spec.use}\n`
      + `  a ${spec.noun} that starts with a dash goes after --:  lens ${name} -- "--like-this"`);
  }
  if (args.length > spec.max) {
    // Using only the first would answer a question nobody asked — the same lie, quieter.
    bad(`"lens ${name}" takes ${spec.takes}, got ${args.length}: ${args.map(show).join(' ')}\n`
      + `  ${name === 'search' ? 'using only the first would answer a question you did not ask' : 'the extra ones would be silently ignored'}.\n`
      + `  usage: ${spec.use}\n`
      + (name === 'search'
        ? `  quote it:  lens search ${show(args.join(' '))}\n`
          + `  (your shell expands globs before lens sees them — quote --glob patterns too: --glob 'src/*')`
        : `  (your shell expands globs before lens sees them — quote them)`));
  }
  return { flags, args };
}

try {
  if (cmd === undefined || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    out(HELP);
  } else if (!SPEC[cmd]) {
    // An unknown command used to print the help text and exit 0 — a failure reported as a
    // success, on stdout, where a caller reads results.
    bad(`unknown command ${show(cmd)}.\n  commands: ${Object.keys(SPEC).filter((c) => c !== 'references').join(' · ')}\n${HELP}`);
  } else if (cmd === 'index') {
    const { flags, args } = parse(cmd, rest);
    out(indexPath(args[0] || '.', { reindex: !!flags['--reindex'] }));
  } else if (cmd === 'search') {
    const { flags, args } = parse(cmd, rest);
    const q = args[0];
    const glob = flags['--glob'];
    // A query with nothing the tokenizer can see (`""`, `"???"`, `"=>"`, `"___"`) has nothing
    // to match on, so an empty `results` comes from a search that NEVER LOOKED — which reads
    // exactly like "your code does not contain that".
    //
    // 🔑 ASK core.indexTerms, DO NOT RE-DERIVE IT. The first version of this guard tested
    // `/[\p{L}\p{N}_]/` — its own copy of ftsQuery's regex — and so believed `_` was part of a
    // word. It is not: the index is `porter unicode61` with no `tokenchars`, so `_` is a
    // SEPARATOR. `lens search "___"` walked straight through the guard and got back
    // `— 0 hits for "___" … searched 20 files / 125 chunks`, the exact confident absence the
    // guard was added to make impossible. A guard built on a wrong model of the index is not a
    // guard; it is a second place for the same lie to come from.
    if (!indexTerms(q).length) {
      bad(`no searchable terms in ${show(q)} — the index is tokenized on letters and digits, and `
        + `"_" and punctuation are SEPARATORS, so there was nothing to look for and lens never `
        + `looked. This is NOT "0 hits".\n`
        + `  (a name like parse_auth_header is fine — it is indexed as the words in it)\n`
        + `  usage: ${SPEC.search.use}`);
    }
    const r = search(q, { k: +(flags['-k'] ?? 8), max_tokens: +(flags['--tokens'] ?? 1800), path_glob: glob });
    // A FAILED SEARCH IS NOT AN EMPTY ONE. core hands back { error, results: [] } when the
    // query blows up in FTS; this printed "— 0 hits —" over it and exited 0.
    if (r.error) {
      bad(`the search failed, so this is NOT "0 hits" — the index was not answered: ${r.error}\n`
        + `  query: ${show(q)}${glob ? `  path_glob: ${show(glob)}` : ''}`);
    }
    for (const x of r.results || []) {
      out(`\n▸ ${x.path}:${x.start}-${x.end}  [${x.lang}]  score=${x.score} ~${x.tokens}tok`);
      out(x.body);
    }
    // An empty result must carry the SIZE OF THE HAYSTACK, and the query it actually ran.
    // "0 hits" on its own is the same sentence as "your code does not contain that"; with
    // the query quoted back and the haystack beside it, a caller can tell an honest absence
    // from a search that was handed the wrong words or looked at almost nothing.
    //
    // 🔑 AND THE HAYSTACK IS THE SCOPE, `stats({ path_glob })` — NOT `stats()`. This line
    // first shipped with the WHOLE INDEX's totals and the glob glued on the end, so a
    // one-file `--glob 'mcp/*'` announced "searched 20 files / 125 chunks matching "mcp/*"".
    // Putting a number on an absence is only worth doing if the number is the one lens
    // actually searched; otherwise the fix for a vague wrong answer is a precise one.
    if (!r.count) {
      const s = stats({ path_glob: glob });
      out(`\n— 0 hits for ${show(q)}, ~0 tokens — searched ${s.files} file${s.files === 1 ? '' : 's'}`
        + ` / ${s.chunks} chunk${s.chunks === 1 ? '' : 's'}${glob ? ` matching ${show(glob)}` : ''}`);
    } else {
      out(`\n— ${r.count} hits, ~${r.tokens || 0} tokens —`);
    }
    // Never let the budget hide results silently: say what was left out and
    // which flag would bring it back.
    if (r.withheld) {
      out(r.limited_by === 'budget'
        ? `  ${r.withheld} more chunk${r.withheld === 1 ? '' : 's'} matched but did not fit the ${r.budget}-token budget — raise it with --tokens ${r.budget * 2}`
        : `  ${r.withheld} more chunk${r.withheld === 1 ? '' : 's'} matched — show them with -k ${r.k * 2}`);
    }
  } else if (cmd === 'refs' || cmd === 'references') {
    const { args } = parse(cmd, rest);
    // Same tokenizer truth as search, and the same reason. `lens refs "_"` used to print
    // `— 0 references to "_" across 0 files —` and exit 0: `_` is not a token in the index,
    // so FTS could never have found it, and that sentence is about lens, not about the code.
    if (!indexTerms(args[0]).length) {
      bad(`no symbol in ${show(args[0])} — a symbol the index can see is made of letters and digits `
        + `("_" and punctuation are separators), and this has none, so lens never looked. `
        + `This is NOT "no references".\n  usage: ${SPEC[cmd].use}`);
    }
    const r = references(args[0]);
    for (const g of r.groups) {
      out(`\n▸ ${g.path}  [${g.lang}]  ${g.refs.length} ref${g.refs.length === 1 ? '' : 's'}`);
      for (const ref of g.refs) out(`${String(ref.line).padStart(6)}  ${ref.text}`);
    }
    out(`\n— ${r.count} references to "${r.symbol}" across ${r.files} files${r.truncated ? ' (truncated)' : ''} —`);
  } else if (cmd === 'outline') {
    const { args } = parse(cmd, rest);
    const r = outline(args[0]);
    out(`${r.path} (${r.lang}, ${r.lines} lines) — ${r.symbols.length} symbols`);
    for (const s of r.symbols) out(`${String(s.line).padStart(5)}  ${s.text}`);
  } else if (cmd === 'read') {
    const { args } = parse(cmd, rest);
    out(readLines(args[0], +args[1] || 1, +args[2] || undefined).body);
  } else if (cmd === 'map') {
    parse(cmd, rest);
    out(map());
  } else if (cmd === 'stats') {
    parse(cmd, rest);
    out(stats());
  } else if (cmd === 'serve') {
    const { flags } = parse(cmd, rest);
    const { serve } = await import('./server.js');
    // 🔑 `??` ON AN ENV VAR IS NOT `||`. An unset LENS_PORT and an EMPTY one are the same
    // intent — "I did not choose a port" — but `process.env.LENS_PORT ?? 7900` only catches
    // the unset one, so `LENS_PORT= lens serve` became `+''` = port 0: a random ephemeral
    // port, announced as `http://localhost:0`, which is a URL that goes nowhere. The old
    // `||` was right about this and the rewrite lost it. The flag keeps `??`, because there
    // `undefined` means "not passed" and an explicit `--port 0` is a real request.
    serve({ port: +(flags['--port'] ?? (process.env.LENS_PORT || 7900)) });
  } else if (cmd === 'mcp') {
    parse(cmd, rest);
    // stdio JSON-RPC. The server starts on import: `npx @tools-for-agents/lens mcp`
    await import('../mcp/mcp-server.js');
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
