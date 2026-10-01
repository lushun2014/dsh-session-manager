// End-to-end check for hardDelete: prove the JSONL dir, local index row, and
// official FTS rows are all actually removed from disk.
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { hardDelete, jsonlSessionDir, projectKey, encodeSegment } from '../lib/delete.js'
import { IndexStore } from '../lib/index-store.js'

const base = mkdtempSync(join(tmpdir(), 'dsh-sm-test-'))
console.log('temp base:', base)

// --- fake JSONL session layout -------------------------------------------
const cwd = 'F:/Hermes数据/demo'
const root = join(base, 'sessions')
const sessionId = 'abc-123-demo'
const dir = jsonlSessionDir(root, cwd, sessionId)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'abc-123-demo.jsonl'), '{"seq":0,"type":"session/created"}\n')
writeFileSync(join(dir, 'session.lock'), 'lease')
console.log('jsonl dir created at:', dir)
console.log('  projectKey =', projectKey(cwd))
console.log('  encodeSegment =', encodeSegment(sessionId))
const dirBefore = existsSync(dir)

// --- local index ----------------------------------------------------------
const indexPath = join(base, 'index.sqlite')
const store = new IndexStore(indexPath)
store.ensureSchema()
store.upsertTitle(sessionId, 'a title')
console.log('local index row present:', store.peek(sessionId) !== undefined)

// --- official FTS index ---------------------------------------------------
const ftsPath = join(base, 'fts.sqlite')
const fts = new DatabaseSync(ftsPath)
fts.exec(`
  CREATE TABLE persisted_sessions (id TEXT PRIMARY KEY, title TEXT);
  CREATE TABLE persisted_docs (session_id TEXT, body TEXT);
`)
fts.prepare('INSERT INTO persisted_sessions (id, title) VALUES (?, ?)').run(sessionId, 'a title')
fts.prepare('INSERT INTO persisted_docs (session_id, body) VALUES (?, ?)').run(sessionId, 'doc text')
fts.close()
console.log('official FTS rows present: yes')

// --- session-projection-cache file --------------------------------------
const projCacheDir = join(base, 'storages', 'session_projcache', 'sessions')
mkdirSync(projCacheDir, { recursive: true })
writeFileSync(join(projCacheDir, `${sessionId}.json`), '{"state":1}')
console.log('projcache file present: yes')

// --- fake ctx: not live -> fall back to sessionPersistence.stat ----------
const ctx = {
  sessions: { get: () => undefined },
  sessionPersistence: { stat: async () => ({ header: { cwd } }) },
}

const resolved = { sessionRoot: root, projCacheRoot: join(base, 'storages'), officialFtsPath: ftsPath }
const report = await hardDelete(ctx, resolved, store, sessionId)

// --- assert everything is gone ------------------------------------------
console.log('\n=== DeleteReport ===')
console.log(JSON.stringify(report, null, 2))

const projCacheFile = join(projCacheDir, `${sessionId}.json`)
const results = []
results.push(['jsonl dir removed', !existsSync(dir)])
results.push(['projcache file removed', !existsSync(projCacheFile)])
results.push(['local index row pruned', store.peek(sessionId) === undefined])
const fts2 = new DatabaseSync(ftsPath)
const sessRow = fts2.prepare('SELECT COUNT(*) c FROM persisted_sessions WHERE id=?').get(sessionId)
const docRow = fts2.prepare('SELECT COUNT(*) c FROM persisted_docs WHERE session_id=?').get(sessionId)
fts2.close()
results.push(['official persisted_sessions row pruned', Number(sessRow.c) === 0])
results.push(['official persisted_docs row pruned', Number(docRow.c) === 0])
results.push(['jsonl dir existed before delete', dirBefore === true])
results.push(['report claims jsonl dir removed', report.removedJsonlDir === dir])
results.push(['report claims projcache removed', report.removedProjCacheFile === projCacheFile])

let ok = true
for (const [label, pass] of results) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) ok = false
}
console.log('\nALL PASS:', ok)

// Tolerate Windows file-locking on just-closed SQLite handles during cleanup.
setTimeout(() => {
  try { rmSync(base, { recursive: true, force: true }) } catch { /* best-effort */ }
  process.exit(ok ? 0 : 1)
}, 300)
