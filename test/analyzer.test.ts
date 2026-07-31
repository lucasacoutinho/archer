import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { analyze } from '../src/index.js'

const fixtureRoot = fileURLToPath(new URL('./fixtures/project', import.meta.url))

describe('analyze', () => {
  test('resolves TypeScript path aliases and records import kinds', async () => {
    const graph = await analyze({ root: fixtureRoot })
    const application = graph.modules.find(
      (sourceModule) => sourceModule.path === 'src/application/create-order.ts',
    )

    expect(application?.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'type',
        specifier: '@domain/order',
        target: 'src/domain/order.ts',
      }),
      expect.objectContaining({
        kind: 'static',
        specifier: '../infrastructure/order-repository.js',
        target: 'src/infrastructure/order-repository.ts',
      }),
    ]))
  })

  test('returns stable project-relative paths', async () => {
    const graph = await analyze({ root: fixtureRoot })

    expect(graph.root).toBe(path.resolve(fixtureRoot))
    expect(graph.modules.map((sourceModule) => sourceModule.path)).toEqual([
      'src/application/create-order.ts',
      'src/domain/order-id.ts',
      'src/domain/order.ts',
      'src/infrastructure/dependencies.ts',
      'src/infrastructure/order-repository.ts',
      'src/lazy/computed.ts',
      'src/lazy/literal.ts',
      'src/shared/a.ts',
      'src/shared/b.ts',
    ])
  })

  test('classifies built-ins, packages, unresolved imports, and import types', async () => {
    const graph = await analyze({ root: fixtureRoot })
    const dependencies = graph.modules.find(
      (sourceModule) => sourceModule.path === 'src/infrastructure/dependencies.ts',
    )?.dependencies

    expect(dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'static', target: 'node:fs/promises' }),
      expect.objectContaining({ kind: 'type', target: 'src/domain/order.ts' }),
      expect.objectContaining({ kind: 'dynamic', target: 'npm:picomatch' }),
      expect.objectContaining({ kind: 'require', target: 'unresolved:./missing.cjs' }),
    ]))
  })

  test('resolves literal lazy imports and records computed imports as unknown', async () => {
    const graph = await analyze({ root: fixtureRoot })

    expect(graph.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: 'src/lazy/literal.ts',
        kind: 'dynamic',
        target: 'src/infrastructure/order-repository.ts',
      }),
      expect.objectContaining({
        from: 'src/lazy/computed.ts',
        kind: 'dynamic',
        specifier: 'moduleName',
        target: 'dynamic:unknown',
      }),
    ]))
  })
})
