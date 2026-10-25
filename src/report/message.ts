import { Match } from "effect"
import type { DependencyKind, FilePath, Target, Use } from "../core/model.ts"
import type { Edge, Violation } from "../core/rule.ts"
import type { RuleInfo } from "./report.ts"

export interface Position {
  readonly path: string
  readonly line: number
  readonly column: number
}

export interface Description {
  readonly message: string
  readonly reason?: string
  readonly location?: Position
}

export const pathText = (path: FilePath): string => path.join("/")

export const targetLabel = (target: Target): string =>
  Match.valueTags(target, {
    File: ({ path }) => pathText(path),
    Package: ({ name, subpath }) => `npm:${[name, ...subpath].join("/")}`,
    Builtin: ({ runtime, name }) => `${runtime}:${name}`,
    Unresolved: ({ specifier }) => `unresolved:${specifier}`,
    Computed: () => "computed:*",
  })

const verbs = (kind: DependencyKind): { readonly active: string; readonly passive: string } =>
  Match.value(kind).pipe(
    Match.when("static", () => ({ active: "imports", passive: "is imported by" })),
    Match.when("type", () => ({ active: "imports the types of", passive: "has its types imported by" })),
    Match.when("require", () => ({ active: "requires", passive: "is required by" })),
    Match.when("dynamic", () => ({ active: "dynamically imports", passive: "is dynamically imported by" })),
    Match.exhaustive,
  )

const specifierText = (specifier: string): string => (specifier === "" ? "" : ` ('${specifier}')`)

export const importText = ({ dependency }: Edge): string =>
  `${verbs(dependency.kind).active} ${targetLabel(dependency.target)}${specifierText(dependency.specifier)}`

const importedByText = ({ source, dependency }: Edge): string =>
  `${verbs(dependency.kind).passive} ${pathText(source)}${specifierText(dependency.specifier)}`

const positionOf = (edge: Edge): Position => ({ path: pathText(edge.source), ...edge.dependency.location })

const locatedAt = (edge: Edge | undefined): { readonly location?: Position } =>
  edge === undefined ? {} : { location: positionOf(edge) }

const chainOf = (edges: ReadonlyArray<Edge>): string => {
  const [first] = edges
  return first === undefined
    ? ""
    : [pathText(first.source), ...edges.map(({ dependency }) => targetLabel(dependency.target))].join(" → ")
}

const useText = (use: Use): string =>
  Match.value(use.kind).pipe(
    Match.when("looseEquality", () => `uses loose equality (${use.name})`),
    Match.when("call", () =>
      Match.valueTags(use.binding, {
        Global: () => `calls ${use.name}`,
        Local: () => `calls ${use.name}`,
        Imported: ({ name }) => `calls ${use.name} (${name.name} from '${name.source}')`,
      }),
    ),
    Match.exhaustive,
  )

const evidenceDescription = ({ subject: subjectPath, evidence }: Violation): Description => {
  const subject = pathText(subjectPath)
  return Match.valueTags(evidence, {
    Walk: ({ target, edges }): Description => {
      const [first] = edges
      const incoming = first !== undefined && pathText(first.source) !== subject
      const chain = chainOf(edges)
      const through = chain === "" ? "" : ` through ${chain}`
      return {
        message: `${incoming ? "is depended on by" : "depends on"} ${targetLabel(target)}${through}`,
        ...locatedAt(first),
      }
    },
    Missing: (): Description => ({ message: "does not satisfy the rule's requirement" }),
    Cycle: ({ edges }): Description => {
      const chain = chainOf(edges)
      return {
        message: chain === "" ? "is part of a dependency cycle" : `is part of a dependency cycle: ${chain}`,
        ...locatedAt(edges[0]),
      }
    },
    Dependency: ({ edge }): Description => ({
      message: pathText(edge.source) === subject ? importText(edge) : importedByText(edge),
      location: positionOf(edge),
    }),
    Declaration: ({ name, location }): Description => ({
      message: `declares ${name}, which the rule does not allow`,
      location: { path: subject, ...location },
    }),
    Export: ({ name }): Description => ({ message: `exports ${name}, which the rule does not allow` }),
    Use: ({ use }): Description => ({ message: useText(use), location: { path: subject, ...use.location } }),
    Name: ({ basename }): Description => ({ message: `has the file name ${basename}, which breaks the naming rule` }),
    Lines: ({ count }): Description => ({ message: `has ${count} lines, more than the rule allows` }),
    Custom: ({ message }): Description => ({ message }),
  })
}

export const describe = (violation: Violation, rules: ReadonlyArray<RuleInfo>): Description => {
  const description = evidenceDescription(violation)
  const reason = rules.find((rule) => rule.id === violation.ruleId)?.reason
  return reason === undefined ? description : { ...description, reason }
}

/** The message with its subject in front when the location is in another file, for output without a file header. */
export const standalone = (violation: Violation, { message, location }: Description): string => {
  const subject = pathText(violation.subject)
  return location === undefined || location.path === subject ? message : `${subject} ${message}`
}
