#!/usr/bin/env node
/**
 * Build script for dsh-safe-tool plugin.
 *
 * 1. pnpm install (all @deepseek-ai/* packages resolve from the registry).
 * 2. Build the server bundle (bundles @deepseek-ai/* deps except dsh-subagent).
 * 3. Build the client bundle.
 * 4. Assemble lib/.
 */

import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PROJECT_DIR = join(__dirname, '..')

/** Abort the build: a missing or truncated artifact must never ship. */
function fail(message) {
  console.error(`[build] ERROR: ${message}`)
  process.exit(1)
}

function run(cmd, cwd = PROJECT_DIR) {
  console.log(`[build] $ ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

console.log('[build] Installing project dependencies...')
run('pnpm install --frozen-lockfile=false')

console.log('[build] Building server bundle...')
run('bash node_modules/.bin/tsdown --config tsdown.config.ts')

console.log('[build] Building client bundle...')
run('bash node_modules/.bin/tsdown --config tsdown.client.config.ts')

console.log('[build] Assembling lib/...')
const libDir = join(PROJECT_DIR, 'lib')
rmSync(libDir, { recursive: true, force: true })
mkdirSync(libDir, { recursive: true })

{
  const src = join(PROJECT_DIR, 'lib-server', 'index.mjs')
  const dest = join(libDir, 'index.js')
  if (!existsSync(src)) fail(`the server bundle is missing: ${src}`)
  copyFileSync(src, dest)
}

{
  const src = join(PROJECT_DIR, 'lib-client', 'index.cjs')
  const dest = join(libDir, 'client.js')
  if (!existsSync(src)) fail(`the client bundle is missing: ${src}`)
  copyFileSync(src, dest)
}

// Verify the package main/exports targets exist and are non-empty: an emitted
// name change must fail the build, not ship an empty package with exit 0.
for (const [file, min] of [['index.js', 1000], ['client.js', 1000]]) {
  const path = join(libDir, file)
  if (!existsSync(path)) fail(`missing artifact: lib/${file}`)
  const bytes = statSync(path).size
  if (bytes < min) fail(`artifact lib/${file} is only ${bytes} bytes (expected >= ${min})`)
  console.log(`[build] ok lib/${file} (${bytes} bytes)`)
}

rmSync(join(PROJECT_DIR, 'lib-server'), { recursive: true, force: true })
rmSync(join(PROJECT_DIR, 'lib-client'), { recursive: true, force: true })

console.log('[build] Done!')
