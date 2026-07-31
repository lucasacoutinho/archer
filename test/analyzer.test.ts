import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { analyze, clearAnalysisCache } from '../src/index.js'

const fixtureRoot = fileURLToPath(new URL('./fixtures/project', import.meta.url))
const workspaceRoot = fileURLToPath(new URL('./fixtures/workspace', import.meta.url))

describe('analyze', () => {
  test('resolves TypeScript path aliases and records import kinds', async () => {
    const graph = await analyze({ root: fixtureRoot })
    const application = graph.modules.find(
      (sourceModule) => sourceModule.path === 'src/application/create-order.ts',
    )

    expect(application?.dependencies).toEqual(
      expect.arrayContaining([
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
      ]),
    )
  })

  test('returns stable project-relative paths', async () => {
    const graph = await analyze({ root: fixtureRoot })

    expect(graph.root).toBe(path.resolve(fixtureRoot))
    expect(graph.modules.map((sourceModule) => sourceModule.path)).toEqual([
      'src/application/create-order.ts',
      'src/domain/index.ts',
      'src/domain/order-id.ts',
      'src/domain/order.ts',
      'src/folders/a/one.ts',
      'src/folders/b/two.ts',
      'src/infrastructure/bun-runtime.ts',
      'src/infrastructure/dependencies.ts',
      'src/infrastructure/order-repository.ts',
      'src/lazy/computed-require.ts',
      'src/lazy/computed.ts',
      'src/lazy/literal.ts',
      'src/shared/a.ts',
      'src/shared/b.ts',
    ])
  })

  test('discovers referenced workspace projects and treats workspace packages as local', async () => {
    const graph = await analyze({ root: workspaceRoot })

    expect(graph.projects.map((project) => project.name)).toEqual(
      expect.arrayContaining(['app', 'core', 'workspace']),
    )
    expect(graph.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          external: false,
          from: 'packages/app/src/entry.ts',
          packageName: '@fixture/core',
          resolution: 'local',
          target: 'packages/core/src/index.ts',
        }),
      ]),
    )
  })

  test('honors project-specific include overrides', async () => {
    const graph = await analyze({
      projects: [{ include: ['src/entry.ts'], tsconfig: 'packages/app/tsconfig.json' }],
      root: workspaceRoot,
      workspaces: false,
    })

    expect(graph.modules.map((sourceModule) => sourceModule.path)).toEqual([
      'packages/app/src/entry.ts',
      'packages/core/src/index.ts',
    ])
  })

  test('classifies built-ins, packages, unresolved imports, and import types', async () => {
    const graph = await analyze({ root: fixtureRoot })
    const dependencies = graph.modules.find(
      (sourceModule) => sourceModule.path === 'src/infrastructure/dependencies.ts',
    )?.dependencies

    expect(dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'static', target: 'node:fs/promises' }),
        expect.objectContaining({ kind: 'type', target: 'src/domain/order.ts' }),
        expect.objectContaining({ kind: 'dynamic', target: 'npm:picomatch' }),
        expect.objectContaining({ kind: 'require', target: 'unresolved:./missing.cjs' }),
      ]),
    )
  })

  test('classifies Bun built-ins separately from npm packages', async () => {
    const graph = await analyze({ root: fixtureRoot })

    expect(graph.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'src/infrastructure/bun-runtime.ts',
          specifier: 'bun:test',
          target: 'bun:test',
        }),
      ]),
    )
  })

  test('resolves literal lazy imports and records computed imports as unknown', async () => {
    const graph = await analyze({ root: fixtureRoot })

    expect(graph.dependencies).toEqual(
      expect.arrayContaining([
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
        expect.objectContaining({
          from: 'src/lazy/computed-require.ts',
          kind: 'require',
          target: 'dynamic:unknown',
        }),
      ]),
    )
  })

  test('reuses unchanged graphs and supports explicit cache invalidation', async () => {
    clearAnalysisCache()
    const first = await analyze({ root: fixtureRoot })
    const second = await analyze({ root: fixtureRoot })
    expect(second).toBe(first)

    clearAnalysisCache()
    expect(await analyze({ root: fixtureRoot })).not.toBe(first)
  })
})
