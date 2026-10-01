/**
 * Plugin entry: model-facing session-management tools for DeepSeek Harness.
 *
 * Tools:
 *  - session_generate_title   LLM title for a session -> official `session/title` event + local index
 *  - session_generate_summary LLM summary of a session -> local index only (never written into the session log)
 *  - session_find             keyword/project search over the local index, with on-demand resync from persisted sessions
 *  - session_delete           hard deletion: JSONL session directory + local index row + optional official FTS row
 *
 * @module dsh-session-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveConfig, type ResolvedConfig } from './config.js'
import { generateTitle, generateSummary, recordTitleOnLiveSession } from './llm.js'
import { IndexStore } from './index-store.js'
import { hardDelete } from './delete.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'dsh-session-manager'

/** Capability services this plugin injects. */
export const inject = ['tools', 'systemPrompt', 'llm', 'sessions', 'sessionPersistence']

/** Optional deployment configuration; every field has a default. */
export interface Config {
  /** Explicit LLM provider route for auxiliary calls; must be paired with `model`. */
  provider?: string
  /** Explicit LLM model id for auxiliary calls; must be paired with `provider`. */
  model?: string
  /** Local index + summary store path. Defaults to `~/.dsh-session-manager/index.sqlite`. */
  indexPath?: string
  /**
   * JSONL persistence root that `session_delete` removes artifacts from.
   * Defaults to `<dshHome>/sessions` (`DSH_HOME` env or `~/.dsh`).
   * Match the `root` of your `@deepseek-ai/dsh-session-persistence-jsonl`.
   */
  sessionRoot?: string
  /**
   * Root of the durable cache trees that `session_delete` removes the
   * per-session projection cache from (`<root>/session_projcache/sessions/<id>.json`).
   * Defaults to `<dshHome>/storages`. Match the `root` of your
   * `@deepseek-ai/dsh-storage-json` / `dsh-session-projection-cache`.
   */
  projCacheRoot?: string
  /** Optional official session-query SQLite FTS index to prune rows from on delete. */
  officialFtsPath?: string
  /** Auxiliary output-token cap for titles. Defaults to 64. */
  titleMaxOutputTokens?: number
  /** Auxiliary output-token cap for summaries. Defaults to 1024. */
  summaryMaxOutputTokens?: number
  /** End-to-end auxiliary request deadline in milliseconds. Defaults to 60000. */
  timeoutMs?: number
  /** Maximum UTF-8 bytes of conversation text framed into one auxiliary prompt. Defaults to 32768. */
  maxInputBytes?: number
  /** Maximum rows returned by `session_find`. Defaults to 20. */
  maxResults?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  provider: z.string(),
  model: z.string(),
  indexPath: z.string(),
  sessionRoot: z.string(),
  projCacheRoot: z.string(),
  officialFtsPath: z.string(),
  titleMaxOutputTokens: z.number().step(1).min(1).default(64),
  summaryMaxOutputTokens: z.number().step(1).min(1).default(1024),
  timeoutMs: z.number().step(1).min(1).default(60_000),
  maxInputBytes: z.number().step(1).min(1).default(32_768),
  maxResults: z.number().step(1).min(1).default(20),
})

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const PROMPT_TEXT =
  'Session management tools: use session_generate_title to name the current or a target session; '
  + 'session_generate_summary to store a generated summary for later recall; session_find to locate prior '
  + 'sessions by keyword, project, or id; session_delete to permanently remove a session from this machine '
  + '(irreversible; it refuses to delete the session that is currently running). Always confirm with the user '
  + 'before calling session_delete.'

/** Register the model-facing session-management tools. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const store = new IndexStore(resolved.indexPath)
  store.ensureSchema()

  // Release the SQLite handle when the plugin unloads or is hot-replaced
  // (each effect is auto-disposed in reverse order on teardown).
  ctx.effect(() => () => {
    store.close()
  }, 'dsh-session-manager index handle')

  ctx.systemPrompt.section({
    name: 'tool:session-manager',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY'),
    text: PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'session_generate_title',
    description:
      'Generate a concise LLM title for a session (default: the current session) and record it in the local '
      + 'session index. Returns the generated title as JSON.',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'Target session id. Omit for the current session.',
      },
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    execute: (args, exec) => runTitle(ctx, exec, resolved, store, args),
  }))

  ctx.tools.register(defineTool({
    name: 'session_generate_summary',
    description:
      'Generate an LLM summary of a session (default: the current session) and store it in the local session '
      + 'index so it can be found later with session_find. Returns the summary as JSON.',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'Target session id. Omit for the current session.',
      },
      focus: {
        type: 'string',
        description: 'Optional instruction narrowing the summary, e.g. "focus on decisions and next steps".',
      },
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    execute: (args, exec) => runSummary(ctx, exec, resolved, store, args),
  }))

  ctx.tools.register(defineTool({
    name: 'session_find',
    description:
      'Search the local session index by keyword (matches id, project, title, and stored summaries), by project, '
      + 'or by session id. The index is resynced from persisted sessions before searching so unindexed sessions '
      + 'are visible. Returns matching sessions as JSON.',
    parameters: {
      keyword: {
        type: 'string',
        description: 'Case-insensitive substring searched across id, project, title, and summary fields.',
      },
      project: {
        type: 'string',
        description: 'Project directory key to restrict results (the cwd stored with the session).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum rows to return (capped by the deployment maxResults).',
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => runFind(ctx, resolved, store, args),
  }))

  ctx.tools.register(defineTool({
    name: 'session_delete',
    description:
      'Permanently delete a session from this machine: removes its JSONL session directory, the local index row, '
      + 'and (when configured) the official FTS index row. This is irreversible and leaves no trace. It refuses '
      + 'to delete the currently running session. Returns a JSON report of what was removed.',
    parameters: {
      sessionId: {
        type: 'string',
        description: 'Session id to delete. Omit to target the current session (which is refused).',
      },
    },
    output: TEXT_OUTPUT,
    timeoutMs: resolved.timeoutMs,
    execute: (args, exec) => runDelete(ctx, exec, resolved, store, args),
  }))
}

/* ---------------- tool bodies ---------------- */

interface ToolArgs {
  readonly sessionId?: string
  readonly focus?: string
  readonly keyword?: string
  readonly project?: string
  readonly limit?: number
}

function currentSessionId(exec: ToolRunContext): string | undefined {
  const agent = exec.agent
  return agent?.session === undefined ? undefined : agent.session.id
}

async function runTitle(ctx: Context, exec: ToolRunContext, resolved: ResolvedConfig, store: IndexStore, args: unknown): Promise<string> {
  const { sessionId } = (args ?? {}) as ToolArgs
  const target = targetSessionId(exec, sessionId)
  if (target === undefined) {
    return jsonResult({ ok: false, error: 'no current session; pass an explicit sessionId' })
  }
  try {
    const generated = await generateTitle(ctx, resolved, target, exec.signal)
    // Record on the live session so the title shows up in the harness UI;
    // persist it to the local index for cross-session recall.
    const live = ctx.sessions.get(SessionId(target))
    if (live !== undefined) {
      recordTitleOnLiveSession(live, generated.title, generated.messageSeqs, undefined)
    }
    store.upsertTitle(target, generated.title)
    return jsonResult({ ok: true, sessionId: target, title: generated.title, indexed: true, recordedOnSession: live !== undefined })
  } catch (error) {
    return jsonResult({ ok: false, sessionId: target, error: messageOf(error) })
  }
}

async function runSummary(ctx: Context, exec: ToolRunContext, resolved: ResolvedConfig, store: IndexStore, args: unknown): Promise<string> {
  const { sessionId, focus } = (args ?? {}) as ToolArgs
  const target = targetSessionId(exec, sessionId)
  if (target === undefined) {
    return jsonResult({ ok: false, error: 'no current session; pass an explicit sessionId' })
  }
  try {
    const summary = await generateSummary(ctx, resolved, target, focus, exec.signal)
    store.upsertSummary(target, summary)
    return jsonResult({ ok: true, sessionId: target, summary, indexed: true })
  } catch (error) {
    return jsonResult({ ok: false, sessionId: target, error: messageOf(error) })
  }
}

async function runFind(ctx: Context, resolved: ResolvedConfig, store: IndexStore, args: unknown): Promise<string> {
  const { keyword, project, limit } = (args ?? {}) as ToolArgs
  try {
    const synced = await store.resync(ctx)
    const cap = Math.max(1, Math.min(resolved.maxResults, Math.trunc(limit ?? resolved.maxResults)))
    const rows = store.search({ keyword, project, limit: cap })
    return jsonResult({ ok: true, newlyIndexed: synced, count: rows.length, sessions: rows })
  } catch (error) {
    return jsonResult({ ok: false, error: messageOf(error) })
  }
}

async function runDelete(ctx: Context, exec: ToolRunContext, resolved: ResolvedConfig, store: IndexStore, args: unknown): Promise<string> {
  const { sessionId } = (args ?? {}) as ToolArgs
  const current = currentSessionId(exec)
  const target = targetSessionId(exec, sessionId)
  if (target === undefined) {
    return jsonResult({ ok: false, error: 'no current session; pass an explicit sessionId' })
  }
  if (current !== undefined && target === current) {
    return jsonResult({
      ok: false,
      sessionId: target,
      error: 'refusing to delete the currently running session; end it first (or delete it from the CLI)',
    })
  }
  try {
    const report = await hardDelete(ctx, resolved, store, target)
    return jsonResult({ ok: true, ...report })
  } catch (error) {
    return jsonResult({ ok: false, sessionId: target, error: messageOf(error) })
  }
}

/* ---------------- helpers ---------------- */

function targetSessionId(exec: ToolRunContext, explicit: string | undefined): string | undefined {
  const id = explicit?.trim() !== undefined && explicit.trim().length > 0 ? explicit.trim() : currentSessionId(exec)
  return id
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
