# D-ports: Archer as a hexagon with deliberately placed seams

Core idea: the pure check is the hexagon's centre. Everything Archer does around it is
either a **driven port** (Archer calls out: Analyzer, ConfigLoader, plus the platform's
FileSystem) or a **driving adapter** over one application port (`Archer`). Test runners
are driving adapters, not a port: Archer imports nothing from vitest, jest, bun or
node:test. A seam appears only where two adapters exist today.

Terms follow GLOSSARY.md. Effect names are v4 (4.0.6).

## 1. Interface

### 1.1 Data (pure, schema-described, exported from `.`)

```ts
export type RelPath = string & Brand<"RelPath">   // root-relative, "/" separators, no "./", no ".."
export type DependencyKind = "static" | "type" | "require" | "dynamic"

export const Target = Schema.Union([                         // exactly the glossary's five targets
  Schema.TaggedStruct("File",       { path: RelPath }),
  Schema.TaggedStruct("Package",    { name: Schema.String.check(Schema.isNonEmpty()) }), // npm:<name>
  Schema.TaggedStruct("Builtin",    { scheme: Schema.Literals(["node", "bun"]), name: Schema.String }),
  Schema.TaggedStruct("Unresolved", { specifier: Schema.String, reason: Schema.Literals(["not-found", "outside-source-set"]) }),
  Schema.TaggedStruct("Computed",   {}),                    // import(x) with no static specifier
])
export const Dependency = Schema.Struct({ from: RelPath, target: Target, specifier: Schema.String,
  kind: DependencyKind, line: PositiveInt, column: PositiveInt })     // 1-based
export const FileFacts = Schema.Struct({ path: RelPath, project: RelPath, lines: NonNegInt,
  dependencies: Schema.Array(Dependency), declarations: Schema.Array(Declaration),
  exports: Schema.Array(Schema.String), uses: Schema.Array(Use) })
export const Graph = Schema.Struct({ files: Schema.Array(FileFacts) })   // + smart constructor below
export const Graph.make: (files: ReadonlyArray<FileFacts>) => Result<Graph, GraphInvariantError>  // canonicalizes + validates
export const Graph.fromLiteral: (spec: Record<string, { imports?: ReadonlyArray<string | [kind, string]>; facts?: Partial<...> }>) => Graph  // test DSL

export const Workspace = Schema.Struct({ root: AbsPath, projects: Schema.NonEmptyArray(RelPath) }) // tsconfigs
export type Config = { workspace: Workspace-ish; policy: Policy; baseline?: RelPath; failOnWarnings?: boolean }
export const Policy: { make(rules: ReadonlyArray<Rule>): Policy; layers(...): Layers }  // Rule = tagged union, others design it
export const check: (policy: Policy, graph: Graph) => ReadonlyArray<Violation>           // PURE, Lean-specified
export const fingerprint: (v: Violation) => Fingerprint     // canonical string "ruleId|subject|target", NOT a hash
export const defineConfig: (c: ConfigInput) => Config       // identity + decode at the boundary
```

`Violation = { ruleId, severity, subject: Target|RelPath, location?, witness?: ReadonlyArray<RelPath>, message }`.
`Report = { violations, suppressed: number, stale: ReadonlyArray<Fingerprint>, counts: {error,warning,info}, stats: {files,dependencies}, verdict: Pass | Fail }`.
Custom rules (`Rule.custom({ id, run: (graph) => ReadonlyArray<Violation> })`) are the only closures. They run in
the shell under `Effect.try`; a throw becomes an error violation `archer:custom-rule-crashed` (total, no new error channel).

### 1.2 Driven port: Analyzer

```ts
export class Analyzer extends Context.Service<Analyzer, {
  readonly analyze: (workspace: Workspace) => Effect.Effect<Graph, AnalysisError>
}>()("archer/Analyzer") {}

export class ProjectParseFailed extends Schema.TaggedError<ProjectParseFailed>()("ProjectParseFailed",
  { tsconfig: RelPath, diagnostics: Schema.Array(Schema.String) }) {}
export class AnalyzerUnavailable extends Schema.TaggedError<AnalyzerUnavailable>()("AnalyzerUnavailable",
  { cause: Schema.Defect() }) {}       // Go server did not spawn / protocol broke / crashed mid-run
export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()("ProjectNotFound", { tsconfig: RelPath }) {}
export type AnalysisError = ProjectParseFailed | AnalyzerUnavailable | ProjectNotFound
```

**Analyzer contract (every adapter; enforced by one shared suite, see 3):**
1. Total or failing: a Graph is whole or an `AnalysisError`. No partial graphs. Unresolved specifiers are data (`Unresolved`), never errors.
2. Determinism: same workspace content gives a byte-identical encoded Graph. `files` sorted by `path` in UTF-16 code-unit order (not locale). Each file's `dependencies` sorted by `(line, column, specifier, kind)`.
3. Paths: every `RelPath` is root-relative, `/`-separated, free of `./`, `//` and `..`, and symlinks are realpath'd before relativizing. `project` is the first project, in `workspace.projects` order, that contains the file; a file appears once.
4. Source set = union of tsconfig file lists, minus `.d.ts` files. Closure: every `File` target is a member of `files`. A resolved workspace file outside the source set (JSON, generated `.d.ts`) becomes `Unresolved{reason:"outside-source-set"}`; a file under `node_modules` becomes `Package{name}` (scope-aware, pnpm layout aware).
5. Edge completeness: exactly one `Dependency` per import site. Sites: `import`/`import type`/side-effect import, `export ... from`, `export type ... from`, `import x = require()`, `require()` call, literal `import()`, `import("x")` type nodes, computed `import(expr)` (kind `dynamic`, target `Computed`). Kind: `type` iff the declaration is `import type`/`export type`, every named specifier is inline-`type`, or it is an `import()` type node; `require` for CommonJS forms; `dynamic` for `import()` expressions; else `static`. Triple-slash references are not edges.
6. Builtins: `node:fs` and bare `fs` both give `Builtin{node,"fs"}` (adapter owns the builtin list); `bun:*` likewise.
7. Facts: `lines` counts `\n`-separated lines, trailing newline adds none. Graph holds no source text (reporters fetch snippets).
8. Scope: an adapter may hold resources (Go process) but acquires them lazily on first `analyze` and releases them with the layer scope. `analyze` is re-entrant and idempotent (watch calls it repeatedly).

### 1.3 Driven port: ConfigLoader

```ts
export type ConfigRef = { _tag: "Discover"; cwd: AbsPath } | { _tag: "Path"; path: AbsPath }
export class ConfigLoader extends Context.Service<ConfigLoader, {
  readonly load: (ref: ConfigRef) => Effect.Effect<Config, ConfigError>
}>()("archer/ConfigLoader") {}
export type ConfigError = ConfigNotFound{searched} | ConfigLoadFailed{path,cause} | ConfigInvalid{path,issues:string[]}
```
Contract: returns a decoded Config (Schema decode with `errors:"all"`), custom rules rehydrated as functions. `Discover` tries `archer.config.ts` then `.mts/.js/.mjs`; first hit wins.

### 1.4 Application port (the hexagon's face): Archer

```ts
export type BaselineMode = "apply" | "ignore" | "record" | "prune"   // default "apply"
export interface CheckOptions { baseline?: BaselineMode; failOnWarnings?: boolean }

export class Archer extends Context.Service<Archer, {
  readonly check: (ref: ConfigRef, o?: CheckOptions) => Effect.Effect<Report, CheckError>
  readonly watch: (ref: ConfigRef, o?: CheckOptions) => Stream.Stream<Report, CheckError>
  readonly graph: (ref: ConfigRef) => Effect.Effect<Graph, ConfigError | AnalysisError>   // for `archer graph`
}>()("archer/Archer") {
  static readonly layer: Layer.Layer<Archer, never, Analyzer | ConfigLoader | FileSystem.FileSystem | Path.Path>
}
export type CheckError = ConfigError | AnalysisError | BaselineCorrupt{path,issues} | BaselineWriteFailed{path,cause}
```

Ordering of `check`: load config, analyze, pure `check`, custom rules, sort violations by
`(file, line, column, ruleId, fingerprint)`, fingerprint, baseline step, verdict. Baseline is read only
for `apply`/`prune`, written only for `record`/`prune`, and only after analysis succeeded (a failed
analysis never touches the baseline). Writes are atomic (temp file + rename) and sorted, so the file is diff-stable.
`record` = all current error/warning fingerprints. `prune` = baseline intersect current (never adds).
`apply` suppresses matches and reports `stale`. No timestamps, so no Clock port.
`watch`: `FileSystem.watch(root, {recursive:true})`, drop paths outside the source set and
`node_modules`/`.git`/outDirs, `Stream.debounce(200ms)`, re-run `check`; emits one Report immediately. Analyzer stays alive across emissions.

### 1.5 Reporting (not a port)
```ts
export type Format = "pretty" | "agent" | "json" | "sarif" | "github" | "dot"   // Schema.Literals
export const render: (f: Format, r: Report) => Effect.Effect<string, never, FileSystem.FileSystem>
```
All formats are pure `Report -> string` except `pretty`, which reads snippet lines from FileSystem and
degrades to no snippet when a read fails (hence `never`).

### 1.6 Non-Effect facade (`./testing`, structural, no runner imports)
```ts
export const checkArchitecture: (o?: { cwd?: string; config?: string | Config; baseline?: BaselineMode }) => Promise<Report>
export const expectArchitecture: (o?: same) => Promise<void>   // rejects ArchitectureViolationError (message = agent format)
export const archerMatchers: { toSatisfyPolicy(received: Graph | undefined, policy: Policy): { pass: boolean; message(): string } }
export const dispose: () => Promise<void>
```
One lazily created `ManagedRuntime.make(ArcherLive)` per process; `config: Config` swaps in `ConfigLoader.fixed`.

## 2. Usage

### 2.1 archer.config.ts (layered app)
```ts
import { defineConfig, Policy, Rule } from "@lucasacoutinho/archer"

const L = Policy.layers({ domain: "src/domain/**", app: "src/application/**", infra: "src/infrastructure/**", ui: "src/ui/**" })
export default defineConfig({
  workspace: { projects: ["tsconfig.json"] },
  baseline: ".archer/baseline.json",
  policy: Policy.make([
    Rule.layered(L, { ui: ["app"], app: ["domain"], infra: ["app", "domain"], domain: [] },
      { id: "layers", reason: "dependencies point inward" }),
    Rule.dependsOnly("src/domain/**", { on: ["src/domain/**", "npm:effect"], kinds: ["static", "type"], id: "pure-domain" }),
    Rule.freeOfCycles({ folders: 2, id: "no-cycles" }),
    Rule.resolvable({ id: "resolvable", severity: "warning" }),
    Rule.custom({ id: "no-deep-barrels", run: (g) => g.files.filter((f) => f.path.endsWith("/index.ts") && f.dependencies.length > 20).map(toViolation) }),
  ]),
})
```
### 2.2 vitest test (any runner: same body)
```ts
import { it } from "vitest"
import { expectArchitecture } from "@lucasacoutinho/archer/testing"
it("architecture", () => expectArchitecture(), 30_000)
```
Effect flavour with `@effect/vitest`:
```ts
it.effect("architecture", () => Effect.gen(function* () {
  const report = yield* (yield* Archer).check({ _tag: "Discover", cwd })
  expect(report.verdict._tag).toBe("Pass")
}).pipe(Effect.provide(ArcherLive)))
```
Jest/bun/node:test use the identical `it("architecture", () => expectArchitecture())`; the matcher is registered
by the caller (`expect.extend(archerMatchers)`), so Archer never imports `jest` or `bun:test`.

### 2.3 Non-Effect caller
```ts
import { checkArchitecture, dispose } from "@lucasacoutinho/archer/testing"
const report = await checkArchitecture({ cwd: process.cwd() })
if (report.verdict._tag === "Fail") console.error(report.counts)
await dispose()   // stops the Go process
```
### 2.4 Rule-engine test, in-memory (no TypeScript spawn)
```ts
const g = Graph.fromLiteral({ "src/domain/a.ts": { imports: ["../infra/db.ts"] }, "src/infra/db.ts": {} })
expect(check(Policy.make([Rule.layered(L, ...)]), g).map((v) => v.ruleId)).toEqual(["layers"])  // pure, no layers
```
Shell test (baseline, watch, CLI) swaps only leaf layers:
```ts
const Test = Archer.layer.pipe(Layer.provide(Analyzer.memory(g)), Layer.provide(ConfigLoader.fixed(config)),
  Layer.provide(FileSystem.layerNoop({ readFileString, writeFileString, rename })), Layer.provide(NodePath.layer))
```
### 2.5 Baseline workflow
```ts
const ref = { _tag: "Discover", cwd } as const
yield* archer.check(ref, { baseline: "record" })       // accept today's violations
const r1 = yield* archer.check(ref)                    // later: only new violations fail; r1.suppressed counts old ones
const r2 = yield* archer.check(ref, { baseline: "prune" })  // r2.stale entries are dropped from the file
```
CLI: `archer baseline record | prune`, `archer check` applies the config's baseline.
### 2.6 CLI composition root (`bin/archer.ts`)
```ts
const common = { config: Flag.String("config").pipe(Flag.optional), reporter: Flag.Literals("reporter", Format.literals).pipe(Flag.withDefault("pretty")),
  graph: Flag.String("graph").pipe(Flag.optional), watch: Flag.Boolean("watch").pipe(Flag.withDefault(false)),
  output: Flag.String("output").pipe(Flag.optional) }
const check = Command.make("check", common, Effect.fn("archer.check")(function* (f) {
  const analyzer = Option.isSome(f.graph) ? Analyzer.replay(f.graph.value) : Analyzer.ts7      // choose adapter after parsing
  const live = Archer.layer.pipe(Layer.provide(analyzer), Layer.provide(ConfigLoader.native))
  yield* drive(f).pipe(Effect.provide(live))                                                     // prints via Terminal or writes via FileSystem
}))
Command.make("archer").pipe(Command.withSubcommands([check, graphCmd, baselineCmd]), Command.run({ version }),
  Effect.provide(NodeServices.layer), NodeRuntime.runMain)    // fail verdict -> process.exitCode = 1
```

## 3. What each adapter hides

- **Analyzer.ts7**: spawn and lifecycle of the Go server (`typescript/unstable/sync` `API`), `parseConfigFile`, `updateSnapshot`, batched `getSymbolAtLocation`, declaration-path to `Target` mapping, builtin and `node_modules` classification, the AST walk for computed `import(x)`, project de-duplication, symlink realpath, sorting. Callers see none of this.
- **Analyzer.memory(graph)**: returns a prebuilt Graph (after `Graph.make` validation). Hides nothing but proves the contract: it is the oracle in the shared suite.
- **Analyzer.replay(path)**: reads a JSON-encoded Graph through FileSystem and decodes it. Hides the encoding version. Gives CI-split analysis, reproducible bug reports, and the exchange format for Lean differential tests.
- **Analyzer contract suite**: `analyzerContract(layer, fixtureDir)` runs the same assertions (items 2-8) against ts7 and against replay of ts7's own output. A new adapter is real only if it passes.
- **ConfigLoader.native**: `import(pathToFileURL(p) + "?v=" + counter)` for fresh loads in watch, extension search order, Schema decode, error shaping. **ConfigLoader.fixed(config)**: ignores the ref.
- **Archer.layer** hides: pipeline order, custom-rule isolation, baseline file codec and atomic write, watch filtering and debounce.

## 4. Dependency categories and seam verdicts (DEEPENING)

| Dependency | Category | Seam? | Adapters |
| --- | --- | --- | --- |
| check, fingerprint, baseline apply/prune logic, render (except pretty snippets) | 1 In-process | No, inline | none |
| Analyzer | 4 True external (Go process owned by TypeScript) | Yes, driven port | ts7, memory, replay |
| ConfigLoader | 2 Local-substitutable | Yes, small | native, fixed |
| FileSystem / Path / Terminal / Stdio | 2 Local-substitutable, already a port in `effect` | Reuse, define no Archer port | NodeServices, `layerNoop` / `Stdio.layerTest` |
| Baseline store | 2 | **No**: a codec plus FileSystem; `layerNoop` is its second adapter, so an own port is a third layer of indirection | n/a |
| Reporter / output sink | 1 + Terminal | **No**: pure functions in a table; stdout is Terminal, files are FileSystem | n/a |
| Clock / hashing | n/a | **No**: no timestamps in artifacts; fingerprint is a canonical string, not a hash; debounce uses Effect's Clock (TestClock in tests) | n/a |
| Watch event source | 2 | **No**: `FileSystem.watch`, with `WatchBackend` as the platform's own substitution | n/a |
| Workspace file discovery | 2 | **No**: tsconfig file lists, resolved inside the ts7 adapter | n/a |
| Test runners | 4 True external | **Driving adapters, no port** | see below |

Runner deletion test:
- `./jest`, `./bun`, `./node` entry points: **deleted**. Each was 10 lines wrapping `test(name, fn)` around the same call; `() => expectArchitecture()` inside any runner's `it` replaces them. Pass-through, no leverage.
- `./jest/plugin`, `./bun/plugin`: deleted (matcher registration is `expect.extend(archerMatchers)` in the caller's setup).
- `./vitest/plugin`: **kept, the only real runner adapter**. It adds behaviour beyond a call: run once per process at `configResolved`, fail Vite startup, and share the process-wide runtime.
- `./testing` is not an adapter either; it is the Promise facade over `Archer`, the one driving adapter all non-Effect callers share. CLI is the other. Two driving adapters over one port.

## 5. Layer graph and composition roots

```
                      +---------------------------+
 driving:  CLI ------>|                           |
           vitest --->|   Archer  (application)   |  pure core: check, fingerprint, baseline logic
           plugin     |   Archer.layer            |
           ./testing->|                           |
                      +--+--------+--------+------+
                         |        |        |
                   Analyzer  ConfigLoader  FileSystem + Path   (platform ports)
                   /   |   \    /     \          |
                ts7 memory replay native fixed   NodeServices.layer | FileSystem.layerNoop
                 |            \________________|__________/
              Go server              (replay, native, Archer.layer all read through FileSystem)
```

Composition roots (the only places that name concrete adapters):
```ts
const Platform = NodeServices.layer
export const ArcherLive = Archer.layer.pipe(
  Layer.provide(Analyzer.ts7), Layer.provide(ConfigLoader.native), Layer.provideMerge(Platform))
```
- **CLI**: `NodeRuntime.runMain` over `Command.run`; Archer layer built per invocation, because `--graph` swaps `ts7` for `replay` after parsing. `ts7` spawns lazily, so building the layer for `replay` never starts Go.
- **vitest plugin / `./testing`**: module-level lazy `ManagedRuntime.make(ArcherLive)`, disposed on `beforeExit`/`dispose()`. One Go process per worker.
- **Programmatic Effect**: caller provides `ArcherLive`, or `Archer.layer` with their own adapters.
- **Tests of the shell**: `Archer.layer` + `memory` + `fixed` + `layerNoop` + `Stdio.layerTest` for CLI via `Command.runWith`.

## 6. Trade-offs and dropped surface

Dropped from legacy:
- `ArchitectureSuite` fluent builder, `arch()` registration, presets registry: rules are data; layers and `Rule.layered` replace presets.
- `/jest`, `/bun`, `/node`, `/jest/plugin`, `/bun/plugin` entries (8 exports become 4: `.`, `./services`, `./testing`, `./vitest`, plus the bin).
- `ArcherOptions` (`include`, `exclude`, `followSymlinks`, `workspaces`, `includeTypeDeclarations`, `cache`): tsconfig defines the source set; `.d.ts` excluded by contract; caching is a future `Analyzer` decorator, not an option, because the analysis costs ~140 ms.
- `sourceLines` in the graph: moved to the pretty reporter; the Graph stays small, serializable, and pure.
- `jiti` TS config loading: native `import()`.

Costs and risks:
- ConfigLoader is the weakest seam: `fixed` is nearly a no-op. Kept because three callers need discovery and it lets `Archer.check` take one argument shape. If a reviewer rejects it, inline `native` and make `check` accept `Config | ConfigRef`.
- `replay` adds a serialized-Graph compatibility surface (version it). Worth it for the Lean differential tests, but it is a commitment.
- The contract suite is real work, and its determinism clauses (UTF-16 order, realpath) will fail adapters in surprising ways.
- Per-process `ManagedRuntime` inside test workers needs careful disposal; leaked Go processes are the main operational failure.
- `render(pretty)` is impure (reads files); the `never` error channel hides read failures by design.
- Custom-rule crash as a violation keeps `check` total but can mask a bug as a lint failure; its message must carry the cause.
- Effect leaks into `./services`; non-Effect callers are safe only through `./testing`.
