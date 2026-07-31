import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import '../src/adapters/vitest/plugin.js'
import { createArcher } from '../src/index.js'

const fixtureRoot = fileURLToPath(new URL('./fixtures/project', import.meta.url))

describe('Vitest matcher plugin', () => {
  test('checks an Archer suite through expect', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer.expect('src/domain/**').not.toDependOn('src/infrastructure/**')

    await expect(archer).toRespectArchitecture()
  })

  test('returns Archer findings as the matcher failure', async () => {
    const archer = createArcher({ root: fixtureRoot })
    archer.expect('src/application/**').not.toDependOn('src/infrastructure/**')

    await expect(expect(archer).toRespectArchitecture()).rejects.toThrow(
      'src/application/create-order.ts',
    )
  })
})
