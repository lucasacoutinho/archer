export { analyze } from './analyzer.js'
export { ArchitectureError, formatResult } from './format.js'
export { ArchExpectation, ArchitectureSuite, createArcher } from './suite.js'
export type {
  ArchitectureGraph,
  ArchitectureResult,
  ArchitectureViolation,
  ArcherOptions,
  Dependency,
  DependencyKind,
  Selector,
  SourceModule,
} from './types.js'
