#!/usr/bin/env node
// lens — MCP server (stdio JSON-RPC). Gives agents token-efficient retrieval:
// search returns just-enough ranked snippets, outline maps a file without reading
// it whole, read pulls exact line ranges. Runs locally with filesystem access.
import { createInterface } from 'node:readline';
import { indexPath, search, references, outline, readLines, map, stats } from '../src/core.js';

const PROTOCOL = '2024-11-05';

const tools = [
  {
    name: 'lens_index',
    description: 'Index (or incrementally refresh) a file or directory so it can be searched. Run once per repo, then again after edits (only changed files are re-read).',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'File or directory to index (default ".")' },
      reindex: { type: 'boolean', description: 'Force full reindex ignoring mtimes' },
    } },
    run: (a) => indexPath(a.path || '.', { reindex: !!a.reindex }),
  },
  {
    name: 'lens_search',
    description: 'Search the indexed codebase and get back the most relevant code snippets (ranked, with file:line), within a token budget. Use this INSTEAD of reading whole files — it is far cheaper.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'What you are looking for, in words or symbols' },
      k: { type: 'integer', description: 'Max snippets (default 8)' },
      max_tokens: { type: 'integer', description: 'Token budget for results (default 1800)' },
      path_glob: { type: 'string', description: "Restrict to paths, e.g. 'src/*.js'" },
    }, required: ['query'] },
    run: (a) => search(a.query, { k: a.k, max_tokens: a.max_tokens, path_glob: a.path_glob }),
  },
  {
    name: 'lens_references',
    description: 'Find every line across the index that mentions a symbol (whole-word), grouped by file with line numbers. Use to see where a function/variable/class is used or defined before editing it.',
    inputSchema: { type: 'object', properties: {
      symbol: { type: 'string', description: 'The identifier to find, e.g. "parseAuthHeader"' },
      limit: { type: 'integer', description: 'Max references (default 400)' },
    }, required: ['symbol'] },
    run: (a) => references(a.symbol, { limit: a.limit }),
  },
  {
    name: 'lens_outline',
    description: 'Get a compact symbol map (functions, classes, headings) of a file with line numbers — understand structure without reading the whole file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: (a) => outline(a.path),
  },
  {
    name: 'lens_read',
    description: 'Read an exact line range of a file (surgical). Pair with lens_search / lens_outline to pull only the lines you need.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' },
    }, required: ['path'] },
    run: (a) => readLines(a.path, a.start || 1, a.end),
  },
  {
    name: 'lens_map',
    description: 'List the indexed files and language breakdown — a quick map of the repo.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
    run: (a) => map({ limit: a.limit }),
  },
  {
    name: 'lens_stats',
    description: 'Index statistics: file/chunk/line counts and languages.',
    inputSchema: { type: 'object', properties: {} },
    run: () => stats(),
  },
];

// ── What each tool does to the world ───────────────────────────────────────────
// MCP tool annotations (spec 2025-11-25). The spec's defaults are PESSIMISTIC: with no
// annotations at all, every tool here — including the pure reads — is declared
// destructive and open-world, and a conformant client should warn before each call.
// You do not become safe by omission. You become safe by saying so.
//
//   readOnlyHint    the tool changes nothing        → the client can skip the confirmation
//   destructiveHint it may overwrite or delete      → the client should warn first
//   idempotentHint  calling twice changes no more   → safe to retry on failure
//   openWorldHint   it reaches, or returns content from, outside our trust boundary
//                   (the web; the output of arbitrary code) → scrutinise what comes back
const ANNOTATIONS = {
  lens_search: {"readOnlyHint": true, "openWorldHint": false},
  lens_references: {"readOnlyHint": true, "openWorldHint": false},
  lens_outline: {"readOnlyHint": true, "openWorldHint": false},
  lens_read: {"readOnlyHint": true, "openWorldHint": false},
  lens_map: {"readOnlyHint": true, "openWorldHint": false},
  lens_stats: {"readOnlyHint": true, "openWorldHint": false},
  lens_index: {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
};

const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize')
    return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} },
      serverInfo: { name: 'lens', version: '0.1.0' } });
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list')
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: ANNOTATIONS[name] })) });
  if (method === 'tools/call') {
    const tool = toolMap[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    // Every tool DECLARES its required arguments in inputSchema, and nothing enforced
    // them. `lens_search` with no query did not say "query is required" — it called
    // search(undefined) and died three layers down with
    //     Cannot read properties of undefined (reading 'match')
    // which is what a model got back, as if it were an answer. A schema that promises a
    // check nobody performs is worse than no schema: the client trusts it.
    const args = params?.arguments || {};
    const missing = (tool.inputSchema?.required || [])
      .filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) {
      const how = missing
        .map((k) => `"${k}"${tool.inputSchema.properties?.[k]?.description ? ` (${tool.inputSchema.properties[k].description})` : ''}`)
        .join(', ');
      return fail(id, -32602, `${tool.name}: missing required argument${missing.length > 1 ? 's' : ''} ${how}`);
    }
    // ...and the TYPES it declares, and the enums. Nothing enforced those either, and
    // unlike a missing argument they do not crash — they corrupt, quietly:
    //   kanban_create_task labels:"urgent"   → a task whose labels are the letters u,r,g…
    //   cortex_write title:{...}             → a note on disk called "[object Object]"
    //   lens_search k:"eight"                → silently ignored, and you never learn why
    // Wrong data written confidently is worse than an error, because nothing announces it.
    const props = tool.inputSchema?.properties || {};
    const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    const OK = {
      string: (v) => typeof v === 'string',
      number: (v) => typeof v === 'number' && Number.isFinite(v),
      integer: (v) => Number.isInteger(v),
      boolean: (v) => typeof v === 'boolean',
      array: (v) => Array.isArray(v),
      object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    };
    const wrong = [];
    for (const [k, spec] of Object.entries(props)) {
      const v = args[k];
      if (v === undefined || v === null) continue;
      if (spec.type && OK[spec.type] && !OK[spec.type](v)) {
        wrong.push(`"${k}" must be ${spec.type}, got ${kindOf(v)}`);
      } else if (spec.enum && !spec.enum.includes(v)) {
        wrong.push(`"${k}" must be one of ${spec.enum.join(' | ')} — got ${JSON.stringify(v)}`);
      }
    }
    if (wrong.length) return fail(id, -32602, `${tool.name}: ${wrong.join('; ')}`);
    try {
      const out = await tool.run(args);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, String(e)); });
});
process.stderr.write('lens MCP server ready\n');
