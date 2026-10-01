# dsh-session-manager

DeepSeek Harness (dsh) plugin that gives the model **session-management tools** over its own session store:

| Tool | What it does |
| --- | --- |
| `session_generate_title` | LLM-generates a title for a session (default: current), records the official `session/title` event on the live session, and stores it in a local index. |
| `session_generate_summary` | LLM-generates a working summary of a session (default: current), stored **only** in the local index (never written into the official session log). |
| `session_find` | Keyword / project / id search over the local index. Resyncs bare rows from `ctx.sessionPersistence.list()` before every search so unindexed sessions are visible. |
| `session_delete` | **Hard delete** of a session: removes its JSONL session directory (all generation logs + write lease), its local index row, and — when configured — its rows in the official session-query SQLite index. Refuses to delete the currently running session. |

Zero native dependencies: the index and FTS pruning use the built-in `node:sqlite` module
(Node ≥ 22.5; tested on Node 26). Keyword search uses `LIKE` (no FTS5) so it works on every
standard `node:sqlite` build.

## Install

```sh
dsh plugin add dsh-session-manager
```

The bundle patches the profile plugin tree (`cordis.patch.yml`) with a
`dsh-session-manager` row. All config fields are optional — uncomment what your
deployment needs.

## Configuration

| Field | Required? | Meaning |
| --- | --- | --- |
| `provider` + `model` | optional, **as a pair** | Explicit LLM route for title/summary generation. Omit both to inherit the session's last logged `request/context` route. |
| `sessionRoot` | optional, **defaults to `<dshHome>/sessions`** | The `root` of your `@deepseek-ai/dsh-session-persistence-jsonl`. `<dshHome>` is the `DSH_HOME` env var or `~/.dsh` when unset — the standard profile layout. |
| `projCacheRoot` | optional, **defaults to `<dshHome>/storages`** | Root of the durable cache trees; delete removes the per-session projection-cache file `<root>/session_projcache/sessions/<id>.json`. |
| `officialFtsPath` | optional | The `path` of your `@deepseek-ai/dsh-session-query-sqlite` index; its `persisted_sessions` / `persisted_docs` rows are pruned on delete. Skip when it runs as `:memory:`. |
| `indexPath` | optional | Local index file. Defaults to `~/.dsh-session-manager/index.sqlite`. |
| `titleMaxOutputTokens` | optional, default 64 | Cap for title generation. |
| `summaryMaxOutputTokens` | optional, default 1024 | Cap for summary generation. |
| `timeoutMs` | optional, default 60000 | End-to-end auxiliary request deadline. |
| `maxInputBytes` | optional, default 32768 | Conversation text budget framed into one auxiliary prompt. |
| `maxResults` | optional, default 20 | Search result cap for `session_find`. |

## How `session_delete` finds the session directory

The JSONL backend lays sessions out as:

```
<sessionRoot>/<projectKey(cwd)>/<encodeSegment(sessionId)>/
```

`projectKey` collapses path separators to `-` and hex-encodes unsafe code units
(`F:\Hermes数据\demo` → `--F-Hermes~6570~636E-demo--`); `encodeSegment` does the
same per-segment. Both are copied verbatim from the reference
`jsonl-format.ts`, so this matches the official backend exactly. The directory
contains every generation log (`.jsonl` / `.jsonl.zstd`) plus the write lease
(`session.lock`); `hardDelete` removes the whole directory, then the local index
row, then the official FTS rows (best-effort, schema-checked, lock-tolerant).

The session's cwd is resolved from the live session when available, otherwise
from `ctx.sessionPersistence.stat()`.

`hardDelete` removes **every** per-session artifact on this machine:

1. The JSONL session directory (all generation logs + write lease).
2. The projection-cache file `<projCacheRoot>/session_projcache/sessions/<id>.json`
   (the durable derived-state cache; missing file is not an error — it is
   rebuilt on next access).
3. The local index row (`deleteIndexRow`).
4. The official FTS rows, when `officialFtsPath` is configured
   (best-effort, schema-checked, lock-tolerant; advisory only).

## Guardrails

- **No self-delete.** `session_delete` resolves the current session from the
  execution context (`exec.agent.session.id`) and refuses to target it.
- **Summaries never touch the official log.** The official session log is
  fail-closed to unknown event data; only the normalized `session/title`
  event shape is ever appended to a live session.
- **Official FTS pruning is advisory.** A missing file, schema mismatch, or
  locked database is recorded in the delete report's `warnings`, never thrown.

## Publishing / distribution

Five supported paths (per the dsh docs, §18.1):

| Path | How |
| --- | --- |
| Local patch overlay | `dsh web --patch ./my.patch.yml` pointing `name: ./src/index.ts` at the source file (fastest dev loop) |
| Bundle + profile install | `dsh plugin add ./dsh-session-manager` (local dir) — this package declares `dsh.bundle` |
| npm publish | `npm publish` (the `prepare` script builds `lib/` first) then `dsh plugin add dsh-session-manager` |
| tarball | `npm pack` → `dsh plugin add ./dsh-session-manager-0.1.0.tgz` |
| GitHub | `dsh plugin add github:you/dsh-session-manager` — pulls **source**, runs the `prepare` script to build `lib/`; pnpm ≥ 10 requires you to allow-list the package's exact key under `allowBuilds:` in the profile's `pnpm-workspace.yaml`, then re-run `add` (treat that as authorizing the package to run on your machine) |

## Development

```sh
npm install          # registry: https://registry.npmmirror.com in restricted networks
npm run typecheck    # tsc --noEmit
npm run build        # emits lib/ + lib/types/
node scripts/verify-delete.mjs   # e2e: fake JSONL dir + local index + official FTS, hardDelete, assert all gone
```

## Layout

```
src/index.ts        plugin entry (name/inject/Config/apply + tool registrations)
src/config.ts       config resolution + defaults
src/llm.ts          title/summary generation via ctx.llm.stream (BlockAssembler)
src/index-store.ts  local SQLite index (node:sqlite, LIKE search)
src/delete.ts       hardDelete + jsonlSessionDir/projectKey/encodeSegment
```
