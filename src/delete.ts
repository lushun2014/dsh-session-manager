/**
 * Hard deletion for dsh-session-manager: remove a session's JSONL artifacts
 * from disk, its local index row, and (when configured) the official
 * session-query FTS index row — leaving no trace on this machine.
 *
 * The JSONL layout this targets (the reference backend's):
 *   <sessionRoot>/<projectKey(cwd)>/<encodeSegment(id)>/   one directory per
 *   session containing every generation log plus the write lease.
 *
 * @module dsh-session-manager/delete
 */

import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
// Type-only import pulls this package's `declare module` Context augmentation
// (ctx.sessionPersistence) into the program.
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ResolvedConfig } from './config.js'
import type { IndexStore } from './index-store.js'

/** One session deletion, reported. */
export interface DeleteReport {
  /** The session id that was targeted. */
  readonly sessionId: string
  /** The JSONL session directory that was removed (or null when not configured/absent). */
  readonly removedJsonlDir: string | null
  /** The session-projection-cache file that was removed (or null when not configured/absent). */
  readonly removedProjCacheFile: string | null
  /** Whether a row in the local index was removed. */
  readonly removedLocalIndexRow: boolean
  /** The official FTS path pruned (or null when not configured/absent). */
  readonly prunedOfficialFts: string | null
  /** Advisory notes about anything that could not be fully removed. */
  readonly warnings: readonly string[]
}

/**
 * Resolve the session's creation cwd from a live session or the persistence
 * seam. Used to locate the JSONL directory.
 * @param ctx - context exposing sessions and the session-persistence seam.
 * @param sessionId - target session.
 * @returns the cwd, or undefined when it cannot be determined.
 */
async function resolveProjectCwd(ctx: Context, sessionId: string): Promise<string | undefined> {
  const live = ctx.sessions.get(SessionId(sessionId))
  if (live !== undefined) return live.header.cwd
  const snapshot = await ctx.sessionPersistence.stat(SessionId(sessionId))
  return snapshot?.header.cwd
}

/**
 * Compute the JSONL session directory for one session, mirroring the
 * reference backend's path layout.
 * @param root - the JSONL persistence root.
 * @param cwd - the session's creation directory (undefined maps to `_no-cwd`).
 * @param id - the session id.
 * @returns the absolute session directory.
 */
export function jsonlSessionDir(root: string, cwd: string | undefined, id: string): string {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd)
  return join(root, project, encodeSegment(id))
}

/**
 * Delete one session completely from this machine.
 * @param ctx - context exposing sessions and the session-persistence seam.
 * @param resolved - deployment policy (sessionRoot, projCacheRoot, officialFtsPath).
 * @param store - the local index store to prune a row from.
 * @param sessionId - target session id.
 * @returns the deletion report.
 */
export async function hardDelete(
  ctx: Context,
  resolved: ResolvedConfig,
  store: IndexStore,
  sessionId: string,
): Promise<DeleteReport> {
  const warnings: string[] = []
  let removedJsonlDir: string | null = null
  let removedProjCacheFile: string | null = null

  const projectCwd = await resolveProjectCwd(ctx, sessionId)

  // 1. JSONL session directory (the authoritative event source + lease).
  {
    const dir = jsonlSessionDir(resolved.sessionRoot, projectCwd, sessionId)
    try {
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true, maxRetries: 3 })
        removedJsonlDir = dir
      } else {
        warnings.push(`jsonl session directory not found at ${dir} (session may never have materialized, or the root differs)`)
      }
    } catch (error) {
      warnings.push(`failed to remove jsonl session directory ${dir}: ${messageOf(error)}`)
    }
  }

  // 2. Session-projection-cache file (the durable derived-state cache).
  if (resolved.projCacheRoot !== undefined) {
    const cacheFile = join(resolved.projCacheRoot, 'session_projcache', 'sessions', `${sessionId}.json`)
    try {
      if (existsSync(cacheFile)) {
        await rm(cacheFile, { force: true, maxRetries: 3 })
        removedProjCacheFile = cacheFile
      }
      // A missing file is not a failure: the cache is rebuilt on next access.
    } catch (error) {
      warnings.push(`failed to remove projection cache file ${cacheFile}: ${messageOf(error)}`)
    }
  }

  // 3. Local index row.
  const removedLocalIndexRow = store.deleteIndexRow(sessionId)

  // 4. Official FTS index row (best-effort; only when configured and present).
  const prunedOfficialFts = resolved.officialFtsPath !== undefined
    ? pruneOfficialFts(resolved.officialFtsPath, sessionId, warnings)
    : null

  return {
    sessionId,
    removedJsonlDir,
    removedProjCacheFile,
    removedLocalIndexRow,
    prunedOfficialFts,
    warnings,
  }
}

/**
 * Remove one session's rows from the official session-query SQLite index.
 * Mirrors the official backend's row layout (persisted_sessions/persisted_docs).
 * The live in-memory view is out of scope. Best-effort: a schema mismatch or
 * lock is recorded in `warnings`, never thrown.
 * @returns the pruned path, or null when the file was absent.
 */
function pruneOfficialFts(path: string, sessionId: string, warnings: string[]): string | null {
  if (!existsSync(path)) {
    warnings.push(`official FTS index not found at ${path}; nothing pruned there`)
    return null
  }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path)
    for (const table of ['persisted_sessions', 'persisted_docs']) {
      const info = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
      if (info === undefined) continue
      if (table === 'persisted_sessions') {
        db.prepare(`DELETE FROM persisted_sessions WHERE id = ?`).run(sessionId)
      } else {
        db.prepare(`DELETE FROM persisted_docs WHERE session_id = ?`).run(sessionId)
      }
    }
    return path
  } catch (error) {
    warnings.push(`could not prune official FTS index at ${path}: ${messageOf(error)}`)
    return null
  } finally {
    db?.close()
  }
}

/**
 * Build the readable project directory key for a path, exactly as the
 * reference backend does: separators (`/`, `\`, `:`) collapse to a single `-`,
 * unsafe code units become `~XXXX` (uppercase hex, zero-padded to 4), leading
 * dashes are stripped, the slug is capped at 251 chars, and the key is wrapped
 * in `--`.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('dsh-session-manager: cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd.charAt(i)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Escape one path segment exactly as the reference backend does: `.` and `..`
 * have fixed encodings, every other unsafe code unit becomes `~XXXX`.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('dsh-session-manager: cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
