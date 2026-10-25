import { describe, expect, layer } from "@effect/vitest"
import { Context, Effect, Layer, Match, Schema } from "effect"
import { Analyzer, type AnalysisError, type Workspace } from "../../src/analyzer/Analyzer.ts"
import { Graph, type Dependency, type SourceFile, type Target } from "../../src/core/model.ts"
import { fixtures } from "./fixtures.ts"

class Analyses extends Context.Service<Analyses, { readonly first: Graph; readonly second: Graph }>()("test/Analyses") {}

const analysesOf = (workspace: Workspace): Layer.Layer<Analyses, AnalysisError, Analyzer> =>
  Layer.effect(
    Analyses,
    Effect.gen(function* () {
      const analyzer = yield* Analyzer
      return { first: yield* analyzer.analyze(workspace), second: yield* analyzer.analyze(workspace) }
    }),
  )

const encode = (graph: Graph): string => JSON.stringify(Schema.encodeSync(Graph)(graph))

const show = (target: Target): string =>
  Match.valueTags(target, {
    File: ({ path }) => `File ${path.join("/")}`,
    Package: ({ name, subpath }) => `Package ${[name, ...subpath].join("/")}`,
    Builtin: ({ runtime, name }) => `Builtin ${runtime}:${name}`,
    Unresolved: ({ specifier }) => `Unresolved ${specifier}`,
    Computed: () => "Computed",
  })

const showDependency = ({ kind, specifier, location, target }: Dependency): string =>
  `${kind} ${specifier} @${location.line}:${location.column} -> ${show(target)}`

const fileAt = (graph: Graph, path: string): SourceFile => {
  const found = graph.files.find((file) => file.path.join("/") === path)
  if (found === undefined) {
    throw new Error(`no source file ${path} in ${graph.files.map((file) => file.path.join("/")).join(", ")}`)
  }
  return found
}

const dependenciesOf = (graph: Graph, path: string): ReadonlyArray<string> => fileAt(graph, path).dependencies.map(showDependency)

const usesOf = (graph: Graph, path: string): ReadonlyArray<string> =>
  fileAt(graph, path).uses.map(
    ({ kind, name, binding, location }) =>
      `${kind} ${name} @${location.line}:${location.column} ${Match.valueTags(binding, {
        Global: () => "global",
        Local: () => "local",
        Imported: ({ name: imported }) => `${imported.source}#${imported.name}`,
      })}`,
  )

const declarationOf = (graph: Graph, path: string, name: string) => {
  const found = fileAt(graph, path).declarations.find((declaration) => declaration.name === name)
  if (found === undefined) {
    throw new Error(`no declaration ${name} in ${path}`)
  }
  return found
}

type Check = readonly [name: string, check: (graph: Graph) => void]

const isAscending = <A>(items: ReadonlyArray<A>, compare: (left: A, right: A) => number): boolean =>
  items.every((item, index) => index === 0 || compare(items[index - 1] as A, item) <= 0)

const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const everyFile = (graph: Graph): ReadonlyArray<SourceFile> => graph.files

const structuralChecks: ReadonlyArray<Check> = [
  [
    "orders files by path in UTF-16 code unit order",
    (graph) => {
      const paths = graph.files.map((file) => file.path.join("/"))
      expect(paths.length).toBeGreaterThan(0)
      expect(isAscending(paths, compareStrings)).toBe(true)
    },
  ],
  [
    "orders dependencies by line, column, specifier, kind",
    (graph) => {
      for (const file of everyFile(graph)) {
        const ordered = isAscending(
          file.dependencies,
          (left, right) =>
            left.location.line - right.location.line ||
            left.location.column - right.location.column ||
            compareStrings(left.specifier, right.specifier) ||
            compareStrings(left.kind, right.kind),
        )
        expect(ordered, file.path.join("/")).toBe(true)
      }
    },
  ],
  [
    "gives every import site one dependency",
    (graph) => {
      for (const file of everyFile(graph)) {
        const sites = file.dependencies.map(({ location }) => `${location.line}:${location.column}`)
        expect(new Set(sites).size, file.path.join("/")).toBe(sites.length)
      }
    },
  ],
  [
    "names files by root-relative segments without dot segments or backslashes",
    (graph) => {
      for (const file of everyFile(graph)) {
        for (const segment of file.path) {
          expect(["", ".", ".."]).not.toContain(segment)
          expect(segment.includes("/") || segment.includes("\\")).toBe(false)
        }
      }
    },
  ],
  [
    "keeps declaration files, JSON, and installed packages out of the source files",
    (graph) => {
      for (const file of everyFile(graph)) {
        const name = file.path.join("/")
        expect([".d.ts", ".d.mts", ".d.cts", ".json"].some((suffix) => name.endsWith(suffix))).toBe(false)
        expect(file.path).not.toContain("node_modules")
      }
    },
  ],
  [
    "points every File target at a source file",
    (graph) => {
      const known = new Set(graph.files.map((file) => file.path.join("/")))
      for (const file of everyFile(graph)) {
        for (const dependency of file.dependencies) {
          if (dependency.target._tag === "File") {
            expect(known.has(dependency.target.path.join("/")), show(dependency.target)).toBe(true)
          }
        }
      }
    },
  ],
  [
    "orders uses by position and exports by code unit without repeats",
    (graph) => {
      for (const file of everyFile(graph)) {
        expect(isAscending(file.uses, (left, right) => left.location.line - right.location.line || left.location.column - right.location.column)).toBe(true)
        expect(isAscending(file.exports, compareStrings)).toBe(true)
        expect(new Set(file.exports).size).toBe(file.exports.length)
      }
    },
  ],
  [
    "decodes with the Graph schema",
    (graph) => {
      const roundTrip = Schema.decodeUnknownSync(Graph)(JSON.parse(encode(graph)))
      expect(roundTrip).toEqual(graph)
    },
  ],
]

const concreteChecks: Record<keyof typeof fixtures, ReadonlyArray<Check>> = {
  project: [
    [
      "resolves path aliases and records type, static, and dynamic kinds",
      (graph) => {
        expect(dependenciesOf(graph, "src/application/create-order.ts")).toEqual([
          "type @domain/order @1:28 -> File src/domain/order.ts",
          "static ../infrastructure/order-repository.js @2:27 -> File src/infrastructure/order-repository.ts",
        ])
        expect(dependenciesOf(graph, "src/lazy/literal.ts")).toEqual([
          "dynamic ../infrastructure/order-repository.js @1:50 -> File src/infrastructure/order-repository.ts",
        ])
        expect(dependenciesOf(graph, "src/domain/index.ts").map((line) => line.split(" ")[0])).toEqual(["type", "type"])
      },
    ],
    [
      "classifies built-ins, packages, unresolved imports, and import types",
      (graph) => {
        expect(dependenciesOf(graph, "src/infrastructure/dependencies.ts")).toEqual([
          "static node:fs/promises @1:26 -> Builtin node:fs/promises",
          "type node:test @2:34 -> Builtin node:test",
          "type ../domain/order.js @4:34 -> File src/domain/order.ts",
          "dynamic effect @7:46 -> Package effect",
          "require ./missing.cjs @9:32 -> Unresolved ./missing.cjs",
        ])
        expect(dependenciesOf(graph, "src/infrastructure/bun-runtime.ts")).toEqual(["static bun:test @1:22 -> Builtin bun:test"])
      },
    ],
    [
      "records computed imports and requires as Computed",
      (graph) => {
        expect(dependenciesOf(graph, "src/lazy/computed.ts")).toEqual(["dynamic moduleName @1:64 -> Computed"])
        expect(dependenciesOf(graph, "src/lazy/computed-require.ts")).toEqual(["require moduleName @2:18 -> Computed"])
      },
    ],
    [
      "keeps import cycles in the graph",
      (graph) => {
        expect(dependenciesOf(graph, "src/shared/a.ts")).toEqual(["static ./b.js @1:19 -> File src/shared/b.ts"])
        expect(dependenciesOf(graph, "src/shared/b.ts")).toEqual(["static ./a.js @1:19 -> File src/shared/a.ts"])
        expect(dependenciesOf(graph, "src/folders/a/one.ts")).toEqual(["static ../b/two.js @1:21 -> File src/folders/b/two.ts"])
        expect(dependenciesOf(graph, "src/folders/b/two.ts")).toEqual(["static ../a/one.js @1:21 -> File src/folders/a/one.ts"])
      },
    ],
    [
      "lists the source files of the tsconfig",
      (graph) => {
        expect(graph.files.map((file) => file.path.join("/"))).toEqual([
          "src/application/create-order.ts",
          "src/domain/index.ts",
          "src/domain/order-id.ts",
          "src/domain/order.ts",
          "src/folders/a/one.ts",
          "src/folders/b/two.ts",
          "src/infrastructure/bun-runtime.ts",
          "src/infrastructure/dependencies.ts",
          "src/infrastructure/order-repository.ts",
          "src/lazy/computed-require.ts",
          "src/lazy/computed.ts",
          "src/lazy/literal.ts",
          "src/shared/a.ts",
          "src/shared/b.ts",
        ])
      },
    ],
    [
      "counts lines without counting a trailing newline",
      (graph) => {
        expect(fileAt(graph, "src/domain/order-id.ts").lines).toBe(1)
        expect(fileAt(graph, "src/domain/order.ts").lines).toBe(5)
        expect(fileAt(graph, "src/application/create-order.ts").lines).toBe(6)
      },
    ],
  ],
  semantic: [
    [
      "reads class heritage, decorators, readonly properties, and method visibility",
      (graph) => {
        expect(declarationOf(graph, "src/user-controller.ts", "UserController")).toEqual({
          name: "UserController",
          kind: "class",
          exported: true,
          abstract: false,
          extended: ["BaseController"],
          implemented: ["Runnable"],
          decorators: ["Controller"],
          methods: [
            { name: "run", visibility: "public", isStatic: false },
            { name: "reset", visibility: "protected", isStatic: false },
          ],
          readonlyProperties: true,
          location: { line: 4, column: 1 },
        })
        expect(declarationOf(graph, "src/base.ts", "BaseController").abstract).toBe(true)
        expect(declarationOf(graph, "src/base.ts", "Runnable").kind).toBe("interface")
      },
    ],
    [
      "reads the export surface through re-exports",
      (graph) => {
        expect(fileAt(graph, "src/index.ts").exports).toEqual(["UserController", "internalName"])
        expect(fileAt(graph, "src/user-controller.ts").exports).toEqual(["UserController"])
      },
    ],
    [
      "binds a locally declared eval to Local and finds the loose equality",
      (graph) => {
        expect(usesOf(graph, "src/equality.ts")).toEqual(["call eval @3:1 local", "looseEquality == @6:15 local"])
        expect(fileAt(graph, "src/equality.ts").declarations.map((declaration) => declaration.name)).toEqual(["eval", "looselyEqual"])
      },
    ],
    [
      "traces imported calls through aliases, namespaces, element access, and require bindings",
      (graph) => {
        expect(usesOf(graph, "src/imported-calls.ts")).toEqual([
          "call require @5:37 global",
          "call runEffect @8:3 react#useEffect",
          "call React.useEffect @9:3 react#useEffect",
          "call React.useContext @10:3 react#useContext",
          "call readContext @11:3 react#useContext",
          "call readInjection @12:3 vue#inject",
          "call getContext @13:3 svelte#getContext",
        ])
      },
    ],
    [
      "resolves path-aliased stubs to source files and leaves require() without aliases",
      (graph) => {
        expect(dependenciesOf(graph, "src/imported-calls.ts")).toEqual([
          "static react @1:47 -> File stubs/react.ts",
          "static vue @2:41 -> File stubs/vue.ts",
          "static svelte @3:28 -> File stubs/svelte.ts",
          "require react @5:45 -> Unresolved react",
        ])
      },
    ],
  ],
  imports: [
    [
      "gives import, export, and type-only forms their kinds",
      (graph) => {
        expect(dependenciesOf(graph, "src/forms.ts")).toEqual([
          "type ./types.js @1:24 -> File src/types.ts",
          "type ./types.js @2:38 -> File src/types.ts",
          "static ./types.js @3:37 -> File src/types.ts",
          "static ./types.js @4:44 -> File src/types.ts",
          "static ./side-effect.js @5:8 -> File src/side-effect.ts",
          "static ./types.js @6:21 -> File src/types.ts",
          "static ./empty.js @7:16 -> File src/empty.ts",
          "static ./types.js @9:15 -> File src/types.ts",
          "static ./types.js @10:26 -> File src/types.ts",
          "static ./types.js @11:34 -> File src/types.ts",
          "type ./types.js @12:37 -> File src/types.ts",
          "type ./types.js @13:37 -> File src/types.ts",
          "type ./types.js @14:20 -> File src/types.ts",
          "type ./types.js @15:58 -> File src/types.ts",
        ])
      },
    ],
    [
      "records import() calls, import() types, and computed imports",
      (graph) => {
        expect(dependenciesOf(graph, "src/lazy.ts")).toEqual([
          "dynamic ./types.js @1:37 -> File src/types.ts",
          "dynamic ./types.js @2:38 -> File src/types.ts",
          "dynamic name @3:50 -> Computed",
          "dynamic `./${name}.js` @4:54 -> Computed",
          "type ./types.js @5:28 -> File src/types.ts",
          "type ./types.js @6:36 -> File src/types.ts",
        ])
      },
    ],
    [
      "records require forms in TypeScript files",
      (graph) => {
        expect(dependenciesOf(graph, "src/legacy.cts")).toEqual([
          "require node:fs @1:21 -> Builtin node:fs",
          "type ./types.js @2:29 -> File src/types.ts",
          "require ./helper.cjs @3:24 -> File src/helper.cts",
          "require ./helper.cjs @5:24 -> File src/helper.cts",
          "require ./types.js @6:25 -> File src/types.ts",
          "require effect @7:23 -> Package effect",
          "require ./missing.cjs @8:25 -> Unresolved ./missing.cjs",
          "require name @9:44 -> Computed",
        ])
      },
    ],
    [
      "classifies built-ins with and without the node: prefix",
      (graph) => {
        expect(dependenciesOf(graph, "src/builtins.ts")).toEqual([
          "static fs @1:16 -> Builtin node:fs",
          "static node:fs/promises @2:26 -> Builtin node:fs/promises",
          "static path/posix @3:18 -> Builtin node:path/posix",
          "static node:test @4:22 -> Builtin node:test",
          "static bun:sqlite @5:26 -> Builtin bun:sqlite",
          "static timers/promises @6:20 -> Builtin node:timers/promises",
          "static test @7:29 -> Unresolved test",
        ])
      },
    ],
    [
      "names packages scope-aware with the subpath as written",
      (graph) => {
        expect(dependenciesOf(graph, "src/packages.ts")).toEqual([
          "static effect @1:24 -> Package effect",
          "static effect/Schema @2:24 -> Package effect/Schema",
          "static @effect/platform-node @3:30 -> Package @effect/platform-node",
          "static @effect/vitest @4:20 -> Package @effect/vitest",
        ])
        expect(fileAt(graph, "src/packages.ts").dependencies.map(({ target }) => target)).toContainEqual({
          _tag: "Package",
          name: "effect",
          subpath: ["Schema"],
        })
      },
    ],
    [
      "leaves missing files, JSON, declaration files, and excluded files Unresolved",
      (graph) => {
        expect(dependenciesOf(graph, "src/unresolved.ts")).toEqual([
          "static ./missing.js @1:8 -> Unresolved ./missing.js",
          "static not-installed-anywhere @2:8 -> Unresolved not-installed-anywhere",
          "static ./data.json @3:18 -> Unresolved ./data.json",
          "type ./ghost.js @4:28 -> Unresolved ./ghost.js",
          "static ./excluded.js @5:8 -> Unresolved ./excluded.js",
        ])
        expect(graph.files.map((file) => file.path.join("/"))).not.toContain("src/excluded.ts")
      },
    ],
    [
      "exports through export * without the default export",
      (graph) => {
        expect(fileAt(graph, "src/forms.ts").exports).toEqual([
          "A",
          "B",
          "ExportedA",
          "ExportedB",
          "OnlyTypeA",
          "OnlyTypeB",
          "renamed",
          "typesNs",
          "value",
        ])
        expect(fileAt(graph, "src/types.ts").exports).toEqual(["A", "B", "default", "value"])
      },
    ],
  ],
  facts: [
    [
      "reads every declaration kind with names, flags, and locations",
      (graph) => {
        const declarations = fileAt(graph, "src/declarations.ts").declarations
        expect(declarations.map(({ kind, name, exported }) => `${kind} ${name} ${exported}`)).toEqual([
          "enum Color true",
          "type Pair true",
          "variable first true",
          "variable second true",
          "variable answer true",
          "variable other true",
          "variable hidden true",
          "class Repository true",
          "class Service true",
          "class Frozen true",
          "class Local true",
          "interface Reader true",
          "function overload true",
          "function Injectable false",
          "class Decorated true",
          "class Named true",
        ])
        expect(declarations.find(({ name }) => name === "Color")?.location).toEqual({ line: 4, column: 1 })
        expect(fileAt(graph, "src/anonymous.ts").declarations.map(({ name, kind }) => `${kind} ${name}`)).toEqual(["function default"])
        expect(fileAt(graph, "src/anonymous.ts").exports).toEqual(["default"])
      },
    ],
    [
      "reads heritage as written, abstract, decorators, and method visibility",
      (graph) => {
        const repository = declarationOf(graph, "src/declarations.ts", "Repository")
        expect(repository.abstract).toBe(true)
        expect(repository.extended).toEqual(["Base"])
        expect(repository.implemented).toEqual(["Contract", "lib.Other"])
        expect(repository.methods).toEqual([
          { name: "create", visibility: "public", isStatic: true },
          { name: "run", visibility: "public", isStatic: false },
          { name: "other", visibility: "public", isStatic: false },
          { name: "load", visibility: "protected", isStatic: false },
          { name: "#cache", visibility: "private", isStatic: false },
          { name: "secret", visibility: "private", isStatic: false },
          { name: "overloaded", visibility: "public", isStatic: false },
        ])
        expect(declarationOf(graph, "src/declarations.ts", "Decorated").decorators).toEqual(["Injectable", "lib.Tagged"])
        expect(declarationOf(graph, "src/declarations.ts", "Reader").extended).toEqual(["Contract"])
      },
    ],
    [
      "counts readonly properties including constructor parameter properties",
      (graph) => {
        const readonlyOf = (name: string) => declarationOf(graph, "src/declarations.ts", name).readonlyProperties
        expect(readonlyOf("Frozen")).toBe(true)
        expect(readonlyOf("Reader")).toBe(true)
        expect(readonlyOf("Service")).toBe(false)
        expect(readonlyOf("Repository")).toBe(false)
        expect(readonlyOf("Color")).toBe(false)
      },
    ],
    [
      "marks names exported by export lists and default exports",
      (graph) => {
        expect(declarationOf(graph, "src/declarations.ts", "hidden").exported).toBe(true)
        expect(declarationOf(graph, "src/declarations.ts", "Local").exported).toBe(true)
        expect(fileAt(graph, "src/declarations.ts").exports).toEqual([
          "Color",
          "Decorated",
          "Frozen",
          "Local",
          "Pair",
          "Reader",
          "Repository",
          "Service",
          "answer",
          "default",
          "first",
          "other",
          "overload",
          "second",
          "visible",
        ])
      },
    ],
    [
      "binds calls to imports, locals, and globals",
      (graph) => {
        expect(usesOf(graph, "src/uses.ts")).toEqual([
          "call fs.readFileSync @6:3 node:fs#readFileSync",
          "call read @7:3 node:fs#readFileSync",
          "call path.join @8:3 node:path#join",
          "call eval @9:3 global",
          "call setTimeout @10:3 global",
          "call local @13:3 local",
          "call read @14:46 local",
          "call shadow @15:3 local",
          "looseEquality == @16:9 local",
          "looseEquality != @16:19 local",
        ])
        expect(usesOf(graph, "src/declarations.ts")).toEqual([
          "call Injectable @68:2 local",
          "call lib.Tagged @69:2 ./base.js#Tagged",
        ])
      },
    ],
  ],
  workspace: [
    [
      "resolves a path alias across projects of the workspace",
      (graph) => {
        expect(graph.files.map((file) => file.path.join("/"))).toEqual(["packages/app/src/entry.ts", "packages/core/src/index.ts"])
        expect(dependenciesOf(graph, "packages/app/src/entry.ts")).toEqual(["static @fixture/core @1:23 -> File packages/core/src/index.ts"])
      },
    ],
  ],
}

/**
 * The checks that every Analyzer adapter must pass. `adapter` builds the
 * layer under test for one fixture workspace.
 */
export const analyzerContract = (
  name: string,
  adapter: (workspace: Workspace) => Layer.Layer<Analyzer, AnalysisError>,
): void => {
  describe(`${name} analyzer contract`, () => {
    for (const [fixture, workspace] of Object.entries(fixtures) as ReadonlyArray<[keyof typeof fixtures, Workspace]>) {
      layer(analysesOf(workspace).pipe(Layer.provideMerge(adapter(workspace))))(fixture, (it) => {
        for (const [checkName, check] of [...structuralChecks, ...concreteChecks[fixture]]) {
          it.effect(checkName, () =>
            Effect.gen(function* () {
              check((yield* Analyses).first)
            }),
          )
        }

        it.effect("encodes two runs to the same bytes", () =>
          Effect.gen(function* () {
            const { first, second } = yield* Analyses
            expect(encode(second)).toBe(encode(first))
          }),
        )

        it.effect("answers again after the first request", () =>
          Effect.gen(function* () {
            const analyzer = yield* Analyzer
            const { first } = yield* Analyses
            expect(encode(yield* analyzer.analyze(workspace))).toBe(encode(first))
          }),
        )
      })
    }
  })
}
