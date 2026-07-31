import type { ArchitectureSuite } from './src/index.ts'

const runnerDependencies = ['bun:*', 'node:test', 'npm:@jest/globals', 'npm:vitest']

export function configureArchitecture(archer: ArchitectureSuite): void {
  archer.preset('strict')

  const layers = archer.layers({
    adapters: 'src/adapters/**',
    analysis: 'src/analysis/**',
    cli: 'src/cli/**',
    config: 'src/config/**',
    core: 'src/core/**',
    engine: 'src/engine/**',
    reporting: 'src/reporting/**',
    testing: 'src/testing/**',
  })

  layers.where('core').mayOnlyDependOn()
  layers.where('analysis').mayOnlyDependOn('core')
  layers.where('engine').mayOnlyDependOn('analysis', 'core')
  layers.where('reporting').mayOnlyDependOn('core')
  layers.where('testing').mayOnlyDependOn('core', 'reporting')
  layers.where('config').mayOnlyDependOn('core', 'engine', 'reporting')
  layers.where('adapters').mayOnlyDependOn('core', 'engine', 'reporting', 'testing')
  layers.where('cli').mayOnlyDependOn('analysis', 'config', 'engine', 'reporting')
  layers.toBeFreeOfCycles()

  archer
    .expect('src/**')
    .ignoring('src/adapters/**')
    .not.toDependOn(['src/adapters/**', ...runnerDependencies])

  archer
    .expect('src/adapters/**')
    .toOnlyDependOn([
      'src/adapters/**',
      'src/core/**',
      'src/engine/**',
      'src/reporting/**',
      'src/testing/**',
      'node:module',
      'node:path',
      ...runnerDependencies,
    ])

  archer.expect('src/**').toHaveSuffix('.ts').and.toHaveLineCountLessThan(650)

  archer
    .expect('src/index.ts')
    .toBePublicApi()
    .and.toOnlyExport(
      'analyze',
      'applyBaseline',
      'applyPreset',
      'archerMatchers',
      'ArchExpectation',
      'ArcherConfig',
      'ArcherOptions',
      'ArcherPreset',
      'ArcherProjectOptions',
      'ArchitectureBaseline',
      'ArchitectureError',
      'ArchitectureGraph',
      'ArchitectureLayers',
      'ArchitectureResult',
      'ArchitectureSuite',
      'ArchitectureViolation',
      'availablePresets',
      'BaselineEntry',
      'clearAnalysisCache',
      'createArcher',
      'createBaseline',
      'CustomRule',
      'CustomRuleContext',
      'CustomRuleResult',
      'CycleOptions',
      'DeclarationInfo',
      'DeclarationKind',
      'Dependency',
      'DependencyKind',
      'DependencyResolution',
      'defineConfig',
      'formatResult',
      'LayerExpectation',
      'MethodInfo',
      'ProjectInfo',
      'readBaseline',
      'registerPreset',
      'report',
      'ReporterName',
      'ResolutionOptions',
      'RuleMetadata',
      'RuleSeverity',
      'Selector',
      'SourceLocation',
      'SourceModule',
      'SourceUse',
      'violationFingerprint',
      'writeBaseline',
    )
}
