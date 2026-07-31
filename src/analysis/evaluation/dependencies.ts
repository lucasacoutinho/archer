import { formatSelector, matchesSelector } from '../../core/matchers.js'
import type { DependencyRule } from '../../core/rules.js'
import type {
  ArchitectureGraph,
  ArchitectureViolation,
  Dependency,
  SourceModule,
} from '../../core/types.js'
import { makeViolation } from './shared.js'

interface TraversedDependency {
  readonly dependency: Dependency
  readonly path: readonly string[]
}

function dependencyAllowed(rule: DependencyRule, dependency: Dependency): boolean {
  return (
    (rule.dependencyKinds === undefined || rule.dependencyKinds.includes(dependency.kind)) &&
    (!rule.localOnly || dependency.resolution === 'local')
  )
}

function directDependencies(
  subject: SourceModule,
  rule: DependencyRule,
): readonly TraversedDependency[] {
  return subject.dependencies
    .filter((dependency) => dependencyAllowed(rule, dependency))
    .map((dependency) => ({ dependency, path: [subject.path, dependency.target] }))
}

function reachableDependencies(
  graph: ArchitectureGraph,
  subject: SourceModule,
  rule: DependencyRule,
): readonly TraversedDependency[] {
  if (!rule.transitive) {
    return directDependencies(subject, rule)
  }
  const moduleByPath = new Map(
    graph.modules.map((sourceModule) => [sourceModule.path, sourceModule]),
  )
  const queue: Array<{ module: SourceModule; path: readonly string[] }> = [
    {
      module: subject,
      path: [subject.path],
    },
  ]
  const visited = new Set([subject.path])
  const traversed: TraversedDependency[] = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) {
      continue
    }
    for (const dependency of current.module.dependencies.filter((item) =>
      dependencyAllowed(rule, item),
    )) {
      const dependencyPath = [...current.path, dependency.target]
      traversed.push({ dependency, path: dependencyPath })
      const target = moduleByPath.get(dependency.target)
      if (target !== undefined && !visited.has(target.path)) {
        visited.add(target.path)
        queue.push({ module: target, path: dependencyPath })
      }
    }
  }
  return traversed
}

function incomingDependencies(
  graph: ArchitectureGraph,
  subject: SourceModule,
  rule: DependencyRule,
): readonly TraversedDependency[] {
  const direct = graph.dependencies
    .filter(
      (dependency) => dependency.target === subject.path && dependencyAllowed(rule, dependency),
    )
    .map((dependency) => ({ dependency, path: [dependency.from, subject.path] }))
  if (!rule.transitive) {
    return direct
  }
  const incomingByTarget = new Map<string, Dependency[]>()
  for (const dependency of graph.dependencies.filter((item) => dependencyAllowed(rule, item))) {
    const list = incomingByTarget.get(dependency.target) ?? []
    list.push(dependency)
    incomingByTarget.set(dependency.target, list)
  }
  const queue: Array<{ path: readonly string[]; target: string }> = [
    { path: [subject.path], target: subject.path },
  ]
  const visited = new Set([subject.path])
  const traversed: TraversedDependency[] = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) {
      continue
    }
    for (const dependency of incomingByTarget.get(current.target) ?? []) {
      const dependencyPath = [dependency.from, ...current.path]
      traversed.push({ dependency, path: dependencyPath })
      if (!visited.has(dependency.from)) {
        visited.add(dependency.from)
        queue.push({ path: dependencyPath, target: dependency.from })
      }
    }
  }
  return traversed
}

function sourceFor(graph: ArchitectureGraph, dependency: Dependency): SourceModule | undefined {
  return graph.modules.find((candidate) => candidate.path === dependency.from)
}

function evaluateDependOn(
  graph: ArchitectureGraph,
  rule: DependencyRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = []
  for (const subject of subjects) {
    const traversed = reachableDependencies(graph, subject, rule)
    const matching = traversed.filter(
      ({ dependency }) =>
        matchesSelector(dependency.target, rule.target) ||
        (rule.negated && dependency.target === 'dynamic:unknown'),
    )
    if (rule.negated) {
      for (const item of matching) {
        const message =
          item.dependency.target === 'dynamic:unknown'
            ? `Cannot resolve computed dynamic import '${item.dependency.specifier}' to prove this boundary.`
            : `Imports '${item.dependency.specifier}', resolved as '${item.dependency.target}'.`
        violations.push(
          makeViolation(
            rule,
            message,
            sourceFor(graph, item.dependency),
            item.dependency,
            undefined,
            item.path,
          ),
        )
      }
    } else if (matching.length === 0) {
      violations.push(
        makeViolation(rule, `Does not depend on ${formatSelector(rule.target)}.`, subject),
      )
    }
  }
  return violations
}

function evaluateOnlyDependOn(
  graph: ArchitectureGraph,
  rule: DependencyRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = []
  for (const subject of subjects) {
    const outside = reachableDependencies(graph, subject, rule).filter(
      ({ dependency }) => !matchesSelector(dependency.target, rule.target),
    )
    if (rule.negated) {
      if (outside.length === 0) {
        violations.push(
          makeViolation(rule, `Every dependency matches ${formatSelector(rule.target)}.`, subject),
        )
      }
    } else {
      for (const item of outside) {
        violations.push(
          makeViolation(
            rule,
            `Imports '${item.dependency.specifier}', resolved as '${item.dependency.target}'.`,
            sourceFor(graph, item.dependency),
            item.dependency,
            undefined,
            item.path,
          ),
        )
      }
    }
  }
  return violations
}

function evaluateDependedOnBy(
  graph: ArchitectureGraph,
  rule: DependencyRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = []
  for (const subject of subjects) {
    const matching = incomingDependencies(graph, subject, rule).filter(({ dependency }) =>
      matchesSelector(dependency.from, rule.target),
    )
    if (rule.negated) {
      for (const item of matching) {
        violations.push(
          makeViolation(
            rule,
            `'${item.dependency.from}' imports '${subject.path}'.`,
            sourceFor(graph, item.dependency),
            item.dependency,
            undefined,
            item.path,
          ),
        )
      }
    } else if (matching.length === 0) {
      violations.push(
        makeViolation(rule, `Is not depended on by ${formatSelector(rule.target)}.`, subject),
      )
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
    const outside = incomingDependencies(graph, subject, rule).filter(
      ({ dependency }) => !matchesSelector(dependency.from, rule.target),
    )
    if (rule.negated) {
      if (outside.length === 0) {
        violations.push(
          makeViolation(
            rule,
            `Every incoming dependency is from ${formatSelector(rule.target)}.`,
            subject,
          ),
        )
      }
    } else {
      for (const item of outside) {
        violations.push(
          makeViolation(
            rule,
            `'${item.dependency.from}' imports '${subject.path}'.`,
            sourceFor(graph, item.dependency),
            item.dependency,
            undefined,
            item.path,
          ),
        )
      }
    }
  }
  return violations
}

export function evaluateDependencyRule(
  graph: ArchitectureGraph,
  rule: DependencyRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  switch (rule.kind) {
    case 'depend-on':
      return evaluateDependOn(graph, rule, subjects)
    case 'only-depend-on':
      return evaluateOnlyDependOn(graph, rule, subjects)
    case 'depended-on-by':
      return evaluateDependedOnBy(graph, rule, subjects)
    case 'only-depended-on-by':
      return evaluateOnlyDependedOnBy(graph, rule, subjects)
  }
}
