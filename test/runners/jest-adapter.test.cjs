const path = require('node:path')

require('../../dist/jest/plugin.cjs')

const { arch } = require('../../dist/jest.cjs')
const { createArcher } = require('../../dist/index.cjs')

const fixtureRoot = path.resolve(__dirname, '../fixtures/project')

arch('the domain does not import infrastructure', { root: fixtureRoot })
  .expect('src/domain/**')
  .not.toDependOn('src/infrastructure/**')

test('Archer installs as a Jest matcher plugin', async () => {
  const archer = createArcher({ root: fixtureRoot })
  archer.expect('src/domain/**').not.toDependOn('src/infrastructure/**')

  await expect(archer).toRespectArchitecture()
})
