# Design A: minimal (three entry points, policy as plain data)

Core idea: a policy is a JSON-shaped value, so the whole library is one verb
(`check`) over one input language (`Config`) with one result type (`Report`).
No builder, no runner adapters, no registry. Everything a runner, CLI, agent or
CI job needs is `check` plus `Report.render` / `Report.orFail`.

Package export map: `"."` only, plus `bin: archer`. No sub-path exports, no
optional peer dependencies.

## 1. Interface

Three values are exported (`Config`, `check`, `Report`). Types ride along.

```ts
import { Effect, FileSystem, Path, Schema } from "effect"

// ---------- entry point 1: Config (the input language) ----------
export declare const Config: Schema.Codec<Config, Config.Input> & {
  readonly presets: { readonly strict: ReadonlyArray<Rule.Input>; readonly node: ...; readonly security: ... }
}
export interface Config {
  readonly workspace: Workspace                  // default { root: ".", projects: ["tsconfig.json"] }
  readonly policy: Policy
  readonly baseline?: Baseline | string          // inline data, or a path (relative to config file / cwd)
  readonly failOn: "error" | "warning"           // default "error"
  readonly custom: Readonly<Record<string, CustomRule>>  // the only closures; keyed by Custom rule `name`
}
export declare namespace Config { type Input = Schema.Codec.Encoded<typeof Config> }
export interface Workspace { root: string; projects: NonEmptyArray<string>; exclude: ReadonlyArray<Selector> }
export interface Policy { layers: Record<LayerId, Selector>; rules: ReadonlyArray<Rule> }

// ---------- entry point 2: check (the only verb) ----------
export interface CheckOptions {
  readonly graph?: Graph.Input                   // in-memory adapter: skips the Analyzer entirely
  readonly baseline?: Baseline | string          // overrides config.baseline
}
export declare const check: {
  (source: Config.Input | string /* path to archer.config.ts */, options?: CheckOptions):
    Effect.Effect<Report, ConfigError | AnalysisError | BaselineError, FileSystem.FileSystem | Path.Path>
  /** Non-Effect bridge: provides NodeServices, runs, rejects with the same typed error instances. */
  promise(source: Config.Input | string, options?: CheckOptions): Promise<Report>
}

// ---------- entry point 3: Report (the result and everything done with it) ----------
export declare const Report: Schema.Codec<Report> & {
  render(report: Report, format: "pretty" | "agent" | "json" | "sarif" | "github" | "dot" | "baseline"): string
  orFail(report: Report): Effect.Effect<Report, ArchitectureViolated>   // fails iff verdict = "fail"
}
export interface Report {
  readonly violations: ReadonlyArray<Violation>   // after baseline, sorted (file, line, ruleId)
  readonly suppressed: number                     // matched a baseline fingerprint
  readonly stale: ReadonlyArray<Fingerprint>      // baseline entries nothing matched any more
  readonly counts: { error: number; warning: number; info: number }
  readonly verdict: "pass" | "fail"               // derived from config.failOn
  readonly graph: Graph                           // immutable; lets "dot" and callers inspect
}
export interface Violation {
  readonly ruleId: string; readonly severity: Severity; readonly reason?: string
  readonly subject: SourceFileId                  // root-relative, "/" separators
  readonly location?: { line: number; column: number }
  readonly message: string
  readonly witness?: Witness                      // Chain (subject -> forbidden target) | Cycle (closed)
  readonly fingerprint: Fingerprint               // `${ruleId}|${subject}|${witnessKey}`: no lines, no wording, no hash
}
export type Witness =
  | { _tag: "Chain"; edges: NonEmptyArray<{ from: SourceFileId; to: TargetId; kind: DependencyKind }> }
  | { _tag: "Cycle"; edges: NonEmptyArray<...> }

// ---------- typed errors (Schema.TaggedError) ----------
ConfigError      { path?: string; reason: "NotFound" | "ImportFailed" | "Invalid"; issues: ReadonlyArray<string> }
AnalysisError    { reason: "TsConfigNotFound" | "ServerSpawnFailed" | "ProjectLoadFailed"; detail: string }
BaselineError    { path: string; reason: "NotFound" | "Invalid" | "Unwritable" }
ArchitectureViolated { report: Report; message: string /* Report.render(report,"pretty") */ }
```

Invariants
- `check` is referentially transparent for a given `(source, graph)`. With inline
  `Config.Input` plus `options.graph` and no baseline path it touches no file and
  spawns no process: that call is the pure `(Policy, Graph) -> violations`
  plus baseline suppression, and is the Lean differential-test target.
- Decode happens once, at the top of `check`. A `Config` never reaches the core
  undecoded. Decode collects all issues (`errors: "all"`).
- Rules are evaluated independently; order of `policy.rules` never changes the
  violation set. Output order is a total sort, so reports are byte-stable.
- Rule `id` is optional input; absent ids are derived from the canonical
  encoding of the rule (`Depends:src/domain/**:out:none:...`), so fingerprints
  survive reordering. Duplicate ids are a `ConfigError(Invalid)`.
- `Custom` rules whose `name` has no entry in `config.custom` are a
  `ConfigError(Invalid)`, never silent.
- A policy with zero rules is a `ConfigError(Invalid)` (legacy returned a fake
  violation).
- Baseline suppresses by fingerprint only; suppression never hides a *new*
  violation of an already-baselined rule (different subject/witness => different
  fingerprint).
- Ordering: decode -> (analyze | take `options.graph`) -> pure evaluate ->
  apply baseline -> derive verdict. `Report.orFail` is the only place that turns
  a failing verdict into an error.

## 2. Usage

### archer.config.ts (layered app)
```ts
import { Config } from "@lucasacoutinho/archer"

export default {
  workspace: { root: ".", projects: ["tsconfig.json", "packages/*/tsconfig.json"] },
  baseline: "archer.baseline.json",
  policy: {
    layers: {
      web: "src/web/**", app: "src/application/**",
      domain: "src/domain/**", infra: "src/infrastructure/**",
    },
    rules: [
      ...Config.presets.strict,                        // plain arrays of Rule.Input
      { _tag: "Layered", allow: {                      // desugars to Depends(only) + layer Acyclic
          web: ["app", "domain"], app: ["domain"], infra: ["app", "domain"], domain: [] },
        reason: "Dependencies point inward." },
      { _tag: "Depends", subject: "layer:domain", direction: "out", quantifier: "none",
        on: ["npm:*", "node:*"], via: { kinds: ["static", "require", "dynamic"] },
        id: "domain/pure", severity: "error" },
      { _tag: "PublicApi", subject: "layer:domain", entry: "src/domain/index.ts" },
    ],
  },
} satisfies Config.Input
```

### vitest (and, unchanged, jest / bun test / node:test)
```ts
import { it, expect } from "vitest"
import { check, Report } from "@lucasacoutinho/archer"

it("architecture holds", async () => {
  const report = await check.promise("archer.config.ts")
  expect(report.violations, Report.render(report, "pretty")).toEqual([])
})
```
With @effect/vitest:
```ts
it.effect("architecture holds", () => check("archer.config.ts").pipe(Effect.flatMap(Report.orFail)))
```

### Non-Effect caller (script, CI glue, other runner)
```ts
const report = await check.promise({ policy: { layers: {}, rules: [...] } })
process.stdout.write(Report.render(report, "github")); process.exitCode = report.verdict === "pass" ? 0 : 1
```
Rejection value is a `ConfigError | AnalysisError | BaselineError` instance, so
`catch (e) { if (e instanceof ConfigError) ... }` works without Effect.

### Custom rule (the only closure; named, referenced from data)
```ts
export default {
  policy: { layers: {}, rules: [
    { _tag: "Custom", name: "max-fanout", subject: "src/**", severity: "warning", options: { limit: 15 } },
  ] },
  custom: {
    "max-fanout": ({ file, graph, options }) =>        // pure: (CustomContext) => ReadonlyArray<CustomFinding>
      graph.outgoing(file).length > options.limit
        ? [{ message: `${file} has ${graph.outgoing(file).length} dependencies` }] : [],
  },
} satisfies Config.Input
```
`options` is `Schema.Json` so the rule stays encodable; the closure gets a
read-only `file` + `graph` view and returns findings; Archer adds id, severity,
subject and fingerprint. Async/Effect-returning custom rules are not supported
(purity keeps `check` deterministic).

### Transitive rule with witness
```ts
{ _tag: "Depends", subject: "layer:web", direction: "out", quantifier: "none",
  on: "layer:infra", via: { transitive: true, localOnly: true } }
```
Report violation: `subject: "src/web/page.ts"`, `witness: { _tag: "Chain", edges:
[web/page.ts -> application/create-order.ts, application/create-order.ts ->
infrastructure/db.ts] }`, fingerprint `.../web/page.ts|...|infrastructure/db.ts`.
The chain is the shortest by edge count, ties broken by lexicographic path.

### Baseline workflow
```sh
archer check --update-baseline          # = writes Report.render(report, "baseline") to config.baseline
archer check                            # baselined violations suppressed; report.stale lists fixed ones
```
```ts
const report = await check.promise("archer.config.ts", { baseline: "archer.baseline.json" })
report.suppressed   // accepted legacy violations
report.stale        // fingerprints to prune: CLI prints "N baseline entries are obsolete"
```
Baseline file = `{ version: 1, fingerprints: Fingerprint[] }`, sorted, one per line.

## 3. What hides behind the seam

- `Config` decoding: native `import()` of the `.ts` file, schema decode, layer
  reference resolution (`layer:x` -> selector), `Layered` desugaring, id derivation.
- Analyzer: TS7 `typescript/unstable/sync` API process, tsconfig project loading,
  batched specifier resolution, built-in/package classification, computed-import
  AST walk, facts extraction, per-signature graph cache.
- Selector matching (segment-based), edge filtering, reachability / shortest
  witness, SCC cycle detection and folder collapsing, declaration/use predicates.
- Fingerprinting, baseline application, stale detection, severity counts, verdict.
- Reporters (pretty, agent, JSON, SARIF, GitHub, DOT) behind one `render`.
- The CLI (`archer check|init`, `--watch` via `FileSystem.watch` + debounce,
  `--reporter`, `--update-baseline`) is a consumer of exactly these three
  values: if it needs something else, the interface is wrong.

## 4. Dependency strategy and seams

| Dependency | Category | Seam | Adapters |
| --- | --- | --- | --- |
| pure evaluate | In-process | none | n/a; called directly |
| Analyzer (`Context.Service`, internal) | Process-backed | **real** | TS7 server adapter; in-memory (`options.graph`) |
| File system | Local-substitutable | internal; Effect `FileSystem` | `NodeFileSystem` / `FileSystem.layerNoop` / temp dir |
| Config loading | Local | none | native `import()` + decode |
| Test runners | True external | **none** | zero adapters: `check.promise` + `Report` suffice |

- Real seams: Analyzer (2 adapters). FileSystem is Effect's own seam, free.
- The Analyzer service is not exported. Its second adapter is surfaced as plain
  data (`options.graph`) rather than a `Layer`, so non-Effect callers can use
  it and the service tag does not widen the interface. If a third adapter ever
  appears (e.g. a Node-only `oxc` analyzer), promote `Analyzer` to an export then.
- `check.promise` is a ~6-line `ManagedRuntime`-free `Effect.runPromise` with
  `NodeServices.layer`; it is a convenience, not a seam.
- Dependencies stay `effect`, `@effect/platform-node`, `typescript@7`; vitest,
  `@effect/vitest`, `@effect/tsgo` dev only. The optional `vitest` and
  `@jest/globals` peer deps disappear.

## 5. Rule as data (Lean-friendly)

Closed tagged union; every member has: `subject` (selector), `except?`, `id?`,
`reason?`, `severity` (default "error"). Shown without those common fields:

```ts
type Selector = string | NonEmptyArray<string>      // glob | npm: node: bun: unresolved: dynamic: layer:
type EdgeFilter = { kinds?: NonEmptyArray<DependencyKind> /* unique */; localOnly: boolean; transitive: boolean }
type Quantifier = "some" | "none" | "only" | "notOnly"  // the 2x2 of {some, only} x {plain, negated}; no redundancy

type Rule =
  | { _tag: "Depends"; direction: "out" | "in"; quantifier: Quantifier; on: Selector; via: EdgeFilter }
  | { _tag: "Acyclic"; kinds?: NonEmptyArray<DependencyKind>; folderDepth?: PositiveInt }
  | { _tag: "Resolvable"; allowDynamic: boolean }
  | { _tag: "PublicApi"; entry: Selector; not: boolean }
  | { _tag: "Layered"; allow: Record<LayerId, ReadonlyArray<LayerId>> }          // desugars to Depends + Acyclic
  | { _tag: "Declares"; every: DeclPredicate; not: boolean }
  | { _tag: "ExportsExactly"; names: ReadonlyArray<string>; not: boolean }
  | { _tag: "Uses"; use: UseSpec; not: boolean }
  | { _tag: "Named"; affix: "prefix" | "suffix"; value: NonEmptyString; not: boolean }
  | { _tag: "Size"; maxLines: PositiveInt; not: boolean }
  | { _tag: "Custom"; name: string; options: Json }                              // opaque oracle in the model

type DeclPredicate =                       // nested union, evaluated per declaration, `And` for conjunction
  | { _tag: "Kind"; kinds: NonEmptyArray<"class"|"interface"|"enum"|"function"|"type"|"variable"> }
  | { _tag: "Abstract" } | { _tag: "Exported" } | { _tag: "ReadonlyProps" }
  | { _tag: "Extends"; name: string } | { _tag: "Implements"; name: string } | { _tag: "Decorator"; name: string }
  | { _tag: "HasMethod"; names: NonEmptyArray<string>; visibility?: Visibility }
  | { _tag: "OnlyPublicMethods"; names: ReadonlyArray<string> }
  | { _tag: "And"; all: NonEmptyArray<DeclPredicate> }                           // recursive via Schema.suspend
type UseSpec =
  | { _tag: "LooseEquality" } | { _tag: "Global"; names: NonEmptyArray<string> }
  | { _tag: "Imported"; from: string; names: NonEmptyArray<string> }
```

Semantics for Lean: `sem : Rule -> Graph -> SourceFileId -> List Violation`
by structural recursion on the tag; `Depends` is one definition parameterised by
`direction x quantifier x filter` (reachability with witness proved once, not
four times); `Layered` has a proven desugaring lemma. `not` is an uniform
per-subject flip. `NonEmptyArray`, unique kinds, positive ints are native checks
(`isMinLength(1)`, `isUnique()`, `isGreaterThan(0)` + `isInt()`); no regex.
Every legacy row of the requirement table maps to a member: Dependency ->
`Depends`; Structure -> `Acyclic`/`Resolvable`/`PublicApi`; Declarations ->
`Declares`/`ExportsExactly`; Uses -> `Uses`; Naming/size -> `Named`/`Size`;
Composition -> `layers`, `Layered`, presets-as-arrays, `Custom`.

## 6. Trade-offs

Leverage is high:
- One verb for CLI, every test runner, agents and CI; adding a runner costs zero
  library code. One decode boundary; one `render`; one place the verdict is derived.
- Data policies are diffable, serialisable (agents can emit them as JSON),
  decodable with full issue lists, and map 1:1 onto the Lean `Rule` inductive.
- Test seam is data: `check({policy}, { graph })` exercises everything but TS.

Leverage is thin:
- Authoring ergonomics are the price. Object literals are verbose next to the
  fluent `expect(..).not.toDependOn(..)` form; mitigated by defaults, `Layered`,
  `layer:` selectors and `satisfies Config.Input` completion, not removed. A
  userland builder can be written in 20 lines over the data; deliberately not shipped.
- In-memory graphs are hand-written literals (`Graph.Input`), no helper exported.
- Pure `evaluate` has no public name; the Lean differential test must go through
  `check` with an inline graph (fine) or import an internal path.
- `Config.presets` are static arrays, not parameterised; parameterised presets are
  just functions the caller writes returning `Rule.Input[]`.
- `Report` doing render + orFail makes it a small grab-bag; the alternative
  (separate `Reporters`) adds an entry point for two functions.
- Custom rules cannot be async or Effectful, and cannot see source text, only
  graph + facts.

Dropped from the legacy surface (deletion test; "complexity reappears?" answer):
| Legacy export | Verdict | Why |
| --- | --- | --- |
| `/vitest` `arch()` | delete | complexity does not reappear: 3 lines over `check.promise`; the hidden-registration style also hid failures from `it.effect` users |
| `/vitest` `archer()` config plugin | delete | single-run-before-collect saves duplicate analysis, but couples to Vite lifecycle; `archer check` in `npm test` pre-step does the same |
| `/vitest/plugin`, `/jest/plugin`, `/bun/plugin` matcher setup | delete | `toRespectArchitecture` = `Report.orFail`; global `expect` mutation, 3 copies, `sideEffects` flags |
| `/jest`, `/bun`, `/node` adapters | delete | each re-wrapped `test()` + a builder; with a promise-returning `check` they are the caller's one-liner |
| `createArcher` / `ArchitectureSuite` / `ArchExpectation` (60 methods, aliases like `toUse`) | delete | replaced by data; aliases were pure surface |
| `registerPreset` / `applyPreset` / `availablePresets` global registry | delete | presets are arrays; mutable global registry has no second implementation |
| `ArcherOptions` knobs (`cache`, `followSymlinks`, `includeTypeDeclarations`, `workspaces`) | fold into `Workspace` / hide | cache is an Analyzer detail; the rest are tsconfig-derived |
| CJS build and `require` export | delete | ESM only per problem-space |
| Fluent modifiers that reset after next rule (`.transitively()`, order-sensitive state) | delete | order-dependent hidden state; now explicit `via` field |

Open risk: if usability testing shows the literals are too heavy, the fix is a
second, *optional* construction module over the same data (a design-B shape),
not changes to `check`/`Report`.
