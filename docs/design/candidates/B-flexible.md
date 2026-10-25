# Design B: a rule algebra (flexibility first)

Core idea: a rule is `Forall(subjects, holds)`. `holds` is a small boolean algebra over
four atoms (subject fields, rows of a relation, reachability, opaque custom). Every
legacy assertion (all 17 rule kinds) is a *derived constructor*: an ordinary function
returning data. New assertions, presets and layers are functions, not registered kinds.
Effects live only in the Analyzer and in Enrichers; `check` stays pure.

## 1. Interface

### 1.1 Data (all Schema-described; `_tag` unions). Names follow the glossary.
```ts
// Scalar predicates over one field value. Total: a missing field makes Is(...) false.
type Pred =
  | { _tag: "Eq"; value: string | number | boolean }
  | { _tag: "In"; values: NonEmptyArray<string> }
  | { _tag: "Glob"; pattern: string }                 // segment matcher (Lean-specified), no regex
  | { _tag: "Prefix" | "Suffix" | "Includes"; value: string }
  | { _tag: "Cmp"; op: "lt" | "lte" | "gt" | "gte"; value: number }
  | { _tag: "Subject" }                               // equals the subject's node (cycles)
  | { _tag: "Some"; pat: Pat }                        // array field: some element matches

// Boolean algebra over the fields of one row. A Selector is a Pat over the `node` relation.
type Pat =
  | { _tag: "True" } | { _tag: "Is"; field: string; pred: Pred }
  | { _tag: "And" | "Or"; of: ReadonlyArray<Pat> } | { _tag: "Not"; of: Pat }
type Selector = Pat   // fields: id, kind(file|package|builtin|unresolved|computed), basename, lines, folder, package

// Relations = Graph/Facts as named tables (file -> rows). Built-ins + enricher tables.
type Relation = "dependency" | "declaration" | "export" | "use" | (string & {})  // custom: enricher tables
//  dependency: kind, local, target.id, target.kind, line      declaration: kind,name,abstract,exported,
//  extends[],implements[],decorators[],readonlyProps, methods[{name,visibility,static}]
//  export: name   use: kind(call|looseEq), name, importedFrom, importedName

type EdgeFilter = { kinds?: NonEmptyArray<DependencyKind>; localOnly?: boolean }  // an Edge filter's non-reach part
type Grain =                                                   // quotient the graph before reachability
  | { _tag: "File" } | { _tag: "Folder"; depth: PositiveInt }
  | { _tag: "Partition"; parts: NonEmptyArray<{ name: string; of: Selector }> }   // layers

type Prop =
  | { _tag: "Where"; pat: Pat }                                // subject's own fields (lines, basename)
  | { _tag: "Rows"; rel: Relation; where: Pat; count: Count }  // |{rows of subject matching}| in count
  | { _tag: "Reach"; dir: "out" | "in"; via: EdgeFilter; to: Selector; hops: "direct" | "transitive"; grain: Grain }
  | { _tag: "And" | "Or"; of: ReadonlyArray<Prop> } | { _tag: "Not"; of: Prop }
  | { _tag: "Label"; name: string; args: Json; of: Prop }       // semantically identity; drives messages
type Count = { op: "eq" | "gte" | "lte"; n: Natural }           // Exists = gte 1

type Rule =
  | { _tag: "Forall"; meta: RuleMeta; subjects: Selector; holds: Prop }
  | { _tag: "Custom"; meta: RuleMeta; run: (g: Graph) => ReadonlyArray<ViolationInput> }  // only closure
type RuleMeta = { id: RuleId /*branded, non-empty*/; reason?: string; severity: "error" | "warning" | "info" }
type Policy = { rules: NonEmptyArray<Rule> }   // Policy.make rejects duplicate ids (makeFilter)

type Witness =
  | { _tag: "Chain"; edges: NonEmptyArray<DependencyRef> }      // shortest, ties by path order
  | { _tag: "Cycle"; edges: NonEmptyArray<DependencyRef> }      // closed chain, rotated to min node
  | { _tag: "Row"; rel: Relation; row: Json; line?: number }
  | { _tag: "Absent"; expected: Prop }                          // a positive claim found nothing
type Violation = { ruleId; severity; subject: NodeId; witness: Witness; message: string;
                   fingerprint: Fingerprint /* branded string */ }
type Report = { violations; suppressed: Violation[]; stale: BaselineEntry[]; counts: Record<Severity, number>;
                verdict: "pass" | "fail"; graphStats: { files: number; dependencies: number } }
```
`Fingerprint` is a canonical string `ruleId|subject|witnessKey` (witness without line numbers or wording;
cycles rotated). No hash: no crypto dependency and string equality is trivial in Lean.

### 1.2 Functions
```ts
// pure core (Lean-specified). Violation unit: one per witness; subject-level (Absent) when no witness.
declare const check: (policy: Policy, graph: Graph) => ReadonlyArray<Violation>   // sorted: subject, ruleId, fingerprint
declare const Baseline: {
  record: (vs: ReadonlyArray<Violation>) => Baseline
  apply:  (b: Baseline, vs: ReadonlyArray<Violation>, o: { failOn: "error" | "warning" }) => Report
  Schema: Schema.Codec<Baseline>     // { version: 1, entries: [{ fingerprint, ruleId, subject }] } sorted
}
declare const Policy: { make: (rules: ReadonlyArray<Rule>) => Result<Policy, PolicyError>
                        typecheck: (p: Policy, shape: GraphShape) => Result<Policy, PolicyError> }  // fields vs tables

// effectful shell
class Analyzer extends Context.Service<Analyzer, {
  readonly analyze: (w: Workspace) => Effect.Effect<Graph, AnalysisError>
}>()("archer/Analyzer") { static readonly ts7: Layer.Layer<Analyzer, never, FileSystem.FileSystem | Path.Path>
                          static readonly memory: (g: GraphLiteral) => Layer.Layer<Analyzer> }

type Enricher = { table: string; fields: Record<string, FieldType>;           // FieldType: "string"|"number"|"boolean"|"string[]"
                  derive: (g: Graph) => Effect.Effect<ReadonlyMap<NodeId, ReadonlyArray<Row>>, EnrichError> }
type Config = { workspace: WorkspaceSpec; policy: Policy | ReadonlyArray<Rule>; enrichers?: Enricher[];
                baseline?: string; failOn?: "error" | "warning"; reporters?: Record<string, Reporter> }
type Reporter = (r: Report, g: Graph) => string                               // pure; DOT needs the graph

declare const Archer: {
  config: (c: Config) => Config                                               // identity + inference (authoring)
  run:  (c: Config, o?: { updateBaseline?: boolean }) => Effect.Effect<{ report: Report; graph: Graph },
          ArcherError, Analyzer | FileSystem.FileSystem | Path.Path>
  load: (path: string) => Effect.Effect<Config, ConfigError, FileSystem.FileSystem | Path.Path>   // import() + decode
  assertPass: (r: Report) => Effect.Effect<void, ArchitectureError>
  layer: Layer.Layer<Analyzer, never, never>   // ts7 over NodeServices; swap with Analyzer.memory(g)
}
```
Builders (all return the data above; zero state, no `.not` toggles):
```ts
Sel.glob(p) Sel.pkg(name) Sel.builtin(n) Sel.unresolved Sel.computed Sel.any Sel.or/and/not Sel.layers({...}) // -> Record<name, Selector> + .all
Prop.where / rows / reach / and / or / not / label / forall(rel, pat) = not(rows(rel, not pat), gte 1)
Rule.forAll(subjects, holds, meta) Rule.custom(id, run, meta)
```

### 1.3 Invariants, ordering, errors
- `check` is total and deterministic; same (policy, graph) gives byte-identical output (sorted by subject, ruleId, fingerprint).
- Order of `Run`: load config -> `Policy.typecheck` -> analyze -> enrich (in config order, each sees prior tables) -> check -> baseline -> verdict. Typecheck failure aborts before spawning TypeScript (fast fail).
- Negation is an operator, not a flag: `Not(Not p) = p`. Dual evidence rule: `explain` pushes Not to atoms (NNF); a failing `Not(Reach|Rows)` yields its witnesses.
- Fail-closed on computed imports is *data*: `forbids(s) = Not(Reach{ to: Or(s, kind=computed) })`; an allow-list names `Sel.computed` to opt in.
- Selector semantics: `Is` on a missing field is false (total). A selector that matches no files is legal; a rule whose `subjects` matches 0 files reports an `info` Violation `empty-subjects` only if `meta.nonEmpty` (opt-in; default silent).
- Errors (Schema.TaggedError): `ConfigError{LoadFailed|DecodeFailed}`, `PolicyError{DuplicateRuleId|EmptyPolicy|UnknownRelation|UnknownField|TypeMismatch}`,
  `AnalysisError{TsconfigUnreadable|ProjectInvalid|AnalyzerCrashed}`, `EnrichError{table,cause}`, `BaselineError{Unreadable|Malformed|VersionUnsupported}`,
  `ArchitectureError{report}` (only from `assertPass`; violations are values, never errors).

## 2. Usage

### 2.1 archer.config.ts, layered app
```ts
import { Archer, Sel, Rule, Prop } from "@lucasacoutinho/archer"
import { layered, strict } from "@lucasacoutinho/archer/presets"

const L = Sel.layers({ domain: "src/domain/**", application: "src/application/**", infrastructure: "src/infrastructure/**" })

export default Archer.config({
  workspace: { tsconfig: ["tsconfig.json"], exclude: ["**/*.generated.ts"] },
  baseline: ".archer-baseline.json",
  policy: [
    ...layered(L, { domain: [], application: ["domain"], infrastructure: ["domain", "application"] },
               { exposeThrough: { domain: "src/domain/index.ts" }, acyclic: true }),
    ...strict(),
    Rule.forAll(Sel.glob("src/legacy/**"), Prop.forbids(Sel.glob("src/new-core/**")),
      { id: "migration/no-new-core", reason: "Legacy code is being removed, not expanded.", severity: "warning" }),
    Rule.forAll(L.domain, Prop.forbids(Sel.or(Sel.pkg("react"), Sel.builtin("fs")), { transitive: true }),
      { id: "domain/portable", severity: "error" }),
  ],
})
```
### 2.2 vitest (no Archer-specific runner code)
```ts
import { it } from "vitest"
import { expectArchitecture } from "@lucasacoutinho/archer/testing"      // Promise surface, throws ArchitectureError
import config from "../archer.config.ts"
it("architecture holds", () => expectArchitecture(config), 30_000)
// Effect users:  it.effect("arch", () => Archer.run(config).pipe(Effect.flatMap(({report}) => Archer.assertPass(report))))
// rule tests with no TypeScript: Effect.provide(Analyzer.memory({ files: { "src/domain/a.ts": { imports: ["npm:react"] } } }))
```
### 2.3 Non-Effect caller (`@lucasacoutinho/archer/testing` and `/promise`)
```ts
import { runCheck, check } from "@lucasacoutinho/archer/promise"
const { report, graph } = await runCheck(config, { cwd: process.cwd() })   // ManagedRuntime(Archer.layer + NodeServices) internally; disposed after
if (report.verdict === "fail") process.exitCode = 1
const vs = check(policy, myGraph)                                          // fully pure, no async, no runtime
```
Rejections are the same typed errors (`instanceof`/`_tag` still work).
### 2.4 Custom rule, derived assertion, custom fact
```ts
// Derived assertion = a function. No registration, no kind, free message via Label.
const fanOutAtMost = (n: number) => Prop.label("fanOutAtMost", { n },
  Prop.rows("dependency", Pat.is("target.kind", Pred.eq("file")), { op: "lte", n }))
Rule.forAll(Sel.glob("src/**"), fanOutAtMost(15), { id: "coupling/fan-out", severity: "warning" })

// Custom fact (effectful, runs once, becomes data): React hooks per file, then a *data* rule over it.
const hooks: Enricher = { table: "hook", fields: { name: "string" }, derive: (g) => scanForHooks(g) }
Rule.forAll(Sel.glob("src/domain/**"), Prop.forall("hook", Pat.not(Pat.true)), { id: "domain/no-hooks", severity: "error" })

// The only closure: something the algebra cannot say (cross-file consistency). Pure and sync.
Rule.custom("naming/file-matches-export", (g) => g.files.flatMap((f) =>
    f.exports.length === 1 && kebab(f.exports[0]) !== f.basename ? [{ subject: f.id, message: "File name differs from its export." }] : []),
  { severity: "warning" })
```
### 2.5 Transitive rule with witness
`domain/portable` above reports, per offending domain file, `Witness.Chain`:
`src/domain/order.ts -> src/shared/util.ts -> npm:react` (shortest, ties by path order). The pretty reporter prints it, JSON keeps `edges` with lines, SARIF turns each edge into a `codeFlow`.
The fingerprint uses node ids only, so moving an import line does not resurrect a baselined violation.
### 2.6 Baseline workflow
```
archer baseline update            # Archer.run(config,{updateBaseline:true}); writes sorted JSON; exit 0
archer check                      # new violations fail; baselined ones land in report.suppressed
archer check --prune-check        # fail if report.stale is non-empty (fixed debt stays recorded)
```
Programmatic: `Baseline.apply(await readBaseline(path), check(policy, graph), { failOn: "error" })` is pure; only reading the file touches `FileSystem`.

## 3. What the implementation hides
- TS7 API process lifecycle (`typescript/unstable/sync` spawn/close, `using` snapshots), tsconfig/project discovery, specifier classification, `rootFiles` as file set.
- Segment-based glob matcher; field typing of Pat against relation shapes; NNF push-down and `explain`.
- Reachability: one BFS/SCC per distinct `(dir, via, grain)` memoized across rules; quotient graphs for Folder/Partition grains; shortest-witness reconstruction with deterministic tie-break; cycle dedup by rotation.
- Enrichment scheduling, config import + schema decode, baseline codec, reporter formatting, sort order, watch mode (`FileSystem.watch` + `Stream.debounce`).
Callers learn: 4 atoms, 1 boolean algebra, 1 selector type. They never learn rule kinds.

## 4. Dependencies and seams
| Dependency | Category | Seam / adapters |
| --- | --- | --- |
| `check`, `Baseline`, matcher, reporters | In-process | No seam. Tested directly, specified in Lean. |
| Analyzer | Process-backed (TS7 Go server) | REAL seam: `Analyzer.ts7` + `Analyzer.memory` (+ fixture-dir variant of ts7 in tests). |
| Enricher | Local, caller-owned | Real *extension* seam (2 adapters in-repo: built-in `declaration`/`use` tables are produced by an Enricher over TS7 snapshots in the ts7 adapter; test fakes in memory). Keeps Analyzer small. |
| FileSystem (config, baseline, output, watch) | Local-substitutable | Effect `FileSystem` (`layerNoop`/temp dir in tests). No Archer port. |
| Config loading | Local | `import()` then Schema decode; `Archer.load` is the only function. |
| Reporters | In-process | Not a seam: `Reporter` is a function type; registry is `Config.reporters` record + built-ins in `/reporters`. |
| Test runners | True external | Collapsed to ONE runner-agnostic adapter (`/testing`) because the seam is "throw on failure". |

## 5. Lean model and desugaring
Primitive semantics to prove (`Graph := files, deps, tables`):
```
evalPat  : Pat -> Row -> Bool                    -- structural; Not/And/Or are Bool ops
evalProp : Prop -> Graph -> Node -> Bool         -- Where, Rows (count), Reach, boolean ops, Label = id
reach    : Graph -> Grain -> EdgeFilter -> Dir -> Node -> List (Node x List Edge)   -- BFS, shortest witness
explain  : Prop -> Graph -> Node -> List Witness -- NNF; [] iff evalProp = true
check    : Policy -> Graph -> List Violation     -- Forall = for each s in files with evalPat subjects, explain; Custom = oracle axiom
```
Theorems: `evalProp (Not (Not p)) = evalProp p`; `explain p s = [] <-> evalProp p s`; Chain witness is a real path and minimal;
`Reach(Subject, transitive, File)` holds iff the subject lies on a cycle (cycle detection is not a separate semantics);
quotient reach lifts file reach; fingerprint is invariant under cycle rotation and line shifts; `apply` suppression is monotone and idempotent;
`check` is permutation-invariant in rule order and graph row order. `Custom` is the sole trust boundary (axiom `run` is a function of the graph).

Desugaring of the legacy table (E = `{kinds?, localOnly?}`, T = transitive):
| Legacy | Derived form |
| --- | --- |
| depends on S | `Reach{out,E,to:S,hops}` |
| not depends on S | `Not(Reach{to: S ∪ computed})` |
| depends only on S | `Not(Reach{to: Not(S)})` (add `computed` explicitly to allow) |
| depended on by S / only by S | `Reach{in, to:S}` / `Not(Reach{in, to:Not S})` |
| free of cycles | `Not(Reach{out,transitive,to:Subject})` |
| folder cycles depth N | same with `grain: Folder N` |
| layer cycles | same with `grain: Partition(layers)`, `localOnly` |
| layer may only depend on A,B | `Not(Reach{out,localOnly,to:Not(A∪B∪self)})` |
| exposeThrough B | subjects `L ∧ ¬B`, holds `Not(Reach{in,localOnly,to:Not L})` |
| resolvable dependencies | `Not(Reach{out,to:kind=unresolved})` (+ `computed` unless `allowDynamic`) |
| line count < n / prefix / suffix | `Where(lines<n)` / `Where(basename Prefix)` / `Where(basename Suffix)` |
| only classes / enums / ... | `forall(declaration, kind=class)` |
| abstract, exported, extends X, implements X, decorator X, readonly props | `forall(declaration, abstract=true)` ... `Is(extends, Some(Eq X))` |
| has method m / public m / only public methods | `rows(declaration, Is(methods, Some(name=m ∧ visibility=public)))` / `forall(declaration, Not(Is(methods, Some(visibility≠public))))` |
| only exports names N | `forall(export, Is(name, In N))` |
| strict equality | `Not(Rows(use, kind=looseEq, gte 1))` |
| forbidden globals / imported symbols | `Not(Rows(use, kind=call ∧ name∈G ∧ importedFrom absent))` / `... importedFrom=M ∧ importedName∈S` |
| ignoring(x) | subjects `S ∧ ¬x` |
| presets, layers | plain functions returning `Rule[]` / `Record<name, Selector>` |
| rule metadata | `RuleMeta` on `Forall`; `Label` carries the assertion name for messages |

## 6. Trade-offs
Leverage high:
- Adding an assertion (fan-out, "only domain may import X") costs one function and zero Lean proof. Primitive count is ~14 constructors vs 17 rule kinds with bespoke evaluators. Cycles, layer cycles, public API, resolvability stop being separate semantics.
- Enrichers + relations give real custom facts (React hooks, Vue, ownership) in a data rule, so baseline/fingerprints/reporters keep working. Custom closures shrink to rare cross-file cases.
- Runner story collapses 7 entry points to 1 (`/testing`) plus the CLI; presets need no global registry (npm package exports a function).
Leverage thin / risk:
- Messages: a desugared `Not(Reach{to:Not S})` is unreadable without `Label`. `Label` is an extra node and every derived constructor must remember it; unlabelled user props get a generic printer.
- Field names are strings on custom tables (`Rows("hook", ...)`): typos surface at `Policy.typecheck`, not compile time. Built-in builders are typed; custom ones are not.
- Callers who just want `expect(domain).not.toDependOn(infra)` need the sugar layer (`Prop.forbids` etc.). The algebra is a second thing to learn; shallow for the simple 80% case.
- Quantification over joins is omitted (`Some` only nests). "class extends X *and* is decorated Y on the same declaration" works; cross-row joins do not, so they go to Custom.
- Generic `Rows` evaluation is slower than bespoke loops; memoizing `reach` is mandatory for 10k-file graphs.
- Trust boundary widens with Enrichers: Lean proves checks over any table, but table correctness is the enricher author's problem.
Dropped from the legacy surface, and why:
- Fluent `expect().not.toX()` with mutable modifiers (`.not`, `.transitively()` reset-after-use is a state bug source, not data). The sugar is plain functions.
- `/vitest`, `/jest`, `/bun`, `/node` `arch()` adapters, `/*/plugin` matcher setups and the vitest config plugin. Deletion test: each is a <15 line wrapper over "run check, throw on fail"; deleting them moves that one line to the caller and loses nothing (config-plugin "once per run" is a vitest `globalSetup` calling `runCheck`). One `/testing` replaces all.
- Async custom rules (impure `check`) -> Enrichers; `registerPreset` global map -> functions; aliases (`toUse`, `toBeUsedIn`); `llm` reporter alias; `peerDependencies` on jest/vitest; CJS build (ESM only).
- Kept: CLI (`check`, `baseline update`, `init`, `graph`), reporters pretty/agent/json/sarif/github/dot as pure functions.
