/**
 * Shared preconditions for the suite.
 *
 * The tests exercise the SHIPPED artifact (`lib/index.js`, `lib/client.js`), not
 * `src/` — that is the point of the suite: it must fail if the built bundle is
 * stale or broken. `lib/` is gitignored, so a fresh checkout has to build first;
 * this module turns that into one actionable message instead of a stack trace.
 *
 * The platform packages are read from the harness checkout that is running the
 * tests, which is not an installable dependency of this plugin. Override the
 * location with `DSH_PLATFORM_PACKAGES_DIR` when the harness lives elsewhere.
 *
 * @module dsh-safe-tool/test/preconditions
 */

import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Where the running harness keeps its `@deepseek-ai/*` packages. */
export const DSH_PLATFORM_PACKAGES_DIR = process.env.DSH_PLATFORM_PACKAGES_DIR
  ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

/**
 * Assert one shipped artifact exists and is non-trivial.
 *
 * @param url - `new URL('../lib/index.js', import.meta.url)` style target.
 * @param label - human name used in the failure message.
 */
export function requireBuiltArtifact(url, label) {
  const path = fileURLToPath(url)
  if (!existsSync(path)) {
    throw new Error(`${label} is missing at ${path} — run \`npm run build\` first (the suite tests the built bundle, not src/)`)
  }
  if (statSync(path).size < 1000) {
    throw new Error(`${label} at ${path} is truncated (${statSync(path).size} bytes) — rebuild with \`npm run build\``)
  }
}

/** Assert the harness packages this suite borrows are present. */
export function requirePlatformPackages() {
  for (const pkg of ['dsh-session-persistence', 'dsh-session-persistence-jsonl', 'dsh-subagent']) {
    const path = `${DSH_PLATFORM_PACKAGES_DIR}/${pkg}/lib/index.js`
    if (!existsSync(path)) {
      throw new Error(`platform package ${pkg} not found at ${path} — set DSH_PLATFORM_PACKAGES_DIR to the running harness's @deepseek-ai directory`)
    }
  }
}
