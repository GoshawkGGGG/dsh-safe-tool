import { defineConfig } from 'tsdown'

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
  // (No CSS-modules pipeline: every component styles itself with theme-token
  // inline styles and the card's tag-level stylesheet is injected in `apply`
  // through `ctx.effect`; nothing imports a `*.module.css`.)
  plugins: [
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
