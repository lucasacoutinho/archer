/**
 * Port of lean/Archer/Impl/Check.lean. Evidence order is documented there:
 * rules in policy order, subjects in graph file order, then per-assertion order.
 */
import { Match } from "effect"
import {
  admits,
  type EdgeFilter,
  type FilePath,
  type Graph,
  graphPaths,
  type Selector,
  type SourceFile,
  type Target,
} from "./model.ts"
import { filterKey, pathKey, targetKey } from "./keys.ts"
import { find, type Found, reach, type ReachFn, reachTarget } from "./reach.ts"
import {
  affixHolds,
  basename,
  collapse,
  type Affix,
  type CustomRules,
  type Evidence,
  holds,
  matchesUse,
  type Policy,
  type Quantifier,
  type Relation,
  restrict,
  type Rule,
  type UseSpec,
  type Violation,
  violationKey,
  type DeclarationPredicate,
  type Edge,
} from "./rule.ts"
import { selects, subjects } from "./selector.ts"
import { structuralKey } from "./structural.ts"

/** Lean `dedupByKey`: drop every violation whose key an earlier violation has. */
export const dedupByKey = (violations: ReadonlyArray<Violation>): Array<Violation> => {
  const seen = new Set<string>()
  return violations.filter((violation) => {
    const key = structuralKey(violationKey(violation))
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type Finding = readonly [subject: FilePath, evidence: Evidence]

const fileTarget = (path: FilePath): Target => ({ _tag: "File", path })

const forbidden = (object: Selector, target: Target): boolean =>
  selects(object, target) || target._tag === "Computed"

const unresolvable = (allowComputed: boolean, target: Target): boolean =>
  Match.valueTags(target, {
    Unresolved: () => true,
    Computed: () => !allowComputed,
    File: () => false,
    Package: () => false,
    Builtin: () => false,
  })

/** `reach` is pure, so one check computes each graph, filter, and source once. */
const memoize = (reachFn: ReachFn): ReachFn => {
  const results = new WeakMap<Graph, Map<string, Found>>()
  return (graph: Graph, filter: EdgeFilter, source: FilePath): Found => {
    let byKey = results.get(graph)
    if (byKey === undefined) {
      byKey = new Map()
      results.set(graph, byKey)
    }
    const key = filterKey(filter) + pathKey(source)
    const cached = byKey.get(key)
    if (cached !== undefined) return cached
    const found = reachFn(graph, filter, source)
    byKey.set(key, found)
    return found
  }
}

const walks: WeakMap<Found, Map<string, ReadonlyArray<Edge>>> = new WeakMap<Found, Map<string, ReadonlyArray<Edge>>>()

/** The witness `found` reports for `target`; `reach` reports each target once. */
const walkTo = (found: Found, target: Target): ReadonlyArray<Edge> | undefined => {
  let index = walks.get(found)
  if (index === undefined) {
    index = new Map(found.map(([reached, edges]) => [targetKey(reached), edges] as const))
    walks.set(found, index)
  }
  return index.get(targetKey(target))
}

/** The witness for one target. It must equal the witness that the check's `ReachFn` reports for it. */
export type ReachTargetFn = (graph: Graph, filter: EdgeFilter, source: FilePath, target: Target) => ReadonlyArray<Edge> | undefined

const fromReach =
  (reachFn: ReachFn): ReachTargetFn =>
  (graph: Graph, filter: EdgeFilter, source: FilePath, target: Target): ReadonlyArray<Edge> | undefined =>
    walkTo(reachFn(graph, filter, source), target)

/** Candidate dependents of an incoming rule, in graph file order. The subject itself is removed per subject. */
const candidates = (graph: Graph, object: Selector): Array<SourceFile> =>
  graph.files.filter((file) => selects(object, fileTarget(file.path)))

const others = (files: ReadonlyArray<SourceFile>, subject: FilePath): Array<SourceFile> => {
  const key = pathKey(subject)
  return files.filter((file) => pathKey(file.path) !== key)
}

interface Importer {
  readonly dependent: SourceFile
  readonly dependency: SourceFile["dependencies"][number]
}

/** The admitted import sites of `files`, by target, in file order then dependency order. */
const importersByTarget = (files: ReadonlyArray<SourceFile>, filter: EdgeFilter): Map<string, Array<Importer>> => {
  const index = new Map<string, Array<Importer>>()
  for (const dependent of files) {
    for (const dependency of dependent.dependencies) {
      if (!admits(filter, dependency)) continue
      const key = targetKey(dependency.target)
      const sites = index.get(key)
      if (sites === undefined) index.set(key, [{ dependent, dependency }])
      else sites.push({ dependent, dependency })
    }
  }
  return index
}

const outgoingForbid = (reachFn: ReachFn, graph: Graph, rule: Rule, object: Selector, filter: EdgeFilter): Array<Finding> =>
  subjects(graph, rule.subject).flatMap((file): Array<Finding> =>
    filter.transitive
      ? reachFn(graph, filter, file.path)
          .filter(([target]) => forbidden(object, target))
          .map(([target, edges]) => [file.path, { _tag: "Walk", target, edges }])
      : file.dependencies
          .filter((dependency) => admits(filter, dependency) && forbidden(object, dependency.target))
          .map((dependency) => [
            file.path,
            { _tag: "Dependency", edge: { source: file.path, dependency } },
          ]),
  )

const outgoingRequire = (reachFn: ReachFn, graph: Graph, rule: Rule, object: Selector, filter: EdgeFilter): Array<Finding> =>
  subjects(graph, rule.subject)
    .filter(
      (file) =>
        !reachFn(graph, filter, file.path).some(([target]) => target._tag !== "Computed" && selects(object, target)),
    )
    .map((file): Finding => [file.path, { _tag: "Missing" }])

const incomingForbid = (reachFn: ReachFn, graph: Graph, rule: Rule, object: Selector, filter: EdgeFilter): Array<Finding> => {
  const dependents = candidates(graph, object)
  if (!filter.transitive) {
    const importers = importersByTarget(dependents, filter)
    return subjects(graph, rule.subject).flatMap((file): Array<Finding> => {
      const key = pathKey(file.path)
      return (importers.get(targetKey(fileTarget(file.path))) ?? [])
        .filter(({ dependent }) => pathKey(dependent.path) !== key)
        .map(({ dependent, dependency }): Finding => [
          file.path,
          { _tag: "Dependency", edge: { source: dependent.path, dependency } },
        ])
    })
  }
  return subjects(graph, rule.subject).flatMap((file) =>
    others(dependents, file.path).flatMap((dependent): Array<Finding> => {
      const edges = walkTo(reachFn(graph, filter, dependent.path), fileTarget(file.path))
      return edges === undefined ? [] : [[file.path, { _tag: "Walk", target: fileTarget(dependent.path), edges }]]
    }),
  )
}

const incomingRequire = (reachFn: ReachFn, graph: Graph, rule: Rule, object: Selector, filter: EdgeFilter): Array<Finding> => {
  const dependents = candidates(graph, object)
  return subjects(graph, rule.subject)
    .filter((file) =>
      others(dependents, file.path).every(
        (dependent) => walkTo(reachFn(graph, filter, dependent.path), fileTarget(file.path)) === undefined,
      ),
    )
    .map((file): Finding => [file.path, { _tag: "Missing" }])
}

export const cycleGraph = (graph: Graph, rule: Rule, depth: number | undefined): Graph => {
  const restricted = restrict(graph, (path) => selects(rule.subject, fileTarget(path)))
  return depth === undefined ? restricted : collapse(restricted, depth)
}

export const cycleFilter = (filter: EdgeFilter): EdgeFilter => ({ ...filter, transitive: true })

/**
 * The files that lie on a cycle: those in a strongly connected component
 * with more than one file, or that import themselves. Only they can reach
 * themselves, so the cycle rule searches from no other file.
 */
const onCycles = (graph: Graph, filter: EdgeFilter): Set<string> => {
  interface Node {
    readonly file: SourceFile
    successors: ReadonlyArray<Node>
    order: number
    low: number
    stacked: boolean
  }
  const nodes = new Map<SourceFile, Node>(
    graph.files.map((file) => [file, { file, successors: [], order: -1, low: 0, stacked: false }] as const),
  )
  for (const node of nodes.values()) {
    node.successors = node.file.dependencies.flatMap((dependency): Array<Node> => {
      if (!admits(filter, dependency) || dependency.target._tag !== "File") return []
      const next = find(graph, dependency.target.path)
      const successor = next === undefined ? undefined : nodes.get(next)
      return successor === undefined ? [] : [successor]
    })
  }
  const cyclic = new Set<string>()
  const stack: Array<Node> = []
  let counter = 0
  const enter = (node: Node): void => {
    node.order = node.low = counter++
    node.stacked = true
    stack.push(node)
  }
  for (const root of nodes.values()) {
    if (root.order !== -1) continue
    enter(root)
    const work: Array<{ readonly node: Node; next: number }> = [{ node: root, next: 0 }]
    for (let frame = work.at(-1); frame !== undefined; frame = work.at(-1)) {
      const successor = frame.node.successors[frame.next]
      if (successor !== undefined) {
        frame.next += 1
        if (successor.order === -1) {
          enter(successor)
          work.push({ node: successor, next: 0 })
        } else if (successor.stacked) {
          frame.node.low = Math.min(frame.node.low, successor.order)
        }
        continue
      }
      work.pop()
      const parent = work.at(-1)
      if (parent !== undefined) parent.node.low = Math.min(parent.node.low, frame.node.low)
      if (frame.node.low !== frame.node.order) continue
      const component: Array<Node> = []
      for (let member = stack.pop(); member !== undefined; member = member === frame.node ? undefined : stack.pop()) {
        member.stacked = false
        component.push(member)
      }
      if (component.length > 1 || frame.node.successors.includes(frame.node)) {
        for (const member of component) cyclic.add(pathKey(member.file.path))
      }
    }
  }
  return cyclic
}

const acyclicFindings = (
  reachTargetFn: ReachTargetFn,
  graph: Graph,
  rule: Rule,
  filter: EdgeFilter,
  depth: number | undefined,
): Array<Finding> => {
  const cycles = cycleGraph(graph, rule, depth)
  const cyclic = onCycles(cycles, cycleFilter(filter))
  return graphPaths(cycles)
    .filter((path) => cyclic.has(pathKey(path)))
    .flatMap((path): Array<Finding> => {
      const edges = reachTargetFn(cycles, cycleFilter(filter), path, fileTarget(path))
      return edges === undefined ? [] : [[path, { _tag: "Cycle", edges }]]
    })
}

const resolvableFindings = (graph: Graph, rule: Rule, allowComputed: boolean): Array<Finding> =>
  subjects(graph, rule.subject).flatMap((file) =>
    file.dependencies
      .filter((dependency) => unresolvable(allowComputed, dependency.target))
      .map((dependency): Finding => [file.path, { _tag: "Dependency", edge: { source: file.path, dependency } }]),
  )

const violatingPredicateValue = (quantifier: Quantifier): boolean =>
  Match.value(quantifier).pipe(
    Match.when("every", () => false),
    Match.when("none", () => true),
    Match.exhaustive,
  )

const violatingAffixValue = (relation: Relation): boolean =>
  Match.value(relation).pipe(
    Match.when("require", () => false),
    Match.when("forbid", () => true),
    Match.exhaustive,
  )

const declaresFindings = (graph: Graph, rule: Rule, quantifier: Quantifier, predicate: DeclarationPredicate): Array<Finding> =>
  subjects(graph, rule.subject).flatMap((file) =>
    file.declarations
      .filter((declaration) => holds(predicate, declaration) === violatingPredicateValue(quantifier))
      .map((declaration): Finding => [
        file.path,
        { _tag: "Declaration", name: declaration.name, location: declaration.location },
      ]),
  )

const exportsOnlyFindings = (graph: Graph, rule: Rule, names: ReadonlyArray<string>): Array<Finding> =>
  subjects(graph, rule.subject).flatMap((file) =>
    file.exports.filter((name) => !names.includes(name)).map((name): Finding => [file.path, { _tag: "Export", name }]),
  )

const usesForbidFindings = (graph: Graph, rule: Rule, spec: UseSpec): Array<Finding> =>
  subjects(graph, rule.subject).flatMap((file) =>
    file.uses.filter((use) => matchesUse(spec, use)).map((use): Finding => [file.path, { _tag: "Use", use }]),
  )

const usesRequireFindings = (graph: Graph, rule: Rule, spec: UseSpec): Array<Finding> =>
  subjects(graph, rule.subject)
    .filter((file) => file.uses.every((use) => !matchesUse(spec, use)))
    .map((file): Finding => [file.path, { _tag: "Missing" }])

const namedFindings = (graph: Graph, rule: Rule, relation: Relation, affix: Affix, value: string): Array<Finding> =>
  subjects(graph, rule.subject)
    .filter((file) => affixHolds(affix, value, basename(file.path)) === violatingAffixValue(relation))
    .map((file): Finding => [file.path, { _tag: "Name", basename: basename(file.path) }])

const maxLinesFindings = (graph: Graph, rule: Rule, max: number): Array<Finding> =>
  subjects(graph, rule.subject)
    .filter((file) => max < file.lines)
    .map((file): Finding => [file.path, { _tag: "Lines", count: file.lines }])

const customFindings = (custom: CustomRules, graph: Graph, rule: Rule, name: string): Array<Finding> =>
  subjects(graph, rule.subject).flatMap((file) =>
    custom(name, graph, file.path).map((message): Finding => [file.path, { _tag: "Custom", message }]),
  )

const findings = (
  reachFn: ReachFn,
  reachTargetFn: ReachTargetFn,
  custom: CustomRules,
  graph: Graph,
  rule: Rule,
): ReadonlyArray<Finding> =>
  Match.valueTags(rule.assertion, {
    Reach: ({ direction, relation, object, edges }) =>
      Match.value({ direction, relation }).pipe(
        Match.when({ direction: "outgoing", relation: "forbid" }, () =>
          outgoingForbid(reachFn, graph, rule, object, edges),
        ),
        Match.when({ direction: "outgoing", relation: "require" }, () =>
          outgoingRequire(reachFn, graph, rule, object, edges),
        ),
        Match.when({ direction: "incoming", relation: "forbid" }, () =>
          incomingForbid(reachFn, graph, rule, object, edges),
        ),
        Match.when({ direction: "incoming", relation: "require" }, () =>
          incomingRequire(reachFn, graph, rule, object, edges),
        ),
        Match.exhaustive,
      ),
    Acyclic: ({ edges, folderDepth }) => acyclicFindings(reachTargetFn, graph, rule, edges, folderDepth),
    Resolvable: ({ allowComputed }) => resolvableFindings(graph, rule, allowComputed),
    Declares: ({ quantifier, predicate }) => declaresFindings(graph, rule, quantifier, predicate),
    ExportsOnly: ({ names }) => exportsOnlyFindings(graph, rule, names),
    Uses: ({ relation, use }) =>
      Match.value(relation).pipe(
        Match.when("forbid", () => usesForbidFindings(graph, rule, use)),
        Match.when("require", () => usesRequireFindings(graph, rule, use)),
        Match.exhaustive,
      ),
    Named: ({ relation, affix, value }) => namedFindings(graph, rule, relation, affix, value),
    MaxLines: ({ max }) => maxLinesFindings(graph, rule, max),
    Custom: ({ name }) => customFindings(custom, graph, rule, name),
  })

const ruleViolations = (
  reachFn: ReachFn,
  reachTargetFn: ReachTargetFn,
  custom: CustomRules,
  graph: Graph,
  rule: Rule,
): Array<Violation> =>
  findings(reachFn, reachTargetFn, custom, graph, rule).map(([subject, evidence]) => ({
    ruleId: rule.id,
    severity: rule.severity,
    subject,
    evidence,
  }))

/** Lean `checkWith`: every rule's violations in policy order, deduplicated by key. */
export const checkWith =
  (
    reachFn: ReachFn,
    reachTargetFn?: ReachTargetFn,
  ): ((custom: CustomRules, policy: Policy, graph: Graph) => Array<Violation>) =>
  (custom: CustomRules, policy: Policy, graph: Graph): Array<Violation> => {
    const memoized = memoize(reachFn)
    const target = reachTargetFn ?? fromReach(memoized)
    return dedupByKey(policy.flatMap((rule) => ruleViolations(memoized, target, custom, graph, rule)))
  }

export const check: (custom: CustomRules, policy: Policy, graph: Graph) => Array<Violation> = checkWith(reach, reachTarget)

export const emptySubjects = (policy: Policy, graph: Graph): Array<string> =>
  policy.filter((rule) => subjects(graph, rule.subject).length === 0).map((rule) => rule.id)

/** Lean `Selector.mentionsGlob`: only positive occurrences, since a typo under `not` matches more, not less. */
const mentionsGlob = (selector: Selector): boolean =>
  Match.valueTags(selector, {
    Glob: (): boolean => true,
    Package: (): boolean => false,
    Builtin: (): boolean => false,
    Unresolved: (): boolean => false,
    Computed: (): boolean => false,
    Any: ({ selectors }): boolean => selectors.some(mentionsGlob),
    All: ({ selectors }): boolean => selectors.some(mentionsGlob),
    Not: (): boolean => false,
  })

/** Lean `emptyObjects`: dependency rules whose object names files by a glob but selects none. */
export const emptyObjects = (policy: Policy, graph: Graph): Array<string> =>
  policy
    .filter((rule) =>
      Match.valueTags(rule.assertion, {
        Reach: ({ object }): boolean =>
          mentionsGlob(object) && graph.files.every((file) => !selects(object, fileTarget(file.path))),
        Acyclic: (): boolean => false,
        Resolvable: (): boolean => false,
        Declares: (): boolean => false,
        ExportsOnly: (): boolean => false,
        Uses: (): boolean => false,
        Named: (): boolean => false,
        MaxLines: (): boolean => false,
        Custom: (): boolean => false,
      }),
    )
    .map((rule) => rule.id)
