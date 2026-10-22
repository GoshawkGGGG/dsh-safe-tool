import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib-server',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: false,
  clean: false,
  // Bundle every @deepseek-ai/* package. The artifact must be self-contained:
  // a plugin installed under a profile has no node_modules resolving the host's
  // packages, so any runtime import of one makes the plugin fail to load.
  deps: {
    alwaysBundle: [/^@deepseek-ai\//, /^cosmokit$/, /^cordis$/, /^schemastery$/],
  },
  external: [],
})
