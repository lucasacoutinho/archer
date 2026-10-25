/** Schemas that mirror lean/Archer/Model.lean. */
import { Schema } from "effect"

export const Segment: Schema.Codec<string> = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((segment) => !segment.includes("/") || "must not contain '/'"),
)

/** A root-relative path as its segments. */
export type FilePath = ReadonlyArray<string>
export const FilePath: Schema.Codec<FilePath> = Schema.Array(Segment)

export type Runtime = "node" | "bun"
export const Runtime: Schema.Codec<Runtime> = Schema.Literals(["node", "bun"])

export type Target =
  | { readonly _tag: "File"; readonly path: FilePath }
  | { readonly _tag: "Package"; readonly name: string; readonly subpath: ReadonlyArray<string> }
  | { readonly _tag: "Builtin"; readonly runtime: Runtime; readonly name: string }
  | { readonly _tag: "Unresolved"; readonly specifier: string }
  | { readonly _tag: "Computed" }

export const Target: Schema.Codec<Target> = Schema.Union([
  Schema.TaggedStruct("File", { path: FilePath }),
  Schema.TaggedStruct("Package", { name: Schema.NonEmptyString, subpath: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Builtin", { runtime: Runtime, name: Schema.NonEmptyString }),
  Schema.TaggedStruct("Unresolved", { specifier: Schema.String }),
  Schema.TaggedStruct("Computed", {}),
])

export type DependencyKind = "static" | "type" | "require" | "dynamic"
export const DependencyKind: Schema.Codec<DependencyKind> = Schema.Literals(["static", "type", "require", "dynamic"])

export interface Location {
  readonly line: number
  readonly column: number
}

export const Location: Schema.Codec<Location> = Schema.Struct({
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  column: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})

export interface Dependency {
  readonly target: Target
  readonly kind: DependencyKind
  readonly specifier: string
  readonly location: Location
}

export const Dependency: Schema.Codec<Dependency> = Schema.Struct({
  target: Target,
  kind: DependencyKind,
  specifier: Schema.String,
  location: Location,
})

export type DeclarationKind = "class" | "interface" | "enum" | "function" | "type" | "variable"
export const DeclarationKind: Schema.Codec<DeclarationKind> = Schema.Literals([
  "class",
  "interface",
  "enum",
  "function",
  "type",
  "variable",
])

export type Visibility = "public" | "protected" | "private"
export const Visibility: Schema.Codec<Visibility> = Schema.Literals(["public", "protected", "private"])

export interface Method {
  readonly name: string
  readonly visibility: Visibility
  readonly isStatic: boolean
}

export const Method: Schema.Codec<Method> = Schema.Struct({
  name: Schema.NonEmptyString,
  visibility: Visibility,
  isStatic: Schema.Boolean,
})

export interface Declaration {
  readonly name: string
  readonly kind: DeclarationKind
  readonly exported: boolean
  readonly abstract: boolean
  readonly extended: ReadonlyArray<string>
  readonly implemented: ReadonlyArray<string>
  readonly decorators: ReadonlyArray<string>
  readonly methods: ReadonlyArray<Method>
  readonly readonlyProperties: boolean
  readonly location: Location
}

export const Declaration: Schema.Codec<Declaration> = Schema.Struct({
  name: Schema.String,
  kind: DeclarationKind,
  exported: Schema.Boolean,
  abstract: Schema.Boolean,
  extended: Schema.Array(Schema.String),
  implemented: Schema.Array(Schema.String),
  decorators: Schema.Array(Schema.String),
  methods: Schema.Array(Method),
  readonlyProperties: Schema.Boolean,
  location: Location,
})

export type UseKind = "call" | "looseEquality"
export const UseKind: Schema.Codec<UseKind> = Schema.Literals(["call", "looseEquality"])

/** The module and export name that an imported call resolves to. */
export interface ImportedName {
  readonly source: string
  readonly name: string
}

export const ImportedName: Schema.Codec<ImportedName> = Schema.Struct({
  source: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
})

export type Binding =
  | { readonly _tag: "Global" }
  | { readonly _tag: "Local" }
  | { readonly _tag: "Imported"; readonly name: ImportedName }

export const Binding: Schema.Codec<Binding> = Schema.Union([
  /** No declaration in the program, such as `eval`. */
  Schema.TaggedStruct("Global", {}),
  Schema.TaggedStruct("Local", {}),
  Schema.TaggedStruct("Imported", { name: ImportedName }),
])

export interface Use {
  readonly kind: UseKind
  readonly name: string
  readonly binding: Binding
  readonly location: Location
}

export const Use: Schema.Codec<Use> = Schema.Struct({
  kind: UseKind,
  name: Schema.String,
  binding: Binding,
  location: Location,
})

export interface SourceFile {
  readonly path: FilePath
  readonly dependencies: ReadonlyArray<Dependency>
  readonly declarations: ReadonlyArray<Declaration>
  readonly exports: ReadonlyArray<string>
  readonly uses: ReadonlyArray<Use>
  readonly lines: number
}

export const SourceFile: Schema.Codec<SourceFile> = Schema.Struct({
  path: FilePath,
  dependencies: Schema.Array(Dependency),
  declarations: Schema.Array(Declaration),
  exports: Schema.Array(Schema.String),
  uses: Schema.Array(Use),
  lines: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

const joinPath = (path: FilePath): string => path.join("/")

/** Decoding establishes the Lean premise `Graph.WellFormed`. */
export interface Graph {
  readonly files: ReadonlyArray<SourceFile>
}

export const Graph: Schema.Codec<Graph> = Schema.Struct({ files: Schema.Array(SourceFile) }).check(
  Schema.makeFilter((graph) => {
    const seen = new Set<string>()
    for (const file of graph.files) {
      const key = joinPath(file.path)
      if (seen.has(key)) {
        return { path: ["files"], issue: `source file '${key}' appears more than once` }
      }
      seen.add(key)
    }
    return undefined
  }),
)

export interface EdgeFilter {
  readonly kinds: ReadonlyArray<DependencyKind>
  readonly localOnly: boolean
  readonly transitive: boolean
}

export const EdgeFilter: Schema.Codec<EdgeFilter> = Schema.Struct({
  kinds: Schema.Array(DependencyKind).check(Schema.isNonEmpty(), Schema.isUnique()),
  localOnly: Schema.Boolean,
  transitive: Schema.Boolean,
})

export const admits = (filter: EdgeFilter, dependency: Dependency): boolean =>
  filter.kinds.includes(dependency.kind) && (!filter.localOnly || dependency.target._tag === "File")

export const graphPaths = (graph: Graph): Array<FilePath> => graph.files.map((file) => file.path)

export type SegmentToken =
  | { readonly _tag: "Literal"; readonly char: string }
  | { readonly _tag: "One" }
  | { readonly _tag: "Star" }

export const SegmentToken: Schema.Codec<SegmentToken> = Schema.Union([
  Schema.TaggedStruct("Literal", { char: Schema.String.check(Schema.isBetweenCodePoints(1, 1)) }),
  /** `?` */
  Schema.TaggedStruct("One", {}),
  /** `*` */
  Schema.TaggedStruct("Star", {}),
])

export type PathToken =
  | { readonly _tag: "Segment"; readonly tokens: ReadonlyArray<SegmentToken> }
  | { readonly _tag: "Globstar" }

export const PathToken: Schema.Codec<PathToken> = Schema.Union([
  Schema.TaggedStruct("Segment", { tokens: Schema.Array(SegmentToken) }),
  /** `**` */
  Schema.TaggedStruct("Globstar", {}),
])

export type Selector =
  | { readonly _tag: "Glob"; readonly tokens: ReadonlyArray<PathToken> }
  /** `npm:<name>`, or `npm:*` without a name. Any subpath. */
  | { readonly _tag: "Package"; readonly name?: string }
  /** `node:fs`, `node:*`, `bun:*`. */
  | { readonly _tag: "Builtin"; readonly runtime: Runtime; readonly name?: string }
  | { readonly _tag: "Unresolved" }
  | { readonly _tag: "Computed" }
  | { readonly _tag: "Any"; readonly selectors: ReadonlyArray<Selector> }
  | { readonly _tag: "All"; readonly selectors: ReadonlyArray<Selector> }
  | { readonly _tag: "Not"; readonly selector: Selector }

export const Selector: Schema.Codec<Selector> = Schema.Union([
  Schema.TaggedStruct("Glob", { tokens: Schema.Array(PathToken) }),
  Schema.TaggedStruct("Package", { name: Schema.optionalKey(Schema.NonEmptyString) }),
  Schema.TaggedStruct("Builtin", { runtime: Runtime, name: Schema.optionalKey(Schema.NonEmptyString) }),
  Schema.TaggedStruct("Unresolved", {}),
  Schema.TaggedStruct("Computed", {}),
  Schema.TaggedStruct("Any", { selectors: Schema.Array(Schema.suspend((): Schema.Codec<Selector> => Selector)) }),
  Schema.TaggedStruct("All", { selectors: Schema.Array(Schema.suspend((): Schema.Codec<Selector> => Selector)) }),
  Schema.TaggedStruct("Not", { selector: Schema.suspend((): Schema.Codec<Selector> => Selector) }),
])
