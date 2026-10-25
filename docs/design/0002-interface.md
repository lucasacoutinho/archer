# 0002: Caller-facing interface

Status: proposed. The decisions at the end have defaults that the owner can override.

Four candidates were designed in parallel from [0001](0001-problem-space.md),
each under a different constraint. Their full write-ups are in
[`candidates/`](candidates/). Terms follow [GLOSSARY.md](../GLOSSARY.md).

| | Constraint | Core idea |
| --- | --- | --- |
| [A](candidates/A-minimal.md) | Minimal interface | Three exports: `Config`, `check`, `Report`. A policy is a plain object literal. |
| [B](candidates/B-flexible.md) | Flexibility | A rule is `Forall(subjects, Prop)` over a boolean algebra of four atoms. Every legacy assertion is a derived function. |
| [C](candidates/C-common-caller.md) | Common caller | `layers` + `stack` + `allow` is the whole default policy. The root export uses Promises, and `./effect` holds the core. |
| [D](candidates/D-ports.md) | Ports and adapters | A hexagon around the pure check, with a strict Analyzer contract, a shared contract suite, and a `replay` adapter. |

## Where the candidates agree

All four candidates reached these conclusions independently, so treat them
as settled:

- **Delete every runner adapter.** `./vitest`, `./jest`, `./bun`, `./node`,
  and the three matcher setup modules all fail the deletion test. Each one
  wraps "run the check, fail on a bad verdict" in less than 15 lines, and the
  complexity does not come back in callers: one call inside any runner's
  `test` replaces all of them. Archer stops depending on any test runner.
- **Delete the fluent builder.** Its `.not`, `.transitively()`, and
  "decorate the last rule" state depend on call order. The Lean model cannot
  describe that state, and data cannot represent it.
- **Make the fingerprint a canonical string,** `ruleId|subject|witnessKey`.
  It contains no hash, no line numbers, and no message wording. String
  equality is trivial in Lean, and the encoding needs no crypto.
- **Make the Analyzer the one real Archer seam,** with `typescript` and `memory`
  adapters. FileSystem is Effect's own seam. Reporters are a table of pure
  functions, not a seam. The baseline is a codec over FileSystem.
- **Make presets plain arrays or functions.** The global preset registry goes.
- **Ship ESM only.** The CJS build goes.

## Where they differ

**Depth.** A has the most leverage per export, but its authoring cost is
high because callers write raw tagged literals. B's algebra is the deepest
for extension, but it is shallow for the common case: callers have to learn
`Not(Reach{to: Not S})` before they can say "only S", and messages depend on
`Label` nodes. C makes the common case nearly free, at the price of two
surfaces (Promise and Effect) that must not drift. D adds no caller
convenience. Its depth is in the shell: the pipeline order, the baseline
modes, watch, and atomic writes.

**Locality.** B gives the best locality for proofs. Cycles, public API,
resolvability, and layer rules all collapse into `Reach`, so one semantics
covers them. C and A get most of that by putting all four dependency
assertions into one `Reach`/`Depends` member, while keeping `Acyclic`
separate so that cycle witnesses stay first-class.

**Seam placement.** D is the only candidate that specifies what the Analyzer
promises: determinism, path normalization, one edge per import site, and the
kind rules. It is also the only one with a contract suite that every adapter
must pass. That contract is the formal statement of the trust boundary
between TypeScript and the Lean model, so it belongs in any final design.
D's `ConfigLoader` port is marginal, and D says so itself. Its vitest config
plugin keeps runner coupling for a benefit that `archer check && vitest`
already provides.

## Recommendation: a hybrid

Take C's caller surface, A's single verb and data discipline, C's rule core
with B's selector algebra, and D's Analyzer contract and baseline modes.

### Policy data (the Lean-specified core)

```ts
type Selector =                                    // a boolean algebra over targets (C, B)
  | Glob { path: PathPattern }                     // pre-parsed segments, see contracts/pattern.md
  | Package { name } | Builtin { runtime: "node" | "bun", name }
  | Unresolved | Computed
  | Or { of: NonEmpty<Selector> } | And { of: NonEmpty<Selector> } | Not { of: Selector }

type EdgeFilter = { kinds: NonEmptySet<DependencyKind>; localOnly: boolean; transitive: boolean }

type Rule = Meta & (                               // Meta = { id: RuleId, severity, reason? }
  | Reach      { subject, direction: "out" | "in", relation: "forbid" | "require", object: Selector, edges }
  | Acyclic    { subject, edges, folderDepth?: PositiveInt }
  | Resolvable { subject, allowComputed: boolean }
  | Declares   { subject, relation: "every" | "none", predicate: DeclPredicate }
  | Uses       { subject, relation: "forbid" | "require", use: UseSpec }
  | Named      { subject, affix: "prefix" | "suffix", value: NonEmptyString, relation }
  | MaxLines   { subject, max: PositiveInt }
  | Custom     { subject, name: string })   // name refers to a closure in Config.custom (A)

type Policy = { rules: NonEmpty<Rule> }            // no layers: lowered away before check
```

- "Depends only on S" is `Reach forbid (Not S)`. "Used only by S" uses
  `direction: "in"`. `publicApi(layer, entry)` and every layer table entry
  lower to `Reach` before the check runs, so the Lean model contains no layer
  node. The lowering itself is a Lean definition with a proved equivalence.
- `Custom` sits in the policy as data, so its id, fingerprint, and baseline
  behavior work like any other rule. In the model it is an opaque oracle
  (`CustomRules`). The closure takes no options: it is defined in the same
  configuration file and closes over what it needs. The shell wraps each
  closure before it becomes `CustomRules`, so a throw returns the single
  message `custom rule crashed: <reason>` as `Custom` evidence under the
  rule's own ID. The check stays total and needs no extra rule or evidence
  kind.
- Computed imports fail closed for `forbid` rules. That behavior is a
  documented clause of `Reach` semantics, not a hidden special case.

### Caller surface

The names follow the glossary. `check` is the pure step from a policy and a
graph to violations. `run` is the effectful pipeline: load, analyze, check,
baseline, verdict.

| Export | Contents |
| --- | --- |
| `.` | Plain TypeScript: no Effect types in any signature. `defineConfig`, the `r.*` rule constructors (each returns plain data), `presets`, the pure `check(config, graph)`, `Graph.fromLiteral`, `run(options): Promise<Report>`, `assertArchitecture(options): Promise<void>`, `render`, `dispose`, and the error classes, which are `Error` subclasses with a `_tag`. |
| `./effect` | The Effect surface that `.` is built on: the schemas, `run` as an Effect, the `Analyzer` service with `typescript`, `memory`, and `replay`, `ArcherLive`, and the typed errors. It is for Effect callers and for integrators. |
| bin `archer` | `check [--watch] [--reporter] [--output] [--graph]`, `baseline record\|prune`, `graph`, `init`. |

`check` stays pure even with custom rules, because custom rule closures are
synchronous functions of the graph. It lowers the config (layers, `stack`,
`allow`, presets) and then evaluates the policy. Both steps are Lean
definitions.

The default configuration is C's:

```ts
export default defineConfig({
  layers: { web: "src/web/**", app: "src/app/**", domain: "src/domain/**", infra: "src/infra/**" },
  stack: ["web", "app", "domain"],
  allow: { infra: ["app", "domain"] },
  rules: [r.forbid("layer:domain", ["npm:*", "node:*"], { id: "domain/pure" })],
})
```

The default test is one line in any runner:

```ts
import { assertArchitecture } from "@lucasacoutinho/archer"
test("architecture", () => assertArchitecture())
```

Testing the policy itself needs no TypeScript process and no disk:

```ts
const report = check(config, Graph.fromLiteral({ "src/domain/a.ts": ["src/infra/db.ts"], "src/infra/db.ts": [] }))
```

### Shell (D)

- The Analyzer contract follows D §1.2 verbatim: a whole graph or an error,
  byte-deterministic ordering, normalized root-relative paths, exactly one
  dependency per import site, explicit kind rules, and builtin
  classification. One `analyzerContract` suite runs against `typescript` and
  `replay`.
- The `replay` adapter reads an encoded graph. It is the exchange format for
  Lean differential tests and for CI-split analysis.
- Baseline modes are `apply`, `ignore`, `record`, and `prune`. Stale entries
  are reported. Writes are atomic and sorted.
- `ConfigLoader` is not a port. `run` takes `Config | path`.

### Not adopted

- B's general `Prop` algebra and Enrichers. They add proof leverage, but
  they are the wrong shape for the common caller. Revisit them when someone
  needs a custom fact.
- The vitest config plugin. It is runner coupling, and `archer check &&
  vitest` gives the same once-per-run behavior.

## Risks

- **Unstable upstream surfaces.** In Effect 4.0.6, `FileSystem`, `Path`,
  the CLI, `Graph`, `@effect/platform-node`, and `@effect/vitest` are marked
  `@stability unstable`. The TypeScript 7 API is `typescript/unstable/sync`.
  The whole shell depends on both. Mitigation: pin exact versions, list the
  unstable Effect APIs in `allowedUnstableApis` for `@effect/tsgo`, and keep
  every TypeScript call inside the `typescript` adapter, where the analyzer contract
  suite catches upstream drift.
- **Behavior changes from the first design.** Custom rules become
  synchronous, because `check` is pure. A policy with no rules becomes a
  `ConfigError` instead of a violation. Each runner adapter becomes a single
  call in the caller's test file. Vitest, `node:test`, and `bun test` run
  that call unchanged. Jest needs its ESM mode, because the package is ESM
  only. Bun works because the analyzer uses TypeScript's async API. The sync
  API needs a file descriptor for standard output, which Bun does not
  provide.

## To settle before the rule contracts

These choices go into the Lean contracts. Each one is stated here so that
the contracts do not settle it by accident.

1. **Subjects are source files.** A rule's `subject` selector ranges over
   source files only, so `Not(Glob src/gen/**)` as a subject selects the
   source files outside `src/gen`, not packages. An `object` selector ranges
   over all targets.
2. **Computed imports fail closed.** A `Computed` target violates
   `Reach forbid S` for every `S` unless `S` explicitly selects `Computed`.
   The witness is the computed import site. `Reach require S` is never
   satisfied by a computed edge. `Resolvable` treats a computed edge as
   unresolved unless `allowComputed` is set.
3. **Vacuous subjects.** A rule whose subject selector matches no source
   file passes, but the report lists it as an `info` finding
   (`archer/empty-subject`), so a mistyped glob is visible. Legacy failed
   such rules.
4. **Vacuous declarations.** `Declares every P` holds for a file with no
   declarations. `Declares none P` holds trivially as well. A policy that
   must reject empty files says so with `MaxLines`, or with a `Declares`
   rule that requires at least one declaration of a kind. The contract
   proves the vacuous case explicitly so that this choice stays visible.

## Decisions, with defaults the owner can override

1. **Direction:** the hybrid above.
2. **Root export:** plain TypeScript and Promise-based, as in candidate C.
   The owner's decision is that Effect is how the package is built, not a
   style that callers must adopt. The root is a thin wrapper over
   `./effect`, which uses one lazy `ManagedRuntime` per process. The
   implementation does not depend on the root.
3. **`replay` ships in version 1.** The Lean differential tests and the
   analyzer contract suite need the serialized-graph format anyway. The
   encoding is versioned from day one.
