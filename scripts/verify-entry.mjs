// Entry smoke test: load lib/index.js the way the dsh Loader would, verify the
// functional-plugin contract (name/inject/Config/apply) and that apply()
// registers all four tools into a fake ctx without throwing.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as plugin from '../lib/index.js'

// 1. Plugin contract shape.
assert.equal(typeof plugin.name, 'string', 'name')
assert.equal(plugin.name, 'dsh-session-manager')
assert.ok(Array.isArray(plugin.inject), 'inject is array')
for (const dep of ['tools', 'systemPrompt', 'llm', 'sessions', 'sessionPersistence']) {
  assert.ok(plugin.inject.includes(dep), `inject includes ${dep}`)
}
assert.ok(plugin.Config, 'Config schema present')
assert.equal(typeof plugin.apply, 'function', 'apply(ctx, config)')

// 2. Config schema: defaults fill in, optional strings stay undefined.
const normalized = plugin.Config({})
assert.equal(normalized.titleMaxOutputTokens, 64)
assert.equal(normalized.summaryMaxOutputTokens, 1024)
assert.equal(normalized.timeoutMs, 60_000)
assert.equal(normalized.maxInputBytes, 32_768)
assert.equal(normalized.maxResults, 20)
assert.equal(normalized.provider, undefined)
assert.equal(normalized.model, undefined)
assert.equal(normalized.sessionRoot, undefined)
assert.equal(normalized.indexPath, undefined)

// 3. apply() registers four tools into a fake ctx.
const base = mkdtempSync(join(tmpdir(), 'dsh-sm-entry-'))
const registered = []
const effects = []
const ctx = {
  systemPrompt: {
    section: () => () => {},
    getSectionOrder: () => 2300,
  },
  tools: {
    register: def => {
      registered.push(def.name)
      assert.equal(typeof def.execute, 'function', `tool ${def.name} has execute`)
    },
  },
  sessions: { get: () => undefined },
  sessionPersistence: {
    stat: async () => undefined,
    list: async () => [],
  },
  // dispose-able effect registration (Cordis auto-cleanup on unload/HMR).
  effect: (fn, label) => {
    effects.push(label)
    const disposer = fn()
    assert.equal(typeof disposer, 'function', `effect ${label} returns a disposer`)
    return () => {}
  },
}
// point the local index at the temp base so nothing writes into ~
plugin.apply(ctx, { ...normalized, indexPath: join(base, 'index.sqlite') })

assert.deepEqual(
  registered,
  ['session_generate_title', 'session_generate_summary', 'session_find', 'session_delete'],
  'tool registration order',
)
assert.deepEqual(effects, ['dsh-session-manager index handle'], 'index handle effect registered')

console.log('PASS  plugin contract (name/inject/Config/apply)')
console.log('PASS  Config defaults + optional passthrough')
console.log('PASS  apply() registers:', registered.join(', '))

setTimeout(() => {
  try { rmSync(base, { recursive: true, force: true }) } catch { /* windows locks */ }
  process.exit(0)
}, 300)
