import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { arch } from '../../dist/bun.js'

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/project')

arch('the domain does not import infrastructure', { root: fixtureRoot })
  .expect('src/domain/**')
  .not.toDependOn('src/infrastructure/**')
