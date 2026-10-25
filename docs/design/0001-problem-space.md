# 0001: Problem space for the Archer redesign

Status: framing. The interface is chosen in 0002.

The previous implementation (`5bf302f`, kept untracked in `.legacy/`) is the
first design. This record states the constraints that any second design must
meet. Terms follow [GLOSSARY.md](../GLOSSARY.md).

## What Archer must keep doing

Callers state a policy about a TypeScript or JavaScript workspace. Archer
analyzes the workspace into a graph with facts, checks the policy, and
returns a report. The CLI, test runners, and agents consume that report.

The rule vocabulary from the first design, which is the requirement baseline:

| Family | Assertions |
| --- | --- |
| Dependency | depends on, depends only on, is depended on by, is depended on only by. Each one can be negated, restricted by an edge filter, and checked transitively with a witness chain. |
| Structure | free of cycles (file level, or folders collapsed to depth N), all dependencies resolvable, public API exposure (a layer reachable only through its entry file). |
| Declarations | only classes, interfaces, enums, functions, or types; abstract; exported; extends; implements; decorator; readonly properties; method existence and visibility; exports exactly a set of names. |
| Uses | strict equality, forbidden globals, forbidden imported symbols (matched by module and export name). |
| Naming and size | file-name prefix or suffix, line count limit. |
| Composition | named layers, presets, custom rules over the graph. |
| Results | rule metadata, fingerprints, baseline, reporters (pretty, agent, JSON, SARIF, GitHub, DOT). |

Each row needs a contract before it gets an implementation. A row can be
dropped only by an explicit decision.

## Hard constraints

1. **Stack.** Effect 4 for effects, services, typed errors, and schemas.
   TypeScript 7 for analysis and compilation. `@effect/tsgo` adds Effect
   diagnostics to the type check. `@effect/vitest` runs the tests.
2. **Few dependencies.** Runtime: `effect`, `@effect/platform-node`, and
   `typescript`. Development: `vitest`, `@effect/vitest`, `@effect/tsgo`.
   The first design's other dependencies go away:

   | Removed | Replacement |
   | --- | --- |
   | `jiti` | Native `import()` of `archer.config.ts` (Node type stripping) |
   | `picomatch` | Archer's own segment-based selector matcher, specified in Lean |
   | `commander` | Effect CLI |
   | `chokidar` | Effect `FileSystem.watch` |
   | `tinyglobby` | The file list from TypeScript's parsed tsconfig |
   | `tsup` | `tsc` emit, ESM only |
   | Jest, Bun, oxlint, oxfmt, publint, attw | Decided per integration in 0002 |

3. **Native checks over regex.** Schemas validate with structural checks
   (length, integer bounds, literals, tagged unions, brands, custom
   predicates). A regex check needs a recorded reason. Selector matching
   compares path segments and does not compile globs to regular expressions.
4. **Formalized.** The pure core has a Lean 4 model with checked proofs:
   selector semantics, rule semantics over a graph, transitive reachability
   with witnesses, cycle detection, layer rules, and baseline suppression.
   The TypeScript core is a handwritten port, so its correspondence to the
   model stays an open obligation. Differential tests against the Lean
   model are evidence for that obligation, not a proof of it.
5. **Rules are data.** A rule is a schema-described value, not a closure
   stored in a builder. This keeps the Lean model, the config boundary, the
   baseline, and the reporters in agreement. Custom rules are the only
   closures, and they sit behind an explicit escape hatch.

## What TypeScript 7 gives the analyzer

Measured on the first design's fixture project (spike in the session
scratchpad):

- `API.parseConfigFile(tsconfig)` returns the compiler options and the file
  list, so tsconfig defines the source file set.
- `SourceFile.imports` contains every import declaration, re-export,
  `import()` type, `require` call, and literal `import()` expression.
- One batched `checker.getSymbolAtLocation(specifiers)` resolves each
  specifier to a module symbol whose declaration carries the target path.
  Path aliases resolve.
- Built-ins without installed types come back unresolved, so they are
  classified from the specifier. Computed `import(x)` needs an AST walk.
- The API is an RPC client to a spawned Go process. Analysis of 14 files
  took 140 ms including startup.

## Dependency categories

| Dependency | Category | Consequence |
| --- | --- | --- |
| Check (policy × graph → violations) | In-process | Pure. Tested directly and proved in Lean. No adapter. |
| Analyzer (workspace → graph) | Process-backed (the TypeScript native server) | A real seam with two adapters: the TypeScript adapter, and an in-memory graph for tests. Rule tests never spawn TypeScript. |
| File system (config, baseline, report output, watch) | Local-substitutable | Effect `FileSystem`. Tests use fixture directories or an in-memory layer. |
| Config loading | Local | Native `import()` followed by schema decoding at the boundary. |
| Test runners | True external | Each integration is an adapter over the same check. 0002 applies the deletion test to every runner entry point. |

## Illustrative sketch

This is not a proposal. It shows the shape that the constraints imply.

```ts
// Pure core, the part the Lean model specifies
type Rule = DependsOnly | DependsOn | FreeOfCycles | Declares | ...  // tagged, schema-described
type Policy = ReadonlyArray<Rule>
declare const check: (policy: Policy, graph: Graph) => ReadonlyArray<Violation>

// Effectful shell
class Analyzer extends Service<Analyzer, {
  readonly analyze: (workspace: Workspace) => Effect<Graph, AnalysisError>
}>() {}

// Caller-facing: the part with real design freedom
const policy = /* builder? object literal? layer table? */
```

The open question for 0002 is the caller-facing interface: how callers write
a policy, how they run a check, and which runner integrations survive.
