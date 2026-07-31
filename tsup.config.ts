import { defineConfig } from 'tsup'

export default defineConfig([
  {
    clean: true,
    dts: true,
    entry: {
      bun: 'src/adapters/bun/index.ts',
      'bun/plugin': 'src/adapters/bun/plugin.ts',
      index: 'src/index.ts',
      jest: 'src/adapters/jest/index.ts',
      'jest/plugin': 'src/adapters/jest/plugin.ts',
      node: 'src/adapters/node/index.ts',
      vitest: 'src/adapters/vitest/index.ts',
      'vitest/plugin': 'src/adapters/vitest/plugin.ts',
    },
    external: ['bun:test', 'node:test'],
    format: ['esm', 'cjs'],
    platform: 'node',
  },
  {
    clean: false,
    dts: true,
    entry: { cli: 'src/cli/index.ts' },
    format: ['esm'],
    platform: 'node',
  },
])
