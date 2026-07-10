#!/usr/bin/env node
// lens CLI — index a repo and query it from the shell.
//   lens index <path> [--reindex]
//   lens search "<query>" [-k 8] [--tokens 1800] [--glob '*.js']
//   lens outline <file>
//   lens read <file> <start> <end>
//   lens map | lens stats
//   lens serve [--port 7900]
import { indexPath, search, outline, readLines, map, stats } from './core.js';

const [, , cmd, ...rest] = process.argv;
const flag = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
const has = (n) => rest.includes(n);
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

try {
  if (cmd === 'index') {
    const path = rest.find((a) => !a.startsWith('-')) || '.';
    out(indexPath(path, { reindex: has('--reindex') }));
  } else if (cmd === 'search') {
    const q = rest.find((a) => !a.startsWith('-')) || '';
    const r = search(q, { k: +flag('-k', 8), max_tokens: +flag('--tokens', 1800), path_glob: flag('--glob') });
    for (const x of r.results || []) {
      out(`\n▸ ${x.path}:${x.start}-${x.end}  [${x.lang}]  score=${x.score} ~${x.tokens}tok`);
      out(x.body);
    }
    out(`\n— ${r.count || 0} hits, ~${r.tokens || 0} tokens —`);
  } else if (cmd === 'outline') {
    const r = outline(rest[0]);
    out(`${r.path} (${r.lang}, ${r.lines} lines) — ${r.symbols.length} symbols`);
    for (const s of r.symbols) out(`${String(s.line).padStart(5)}  ${s.text}`);
  } else if (cmd === 'read') {
    out(readLines(rest[0], +rest[1] || 1, +rest[2] || undefined).body);
  } else if (cmd === 'map') {
    out(map());
  } else if (cmd === 'stats') {
    out(stats());
  } else if (cmd === 'serve') {
    const { serve } = await import('./server.js');
    serve({ port: +flag('--port', process.env.LENS_PORT || 7900) });
  } else {
    out(`lens — token-efficient code context for agents

  lens index <path> [--reindex]     build / refresh the index
  lens search "<query>" [-k N] [--tokens N] [--glob PAT]
  lens outline <file>               symbol map, no full read
  lens read <file> <start> <end>    surgical line read
  lens map | lens stats
  lens serve [--port 7900]          browsable web explorer`);
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
