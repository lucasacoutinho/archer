import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { ArchitectureError, createArcher, formatResult } from '../src/index.js'

const fixtureRoot = fileURLToPath(new URL('./fixtures/project', import.meta.url))

describe('architecture rules', () => {
  test('fails an empty architecture suite', async () => {
    const result = await createArcher({ root: fixtureRoot }).check()

    expect(result.ok).toBe(false)
    expect(result.violations[0]?.message).toBe('No architecture rules were declared.')
  })

  test('passes dependency, naming, line-count, and reverse-dependency rules', async () => {
    const archer = createArcher({ root: fixtureRoot })

    archer
      .expect('src/domain/**')
      .not.toDependOn('src/infrastructure/**')
      .and.toOnlyDependOn(['src/domain/**'])
      .and.toHaveSuffix('.ts')
      .and.toHaveLineCountLessThan(10)

    archer
      .expect('src/domain/order.ts')
      .toBeDependedOnBy('src/application/**')
      .and.toOnlyBeDependedOnBy([
        'src/application/**',
        'src/infrastructure/**',
      ])

    const result = await archer.check()

    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.filesAnalyzed).toBe(9)
  })

  test('reports the importing file and exact source location', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer
      .expect('src/application/**')
      .not.toUse('src/infrastructure/**')

    const result = await archer.check()

    expect(result.ok).toBe(false)
    expect(result.violations).toEqual([
      expect.objectContaining({
        dependency: 'src/infrastructure/order-repository.ts',
        file: 'src/application/create-order.ts',
        line: 2,
      }),
    ])
    expect(formatResult(result)).toContain("Imports '../infrastructure/order-repository.js'")
    expect(new ArchitectureError(result).result).toBe(result)
  })

  test('fails when an expectation selects no files', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer.expect('src/missing/**').not.toDependOn('src/domain/**')

    const result = await archer.check()

    expect(result.violations[0]?.message).toBe("No files matched 'src/missing/**'.")
  })

  test('detects cycles inside the selected boundary', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer.expect('src/shared/**').toBeFreeOfCycles()

    const result = await archer.check()

    expect(result.violations).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('src/shared/a.ts'),
        rule: "'src/shared/**' must be free of cycles",
      }),
    ])
  })

  test('applies ignoring to rules already declared on the expectation', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer
      .expect('src/shared/**')
      .toHavePrefix('a')
      .ignoring('src/shared/b.ts')

    const result = await archer.check()

    expect(result.ok).toBe(true)
  })

  test('resets negation after one expectation', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer
      .expect('src/domain/order.ts')
      .not.toHavePrefix('service-')
      .toHaveSuffix('.ts')

    expect((await archer.check()).ok).toBe(true)
  })

  test('negates an only rule as a whole-file predicate', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer
      .expect('src/application/**')
      .not.toOnlyDependOn('src/domain/**')

    expect((await archer.check()).ok).toBe(true)
  })

  test('matches built-in, package, project, and unresolved dependency selectors', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer
      .expect('src/infrastructure/dependencies.ts')
      .toOnlyUse([
        'node:fs',
        'npm:picomatch',
        'src/domain/**',
        'unresolved:*',
      ])

    expect((await archer.check()).ok).toBe(true)
  })

  test('catches a forbidden literal lazy import', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer
      .expect('src/lazy/literal.ts')
      .not.toDependOn('src/infrastructure/**')

    const result = await archer.check()

    expect(result.violations).toEqual([
      expect.objectContaining({
        dependency: 'src/infrastructure/order-repository.ts',
        file: 'src/lazy/literal.ts',
      }),
    ])
  })

  test('fails closed on a computed dynamic import', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer
      .expect('src/lazy/computed.ts')
      .not.toDependOn('src/infrastructure/**')

    const result = await archer.check()

    expect(result.violations[0]).toEqual(expect.objectContaining({
      dependency: 'dynamic:unknown',
      message: expect.stringContaining('Cannot resolve computed dynamic import'),
    }))
  })

  test('allows computed dynamic imports only when a rule says so', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer
      .expect('src/lazy/computed.ts')
      .toOnlyDependOn('dynamic:*')

    expect((await archer.check()).ok).toBe(true)
  })
})
