import { configureArchitecture } from './archer.rules.ts'
import { defineConfig } from './src/index.ts'

export default defineConfig({
  include: ['src/**/*.ts'],
  rules: configureArchitecture,
})
