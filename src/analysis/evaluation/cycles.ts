import path from 'node:path'

import type { CycleRule } from '../../core/rules.js'
import type { ArchitectureViolation, SourceModule } from '../../core/types.js'
import { makeViolation } from './shared.js'

function collapsedPath(fileName: string, depth: number | undefined): string {
  if (depth === undefined) {
    return fileName
  }
  return fileName.split('/').slice(0, depth).join('/')
}

function adjacencyFor(
  modules: readonly SourceModule[],
  rule: CycleRule,
): ReadonlyMap<string, readonly string[]> {
  const sourcePaths = new Set(modules.map((sourceModule) => sourceModule.path))
  const adjacency = new Map<string, Set<string>>()
  for (const sourceModule of modules) {
    const from = collapsedPath(sourceModule.path, rule.collapseToFolderDepth)
    const targets = adjacency.get(from) ?? new Set<string>()
    for (const dependency of sourceModule.dependencies) {
      if (
        sourcePaths.has(dependency.target) &&
        (rule.dependencyKinds === undefined || rule.dependencyKinds.includes(dependency.kind))
      ) {
        const target = collapsedPath(dependency.target, rule.collapseToFolderDepth)
        if (target !== from || dependency.target === sourceModule.path) {
          targets.add(target)
        }
      }
    }
    adjacency.set(from, targets)
  }
  return new Map([...adjacency].map(([key, values]) => [key, [...values]]))
}

function stronglyConnectedComponents(
  adjacency: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
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

  for (const node of adjacency.keys()) {
    if (!indexes.has(node)) {
      connect(node)
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

function findCycle(
  component: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const members = new Set(component)
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  function visit(node: string): readonly string[] | undefined {
    visiting.add(node)
    stack.push(node)
    for (const target of adjacency.get(node) ?? []) {
      if (!members.has(target)) {
        continue
      }
      if (visiting.has(target)) {
        return [...stack.slice(stack.indexOf(target)), target]
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

  for (const node of component.toSorted()) {
    const cycle = visit(node)
    if (cycle !== undefined) {
      return cycle
    }
  }
  return component
}

export function evaluateCycleRule(
  rule: CycleRule,
  subjects: readonly SourceModule[],
): readonly ArchitectureViolation[] {
  const adjacency = adjacencyFor(subjects, rule)
  return stronglyConnectedComponents(adjacency).map((component) => {
    const cycle = findCycle(component, adjacency)
    const first = cycle[0]
    const source =
      first === undefined
        ? undefined
        : subjects.find((subject) =>
            rule.collapseToFolderDepth === undefined
              ? subject.path === first
              : collapsedPath(subject.path, rule.collapseToFolderDepth) === first,
          )
    return makeViolation(rule, `Dependency cycle: ${cycle.join(' -> ')}.`, source)
  })
}

export function publicApiFile(fileName: string): boolean {
  const baseName = path.basename(fileName)
  return /^(?:index|public-api)\.[cm]?[jt]sx?$/u.test(baseName)
}
