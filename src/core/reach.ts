/** Port of lean/Archer/Impl/Reach.lean. Output order: breadth-first discovery, as documented there. */
import { pathKey, targetKey } from "./keys.ts"
import { admits, type Dependency, type EdgeFilter, type FilePath, type Graph, type SourceFile, type Target } from "./model.ts"
import type { Edge } from "./rule.ts"

export type Found = ReadonlyArray<readonly [Target, ReadonlyArray<Edge>]>

export type ReachFn = (graph: Graph, filter: EdgeFilter, source: FilePath) => Found

const indexes: WeakMap<Graph, Map<string, SourceFile>> = new WeakMap<Graph, Map<string, SourceFile>>()

/** Lean `Graph.find?`: the first file with the path. */
export const find = (graph: Graph, path: FilePath): SourceFile | undefined => {
  let index = indexes.get(graph)
  if (index === undefined) {
    index = new Map()
    for (const file of graph.files) {
      const key = pathKey(file.path)
      if (!index.has(key)) index.set(key, file)
    }
    indexes.set(graph, index)
  }
  return index.get(pathKey(path))
}

/** A dependency with its target's key and, for a source file target, the file the search continues from. */
interface Step {
  readonly dependency: Dependency
  readonly key: string
  readonly next: SourceFile | undefined
}

const stepsByGraph: WeakMap<Graph, WeakMap<SourceFile, ReadonlyArray<Step>>> = new WeakMap<
  Graph,
  WeakMap<SourceFile, ReadonlyArray<Step>>
>()

const steps = (graph: Graph, file: SourceFile): ReadonlyArray<Step> => {
  let byFile = stepsByGraph.get(graph)
  if (byFile === undefined) {
    byFile = new WeakMap()
    stepsByGraph.set(graph, byFile)
  }
  const cached = byFile.get(file)
  if (cached !== undefined) return cached
  const computed = file.dependencies.map(
    (dependency): Step => ({
      dependency,
      key: targetKey(dependency.target),
      next: dependency.target._tag === "File" ? find(graph, dependency.target.path) : undefined,
    }),
  )
  byFile.set(file, computed)
  return computed
}

type Front = ReadonlyArray<readonly [SourceFile, ReadonlyArray<Edge>]>

/**
 * The breadth-first search of Lean's `reach`. With `stopAt`, it returns as
 * soon as that target is discovered; discovery happens once per target, so
 * the witness is the one the whole search would report.
 */
const search = (graph: Graph, filter: EdgeFilter, source: FilePath, stopAt: string | undefined): Found => {
  const found: Array<readonly [Target, ReadonlyArray<Edge>]> = []
  const continuations: Array<SourceFile | undefined> = []
  const seen = new Set<string>()
  const start = find(graph, source)
  let front: Front = start === undefined ? [] : [[start, []]]
  for (let fuel = graph.files.length + 1; fuel > 0 && front.length > 0; fuel--) {
    const before = found.length
    for (const [file, witness] of front) {
      for (const step of steps(graph, file)) {
        if (!admits(filter, step.dependency) || seen.has(step.key)) continue
        seen.add(step.key)
        found.push([step.dependency.target, [...witness, { source: file.path, dependency: step.dependency }]])
        continuations.push(step.next)
        if (step.key === stopAt) return found
      }
    }
    if (!filter.transitive) break
    const round: Array<readonly [SourceFile, ReadonlyArray<Edge>]> = []
    for (let index = before; index < found.length; index++) {
      const next = continuations[index]
      const entry = found[index]
      if (next !== undefined && entry !== undefined) round.push([next, entry[1]])
    }
    front = round
  }
  return found
}

export const reach: ReachFn = (graph: Graph, filter: EdgeFilter, source: FilePath): Found =>
  search(graph, filter, source, undefined)

/** The witness `reach` reports for `target`, found without searching past it. */
export const reachTarget = (
  graph: Graph,
  filter: EdgeFilter,
  source: FilePath,
  target: Target,
): ReadonlyArray<Edge> | undefined => {
  const key = targetKey(target)
  const last = search(graph, filter, source, key).at(-1)
  return last !== undefined && targetKey(last[0]) === key ? last[1] : undefined
}
