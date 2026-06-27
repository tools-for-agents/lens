# 🔎 lens

**Token-efficient code & doc retrieval for agents.**

The biggest token sink for a coding agent is reading whole files to find a few relevant lines. `lens` fixes that: index a repo once, then **search for ranked snippets**, get a **symbol outline** of a file, or do a **surgical line read** — pulling *just enough* context instead of the whole file.

Part of [`tools-for-agents`](https://github.com/tools-for-agents). **Zero dependencies** — Node standard library + built-in `node:sqlite` with FTS5 (BM25 ranking).

---

## Why

| Without lens | With lens |
|---|---|
| `Read` a 600-line file to find one function → ~6k tokens | `lens_search "parse auth header"` → ~300 tokens of the exact snippets |
| Read a file just to learn its structure | `lens_outline` → a symbol map, ~100 tokens |
| Re-read whole files after each edit | incremental reindex touches only changed files |

## CLI

```bash
node src/cli.js index .                       # build the index (incremental on re-run)
node src/cli.js search "websocket reconnect" -k 6 --tokens 1500 --glob 'src/*'
node src/cli.js outline src/server.js         # symbol map, no full read
node src/cli.js read src/server.js 40 80      # surgical line range
node src/cli.js stats                         # index stats
```

Index location is `./.lens/index.db` (override with `LENS_DB`).

## MCP server (for agents)

```jsonc
{
  "mcpServers": {
    "lens": { "command": "node", "args": ["/abs/path/to/lens/mcp/mcp-server.js"],
              "env": { "LENS_DB": "/abs/path/to/repo/.lens/index.db" } }
  }
}
```

### Tools

| Tool | Use it to… |
|---|---|
| `lens_index` | Index / refresh a path (incremental: only changed files re-read). |
| `lens_search` | Get ranked snippets within a **token budget** — use instead of reading files. |
| `lens_outline` | Get a file's symbol map (functions/classes/headings) with line numbers. |
| `lens_read` | Read an exact line range. |
| `lens_map` | List indexed files + language breakdown. |
| `lens_stats` | Index statistics. |

## How it works

- Walks a tree (skipping `node_modules`, `.git`, build dirs, binaries, huge files).
- Chunks each file into overlapping line windows and stores them in an **FTS5** virtual table.
- `search` runs an FTS5 `MATCH` ranked by **bm25**, then fills results up to a token budget (≈4 chars/token).
- `outline` is regex-based per language (js/ts, py, go, rust, java, ruby, sql, markdown…).
- `index` is **incremental** — files unchanged since last index (by mtime) are skipped.

MIT licensed.
