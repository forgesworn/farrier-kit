import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    bolt11: 'src/bolt11.ts',
    preimage: 'src/preimage.ts',
    http: 'src/http.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2022',
  platform: 'neutral',
  clean: true,
  sourcemap: true,
})
