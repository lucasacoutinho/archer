import { defineConfig, mergeConfig } from 'vitest/config'

import { loadTiaPlugin } from './config/load-tiacore.mjs'
import vitestConfig from './vitest.config.js'

const { tia } = await loadTiaPlugin()

export default mergeConfig(
  vitestConfig,
  defineConfig({
    plugins: [tia()],
  }),
)
