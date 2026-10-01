// Install-time build hook (pnpm `prepare`).
//
// GitHub installs clone source and run prepare WITH devDependencies, so `tsc`
// is available. Local `file:` installs run prepare WITHOUT devDependencies.
// lib/ is committed-shippable, so when it is already present we skip; when it
// is missing we look for a locally installed tsc before failing loud.
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// This file lives in scripts/; the package root is one level up.
const root = dirname(dirname(fileURLToPath(import.meta.url)))

// 1. Already built -> nothing to do (the shippable path).
if (existsSync(join(root, 'lib', 'index.js'))) {
  console.log('[prepare] lib/index.js present, skipping build')
  process.exit(0)
}

// 2. Not built yet -> try the local tsc (git installs have devDeps installed).
try {
  execSync('npx --no-install tsc -p tsconfig.json', { cwd: root, stdio: 'inherit' })
  console.log('[prepare] built lib/ from source')
} catch (error) {
  console.error(
    '[prepare] lib/ is missing and no local tsc is available to build it.\n'
      + '  This happens for `file:` installs where devDependencies are not installed.\n'
      + '  Fix: run `npm install && npm run build` in this folder once, then retry the install;\n'
      + '       or install from the git URL (which carries devDependencies).\n'
      + `Cause: ${error?.message ?? error}`,
  )
  process.exit(1)
}
