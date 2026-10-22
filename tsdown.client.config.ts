import { defineConfig } from 'tsdown'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import * as lightningcss from 'lightningcss'

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Record<string, string>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

export default defineConfig({
  entry: ['src/client/index.ts'],
  outDir: 'lib-client',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2020',
  dts: false,
  clean: false,
  external: [
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    '@deepseek-ai/cordis',
    // Provided by the app's browser module table (bundled by the web shell).
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
  ],
  // Wrap the bundle into the browser module-loader factory format so the
  // loader registers (and later materializes) this module like every other.
  plugins: [
    {
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId, 'utf8')
        // Use lightningcss directly (not through the module wrapper)
        const result = lightningcss.transform({
          filename: fileId,
          code: Buffer.from(source),
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(result.exports ?? {})) {
          classMap[local] = exp.name
        }
        return styleInjectionModule('dsh-safe-tool', fileId, result.code.toString(), classMap)
      },
    },
    {
      name: 'dsh-module-wrapper',
      renderChunk(code: string) {
        const wrapper = `window.__ModuleLoader__.load({
  id: "dsh-safe-tool",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

`
        const footer = `
    return module.exports;
  },
});
`
        return wrapper + code + footer
      },
    },
  ],
})
