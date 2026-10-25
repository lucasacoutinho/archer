# Design C: optimise for the common caller

The most common caller is a team that wants layered boundaries enforced in CI
and in its test suite. It does not know Effect and does not want to learn a rule
DSL. So the default case is one object literal in `archer.config.ts` with a
`layers` table and an `allow` table. The test is two lines. Everything else
(declaration rules, custom rules, Effect composition) costs more and lives
behind explicit, secondary entry points.

Terms follow docs/GLOSSARY.md. "Selector", "layer", "edge filter", "witness" etc.
are used in the glossary sense.

## 1. Interface

### 1.1 Entry points (package exports; ESM only)

| Export | Audience | Contents |
| --- | --- | --- |
| `.` | 95% of callers | Promise surface: `defineConfig`, `r` (rule constructors), `presets`, `check`, `checkGraph`, `assertArchitecture`, `reporters`, `graph` (in-memory graph builder), `ArchitectureError` |
| `./effect` | Effect users, integrators | `Archer` namespace: `Rule`, `Selector`, `Policy`, `Graph`, `Violation`, `Report` schemas; `check` (pure); `run`; services `Analyzer`, `Baseline`; typed errors |
| bin `archer` | CI | `archer check`, `archer baseline`, `archer graph`, `archer init` |

There is no per-runner entry point (see 6.2). The root entry never exposes an
`Effect` type; `./effect` never re-implements anything the root has.

### 1.2 The config (caller-facing, what 95% write)

```ts
type LayerName = string
type SelectorInput = string | ReadonlyArray<string> | Selector   // "src/a/**", "npm:zod", "layer:domain"

interface Config {
  readonly layers?: Readonly<Record<LayerName, SelectorInput>>
  /** layer -> layers it may depend on (besides itself). Local deps only; absent key = unconstrained, [] = nothing. */
  readonly allow?: Readonly<Record<LayerName, ReadonlyArray<LayerName>>>
  /** Top to bottom. Sugar: each layer may depend on layers after it, never before. Merged with `allow`. */
  readonly stack?: ReadonlyArray<LayerName>
  /** Extra data rules. Presets are plain arrays, so `[...presets.strict, r.maxLines("src/**", 400)]`. */
  readonly rules?: ReadonlyArray<Rule | CustomRule>
  /** Default `presets.recommended` = acyclic files + resolvable dependencies. Pass `[]` to opt out. */
  readonly extends?: ReadonlyArray<ReadonlyArray<Rule>>
  readonly workspace?: { readonly tsconfig?: string | ReadonlyArray<string>; readonly root?: string }
  readonly baseline?: string | false          // default ".archer-baseline.json" if the file exists
  readonly failOn?: "error" | "warning"       // default "error"
}
declare const defineConfig: (config: Config) => Config   // identity; type + early decode in the editor only
```

Layer references inside any selector use the prefixed form `layer:<name>`, like
`npm:` and `node:`. It is lowered away before `check` (1.4), so the Lean model has
no layer node.

### 1.3 Running a check (Promise surface, root export)

```ts
interface RunOptions {
  readonly config?: string | Config      // path (default: discover archer.config.ts upward from cwd) or inline object
  readonly cwd?: string
  readonly baseline?: "use" | "ignore" | "update"   // default "use"
}
declare const check: (options?: RunOptions) => Promise<Report>              // rejects with ConfigError | AnalysisError | BaselineError (plain Error subclasses with `_tag`)
declare const checkGraph: (config: Config, graph: Graph) => Report          // sync, no analyzer, no baseline: for policy unit tests
declare const assertArchitecture: (options?: RunOptions) => Promise<void>    // rejects with ArchitectureError when verdict is fail
declare class ArchitectureError extends Error { readonly report: Report }   // message = pretty report, so runner output is the report
declare const reporters: Readonly<Record<"pretty" | "agent" | "json" | "github" | "sarif", (r: Report) => string>>
declare const graph: (adjacency: Record<string, ReadonlyArray<string>>) => Graph   // in-memory adapter input, see 3
```

`check` creates a `ManagedRuntime` with the TS7 analyzer and Node services, runs
`run`, and disposes it in `finally`. One call is one TS7 server spawn (about
140 ms measured). Callers who run many checks use `./effect`.

### 1.4 Effect surface (`./effect`)

```ts
export declare const run: (input: Config | Policy, opts?: { baseline?: "use" | "ignore" | "update" }) =>
  Effect.Effect<Report, ConfigError | AnalysisError | BaselineError, Analyzer | Baseline | FileSystem.FileSystem | Path.Path>
export declare const loadConfig: (path?: string) => Effect.Effect<Config, ConfigError, FileSystem.FileSystem | Path.Path>
export declare const lower: (config: Config) => Result.Result<Policy, ConfigError>   // pure: layers/allow/stack/extends -> Policy
export declare const check: (policy: Policy, graph: Graph) => ReadonlyArray<Violation>  // pure, the Lean-specified function
export declare const applyBaseline: (violations: ReadonlyArray<Violation>, b: BaselineFile) => Report  // pure
export declare const live: Layer.Layer<Analyzer | Baseline, never, FileSystem.FileSystem | Path.Path>   // TS7 + file baseline

export class Analyzer extends Context.Service<Analyzer, {
  readonly analyze: (w: Workspace) => Effect.Effect<Graph, AnalysisError>
}>()("archer/Analyzer") {
  static readonly ts7: Layer.Layer<Analyzer>
  static readonly memory: (g: Graph) => Layer.Layer<Analyzer>
}
export class Baseline extends Context.Service<Baseline, {
  readonly read: (path: string) => Effect.Effect<BaselineFile, BaselineError>
  readonly write: (path: string, fingerprints: ReadonlyArray<Fingerprint>) => Effect.Effect<void, BaselineError>
}>()("archer/Baseline") {}
```

Typed errors (all `Schema.TaggedError`):

```ts
class ConfigError   extends Schema.TaggedError<ConfigError>()("ConfigError",   { path: Schema.String, issues: Schema.NonEmptyArray(Schema.String) }) {}
class AnalysisError extends Schema.TaggedError<AnalysisError>()("AnalysisError", { reason: Schema.Literals(["TsconfigNotFound", "ServerFailed", "ProjectLoadFailed"]), detail: Schema.String }) {}
class BaselineError extends Schema.TaggedError<BaselineError>()("BaselineError", { path: Schema.String, reason: Schema.Literals(["Unreadable", "Malformed", "UnsupportedVersion"]) }) {}
```

`check` (pure) cannot fail: invalid policies are unrepresentable after decode.
Rule `Custom` failures (a custom rule that throws) become a `Violation` with
detail `CustomFailed`, never an `AnalysisError`.

### 1.5 Invariants and ordering

1. `lower` runs before any analysis; all `ConfigError`s (unknown layer, empty
   selector list, duplicate rule id, `layer:` cycle) surface before TS7 spawns.
2. Layer expansion is pure and total: `layer:x` is replaced by its selector
   (recursive references to layers are rejected). `check` never sees a layer.
3. `allow`/`stack` shorthand lowers to rules with ids `layer/<name>/allow`;
   they only constrain local edges (`edges.local = true`), as in the legacy.
4. Violations are totally ordered by `(file, ruleId, fingerprint)`. Output is
   deterministic for a given policy and graph.
5. Baseline is applied after `check` and before the verdict. Baselined
   violations are counted, not listed; fingerprints in the file that match
   nothing are reported as `stale` (info; `--strict-baseline` turns into fail).
6. `verdict = fail` iff an active `error` violation exists, or an active
   `warning` when `failOn = "warning"`.
7. `baseline: "update"` writes fingerprints of all current violations and
   returns a passing report. It is never implicit.
8. A rule with no subjects is a pass, except the whole policy being empty after
   lowering, which is `ConfigError` (legacy did this as a violation; moving it
   earlier removes a runtime special case).

### 1.6 Report and violation (data)

```ts
const Detail = Schema.Union([
  Schema.TaggedStruct("Edge",   { target: Target, kind: DependencyKind, at: Loc }),
  Schema.TaggedStruct("Chain",  { chain: Schema.NonEmptyArray(Target), at: Loc }),       // witness: subject ... forbidden target
  Schema.TaggedStruct("Cycle",  { members: Schema.NonEmptyArray(Schema.String) }),        // closed chain, first = last
  Schema.TaggedStruct("Symbol", { name: Schema.String, at: Loc }),
  Schema.TaggedStruct("Size",   { lines: Schema.Int }),
  Schema.TaggedStruct("Custom", { message: Schema.String }),
])
class Violation extends Schema.Class<Violation>("archer/Violation")({
  ruleId: RuleId, severity: Severity, reason: Schema.optionalKey(Schema.String),
  subject: SourceFilePath, detail: Detail, fingerprint: Fingerprint,   // fingerprint = hash(ruleId, subject, detail minus Loc)
}) {}
class Report extends Schema.Class<Report>("archer/Report")({
  violations: Schema.Array(Violation), baselined: Schema.Int, stale: Schema.Array(Fingerprint),
  counts: Schema.Struct({ error: Schema.Int, warning: Schema.Int, info: Schema.Int }),
  verdict: Schema.Literals(["pass", "fail"]),
}) {}
```

Message wording is produced by reporters from `Detail`, so wording changes never
touch fingerprints.

## 2. Usage

### 2.1 archer.config.ts for a layered app (the whole default case)

```ts
import { defineConfig } from "@lucasacoutinho/archer"

export default defineConfig({
  layers: { web: "src/web/**", app: "src/app/**", domain: "src/domain/**", infra: "src/infra/**" },
  allow: { infra: ["app", "domain"] },
  stack: ["web", "app", "domain"],
})
```

That is the entire policy: web -> app -> domain, infra may use app and domain,
no cycles, all imports resolvable (the implicit `recommended` preset). `stack`
and `allow` lower to `Reach` rules; nothing here is a closure.

Running it:

```sh
npx archer check                    # pretty; exit 1 on fail
npx archer check -r github          # CI annotations
```

### 2.2 The vitest test

```ts
import { test } from "vitest"
import { assertArchitecture } from "@lucasacoutinho/archer"

test("architecture", () => assertArchitecture(), 30_000)
```

Same recipe for jest, `bun:test`, `node:test`: swap the first import. The
failure output is the pretty report because `ArchitectureError.message` is it.
Unit-testing a policy with no TS7 and no disk:

```ts
import { checkGraph, graph } from "@lucasacoutinho/archer"
import config from "../archer.config.ts"

test("domain cannot reach infra", () => {
  const report = checkGraph(config, graph({ "src/domain/a.ts": ["src/infra/db.ts"], "src/infra/db.ts": [] }))
  expect(report.violations.map((v) => v.ruleId)).toEqual(["layer/domain/allow"])
})
```

### 2.3 Non-Effect caller (script or GitHub action)

```ts
import { check, reporters } from "@lucasacoutinho/archer"

const report = await check({ config: "archer.config.ts", baseline: "ignore" })
console.log(reporters.json(report))
process.exitCode = report.verdict === "fail" ? 1 : 0
```

No `Effect` import; rejection values are plain `Error`s with `_tag`
(`"ConfigError"`, `"AnalysisError"`, `"BaselineError"`) and `cause`.

### 2.4 Effect caller

```ts
import { Archer } from "@lucasacoutinho/archer/effect"
const program = Archer.run(config).pipe(Effect.provide(Archer.live), Effect.provide(NodeServices.layer))
// test: Archer.run(config).pipe(Effect.provide(Layer.mergeAll(Analyzer.memory(g), Baseline.noop)))
```

### 2.5 Transitive rule with witness

```ts
rules: [
  r.forbid("layer:web", "npm:pg", { transitive: true, kinds: ["static", "require"],
    id: "web/no-db-driver", reason: "Web code reaches the database through app only." }),
]
```

Violation (pretty reporter):

```
error web/no-db-driver  src/web/page.ts
  src/web/page.ts -> src/app/users.ts -> src/infra/db.ts -> npm:pg
  Web code reaches the database through app only.
```

`detail` is `{ _tag: "Chain", chain: ["src/web/page.ts", "src/app/users.ts", "src/infra/db.ts", "npm:pg"], at }`. The
chain is a shortest path; ties break lexicographically so the fingerprint is stable.

### 2.6 Custom rule (the only closure)

```ts
rules: [
  r.custom("features/one-entrypoint", { subject: "src/features/**", severity: "warning" },
    ({ files }) => files.filter((f) => f.exports.length > 1)
      .map((f) => ({ subject: f.path, message: `exports ${f.exports.length} names` }))),
]
```

```ts
type CustomRule = {
  readonly _tag: "Custom"; readonly id: RuleId; readonly severity: Severity
  readonly subject: Selector
  readonly run: (view: { files: ReadonlyArray<FileView>; graph: Graph }) =>
    ReadonlyArray<{ subject: string; message: string }> | Promise<ReadonlyArray<{ subject: string; message: string }>>
}
```

Custom rules live next to the policy, not inside it: `Policy = { rules: Rule[] }` is
pure data; the shell (`run`) evaluates `CustomRule`s on the same graph after
`check` and merges `Custom` details. A throwing closure is contained.

### 2.7 Baseline workflow

```sh
npx archer baseline            # = check --baseline update: writes .archer-baseline.json, exits 0
git add .archer-baseline.json  # file: { version: 1, fingerprints: [...] } sorted
npx archer check               # existing violations suppressed; new ones fail
```

`report.baselined` and `report.stale` tell the team when the debt shrinks. In
code: `check({ baseline: "update" })`.

### 2.8 The rest of the rule families (cost more, still short)

```ts
rules: [
  r.acyclic("src/**", { folders: 2 }),
  r.only("layer:domain", ["layer:domain", "layer:shared", "node:crypto"]),       // depends only on
  r.usedOnlyBy("layer:domain", ["layer:app", "layer:infra"]),
  r.publicApi("layer:domain", "src/domain/index.ts"),
  r.declares("src/controllers/**", { kind: "class", extends: "BaseController", decorator: "Controller", readonlyProps: true, methods: ["execute"] }),
  r.declares("src/index.ts", { exportsExactly: ["Client", "ClientOptions"] }),
  r.forbidUse("src/**", { globals: ["eval", "Function"] }),
  r.forbidUse("src/**", { imported: { from: "react", names: ["useEffect"] } }),
  r.forbidUse("src/**", { looseEquality: true }),
  r.named("src/services/**", { suffix: ".service.ts" }),
  r.maxLines("src/**", 400),
]
```

## 3. What the implementation hides

- Config discovery and native `import()` of `.ts`; decoding with `Config`
  schema; closure-vs-data separation.
- Lowering (`lower`): `layer:` expansion, `allow`/`stack` desugaring, `extends`
  merging, default-id derivation (`reach/<subject>/<relation>/<object>`),
  conjunctive `declares` splitting into one `Declares` rule per predicate, id
  uniqueness, severity defaults.
- TS7 session management: spawning the server, project loading, specifier
  resolution batching, built-in classification, computed-import AST walk,
  the file list from tsconfig. The caller sees `Graph` only.
- Checking: selector matching (segment-based), reachability with shortest
  witness, Tarjan SCC with folder collapse, deterministic ordering, fingerprinting.
- Baseline file format and versioning; staleness detection.
- Reporters (SARIF, GitHub annotation escaping, pretty color detection).
- Runtime management for the Promise surface (`ManagedRuntime`, disposal).
- Differential test harness against the Lean model (internal, not exported).

## 4. Dependencies and seams

| Dependency | Category | Seam | Adapters |
| --- | --- | --- | --- |
| `check`, `lower`, `applyBaseline`, reporters | In-process | none; tested directly | n/a |
| Analyzer | Process-backed | `Analyzer` service. Real. | `ts7` (production), `memory` (tests, `checkGraph`, `graph()`) |
| File system (config, baseline, report output, watch) | Local-substitutable | Effect `FileSystem` + `Path`. Real. | `NodeFileSystem`, `FileSystem.layerNoop`/temp dir |
| Baseline store | Local-substitutable | `Baseline` service. **Hypothetical until a second adapter earns it.** | `Baseline.file` now; `Baseline.noop` for `baseline: "ignore"` is the second, so keep it. |
| Config loading | Local | none (function) | n/a |
| Test runners | True external | **no seam** (see 6.2) | `assertArchitecture` rejects; every runner already knows how to fail on a rejection |
| Reporters | In-process | none: `(Report) => string` record. A function table is not a seam | n/a |

Seams introduced: `Analyzer` (real), `FileSystem` (real, comes from Effect),
`Baseline` (two cheap adapters). Nothing else.

## 5. Rule data type (Lean-friendly)

Two data types do all the work: `Selector` (a Boolean algebra over targets) and
`Rule` (seven tags). Everything else in the legacy rule table is sugar that
lowers into these.

```ts
const Selector: Schema.Codec<Selector> = Schema.Union([
  Schema.TaggedStruct("Glob",       { segments: Schema.NonEmptyArray(Segment) }),  // pre-parsed: "**" | "*" | literal | "{a,b}" alternation
  Schema.TaggedStruct("Package",    { name: Schema.NonEmptyString }),               // npm:<name>
  Schema.TaggedStruct("Builtin",    { scheme: Schema.Literals(["node", "bun"]), name: Schema.NonEmptyString }),
  Schema.TaggedStruct("Unresolved", {}),                                            // unresolved:*
  Schema.TaggedStruct("Dynamic",    {}),                                            // dynamic:*
  Schema.TaggedStruct("Or",  { of: Schema.NonEmptyArray(Schema.suspend(() => Selector)) }),
  Schema.TaggedStruct("And", { of: Schema.NonEmptyArray(Schema.suspend(() => Selector)) }),
  Schema.TaggedStruct("Not", { of: Schema.suspend(() => Selector) }),
])
// Lean: inductive Sel; def matches : Sel -> Target -> Bool, structural recursion.
```

```ts
const Edges = Schema.Struct({                       // the edge filter
  kinds: Schema.NonEmptyArray(DependencyKind),      // default all four
  local: Schema.Boolean,                            // targets that are source files only
  transitive: Schema.Boolean,
})
const Meta = { id: RuleId, severity: Severity, reason: Schema.optionalKey(Schema.String) }

const Rule = Schema.Union([
  Reach,      // { subject, direction: "out"|"in", relation: "forbid"|"require", object: Selector, edges }
  Acyclic,    // { subject, edges, foldersToDepth?: positive Int }
  Resolvable, // { subject, allowDynamic }
  Declares,   // { subject, relation, pred: DeclPred }   DeclPred = Kind | Abstract | Exported | Extends | Implements | Decorator | ReadonlyProps | HasMethod | OnlyPublicMethods | ExportsExactly
  Uses,       // { subject, relation, use: LooseEquality | Global(names) | Imported(from, names) }
  Named,      // { subject, relation, affix: "prefix"|"suffix", value }
  MaxLines,   // { subject, max: positive Int }
])                                                   // each member = TaggedStruct(tag, { ...Meta, ...fields })
```

Why this shape is Lean-ready:

- Every dependency rule is a `Reach`. `only(X)` is `forbid(Not X)`; "depends on
  only" negated is `require(Not X)`; `usedOnlyBy` is `direction: "in"`;
  `publicApi(layer, entry)` is `forbid` with `subject = Not layer`, `direction: "out"`,
  `object = And[layer, Not entry]`; layer rules are `Reach` after `lower`. One
  semantic function covers 12+ legacy rule kinds, so one proof family
  (reachability with witness, soundness: a returned chain is a path in the graph
  and ends at a matching target; completeness: if no violation then no matching
  path exists) covers them.
- `relation` is an enum, not a `negated` boolean next to ad hoc kinds, so
  there are no unrepresentable combinations like "negated cycles".
- `Acyclic`, `Resolvable`, `MaxLines` are monomorphic and tiny. They carry the
  proof obligations cycle detection (SCC witness) and completeness.
- `Declares`, `Uses`, `Named` are predicates over facts; they are checked as
  `all subjects satisfy pred` with `relation` flipping. Facts are an input
  record in the Lean model; the TS7 adapter's correctness is out of Lean's scope.
- `Custom` is not in `Rule`. The Lean `check` is `Policy -> Graph -> List Violation`
  with `Policy = List Rule`; the shell adds closures after.
- Schema checks are native: `Schema.isMinLength`, `Schema.isInt` +
  `isGreaterThan(0)`, brands for `RuleId` (non-empty, no spaces via `isIncluding`
  negated in a `makeFilter`), `Segment` parsed by hand. No regex.
  Glob strings parse to `Segment[]` with a hand-written scanner at the boundary
  (`parseSelector`), a pure function also given a Lean spec.

## 6. Trade-offs

### 6.1 Where leverage is high

- Default policy is about 5 lines; `stack` + `allow` cover layered, hexagonal,
  and onion architectures. 80% of real users write nothing else.
- One `assertArchitecture` replaces six integration entry points.
- `checkGraph` + `graph()` make the policy itself unit-testable in
  milliseconds with no TypeScript server, which is the in-memory adapter paying
  for its seam on every rule test.
- `Reach` collapses 12+ legacy rule kinds into one proven semantics.

### 6.2 Deletion test on every legacy entry point

| Legacy export | Verdict | Reason |
| --- | --- | --- |
| `.` (`createArcher`, fluent builder) | Replaced by `defineConfig` + `r.*` | Builder is mutable state ("last rule" decoration) the Lean model cannot talk about. Data constructors have the same call-site cost. |
| `./vitest` (`arch()`) | Delete | Pass-through: `test(name, () => assertArchitecture())`. Complexity does not reappear in N callers; it is two lines. |
| `./vitest/plugin` (`toRespectArchitecture`) | Delete | Matcher over the same call. `ArchitectureError` carries the pretty report. |
| vitest config plugin `archer()` | Delete | Pre-collection run equals `archer check && vitest` in `package.json`. The plugin was the only reason for a vitest peer dependency in the runtime package. |
| `./jest`, `./jest/plugin` | Delete | Same as vitest. Jest is not in the allowed dependency list. |
| `./bun`, `./bun/plugin` | Delete | Same; Bun support stays through its own `bun:test` calling the Promise surface. |
| `./node` | Delete | Same; `node:test` takes an async function. |
| CLI bin | Keep | CI entry; it earns its keep: reporters, exit codes, baseline, watch. |
| CJS dual build | Delete | Constraint: ESM only. Promise surface works from `import()` in CJS. |

What this costs: no runner-specific timeout option and no per-test registration
of individual rules (legacy `arch("name")` made one test per rule). Mitigation:
`assertArchitecture({ config })` accepts a Config, so a team can split a policy
into several tests, and `check` returns per-rule ids. A team that wants one
vitest test per rule writes `it.each(config.rules)`. Not built in.

### 6.3 Dropped legacy surface

- Aliases (`toUse`, `toOnlyUse`, `toBeUsedIn`, `toUseNothing`, `llm`
  reporter): vocabulary duplicates; `only(x, [])` covers `toUseNothing`.
- Global `registerPreset` registry: global mutable state; presets are arrays.
- `.ignoring()`: replaced by `And/Not` selectors (`["src/**", r.not("src/gen/**")]`).
- `includeTypeDeclarations`, `followSymlinks`, `cache`: analyzer-internal;
  re-add only when a caller asks (all are one field on `workspace`).
- Preset `node` and `security` become `presets.node`/`presets.security` arrays.

### 6.4 Where leverage is thin

- `Declares` / `Uses` / `Named` constructors are almost 1:1 with legacy
  methods; the shape is better but the surface is not smaller. They are the
  uncommon cases and stay cheap-ish, not trivial.
- `Not`/`And` selectors are powerful but a team must read `forbid(Not X)` as
  "only X"; `r.only` hides it, but error messages are about the lowered form
  unless reporters keep a `reason`. Mitigation: lowered `only` rules get a
  generated reason "depends only on ...".
- `stack` + `allow` only constrain local edges; external packages need
  explicit rules. Surprising for first-time users; documented in `init` template.
- Promise surface spawns TS7 per call. With 10 test files each calling
  `assertArchitecture`, that is 10 spawns; acceptable but a shared
  `createChecker()` handle would fix it (deferred until measured).
- Two surfaces (root Promise, `./effect`) must not drift. Mitigation: root is
  a 40-line wrapper over `./effect`, tested by one smoke test.
- Custom rules take a closure over a read view; they cannot be
  fingerprinted by content, only by id, so their violations rely on `subject`
  + message for stability.
- `check` never returns errors, so the "No rules declared" legacy violation
  becomes a `ConfigError` at lowering time. Behavior change callers might notice.
