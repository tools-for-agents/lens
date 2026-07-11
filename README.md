# 🔎 lens

[![ci](https://github.com/tools-for-agents/lens/actions/workflows/ci.yml/badge.svg)](https://github.com/tools-for-agents/lens/actions/workflows/ci.yml)

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
node src/cli.js refs parseAuthHeader          # every line that mentions a symbol
node src/cli.js outline src/server.js         # symbol map, no full read
node src/cli.js read src/server.js 40 80      # surgical line range
node src/cli.js stats                         # index stats
node src/cli.js serve                         # browsable web explorer → :7900
```

Index location is `./.lens/index.db` (override with `LENS_DB`).

## Web explorer (`lens serve`)

![lens serve — the code explorer: file tree, FTS search, syntax-highlighted reader and symbol outline](docs/web-view.png)

```bash
node src/cli.js index .        # index the repo you're in
node src/cli.js serve          # → http://localhost:7900  (--port to change)
```

A zero-dependency, IDE-style explorer for the same index the agent queries — so a human can see what `lens` sees:

- **FTS search** across the repo, ranked by bm25, with each snippet's **`~token` cost** and matched terms highlighted — the token-budgeted view an agent gets.
- **File tree** grouped by directory with a language-distribution bar, and a per-file **token-weight bar** (scaled to the heaviest file) so the pages that are expensive to read whole stand out at a glance — hover any file for its exact `~token` cost. Reading the right lines instead of the whole file is the point of `lens`, and the tree now shows you where that matters most.
- **The index knows when it's lying** — lens serves an index of a tree that keeps moving underneath it. Now it checks: if files changed, appeared or were deleted since you indexed, the rail says so (*“1 changed · 1 new · 1 deleted — search and the tree are answering from the old tree”*) and offers **↻ re-index**, which rebuilds without leaving the browser. Re-indexing is a `POST` (a `GET` must never make the server walk your disk).
- **The treemap** (`◱ map`) — where the repo's tokens actually *are*. Every file is a rectangle whose **area is its token cost**, grouped by directory and coloured by language, so the mass of the repo is a shape you can see: in `lens` itself, one file is **55% of the entire index**. Those are the files an agent must never read whole — which is the entire argument for `lens`, finally visible. Hover for the exact cost, click to open it. (The layout compensates each directory's header/padding, so a small file in a small folder is drawn at the same tokens-per-pixel as a big one — a treemap that lies about area isn't worth drawing.)
- **Recent files** — the files you've opened surface as clickable chips above the tree (remembered in the browser only, most-recent first); jump back to one in a click, or **clear ✕** to forget them.
- **Syntax-highlighted reader** with line numbers and a live **symbol outline** that **tracks your scroll** — the symbol you're currently reading stays highlighted, and clicking one jumps to it (or ⇉ to find its references). **Filter the outline by kind** — chips (`fn` · `class` · `type` · `const` · …, each with a count) narrow a big file's symbol list to just the functions, or just the classes, in one click.
- **Jump to symbol** — hit `⌘⇧O` (or the **⤳ jump** button on the outline) for a quick-nav palette over the open file: type to fuzzy-filter its symbols (matches highlighted), `↑`/`↓` to move, `Enter` to fly to one, `Esc` to dismiss — the same jump-to-symbol muscle memory as your editor, in the browser.
- **Find references** — flip the search to `⇉ refs` mode (or hit ⇉ on an outline symbol) to list every line across the repo that mentions a symbol, grouped by file; click a line to open it.
- **Copy path · copy permalink** — the reader header carries **⧉ path** (the file path, ready to paste into a prompt or a shell) and **⧉ link** (a permalink to exactly what you're reading). Click a line number to aim the permalink at that line: the URL bar becomes `…/#src/core.js:45`, and opening that link anywhere — another browser, another agent, a `recall` briefing — lands on that file at that line.
- **Send a passage to cortex** — hit **🧠 → cortex** in the reader and the code you're looking at becomes a note in your [second brain](https://github.com/tools-for-agents/cortex): the lines you selected, or — if you selected nothing — the symbol you're currently reading. It lands as a fenced code block carrying lens's own `#path:line` permalink as its source, so the note can always walk back to the code. lens never writes: your browser POSTs to cortex's own `/api/capture` (point it elsewhere with `LENS_CORTEX_URL`).
- **Light or dark** — a ◐ toggle (remembered per browser; follows your OS preference by default), with a syntax palette tuned for each.
- **Keyboard-accessible** — every control has a visible focus ring, the file tree and symbol outline are operable with Tab + Enter (not just the mouse), and icon controls carry aria-labels.
- Read-only; `outline`/`read` are guarded to indexed paths (no traversal).

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
| `lens_references` | Find every line that mentions a symbol (whole-word), grouped by file — where is it used/defined? |
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

## The agent toolkit

`lens` is the **read-code** leg of the `tools-for-agents` toolkit:

- 🛰️ [**agent-hq**](https://github.com/tools-for-agents/agent-hq) — coordinate (memory, kanban, dashboard)
- 🔎 **lens** — read code (token-budgeted retrieval)
- ⚒ [**anvil**](https://github.com/tools-for-agents/anvil) — run safely (sandboxed execution)
- 🧠 [**cortex**](https://github.com/tools-for-agents/cortex) — remember (Obsidian-compatible second brain)
- 🧭 [**scout**](https://github.com/tools-for-agents/scout) — read the web (clean, cached markdown)
- 🎯 [**recall**](https://github.com/tools-for-agents/recall) — recall it all (one query across every store)

MIT licensed.
