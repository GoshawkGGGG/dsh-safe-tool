#!/usr/bin/env node
/**
 * Build script for dsh-safe-tool plugin.
 *
 * Strategy:
 * 1. Run pnpm install for this project (all @deepseek-ai/* packages are
 *    declared as normal npm dependencies, resolved from the registry).
 * 2. Build server bundle (bundle all @deepseek-ai/* deps into a single output).
 * 3. Build client bundle.
 * 4. Assemble lib/ directory.
 *
 * No git clone, no host-specific paths, no manual package copying — the plugin
 * builds from source anywhere `pnpm install` can reach the npm registry.
 */

import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PROJECT_DIR = join(__dirname, '..')

function run(cmd, cwd = PROJECT_DIR) {
  console.log(`[build] $ ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

// ─── Step 1: Install project dependencies ────────────────────────────────────
// All @deepseek-ai/* packages are declared in package.json `dependencies`,
// so a normal install is enough — no DSH git clone required.

console.log('[build] Installing project dependencies...')
run('pnpm install --frozen-lockfile=false')

// ─── Step 2: Build server bundle ──────────────────────────────────────────────
// tsdown resolves @deepseek-ai/* from this project's node_modules and bundles
// them (per tsdown.config.ts `deps.alwaysBundle`).

console.log('[build] Building server bundle...')
run('bash node_modules/.bin/tsdown --config tsdown.config.ts')

// ─── Step 3: Build client bundle ──────────────────────────────────────────────

console.log('[build] Building client bundle...')
run('bash node_modules/.bin/tsdown --config tsdown.client.config.ts')

// ─── Step 4: Assemble final lib/ directory ────────────────────────────────────

console.log('[build] Assembling lib/...')
const libDir = join(PROJECT_DIR, 'lib')
rmSync(libDir, { recursive: true, force: true })
mkdirSync(libDir, { recursive: true })

for (const f of ['index.mjs', 'invariant.mjs']) {
  const src = join(PROJECT_DIR, 'lib-server', f)
  const dest = join(libDir, f.replace('.mjs', '.js'))
  if (existsSync(src)) copyFileSync(src, dest)
}

for (const f of ['index.cjs', 'style.css']) {
  const src = join(PROJECT_DIR, 'lib-client', f)
  const dest = join(libDir, f === 'index.cjs' ? 'client.js' : f)
  if (existsSync(src)) copyFileSync(src, dest)
}

// Clean up temp build dirs
rmSync(join(PROJECT_DIR, 'lib-server'), { recursive: true, force: true })
rmSync(join(PROJECT_DIR, 'lib-client'), { recursive: true, force: true })

console.log('[build] Done!')