#!/usr/bin/env node
// lens CLI — index a repo and query it from the shell.
//   lens index <path> [--reindex]
//   lens search "<query>" [-k 8] [--tokens 1800] [--glob '*.js']
//   lens refs <symbol>
//   lens outline <file>
//   lens read <file> <start> <end>
//   lens map | lens stats
//   lens serve [--port 7900]
import { indexPath, search, references, outline, readLines, map, stats } from './core.js';

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
    // Never let the budget hide results silently: say what was left out and
    // which flag would bring it back.
    if (r.withheld) {
      out(r.limited_by === 'budget'
        ? `  ${r.withheld} more chunk${r.withheld === 1 ? '' : 's'} matched but did not fit the ${r.budget}-token budget — raise it with --tokens ${r.budget * 2}`
        : `  ${r.withheld} more chunk${r.withheld === 1 ? '' : 's'} matched — show them with -k ${r.k * 2}`);
    }
  } else if (cmd === 'refs' || cmd === 'references') {
    const r = references(rest.find((a) => !a.startsWith('-')) || '');
    if (!r.symbol) { out('usage: lens refs <symbol>'); }
    else {
      for (const g of r.groups) {
        out(`\n▸ ${g.path}  [${g.lang}]  ${g.refs.length} ref${g.refs.length === 1 ? '' : 's'}`);
        for (const ref of g.refs) out(`${String(ref.line).padStart(6)}  ${ref.text}`);
      }
      out(`\n— ${r.count} references to "${r.symbol}" across ${r.files} files${r.truncated ? ' (truncated)' : ''} —`);
    }
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
  } else if (cmd === 'mcp') {
    // stdio JSON-RPC. The server starts on import: `npx @tools-for-agents/lens mcp`
    await import('../mcp/mcp-server.js');
  } else {
    out(`lens — token-efficient code context for agents

  lens index <path> [--reindex]     build / refresh the index
  lens search "<query>" [-k N] [--tokens N] [--glob PAT]
  lens refs <symbol>                every line that mentions a symbol
  lens outline <file>               symbol map, no full read
  lens read <file> <start> <end>    surgical line read
  lens map | lens stats
  lens serve [--port 7900]          browsable web explorer`);
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
