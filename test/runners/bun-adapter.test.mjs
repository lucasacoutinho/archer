import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'bun:test'

import '../../dist/bun/plugin.js'
import { arch } from '../../dist/bun.js'
import { createArcher } from '../../dist/index.js'

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/project',
)

arch('the domain does not import infrastructure', { root: fixtureRoot })
  .expect('src/domain/**')
  .not.toDependOn('src/infrastructure/**')

test('Archer installs as a Bun matcher plugin', async () => {
  const archer = createArcher({ root: fixtureRoot })
  archer.expect('src/domain/**').not.toDependOn('src/infrastructure/**')

  await expect(archer).toRespectArchitecture()
})
