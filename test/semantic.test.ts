import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { createArcher, registerPreset } from '../src/index.js'

const fixtureRoot = fileURLToPath(new URL('./fixtures/semantic', import.meta.url))

describe('semantic architecture rules', () => {
  test('checks declarations, heritage, decorators, readonly properties, and methods', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer
      .expect('src/user-controller.ts')
      .toBeClasses()
      .and.toExtend('BaseController')
      .and.toImplement('Runnable')
      .and.toHaveDecorator('Controller')
      .and.toHaveReadonlyProperties()
      .and.toHaveMethods('run', 'reset')
      .and.toHavePublicMethods('run')
      .and.toHaveProtectedMethods('reset')
      .and.toBeExported()

    archer.expect('src/base.ts').toBeAbstract()

    expect((await archer.check()).ok).toBe(true)
  })

  test('checks the resolved export surface and method visibility', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer.expect('src/index.ts').toOnlyExport('UserController')
    archer.expect('src/user-controller.ts').toOnlyHavePublicMethods()

    const result = await archer.check()
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'src/user-controller.ts',
          message: expect.stringContaining('run, reset'),
        }),
        expect.objectContaining({
          file: 'src/index.ts',
          message: "'internalName' is exported.",
        }),
      ]),
    )
    expect(result.violations).toHaveLength(2)
  })

  test('finds loose equality without mistaking a shadowed function for a global', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer.expect('src/equality.ts').toUseStrictEquality().and.not.toUseGlobals('eval')

    const result = await archer.check()
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.message).toContain('loose equality')
  })

  test('supports custom async rules with stable metadata and warning severity', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer
      .expect('src/**')
      .toSatisfy('project/file-count', async ({ modules }) => ({
        message: `Project contains ${modules.length} modules.`,
        rule: 'project must stay small',
        severity: 'error',
      }))
      .because('Small projects are easier to navigate.')
      .withSeverity('warning')

    const result = await archer.check()
    expect(result.ok).toBe(true)
    expect(result.warnings).toBe(1)
    expect(result.violations[0]).toEqual(
      expect.objectContaining({
        reason: 'Small projects are easier to navigate.',
        ruleId: 'project/file-count',
        severity: 'warning',
      }),
    )
  })

  test('ships presets and accepts registered project presets', async () => {
    registerPreset('semantic-fixture', (suite) => {
      suite.expect('src/**').toHaveResolvableDependencies()
    })
    const archer = createArcher({ root: fixtureRoot }).preset('semantic-fixture')

    expect((await archer.check()).ok).toBe(true)
  })
})
