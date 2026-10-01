// End-to-end check for session_find plumbing: local index upserts, resync
// backfill (COALESCE fix), and keyword/project search.
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

import { IndexStore } from '../lib/index-store.js'

const base = mkdtempSync(join(tmpdir(), 'dsh-sm-find-'))
const store = new IndexStore(join(base, 'index.sqlite'))
store.ensureSchema()

// 1. LLM upsert creates a bare row (project null) BEFORE persistence is known.
store.upsertTitle('sess-a', 'debug the parser')
store.upsertSummary('sess-b', 'refactor auth middleware')
assert.equal(store.peek('sess-a')?.project, null, 'bare row has no project yet')

// 2. resync with the persistence seam: backfills the bare row's project and
//    counts only ids that had no row yet.
const fakeCtx = {
  sessionPersistence: {
    list: async () => [
      { header: { id: 'sess-a', cwd: 'F:/proj/one', createdAt: 1000 } },
      { header: { id: 'sess-b', cwd: 'F:/proj/two', createdAt: 2000 } },
      { header: { id: 'sess-new', cwd: 'F:/proj/three', createdAt: 3000 } },
    ],
  },
}
const newlyIndexed = await store.resync(fakeCtx)
assert.equal(newlyIndexed, 1, 'only sess-new was new')
assert.equal(store.peek('sess-a')?.project, 'F:/proj/one', 'COALESCE backfill of project')
assert.equal(store.peek('sess-a')?.createdAt, 1000, 'COALESCE backfill of created_at')

// 3. Second resync is idempotent: nothing new, values preserved.
const second = await store.resync(fakeCtx)
assert.equal(second, 0, 'resync is idempotent')
assert.equal(store.peek('sess-a')?.project, 'F:/proj/one')

// 4. Search: keyword matches id / project / title / summary; project filter.
const byKeyword = store.search({ keyword: 'auth', limit: 20 })
assert.deepEqual(byKeyword.map(r => r.id), ['sess-b'], 'keyword hits summary')
const byProject = store.search({ project: 'F:/proj/one', limit: 20 })
assert.deepEqual(byProject.map(r => r.id), ['sess-a'], 'project filter')
const byId = store.search({ keyword: 'sess-new', limit: 20 })
assert.deepEqual(byId.map(r => r.id), ['sess-new'], 'id match')
const miss = store.search({ keyword: 'zzz-no-such-thing', limit: 20 })
assert.equal(miss.length, 0, 'no false hits')

// 5. hardDelete-adjacent: deleteIndexRow prunes and reports.
assert.equal(store.deleteIndexRow('sess-a'), true)
assert.equal(store.peek('sess-a'), undefined)
assert.equal(store.deleteIndexRow('sess-a'), false, 'second delete is a no-op')

console.log('PASS  upsert + resync backfill (COALESCE) + idempotency')
console.log('PASS  search by keyword/project/id + clean miss')
console.log('PASS  deleteIndexRow prune + no-op second delete')

setTimeout(() => {
  try { rmSync(base, { recursive: true, force: true }) } catch { /* windows locks */ }
  process.exit(0)
}, 300)
