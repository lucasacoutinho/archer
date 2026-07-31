import { configureArchitecture } from '../archer.rules.js'
import { arch } from '../src/adapters/vitest/index.js'

configureArchitecture(arch('Archer keeps its package boundaries'))
