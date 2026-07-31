const path = require('node:path')

const { arch } = require('../../dist/jest.cjs')

const fixtureRoot = path.resolve(__dirname, '../fixtures/project')

arch('the domain does not import infrastructure', { root: fixtureRoot })
  .expect('src/domain/**')
  .not.toDependOn('src/infrastructure/**')
