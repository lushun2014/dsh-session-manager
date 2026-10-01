// Real-machine path check: feed the ACTUAL cwp + session ids observed under
// C:/Users/Administrator/.dsh/sessions into our projectKey/encodeSegment and
// assert the computed directories exist on disk (read-only, nothing mutated).
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'

import { projectKey, encodeSegment, jsonlSessionDir } from '../lib/delete.js'

const root = 'C:/Users/Administrator/.dsh/sessions'

// Real dir observed on disk: --C-Users-Administrator-Desktop-~65B0~5EFA~6587~4EF6~5939--
// (hex = 新建文件夹, the Chinese-named desktop folder; 65B0=新 5EFA=建 6587=文 4EF6=件 5939=夹)
const cases = [
  {
    cwd: 'C:\\Users\\Administrator\\Desktop\\新建文件夹',
    id: 'session-3774acb7-eec0-4f7b-ae75-cf56147dee34',
    expectDir: '--C-Users-Administrator-Desktop-~65B0~5EFA~6587~4EF6~5939--',
  },
  {
    cwd: 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace',
    id: 'session-8386757d-8db0-4678-b772-416206fa21ee',
    expectDir: '--C-Users-Administrator-Documents-deepseek-harness-default-workspace--',
  },
]

for (const c of cases) {
  assert.equal(projectKey(c.cwd), c.expectDir, `projectKey(${c.cwd})`)
  assert.equal(encodeSegment(c.id), c.id, `encodeSegment passes ids through unchanged`)
  const dir = jsonlSessionDir(root, c.cwd, c.id)
  assert.ok(existsSync(dir), `computed dir exists on disk: ${dir}`)
  console.log(`PASS  ${c.cwd}`)
  console.log(`      -> ${dir}  (exists: true)`)
}

// The inner session file the layout actually holds:
console.log('\nPASS  real layout match: our path algorithm == disk layout')
process.exit(0)
