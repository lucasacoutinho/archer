/** Schemas and semantics of lean/Archer/Rule.lean. */
import { Match, Schema } from "effect"
import {
  type Declaration,
  DeclarationKind,
  Dependency,
  EdgeFilter,
  FilePath,
  type Graph,
  Location,
  Selector,
  Target,
  Use,
  Visibility,
} from "./model.ts"
import { dedupStructural, structuralEquals } from "./structural.ts"

export type Severity = "error" | "warning" | "info"
export const Severity: Schema.Codec<Severity> = Schema.Literals(["error", "warning", "info"])

export type Direction = "outgoing" | "incoming"
export const Direction: Schema.Codec<Direction> = Schema.Literals(["outgoing", "incoming"])

export type Relation = "forbid" | "require"
export const Relation: Schema.Codec<Relation> = Schema.Literals(["forbid", "require"])

export type Quantifier = "every" | "none"
export const Quantifier: Schema.Codec<Quantifier> = Schema.Literals(["every", "none"])

export type DeclarationPredicate =
  | { readonly _tag: "Kind"; readonly kinds: ReadonlyArray<DeclarationKind> }
  | { readonly _tag: "Abstract" }
  | { readonly _tag: "Exported" }
  | { readonly _tag: "ReadonlyProperties" }
  | { readonly _tag: "Extends"; readonly name: string }
  | { readonly _tag: "Implements"; readonly name: string }
  | { readonly _tag: "Decorator"; readonly name: string }
  /** Declares every named method, with the visibility when one is given. */
  | { readonly _tag: "HasMethods"; readonly names: ReadonlyArray<string>; readonly visibility?: Visibility }
  | { readonly _tag: "OnlyPublicMethods" }
  | { readonly _tag: "All"; readonly predicates: ReadonlyArray<DeclarationPredicate> }

export const DeclarationPredicate: Schema.Codec<DeclarationPredicate> = Schema.Union([
  Schema.TaggedStruct("Kind", { kinds: Schema.Array(DeclarationKind) }),
  Schema.TaggedStruct("Abstract", {}),
  Schema.TaggedStruct("Exported", {}),
  Schema.TaggedStruct("ReadonlyProperties", {}),
  Schema.TaggedStruct("Extends", { name: Schema.String }),
  Schema.TaggedStruct("Implements", { name: Schema.String }),
  Schema.TaggedStruct("Decorator", { name: Schema.String }),
  Schema.TaggedStruct("HasMethods", { names: Schema.Array(Schema.String), visibility: Schema.optionalKey(Visibility) }),
  Schema.TaggedStruct("OnlyPublicMethods", {}),
  Schema.TaggedStruct("All", {
    predicates: Schema.Array(Schema.suspend((): Schema.Codec<DeclarationPredicate> => DeclarationPredicate)),
  }),
])

export const holds = (predicate: DeclarationPredicate, declaration: Declaration): boolean =>
  Match.valueTags(predicate, {
    Kind: ({ kinds }) => kinds.includes(declaration.kind),
    Abstract: () => declaration.abstract,
    Exported: () => declaration.exported,
    ReadonlyProperties: () => declaration.readonlyProperties,
    Extends: ({ name }) => declaration.extended.includes(name),
    Implements: ({ name }) => declaration.implemented.includes(name),
    Decorator: ({ name }) => declaration.decorators.includes(name),
    HasMethods: ({ names, visibility }) =>
      names.every((name) =>
        declaration.methods.some(
          (method) => method.name === name && (visibility === undefined || method.visibility === visibility),
        ),
      ),
    OnlyPublicMethods: () => declaration.methods.every((method) => method.visibility === "public"),
    All: ({ predicates }) => predicates.every((inner) => holds(inner, declaration)),
  })

export type UseSpec =
  | { readonly _tag: "LooseEquality" }
  | { readonly _tag: "Globals"; readonly names: ReadonlyArray<string> }
  | { readonly _tag: "Imported"; readonly source: string; readonly names: ReadonlyArray<string> }

export const UseSpec: Schema.Codec<UseSpec> = Schema.Union([
  Schema.TaggedStruct("LooseEquality", {}),
  /** Calls of these names that resolve to no declaration. */
  Schema.TaggedStruct("Globals", { names: Schema.Array(Schema.String) }),
  /** Calls that resolve to these exports of `source`. */
  Schema.TaggedStruct("Imported", { source: Schema.String, names: Schema.Array(Schema.String) }),
])

export const matchesUse = (spec: UseSpec, use: Use): boolean =>
  Match.valueTags(spec, {
    LooseEquality: () => use.kind === "looseEquality",
    Globals: ({ names }) => use.kind === "call" && use.binding._tag === "Global" && names.includes(use.name),
    Imported: ({ source, names }) =>
      use.kind === "call" &&
      Match.valueTags(use.binding, {
        Global: () => false,
        Local: () => false,
        Imported: ({ name }) => name.source === source && names.includes(name.name),
      }),
  })

export type Affix = "prefix" | "suffix"
export const Affix: Schema.Codec<Affix> = Schema.Literals(["prefix", "suffix"])

/** Compares code points, as Lean's `String.toList`. */
export const affixHolds = (affix: Affix, value: string, name: string): boolean => {
  const needle = Array.from(value)
  const hay = Array.from(name)
  return Match.value(affix).pipe(
    Match.when("prefix", () => needle.every((char, index) => hay[index] === char)),
    Match.when("suffix", () => {
      const offset = hay.length - needle.length
      return offset >= 0 && needle.every((char, index) => hay[offset + index] === char)
    }),
    Match.exhaustive,
  )
}

/** `S` is `Selector` in a checked policy and `ConfigSelector` in a configuration. */
export type Assertion<S> =
  | {
      readonly _tag: "Reach"
      readonly direction: Direction
      readonly relation: Relation
      readonly object: S
      readonly edges: EdgeFilter
    }
  /** With `folderDepth`, files collapse to their folder prefix before cycles are detected. */
  | { readonly _tag: "Acyclic"; readonly edges: EdgeFilter; readonly folderDepth?: number }
  | { readonly _tag: "Resolvable"; readonly allowComputed: boolean }
  | { readonly _tag: "Declares"; readonly quantifier: Quantifier; readonly predicate: DeclarationPredicate }
  | { readonly _tag: "ExportsOnly"; readonly names: ReadonlyArray<string> }
  | { readonly _tag: "Uses"; readonly relation: Relation; readonly use: UseSpec }
  | { readonly _tag: "Named"; readonly relation: Relation; readonly affix: Affix; readonly value: string }
  | { readonly _tag: "MaxLines"; readonly max: number }
  /** A closure from the configuration, named here so the rule stays data. */
  | { readonly _tag: "Custom"; readonly name: string }

export const assertionOf = <S>(selector: Schema.Codec<S>): Schema.Codec<Assertion<S>> =>
  Schema.Union([
    Schema.TaggedStruct("Reach", { direction: Direction, relation: Relation, object: selector, edges: EdgeFilter }),
    Schema.TaggedStruct("Acyclic", {
      edges: EdgeFilter,
      folderDepth: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
    Schema.TaggedStruct("Resolvable", { allowComputed: Schema.Boolean }),
    Schema.TaggedStruct("Declares", { quantifier: Quantifier, predicate: DeclarationPredicate }),
    Schema.TaggedStruct("ExportsOnly", { names: Schema.Array(Schema.String) }),
    Schema.TaggedStruct("Uses", { relation: Relation, use: UseSpec }),
    Schema.TaggedStruct("Named", { relation: Relation, affix: Affix, value: Schema.String }),
    Schema.TaggedStruct("MaxLines", { max: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
    Schema.TaggedStruct("Custom", { name: Schema.String }),
  ])

export interface RuleOf<S> {
  readonly id: string
  readonly severity: Severity
  readonly subject: S
  readonly assertion: Assertion<S>
}

export const ruleOf = <S>(selector: Schema.Codec<S>): Schema.Codec<RuleOf<S>> =>
  Schema.Struct({ id: Schema.String, severity: Severity, subject: selector, assertion: assertionOf(selector) })

export type Rule = RuleOf<Selector>
export const Rule: Schema.Codec<Rule> = ruleOf(Selector)

export type Policy = ReadonlyArray<Rule>

export interface Edge {
  readonly source: FilePath
  readonly dependency: Dependency
}

export const Edge: Schema.Codec<Edge> = Schema.Struct({ source: FilePath, dependency: Dependency })

export type Evidence =
  | { readonly _tag: "Walk"; readonly target: Target; readonly edges: ReadonlyArray<Edge> }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Cycle"; readonly edges: ReadonlyArray<Edge> }
  | { readonly _tag: "Dependency"; readonly edge: Edge }
  | { readonly _tag: "Declaration"; readonly name: string; readonly location: Location }
  | { readonly _tag: "Export"; readonly name: string }
  | { readonly _tag: "Use"; readonly use: Use }
  | { readonly _tag: "Name"; readonly basename: string }
  | { readonly _tag: "Lines"; readonly count: number }
  | { readonly _tag: "Custom"; readonly message: string }

export const Evidence: Schema.Codec<Evidence> = Schema.Union([
  /** A forbidden target and the shortest considered walk to it. */
  Schema.TaggedStruct("Walk", { target: Target, edges: Schema.Array(Edge) }),
  /** A `require` assertion found nothing. */
  Schema.TaggedStruct("Missing", {}),
  /** The shortest cycle through the subject. */
  Schema.TaggedStruct("Cycle", { edges: Schema.Array(Edge) }),
  Schema.TaggedStruct("Dependency", { edge: Edge }),
  Schema.TaggedStruct("Declaration", { name: Schema.String, location: Location }),
  Schema.TaggedStruct("Export", { name: Schema.String }),
  Schema.TaggedStruct("Use", { use: Use }),
  Schema.TaggedStruct("Name", { basename: Schema.String }),
  Schema.TaggedStruct("Lines", { count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.TaggedStruct("Custom", { message: Schema.String }),
])

/** What identifies a violation within one rule and subject: walks and cycles without their edges. */
export type EvidenceKey =
  | { readonly _tag: "Target"; readonly target: Target }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Cycle" }
  | { readonly _tag: "Dependency"; readonly edge: Edge }
  | { readonly _tag: "Declaration"; readonly name: string; readonly location: Location }
  | { readonly _tag: "Export"; readonly name: string }
  | { readonly _tag: "Use"; readonly use: Use }
  | { readonly _tag: "Name" }
  | { readonly _tag: "Lines" }
  | { readonly _tag: "Custom"; readonly message: string }

export const EvidenceKey: Schema.Codec<EvidenceKey> = Schema.Union([
  Schema.TaggedStruct("Target", { target: Target }),
  Schema.TaggedStruct("Missing", {}),
  Schema.TaggedStruct("Cycle", {}),
  Schema.TaggedStruct("Dependency", { edge: Edge }),
  Schema.TaggedStruct("Declaration", { name: Schema.String, location: Location }),
  Schema.TaggedStruct("Export", { name: Schema.String }),
  Schema.TaggedStruct("Use", { use: Use }),
  Schema.TaggedStruct("Name", {}),
  Schema.TaggedStruct("Lines", {}),
  Schema.TaggedStruct("Custom", { message: Schema.String }),
])

export const evidenceKey = (evidence: Evidence): EvidenceKey =>
  Match.valueTags(evidence, {
    Walk: ({ target }): EvidenceKey => ({ _tag: "Target", target }),
    Missing: (): EvidenceKey => ({ _tag: "Missing" }),
    Cycle: (): EvidenceKey => ({ _tag: "Cycle" }),
    Dependency: ({ edge }): EvidenceKey => ({ _tag: "Dependency", edge }),
    Declaration: ({ name, location }): EvidenceKey => ({ _tag: "Declaration", name, location }),
    Export: ({ name }): EvidenceKey => ({ _tag: "Export", name }),
    Use: ({ use }): EvidenceKey => ({ _tag: "Use", use }),
    Name: (): EvidenceKey => ({ _tag: "Name" }),
    Lines: (): EvidenceKey => ({ _tag: "Lines" }),
    Custom: ({ message }): EvidenceKey => ({ _tag: "Custom", message }),
  })

export interface Violation {
  readonly ruleId: string
  readonly severity: Severity
  /** A source file, or a folder for a collapsed cycle rule. */
  readonly subject: FilePath
  readonly evidence: Evidence
}

export const Violation: Schema.Codec<Violation> = Schema.Struct({
  ruleId: Schema.String,
  severity: Severity,
  /** A source file, or a folder for a collapsed cycle rule. */
  subject: FilePath,
  evidence: Evidence,
})

export const violationKey = (violation: Violation): readonly [string, FilePath, EvidenceKey] => [
  violation.ruleId,
  violation.subject,
  evidenceKey(violation.evidence),
]

export type CustomRules = (name: string, graph: Graph, subject: FilePath) => ReadonlyArray<string>

export const basename = (path: FilePath): string => path.at(-1) ?? ""

/** Lean `Graph.restrict`: the given files, and only the dependencies between them. */
export const restrict = (graph: Graph, keep: (path: FilePath) => boolean): Graph => ({
  files: graph.files
    .filter((file) => keep(file.path))
    .map((file) => ({
      ...file,
      dependencies: file.dependencies.filter(({ target }) => target._tag === "File" && keep(target.path)),
    })),
})

/** Lean `folderOf`: the first `depth` segments of the file's directory. */
export const folderOf = (depth: number, path: FilePath): FilePath => path.slice(0, -1).slice(0, depth)

/** Lean `Graph.collapse`: one node per folder, an edge per dependency that crosses folders. */
export const collapse = (graph: Graph, depth: number): Graph => ({
  files: dedupStructural(graph.files.map((file) => folderOf(depth, file.path))).map((folder) => ({
    path: folder,
    dependencies: graph.files
      .filter((file) => structuralEquals(folderOf(depth, file.path), folder))
      .flatMap((file) =>
        file.dependencies.flatMap((dependency) =>
          Match.value(dependency.target).pipe(
            Match.tag("File", ({ path }) => {
              const targetFolder = folderOf(depth, path)
              return structuralEquals(targetFolder, folder)
                ? []
                : [{ ...dependency, target: { _tag: "File" as const, path: targetFolder } }]
            }),
            Match.orElse(() => []),
          ),
        ),
      ),
    declarations: [],
    exports: [],
    uses: [],
    lines: 0,
  })),
})

export const assertionSelectors = <S>(assertion: Assertion<S>): Array<S> =>
  Match.value(assertion).pipe(
    Match.tag("Reach", ({ object }) => [object]),
    Match.orElse(() => []),
  )

export const mapAssertion = <S, T>(assertion: Assertion<S>, f: (selector: S) => T): Assertion<T> =>
  Match.value(assertion).pipe(
    Match.tag("Reach", (reach): Assertion<T> => ({ ...reach, object: f(reach.object) })),
    Match.orElse((other): Assertion<T> => other),
  )
