export { analyze, clearAnalysisCache } from './analysis/analyzer.js'
export {
  applyBaseline,
  createBaseline,
  readBaseline,
  violationFingerprint,
  writeBaseline,
} from './reporting/baseline.js'
export { defineConfig } from './config/index.js'
export { ArchitectureLayers, LayerExpectation } from './core/layers.js'
export {
  applyPreset,
  ArchExpectation,
  ArchitectureSuite,
  availablePresets,
  createArcher,
  registerPreset,
} from './engine/suite.js'
export { ArchitectureError, formatResult } from './reporting/format.js'
export { report } from './reporting/reporters.js'
export { archerMatchers } from './testing/matchers.js'
export type { ArchitectureBaseline, BaselineEntry } from './reporting/baseline.js'
export type { ArcherConfig } from './config/index.js'
export type { ArcherPreset, CycleOptions, ResolutionOptions } from './engine/suite.js'
export type { ReporterName } from './reporting/reporters.js'
export type {
  ArchitectureViolation,
  ArchitectureGraph,
  ArchitectureResult,
  ArcherOptions,
  ArcherProjectOptions,
  CustomRule,
  CustomRuleContext,
  CustomRuleResult,
  DeclarationInfo,
  DeclarationKind,
  Dependency,
  DependencyKind,
  DependencyResolution,
  MethodInfo,
  ProjectInfo,
  RuleMetadata,
  RuleSeverity,
  Selector,
  SourceLocation,
  SourceModule,
  SourceUse,
} from './core/types.js'
