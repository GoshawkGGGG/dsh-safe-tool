import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib-server',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  dts: false,
  clean: false,
  // Bundle all @deepseek-ai/* packages
  deps: {
    alwaysBundle: [/^@deepseek-ai\//, /^cosmokit$/, /^cordis$/, /^schemastery$/],
  },
  // Externalize dsh-subagent to avoid bundling issues
  // The package will be resolved at runtime from node_modules
  external: [
    '@deepseek-ai/dsh-subagent',
  ],
})
