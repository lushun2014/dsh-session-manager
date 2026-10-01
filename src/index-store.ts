/**
 * Local SQLite index for dsh-session-manager: one `sessions` row per known
 * session, carrying id, project (cwd), title, and LLM summary. Backed by the
 * built-in `node:sqlite` module (no native deps). Keyword search uses LIKE so
 * the node:sqlite binary build (which may omit FTS5) is safe.
 * @module dsh-session-manager/index-store
 */

import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
// Type-only import pulls this package's `declare module` Context augmentation
// (ctx.sessionPersistence) plus the snapshot type into the program.
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { ResolvedConfig } from './config.js'

/** One indexed session row. */
export interface IndexRow {
  readonly id: string
  readonly project: string | null
  readonly title: string | null
  readonly summary: string | null
  readonly createdAt: number | null
  readonly indexedAt: number
  readonly source: string
}

/** Filters for {@link IndexStore.search}. */
export interface SearchQuery {
  readonly keyword?: string
  readonly project?: string
  readonly limit: number
}

/**
 * A file-backed session index.
 *
 * The store is created lazily against one SQLite file and is safe to reuse
 * across tool calls within a plugin lifetime. Call {@link close} when the
 * owning plugin unloads (or on HMR replacement) to release the file handle.
 */
export class IndexStore {
  private readonly db: DatabaseSync
  private closed = false

  constructor(indexPath: string) {
    mkdirSync(dirname(indexPath), { recursive: true })
    this.db = new DatabaseSync(indexPath)
  }

  /** Close the underlying SQLite handle. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db.close()
    } catch {
      // Already closed or handle lost; nothing left to release.
    }
  }

  /** Create the schema if absent. Idempotent. */
  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        project     TEXT,
        title       TEXT,
        summary     TEXT,
        created_at  INTEGER,
        indexed_at  INTEGER NOT NULL,
        source      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project);
      CREATE INDEX IF NOT EXISTS idx_sessions_title ON sessions (title);
    `)
  }

  /**
   * Upsert one row's title (inserting a bare row when the id is unknown).
   * @param id - session id.
   * @param title - normalized title text.
   */
  upsertTitle(id: string, title: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, indexed_at, source)
         VALUES (?, ?, ?, 'llm-title')
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title,
           indexed_at = excluded.indexed_at,
           source = CASE WHEN sessions.source IN ('persistence') THEN 'persistence+llm-title' ELSE 'llm-title' END`,
      )
      .run(id, title, Date.now())
  }

  /**
   * Upsert one row's summary (inserting a bare row when the id is unknown).
   * @param id - session id.
   * @param summary - summary text.
   */
  upsertSummary(id: string, summary: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, summary, indexed_at, source)
         VALUES (?, ?, ?, 'llm-summary')
         ON CONFLICT (id) DO UPDATE SET
           summary = excluded.summary,
           indexed_at = excluded.indexed_at,
           source = CASE WHEN sessions.source IN ('persistence') THEN 'persistence+llm-summary' ELSE 'llm-summary' END`,
      )
      .run(id, summary, Date.now())
  }

  /**
   * Remove one row. No-op when the id is absent.
   * @param id - session id.
   * @returns whether a row was actually removed.
   */
  deleteIndexRow(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
    return Number(result.changes) > 0
  }

  /**
   * Read one row's fields (project + created_at) without touching title/summary.
   * @param id - session id.
   * @returns the partial fields, or undefined when unknown.
   */
  peek(id: string): { project: string | null; createdAt: number | null } | undefined {
    const row = this.db
      .prepare(`SELECT project, created_at FROM sessions WHERE id = ?`)
      .get(id) as { project: string | null; created_at: number | null } | undefined
    if (row === undefined) return undefined
    return { project: row.project, createdAt: row.created_at }
  }

  /**
   * Sync the index with every persisted session: insert a bare row for any
   * session id not yet known, backfilling project (cwd) and created_at, and
   * backfill a still-null project / created_at on a row that an earlier LLM
   * upsert created before the persistence seam was observed.
   * @param ctx - context exposing the session-persistence seam.
   * @returns the number of session ids that had no local row before this call.
   */
  async resync(ctx: Context): Promise<number> {
    const snapshots = await ctx.sessionPersistence.list()
    const headers = snapshots.map((snapshot: SessionPersistenceSnapshot) => ({
      id: snapshot.header.id,
      cwd: snapshot.header.cwd,
      createdAt: snapshot.header.createdAt,
    }))
    const unknown = headers.filter(header => this.peek(header.id) === undefined).length
    this.resyncSync(headers)
    return unknown
  }

  /**
   * Backfill bare rows for a batch of persisted session headers. Idempotent:
   * an unknown id is inserted; an existing row keeps its values but a still
   * null project / created_at is backfilled from the header.
   * @param headers - one entry per persisted session (id, cwd, createdAt).
   */
  resyncSync(headers: readonly { readonly id: string; readonly cwd?: string; readonly createdAt: number }[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO sessions (id, project, created_at, indexed_at, source)
       VALUES (?, ?, ?, ?, 'persistence')
       ON CONFLICT (id) DO UPDATE SET
         project    = COALESCE(sessions.project, excluded.project),
         created_at = COALESCE(sessions.created_at, excluded.created_at)`,
    )
    for (const header of headers) {
      upsert.run(header.id, header.cwd ?? null, header.createdAt, Date.now())
    }
  }

  /**
   * Search the index by keyword (id/project/title/summary) and/or project.
   * @param query - filters and page size.
   * @returns matching rows, most recently indexed first.
   */
  search(query: SearchQuery): readonly IndexRow[] {
    const where: string[] = []
    const params: (string | number | null)[] = []
    if (query.project !== undefined && query.project.trim().length > 0) {
      where.push('project = ?')
      params.push(query.project.trim())
    }
    if (query.keyword !== undefined && query.keyword.trim().length > 0) {
      const escaped = escapeLike(query.keyword.trim())
      const like = `%${escaped}%`
      where.push(
        `(id LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')`,
      )
      params.push(like, like, like, like)
    }
    const sql = `
      SELECT id, project, title, summary, created_at AS createdAt, indexed_at AS indexedAt, source
      FROM sessions
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY indexed_at DESC
      LIMIT ?
    `
    params.push(query.limit)
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string
      project: string | null
      title: string | null
      summary: string | null
      createdAt: number | null
      indexedAt: number
      source: string
    }>
    return rows.map(row => ({
      id: row.id,
      project: row.project,
      title: row.title,
      summary: row.summary,
      createdAt: row.createdAt,
      indexedAt: row.indexedAt,
      source: row.source,
    }))
  }
}

/** Escape a user-supplied LIKE pattern (neutralize %, _, and the escape char). */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}
