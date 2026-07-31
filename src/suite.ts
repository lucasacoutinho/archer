import path from 'node:path'

import { analyze } from './analyzer.js'
import { formatSelector, matchesSelector, selectorValues } from './matchers.js'
import type { ArchitectureRule, DependencyRule, Selection } from './rules.js'
import type {
  ArchitectureGraph,
  ArchitectureResult,
  ArchitectureViolation,
  ArcherOptions,
  Dependency,
  Selector,
  SourceModule,
} from './types.js'

function selectedModules(graph: ArchitectureGraph, selection: Selection): readonly SourceModule[] {
  return graph.modules.filter((sourceModule) =>
    matchesSelector(sourceModule.path, selection.selector)
    && !selection.ignored.some((ignored) => matchesSelector(sourceModule.path, ignored)),
  )
}

function describeRule(rule: ArchitectureRule): string {
  const subject = formatSelector(rule.selection.selector)
  const not = rule.negated ? ' not' : ''

  switch (rule.kind) {
    case 'depend-on':
      return `${subject} must${not} depend on ${formatSelector(rule.target)}`
    case 'only-depend-on':
      return `${subject} must${not} only depend on ${formatSelector(rule.target)}`
    case 'depended-on-by':
      return `${subject} must${not} be depended on by ${formatSelector(rule.target)}`
    case 'only-depended-on-by':
      return `${subject} must${not} only be depended on by ${formatSelector(rule.target)}`
    case 'free-of-cycles':
      return `${subject} must be free of cycles`
    case 'prefix':
      return `${subject} must${not} have prefix '${rule.value}'`
    case 'suffix':
      return `${subject} must${not} have suffix '${rule.value}'`
    case 'line-count-less-than':
      return `${subject} must${not} have fewer than ${rule.value} lines`
  }
}

function violation(
  rule: ArchitectureRule,
  message: string,
  sourceModule?: SourceModule,
  dependency?: Dependency,
): ArchitectureViolation {
  return {
    ...(dependency === undefined ? {} : {
      column: dependency.column,
      dependency: dependency.target,
      line: dependency.line,
    }),
    ...(sourceModule === undefined ? {} : { file: sourceModule.path }),
    message,
    rule: describeRule(rule),
  }
}

function evaluateDependOn(
  rule: DependencyRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = []

  for (const subject of subjects) {
    const matching = subject.dependencies.filter((dependency) =>
      matchesSelector(dependency.target, rule.target)
      || (rule.negated && dependency.target === 'dynamic:unknown'),
    )
    if (rule.negated) {
      for (const dependency of matching) {
        const message = dependency.target === 'dynamic:unknown'
          ? `Cannot resolve computed dynamic import '${dependency.specifier}' to prove this boundary.`
          : `Imports '${dependency.specifier}', resolved as '${dependency.target}'.`
        violations.push(violation(
          rule,
          message,
          subject,
          dependency,
        ))
      }
    } else if (matching.length === 0) {
      violations.push(violation(
        rule,
        `Does not depend on ${formatSelector(rule.target)}.`,
        subject,
      ))
    }
  }

  return violations
}

function evaluateOnlyDependOn(
  rule: DependencyRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = []

  for (const subject of subjects) {
    const outside = subject.dependencies.filter(
      (dependency) => !matchesSelector(dependency.target, rule.target),
    )

    if (rule.negated) {
      if (outside.length === 0) {
        violations.push(violation(
          rule,
          `Every dependency matches ${formatSelector(rule.target)}.`,
          subject,
        ))
      }
    } else {
      for (const dependency of outside) {
        violations.push(violation(
          rule,
          `Imports '${dependency.specifier}', resolved as '${dependency.target}'.`,
          subject,
          dependency,
        ))
      }
    }
  }

  return violations
}

function incomingDependencies(graph: ArchitectureGraph, subject: SourceModule): readonly Dependency[] {
  return graph.dependencies.filter((dependency) => dependency.target === subject.path)
}

function evaluateDependedOnBy(
  graph: ArchitectureGraph,
  rule: DependencyRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = []

  for (const subject of subjects) {
    const incoming = incomingDependencies(graph, subject)
      .filter((dependency) => matchesSelector(dependency.from, rule.target))

    if (rule.negated) {
      for (const dependency of incoming) {
        const source = graph.modules.find((candidate) => candidate.path === dependency.from)
        violations.push(violation(
          rule,
          `'${dependency.from}' imports '${subject.path}'.`,
          source,
          dependency,
        ))
      }
    } else if (incoming.length === 0) {
      violations.push(violation(
        rule,
        `Is not depended on by ${formatSelector(rule.target)}.`,
        subject,
      ))
    }
  }

  return violations
}

function evaluateOnlyDependedOnBy(
  graph: ArchitectureGraph,
  rule: DependencyRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = []

  for (const subject of subjects) {
    const outside = incomingDependencies(graph, subject)
      .filter((dependency) => !matchesSelector(dependency.from, rule.target))

    if (rule.negated) {
      if (outside.length === 0) {
        violations.push(violation(
          rule,
          `Every incoming dependency is from ${formatSelector(rule.target)}.`,
          subject,
        ))
      }
    } else {
      for (const dependency of outside) {
        const source = graph.modules.find((candidate) => candidate.path === dependency.from)
        violations.push(violation(
          rule,
          `'${dependency.from}' imports '${subject.path}'.`,
          source,
          dependency,
        ))
      }
    }
  }

  return violations
}

function stronglyConnectedComponents(
  modules: readonly SourceModule[],
): readonly (readonly string[])[] {
  const paths = new Set(modules.map((sourceModule) => sourceModule.path))
  const adjacency = new Map(modules.map((sourceModule) => [
    sourceModule.path,
    sourceModule.dependencies
      .map((dependency) => dependency.target)
      .filter((target) => paths.has(target)),
  ]))
  const indexes = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []
  let index = 0

  function connect(node: string): void {
    indexes.set(node, index)
    lowLinks.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)

    for (const target of adjacency.get(node) ?? []) {
      if (!indexes.has(target)) {
        connect(target)
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, lowLinks.get(target) ?? 0))
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, indexes.get(target) ?? 0))
      }
    }

    if (lowLinks.get(node) === indexes.get(node)) {
      const component: string[] = []
      let current: string | undefined
      do {
        current = stack.pop()
        if (current !== undefined) {
          onStack.delete(current)
          component.push(current)
        }
      } while (current !== node)
      components.push(component)
    }
  }

  for (const sourceModule of modules) {
    if (!indexes.has(sourceModule.path)) {
      connect(sourceModule.path)
    }
  }

  return components.filter((component) => {
    if (component.length > 1) {
      return true
    }
    const only = component[0]
    return only !== undefined && (adjacency.get(only) ?? []).includes(only)
  })
}

function evaluateCycles(
  rule: Extract<ArchitectureRule, { kind: 'free-of-cycles' }>,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  const moduleByPath = new Map(subjects.map((sourceModule) => [sourceModule.path, sourceModule]))

  function findCycle(component: readonly string[]): readonly string[] {
    const members = new Set(component)
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const stack: string[] = []

    function visit(node: string): readonly string[] | undefined {
      visiting.add(node)
      stack.push(node)

      const targets = moduleByPath.get(node)?.dependencies
        .map((dependency) => dependency.target)
        .filter((target) => members.has(target)) ?? []

      for (const target of targets) {
        if (visiting.has(target)) {
          const start = stack.indexOf(target)
          return [...stack.slice(start), target]
        }
        if (!visited.has(target)) {
          const cycle = visit(target)
          if (cycle !== undefined) {
            return cycle
          }
        }
      }

      stack.pop()
      visiting.delete(node)
      visited.add(node)
      return undefined
    }

    for (const node of [...component].sort()) {
      if (!visited.has(node)) {
        const cycle = visit(node)
        if (cycle !== undefined) {
          return cycle
        }
      }
    }

    return component
  }

  return stronglyConnectedComponents(subjects).map((component) => {
    const cycle = findCycle(component).join(' -> ')
    return violation(rule, `Dependency cycle: ${cycle}.`)
  })
}

function evaluateName(
  rule: Extract<ArchitectureRule, { kind: 'prefix' | 'suffix' }>,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const fileName = path.basename(subject.path)
    const matches = rule.kind === 'prefix'
      ? fileName.startsWith(rule.value)
      : fileName.endsWith(rule.value)
    return matches !== rule.negated
      ? []
      : [violation(rule, `File name is '${fileName}'.`, subject)]
  })
}

function evaluateLineCount(
  rule: Extract<ArchitectureRule, { kind: 'line-count-less-than' }>,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  return subjects.flatMap((subject) => {
    const matches = subject.lines < rule.value
    return matches !== rule.negated
      ? []
      : [violation(rule, `File has ${subject.lines} lines.`, subject)]
  })
}

function evaluateRule(graph: ArchitectureGraph, rule: ArchitectureRule): readonly ArchitectureViolation[] {
  const subjects = selectedModules(graph, rule.selection)
  if (subjects.length === 0) {
    return [violation(rule, `No files matched ${formatSelector(rule.selection.selector)}.`)]
  }

  switch (rule.kind) {
    case 'depend-on':
      return evaluateDependOn(rule, subjects)
    case 'only-depend-on':
      return evaluateOnlyDependOn(rule, subjects)
    case 'depended-on-by':
      return evaluateDependedOnBy(graph, rule, subjects)
    case 'only-depended-on-by':
      return evaluateOnlyDependedOnBy(graph, rule, subjects)
    case 'free-of-cycles':
      return evaluateCycles(rule, subjects)
    case 'prefix':
    case 'suffix':
      return evaluateName(rule, subjects)
    case 'line-count-less-than':
      return evaluateLineCount(rule, subjects)
  }
}

export class ArchitectureSuite {
  readonly options: ArcherOptions
  readonly #rules: ArchitectureRule[] = []

  constructor(options: ArcherOptions = {}) {
    this.options = options
  }

  expect(selector: Selector): ArchExpectation {
    if (selectorValues(selector).length === 0) {
      throw new TypeError('expect() needs at least one selector.')
    }
    return new ArchExpectation(this, { ignored: [], selector })
  }

  add(rule: ArchitectureRule): void {
    this.#rules.push(rule)
  }

  async check(): Promise<ArchitectureResult> {
    const graph = await analyze(this.options)
    if (this.#rules.length === 0) {
      return {
        dependenciesAnalyzed: graph.dependencies.length,
        filesAnalyzed: graph.modules.length,
        ok: false,
        violations: [{
          message: 'No architecture rules were declared.',
          rule: 'an architecture test must declare at least one rule',
        }],
      }
    }

    const violations = this.#rules.flatMap((rule) => evaluateRule(graph, rule))
      .sort((left, right) => {
        const fileComparison = (left.file ?? '').localeCompare(right.file ?? '')
        if (fileComparison !== 0) {
          return fileComparison
        }
        return (left.line ?? 0) - (right.line ?? 0)
      })

    return {
      dependenciesAnalyzed: graph.dependencies.length,
      filesAnalyzed: graph.modules.length,
      ok: violations.length === 0,
      violations,
    }
  }
}

export class ArchExpectation {
  readonly #suite: ArchitectureSuite
  readonly #selection: Selection
  #negated = false

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

  toDependOn(target: Selector): this {
    this.addDependencyRule('depend-on', target)
    return this
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

  toBeFreeOfCycles(): this {
    if (this.consumeNegation()) {
      throw new TypeError('toBeFreeOfCycles() cannot be negated.')
    }
    this.#suite.add({ kind: 'free-of-cycles', negated: false, selection: this.#selection })
    return this
  }

  toHavePrefix(value: string): this {
    this.#suite.add({
      kind: 'prefix',
      negated: this.consumeNegation(),
      selection: this.#selection,
      value,
    })
    return this
  }

  toHaveSuffix(value: string): this {
    this.#suite.add({
      kind: 'suffix',
      negated: this.consumeNegation(),
      selection: this.#selection,
      value,
    })
    return this
  }

  toHaveLineCountLessThan(value: number): this {
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError('toHaveLineCountLessThan() needs a positive integer.')
    }
    this.#suite.add({
      kind: 'line-count-less-than',
      negated: this.consumeNegation(),
      selection: this.#selection,
      value,
    })
    return this
  }

  #consumeNegation(): boolean {
    const negated = this.#negated
    this.#negated = false
    return negated
  }

  private consumeNegation(): boolean {
    return this.#consumeNegation()
  }

  private addDependencyRule(
    kind: 'depend-on' | 'only-depend-on' | 'depended-on-by' | 'only-depended-on-by',
    target: Selector,
  ): void {
    this.#suite.add({
      kind,
      negated: this.consumeNegation(),
      selection: this.#selection,
      target,
    })
  }
}

export function createArcher(options: ArcherOptions = {}): ArchitectureSuite {
  return new ArchitectureSuite(options)
}
