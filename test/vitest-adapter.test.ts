import { fileURLToPath } from 'node:url'

import { arch } from '../src/vitest.js'

const fixtureRoot = fileURLToPath(new URL('./fixtures/project', import.meta.url))

arch('the domain does not import infrastructure', { root: fixtureRoot })
  .expect('src/domain/**')
  .not.toDependOn('src/infrastructure/**')
