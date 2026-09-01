/**
 * Runtime invariant for dsh-safe-tool.
 *
 * Verifies that no unexploded assumptions exist at runtime.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-safe-tool'

export const name = 'safe-tool-invariant'
export const inject = ['invariants'] as const

/**
 * No runtime invariant: the plugin is an event-intercepting tool approval
 * handler with no persistent mutable state to audit.
 */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

