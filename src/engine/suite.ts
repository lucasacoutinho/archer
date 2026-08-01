import { analyze } from '../analysis/analyzer.js'
import { evaluateRule } from '../analysis/evaluation/index.js'
import { ArchitectureLayers } from '../core/layers.js'
import { selectorValues } from '../core/matchers.js'
import type { ArchitectureRule, DependencyRule, Selection } from '../core/rules.js'
import type {
  ArchitectureGraph,
  ArchitectureResult,
  ArchitectureViolation,
  ArcherOptions,
  CustomRule,
  DeclarationKind,
  DependencyKind,
  RuleMetadata,
  RuleSeverity,
  Selector,
} from '../core/types.js'

type SimpleRule = Exclude<
  ArchitectureRule,
  DependencyRule | Extract<ArchitectureRule, { kind: 'custom' | 'free-of-cycles' }>
>
type RuleInput<T> = T extends ArchitectureRule
  ? Omit<T, 'id' | 'reason' | 'selection' | 'severity'>
  : never

export interface CycleOptions {
  readonly collapseToFolderDepth?: number
  readonly dependencyKinds?: readonly DependencyKind[]
}

export interface ResolutionOptions {
  readonly allowDynamic?: boolean
}

export type ArcherPreset = (suite: ArchitectureSuite, options?: unknown) => void

const presets = new Map<string, ArcherPreset>()

function metadata(values: RuleMetadata = {}): Pick<ArchitectureRule, 'id' | 'reason' | 'severity'> {
  return {
    ...(values.id === undefined ? {} : { id: values.id }),
    ...(values.reason === undefined ? {} : { reason: values.reason }),
    severity: values.severity ?? 'error',
  }
}

function countResult(
  graph: ArchitectureGraph,
  violations: readonly ArchitectureViolation[],
): ArchitectureResult {
  const errors = violations.filter((item) => item.severity === 'error').length
  const warnings = violations.filter((item) => item.severity === 'warning').length
  const infos = violations.filter((item) => item.severity === 'info').length
  return {
    dependenciesAnalyzed: graph.dependencies.length,
    errors,
    filesAnalyzed: graph.modules.length,
    infos,
    ok: errors === 0,
    violations,
    warnings,
  }
}

export class ArchitectureSuite {
  readonly options: ArcherOptions
  readonly #rules: ArchitectureRule[] = []
  #lastRule?: ArchitectureRule

  constructor(options: ArcherOptions = {}) {
    this.options = options
  }

  expect(selector: Selector): ArchExpectation {
    if (selectorValues(selector).length === 0) {
      throw new TypeError('expect() needs at least one selector.')
    }
    return new ArchExpectation(this, { ignored: [], selector })
  }

  layers(definitions: Readonly<Record<string, Selector>>): ArchitectureLayers {
    return new ArchitectureLayers(this, definitions)
  }

  preset(name: string, options?: unknown): this {
    applyPreset(name, this, options)
    return this
  }

  rule(id: string, evaluator: CustomRule, ruleMetadata: Omit<RuleMetadata, 'id'> = {}): this {
    this.add({
      ...metadata({ ...ruleMetadata, id }),
      evaluator,
      kind: 'custom',
      selection: { ignored: [], selector: '**' },
    })
    return this
  }

  add(rule: ArchitectureRule): void {
    this.#rules.push(rule)
    this.#lastRule = rule
  }

  decorateLast(values: RuleMetadata): void {
    if (this.#lastRule === undefined) {
      throw new TypeError('Declare a rule before adding metadata.')
    }
    if (values.id !== undefined) {
      this.#lastRule.id = values.id
    }
    if (values.reason !== undefined) {
      this.#lastRule.reason = values.reason
    }
    if (values.severity !== undefined) {
      this.#lastRule.severity = values.severity
    }
  }

  async check(graph?: ArchitectureGraph): Promise<ArchitectureResult> {
    const analyzed = graph ?? (await analyze(this.options))
    if (this.#rules.length === 0) {
      return countResult(analyzed, [
        {
          message: 'No architecture rules were declared.',
          rule: 'an architecture test must declare at least one rule',
          severity: 'error',
        },
      ])
    }

    const groups = await Promise.all(this.#rules.map(async (rule) => evaluateRule(analyzed, rule)))
    const violations = groups.flat().toSorted((left, right) => {
      const fileComparison = (left.file ?? '').localeCompare(right.file ?? '')
      if (fileComparison !== 0) {
        return fileComparison
      }
      const lineComparison = (left.line ?? 0) - (right.line ?? 0)
      return lineComparison === 0
        ? (left.ruleId ?? left.rule).localeCompare(right.ruleId ?? right.rule)
        : lineComparison
    })
    return countResult(analyzed, violations)
  }
}

export class ArchExpectation {
  readonly #suite: ArchitectureSuite
  readonly #selection: Selection
  #dependencyKinds: readonly DependencyKind[] | undefined
  #localOnly = false
  #negated = false
  #transitive = false

  constructor(suite: ArchitectureSuite, selection: Selection) {
    this.#suite = suite
    this.#selection = selection
  }

  get and(): this {
    return this
  }

  get not(): this {
    this.#negated = !this.#negated
    return this
  }

  expect(selector: Selector): ArchExpectation {
    return this.#suite.expect(selector)
  }

  ignoring(...selectors: readonly string[]): this {
    this.#selection.ignored.push(...selectors)
    return this
  }

  includingDependencyKinds(...kinds: readonly DependencyKind[]): this {
    if (kinds.length === 0) {
      throw new TypeError('includingDependencyKinds() needs at least one dependency kind.')
    }
    this.#dependencyKinds = [...new Set(kinds)]
    return this
  }

  runtimeDependencies(): this {
    return this.includingDependencyKinds('static', 'dynamic', 'require')
  }

  typeDependencies(): this {
    return this.includingDependencyKinds('type')
  }

  dynamicDependencies(): this {
    return this.includingDependencyKinds('dynamic')
  }

  localDependencies(): this {
    this.#localOnly = true
    return this
  }

  transitively(): this {
    this.#transitive = true
    return this
  }

  toDependOn(target: Selector): this {
    this.addDependencyRule('depend-on', target)
    return this
  }

  toTransitivelyDependOn(target: Selector): this {
    return this.transitively().toDependOn(target)
  }

  toUse(target: Selector): this {
    return this.toDependOn(target)
  }

  toOnlyDependOn(target: Selector): this {
    this.addDependencyRule('only-depend-on', target)
    return this
  }

  toOnlyUse(target: Selector): this {
    return this.toOnlyDependOn(target)
  }

  toUseNothing(): this {
    return this.toOnlyDependOn([])
  }

  toBeDependedOnBy(target: Selector): this {
    this.addDependencyRule('depended-on-by', target)
    return this
  }

  toTransitivelyBeDependedOnBy(target: Selector): this {
    return this.transitively().toBeDependedOnBy(target)
  }

  toBeUsedIn(target: Selector): this {
    return this.toBeDependedOnBy(target)
  }

  toBeUsed(): this {
    return this.toBeDependedOnBy('**')
  }

  toOnlyBeDependedOnBy(target: Selector): this {
    this.addDependencyRule('only-depended-on-by', target)
    return this
  }

  toOnlyBeUsedIn(target: Selector): this {
    return this.toOnlyBeDependedOnBy(target)
  }

  toBeFreeOfCycles(options: CycleOptions = {}): this {
    if (this.consumeNegation()) {
      throw new TypeError('toBeFreeOfCycles() cannot be negated.')
    }
    if (options.collapseToFolderDepth !== undefined && options.collapseToFolderDepth < 1) {
      throw new TypeError('collapseToFolderDepth must be a positive integer.')
    }
    this.#suite.add({
      ...metadata(),
      ...options,
      kind: 'free-of-cycles',
      selection: this.#selection,
    })
    return this
  }

  toBeFreeOfFolderCycles(depth = 1): this {
    return this.toBeFreeOfCycles({ collapseToFolderDepth: depth })
  }

  toHavePrefix(value: string): this {
    this.addSimple({ kind: 'prefix', negated: this.consumeNegation(), value })
    return this
  }

  toHaveSuffix(value: string): this {
    this.addSimple({ kind: 'suffix', negated: this.consumeNegation(), value })
    return this
  }

  toHaveLineCountLessThan(value: number): this {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError('toHaveLineCountLessThan() needs a positive integer.')
    }
    this.addSimple({ kind: 'line-count-less-than', negated: this.consumeNegation(), value })
    return this
  }

  toBeClasses(): this {
    return this.addDeclarationKind('class')
  }
  toBeEnums(): this {
    return this.addDeclarationKind('enum')
  }
  toBeFunctions(): this {
    return this.addDeclarationKind('function')
  }
  toBeInterfaces(): this {
    return this.addDeclarationKind('interface')
  }
  toBeTypes(): this {
    return this.addDeclarationKind('type')
  }

  toBeAbstract(): this {
    this.addSimple({ kind: 'abstract', negated: this.consumeNegation() })
    return this
  }

  toBeExported(): this {
    this.addSimple({ kind: 'exported', negated: this.consumeNegation() })
    return this
  }

  toExtend(value: string): this {
    this.addSimple({ kind: 'extend', negated: this.consumeNegation(), value })
    return this
  }

  toImplement(value: string): this {
    this.addSimple({ kind: 'implement', negated: this.consumeNegation(), value })
    return this
  }

  toHaveDecorator(value: string): this {
    this.addSimple({ kind: 'decorator', negated: this.consumeNegation(), value })
    return this
  }

  toOnlyExport(...names: readonly string[]): this {
    this.addSimple({ kind: 'only-export', names, negated: this.consumeNegation() })
    return this
  }

  toHaveReadonlyProperties(): this {
    this.addSimple({ kind: 'readonly-properties', negated: this.consumeNegation() })
    return this
  }

  toUseStrictEquality(): this {
    if (this.consumeNegation()) {
      throw new TypeError('toUseStrictEquality() cannot be negated.')
    }
    this.addSimple({ kind: 'strict-equality' })
    return this
  }

  toUseGlobals(...globals: readonly string[]): this {
    if (globals.length === 0) {
      throw new TypeError('toUseGlobals() needs at least one global name.')
    }
    this.addSimple({ globals, kind: 'use-globals', negated: this.consumeNegation() })
    return this
  }

  toUseImportedSymbols(importedFrom: string, ...symbols: readonly string[]): this {
    if (importedFrom.trim() === '') {
      throw new TypeError('toUseImportedSymbols() needs a module specifier.')
    }
    if (symbols.length === 0) {
      throw new TypeError('toUseImportedSymbols() needs at least one imported symbol.')
    }
    this.addSimple({
      importedFrom,
      kind: 'use-imported-symbols',
      negated: this.consumeNegation(),
      symbols,
    })
    return this
  }

  toHaveMethods(...names: readonly string[]): this {
    if (names.length === 0) {
      throw new TypeError('toHaveMethods() needs at least one method name.')
    }
    this.addSimple({ kind: 'have-methods', names, negated: this.consumeNegation() })
    return this
  }

  toHavePublicMethods(...names: readonly string[]): this {
    return this.addVisibleMethods('public', names)
  }

  toHaveProtectedMethods(...names: readonly string[]): this {
    return this.addVisibleMethods('protected', names)
  }

  toHavePrivateMethods(...names: readonly string[]): this {
    return this.addVisibleMethods('private', names)
  }

  toOnlyHavePublicMethods(...names: readonly string[]): this {
    this.addSimple({ kind: 'only-public-methods', names, negated: this.consumeNegation() })
    return this
  }

  toHaveResolvableDependencies(options: ResolutionOptions = {}): this {
    if (this.consumeNegation()) {
      throw new TypeError('toHaveResolvableDependencies() cannot be negated.')
    }
    this.addSimple({ allowDynamic: options.allowDynamic ?? false, kind: 'resolvable-dependencies' })
    return this
  }

  toBePublicApi(): this {
    this.addSimple({ kind: 'public-api', negated: this.consumeNegation() })
    return this
  }

  toSatisfy(id: string, evaluator: CustomRule, ruleMetadata: Omit<RuleMetadata, 'id'> = {}): this {
    this.#suite.add({
      ...metadata({ ...ruleMetadata, id }),
      evaluator,
      kind: 'custom',
      selection: this.#selection,
    })
    this.#negated = false
    return this
  }

  because(reason: string): this {
    this.#suite.decorateLast({ reason })
    return this
  }

  as(id: string): this {
    this.#suite.decorateLast({ id })
    return this
  }

  withSeverity(severity: RuleSeverity): this {
    this.#suite.decorateLast({ severity })
    return this
  }

  private addDeclarationKind(declarationKind: DeclarationKind): this {
    this.addSimple({
      declarationKind,
      kind: 'declaration-kind',
      negated: this.consumeNegation(),
    })
    return this
  }

  private addVisibleMethods(
    visibility: 'private' | 'protected' | 'public',
    names: readonly string[],
  ): this {
    if (names.length === 0) {
      throw new TypeError(
        `toHave${visibility[0]?.toUpperCase() ?? ''}${visibility.slice(1)}Methods() needs at least one method name.`,
      )
    }
    this.addSimple({
      kind: 'have-visible-methods',
      names,
      negated: this.consumeNegation(),
      visibility,
    })
    return this
  }

  private addSimple(rule: RuleInput<SimpleRule>): void {
    this.#suite.add({ ...metadata(), ...rule, selection: this.#selection } as ArchitectureRule)
  }

  private consumeNegation(): boolean {
    const negated = this.#negated
    this.#negated = false
    return negated
  }

  private addDependencyRule(kind: DependencyRule['kind'], target: Selector): void {
    this.#suite.add({
      ...metadata(),
      ...(this.#dependencyKinds === undefined ? {} : { dependencyKinds: this.#dependencyKinds }),
      kind,
      localOnly: this.#localOnly,
      negated: this.consumeNegation(),
      selection: this.#selection,
      target,
      transitive: this.#transitive,
    })
    this.#dependencyKinds = undefined
    this.#localOnly = false
    this.#transitive = false
  }
}

export function createArcher(options: ArcherOptions = {}): ArchitectureSuite {
  return new ArchitectureSuite(options)
}

presets.set('strict', (suite) => {
  suite
    .expect('**')
    .toBeFreeOfCycles()
    .as('strict/no-cycles')
    .and.toHaveResolvableDependencies()
    .as('strict/resolvable-dependencies')
    .and.toUseStrictEquality()
    .as('strict/strict-equality')
})

presets.set('node', (suite) => {
  suite.expect('**').toHaveResolvableDependencies().as('node/resolvable-dependencies')
  suite
    .expect('**')
    .not.toDependOn(['node:domain', 'node:punycode', 'node:sys'])
    .as('node/no-deprecated-builtins')
})

presets.set('security', (suite) => {
  suite.expect('**').not.toUseGlobals('eval', 'Function').as('security/no-dynamic-code')
})

export function registerPreset(name: string, preset: ArcherPreset): void {
  if (name.trim() === '') {
    throw new TypeError('registerPreset() needs a non-empty name.')
  }
  presets.set(name, preset)
}

export function applyPreset(name: string, suite: ArchitectureSuite, options?: unknown): void {
  const preset = presets.get(name)
  if (preset === undefined) {
    throw new TypeError(`Unknown Archer preset '${name}'.`)
  }
  preset(suite, options)
}

export function availablePresets(): readonly string[] {
  return [...presets.keys()].toSorted()
}
