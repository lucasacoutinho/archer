import { matchesSelector, selectorValues } from './matchers.js'
import type {
  ArchitectureViolation,
  CustomRule,
  RuleMetadata,
  Selector,
  SourceModule,
} from './types.js'

interface LayerArchExpectation {
  readonly not: LayerArchExpectation
  localDependencies(): LayerArchExpectation
  toDependOn(target: Selector): LayerArchExpectation
  toOnlyBeDependedOnBy(target: Selector): LayerArchExpectation
  toOnlyDependOn(target: Selector): LayerArchExpectation
  toSatisfy(
    id: string,
    evaluator: CustomRule,
    metadata?: Omit<RuleMetadata, 'id'>,
  ): LayerArchExpectation
}

interface LayerSuite {
  expect(selector: Selector): LayerArchExpectation
  rule(id: string, evaluator: CustomRule, metadata?: Omit<RuleMetadata, 'id'>): LayerSuite
}

function violation(
  rule: string,
  message: string,
  source?: SourceModule,
  line?: number,
  column?: number,
): ArchitectureViolation {
  return {
    ...(column === undefined ? {} : { column }),
    ...(source === undefined ? {} : { file: source.path }),
    ...(line === undefined ? {} : { line }),
    message,
    rule,
    severity: 'error',
  }
}

export class ArchitectureLayers {
  readonly #definitions: Readonly<Record<string, Selector>>
  readonly #suite: LayerSuite

  constructor(suite: LayerSuite, definitions: Readonly<Record<string, Selector>>) {
    if (Object.keys(definitions).length === 0) {
      throw new TypeError('layers() needs at least one named layer.')
    }
    this.#suite = suite
    this.#definitions = definitions
  }

  where(name: string): LayerExpectation {
    return new LayerExpectation(this.#suite, this.#definitions, name)
  }

  toBeFreeOfCycles(): this {
    const definitions = this.#definitions
    this.#suite.rule('layers-free-of-cycles', ({ graph }) => {
      const adjacency = new Map(Object.keys(definitions).map((name) => [name, new Set<string>()]))
      for (const dependency of graph.dependencies.filter((item) => item.resolution === 'local')) {
        const from = Object.entries(definitions).find(([, selector]) =>
          matchesSelector(dependency.from, selector),
        )?.[0]
        const target = Object.entries(definitions).find(([, selector]) =>
          matchesSelector(dependency.target, selector),
        )?.[0]
        if (from !== undefined && target !== undefined && from !== target) {
          adjacency.get(from)?.add(target)
        }
      }
      const visiting = new Set<string>()
      const visited = new Set<string>()
      const stack: string[] = []
      const found: string[][] = []
      function visit(name: string): void {
        visiting.add(name)
        stack.push(name)
        for (const target of adjacency.get(name) ?? []) {
          if (visiting.has(target)) {
            found.push([...stack.slice(stack.indexOf(target)), target])
          } else if (!visited.has(target)) {
            visit(target)
          }
        }
        stack.pop()
        visiting.delete(name)
        visited.add(name)
      }
      for (const name of adjacency.keys()) {
        if (!visited.has(name)) visit(name)
      }
      return found.map((cycle) =>
        violation('named layers must be free of cycles', `Layer cycle: ${cycle.join(' -> ')}.`),
      )
    })
    return this
  }
}

export class LayerExpectation {
  readonly #definitions: Readonly<Record<string, Selector>>
  readonly #name: string
  readonly #selector: Selector
  readonly #suite: LayerSuite

  constructor(suite: LayerSuite, definitions: Readonly<Record<string, Selector>>, name: string) {
    const selector = definitions[name]
    if (selector === undefined) {
      throw new TypeError(`Unknown architecture layer '${name}'.`)
    }
    this.#suite = suite
    this.#definitions = definitions
    this.#name = name
    this.#selector = selector
  }

  mayDependOn(...names: readonly string[]): this {
    this.#suite
      .expect(this.#selector)
      .localDependencies()
      .toOnlyDependOn([...this.selectors(names), ...this.selectors([this.#name])])
    return this
  }

  mayOnlyDependOn(...names: readonly string[]): this {
    return this.mayDependOn(...names)
  }

  mayNotDependOn(...names: readonly string[]): this {
    this.#suite.expect(this.#selector).localDependencies().not.toDependOn(this.selectors(names))
    return this
  }

  mayOnlyBeUsedBy(...names: readonly string[]): this {
    this.#suite
      .expect(this.#selector)
      .localDependencies()
      .toOnlyBeDependedOnBy([...this.selectors(names), ...this.selectors([this.#name])])
    return this
  }

  exposeThrough(...barrels: readonly string[]): this {
    if (barrels.length === 0) {
      throw new TypeError('exposeThrough() needs at least one public API selector.')
    }
    const selector = this.#selector
    const layerName = this.#name
    this.#suite.expect(selector).toSatisfy(`layer-${layerName}-public-api`, ({ graph }) => {
      return graph.dependencies.flatMap((dependency) => {
        if (
          dependency.resolution !== 'local' ||
          matchesSelector(dependency.from, selector) ||
          !matchesSelector(dependency.target, selector) ||
          matchesSelector(dependency.target, barrels)
        ) {
          return []
        }
        const source = graph.modules.find((item) => item.path === dependency.from)
        return [
          violation(
            `layer '${layerName}' must be exposed through ${barrels.join(', ')}`,
            `Imports internal module '${dependency.target}' instead of a public API.`,
            source,
            dependency.line,
            dependency.column,
          ),
        ]
      })
    })
    return this
  }

  private selectors(names: readonly string[]): string[] {
    return names.flatMap((name) => {
      const selector = this.#definitions[name]
      if (selector === undefined) {
        throw new TypeError(`Unknown architecture layer '${name}'.`)
      }
      return selectorValues(selector)
    })
  }
}
