import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    bolt11: 'src/bolt11.ts',
    preimage: 'src/preimage.ts',
    http: 'src/http.ts',
    lnurl: 'src/lnurl.ts',
    // Node-only transport (uses node: builtins). Never imported by the root
    // barrel, so the browser bundle stays free of it.
    node: 'src/node/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2022',
  platform: 'neutral',
  clean: true,
  sourcemap: true,
})
