# AGENTS.md — lens

🔎 **Token-efficient code & doc retrieval for agents.** FTS5 search, symbol outlines and surgical line reads,
so an agent pulls *just enough* context instead of reading whole files. CLI + web explorer + MCP.
Part of [tools-for-agents](https://github.com/tools-for-agents).

## Setup

```bash
node --version                          # 22+ required. Nothing to install.
npm test                                # = node --test
node src/cli.js index .                 # build the index for a repo
node src/cli.js search "some query"
node src/cli.js serve --port 7900       # the web explorer
npm run mcp                             # the MCP server, stdio
```

**Zero runtime dependencies, and that is a hard rule.** No `dependencies` in `package.json`, ever. Node 22+
gives you `node:sqlite` (FTS5 included) and a test runner.

| Env | For |
|---|---|
| `LENS_DB` | the index database — **always redirect this in tests** |
| `LENS_PORT` | serve port (default 7900) |
| `LENS_CORTEX_URL` | optional cortex link-up |

## The rules this repo is built on

**1. Only the picture is evidence.** Run [iris](https://github.com/tools-for-agents/iris) against any UI
change and *look at the shot* before saying it works. `.ch-btn.brain:hover` shipped from this repo at
**2.72:1 and was found by hand** — the `--hover` flag that now gates the whole kit exists *because of lens*,
and lens was the last repo not using it. Audit `phone,tablet,desktop`, both themes, with `--hover`.

**2. Open the doors.** A state behind a button is a state nothing has ever rendered. Drive the page with
`--pre` and look. Still unopened here: `.okind`, `.refline`, `.tm-file`, `.stale button`.

**3. Ranking is a contract.** bm25 ordering with equal scores must not be nondeterministic — a tie-break that
depends on insertion order makes results shuffle between runs and the tool untrustworthy.

**4. Token budget is the point.** Every change should be judged by "does this let the model read less?" A
result that forces the agent to open the whole file anyway is a failure, even if it is correct.

## Tests

`npm test` — `node --test`, **no test may be skipped**. Prefer a test that fails against the original code.

## CI

`test` · `mutants` · `look` · `look-results` · `look-reader` · `first-run` · `states` · `dead-api` ·
`slow-api`

- **`mutants`** breaks the code on purpose — every canary must die. Push and read CI; do not run it locally.
- **`look*`** are iris gates, seeded with real data first — an empty page cannot be wrong.

## Commits

Lowercase, `area: what changed and why it mattered` — `core:`, `ui:`, `ci:`, `fix:`. Say what was actually
wrong, including what fooled you. The git log is this project's real documentation.
