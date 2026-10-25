# Changelog

## 0.3.0 - 2026-10-24

Archer is rebuilt from scratch. The pure core is specified in Lean 4, with
proofs for the glob matcher, reachability, the check, layer lowering,
fingerprints, baselines, and selector text. The TypeScript code is a port of
that model. Its correspondence is tested, not proved: differential tests compare
the port with the Lean implementation. The public API is new, so read the
breaking changes before you upgrade. The README documents it.

### Breaking changes

- Removed the fluent builder: `createArcher`, `archer.expect(...)`, `arch()`,
  the `.not`, `.and`, and `.transitively()` modifiers, and the Pest-style
  aliases. Rules are now plain data from the `r.*` constructors, listed in the
  `rules` array of the config. For example,
  `.expect('src/domain/**').not.toDependOn('src/infrastructure/**')` becomes
  `r.forbid('domain/isolation', 'src/domain', 'src/infrastructure')`.
- Removed `archer.layers()` and `.where(...)` (`mayNotDependOn`,
  `mayOnlyDependOn`, `mayOnlyBeUsedBy`, `exposeThrough`). Layers are config
  fields now: `layers`, `stack`, `allow`, and `publicApis`.
- Removed the `/vitest`, `/jest`, `/bun`, and `/node` entry points, the
  `/vitest/plugin`, `/jest/plugin`, and `/bun/plugin` matcher setup modules, and
  the Vitest config plugin. Call `assertArchitecture()` in a Vitest, Jest, or
  `node:test`, or `bun test` test, or run `archer check` before the tests.
- The package is ESM only. The CommonJS build is gone. Jest needs its ESM mode.
- Archer requires Node.js 22.18 or newer. It supported Node.js 20.
- Archer analyzes projects with the native TypeScript 7 compiler API, which it
  bundles. It used TypeScript 5.9. A tsconfig that TypeScript 7 reports errors
  for stops the run with `ProjectParseFailed`.
- Custom rules are synchronous. `toSatisfy(id, fn)` becomes
  `r.custom(id, subject, check)`. `check` receives `{ graph, subject }` once per
  subject file and returns an array of messages. A throw becomes one finding.
- Every rule needs an id, as the first argument of its constructor. Ids must be
  unique. The ids `layer/<name>` and `public-api/<name>` belong to layer rules.
- The selector prefix `dynamic:*` is now `computed:*`.
- Path selectors no longer accept character classes (`[...]`) or backslashes.
  Archer reports a selector that contains one as a configuration error. Braces
  still work.
- A plain path selects everything under it: `src/domain` now means
  `src/domain/**`. A path with a wildcard means exactly its tokens, so
  `src/domain/*` selects only the files directly inside `src/domain`.
- A rule whose subject selects no source file now passes, and the report lists
  it in `emptySubjects`. It used to fail. A config with no rules is now a
  configuration error (`EmptyPolicy`) instead of a violation.
- The baseline has a new format and a new default path. `.archer-baseline`
  replaces `.archer-baseline.json`. The file starts with the line
  `archer-baseline 1` and holds one line per accepted violation. Run
  `archer baseline record` to write a new one. Archer rejects a file in any
  other format with a `BaselineError`.
- Replaced CLI flags. `--update-baseline` is now `archer baseline record`. The
  `--baseline <file>` and `--fail-on-warnings` flags are now the `baseline` and
  `failOnWarnings` config fields. The `llm` reporter alias is gone, so use
  `agent`.
- Removed the config fields `include`, `exclude`, `workspaces`,
  `followSymlinks`, `cache`, and `tsconfig`, and the `rules(archer)` function
  form. The `projects` field is now a list of tsconfig files. Archer analyzes
  the files that those tsconfigs include and no longer discovers workspaces or
  follows project references, so list every tsconfig.
- Removed `archer.preset()`, `registerPreset`, and the `strict`, `node`, and
  `security` presets. `presets.recommended` is a plain array of two rules (no
  import cycles, every import resolves) that you spread into `rules`.
- The root export is new. Removed `ArchitectureSuite`, `ArchitectureLayers`,
  `analyze`, `report`, `formatResult`, `archerMatchers`, and the baseline
  helpers. `ArchitectureError` now wraps a `Report`.

### Added

- Reports list `emptyObjects`: dependency rules whose target names files by a glob but selects none, which is usually a mistyped path.
- `archer check --watch` runs each check in a fresh process. Edits to modules that `archer.config.ts` imports take effect, memory stays flat over long sessions, and the `--output` file does not trigger a new run.

- `archer baseline record|prune`, `archer graph -o <file>`, and
  `archer check --graph <file>`. `archer check --ignore-baseline` reports every
  violation, including the ones that the baseline accepts.
- Exit codes. `archer check` exits with 0 when the report passes, 1 when it
  fails, and 2 when Archer cannot check at all: a missing or invalid config, a
  missing tsconfig, an unreadable baseline, or an invalid saved graph. Archer
  prints the cause as a readable message. An invalid config lists one issue per
  line, such as `layers.a: 'src//x' is not a selector (InvalidSegment)`.
- The config fields `root`, `projects`, `layers`, `stack`, `allow`,
  `publicApis`, `rules`, `baseline`, and `failOnWarnings`.
- Rule constructors: `r.forbid`, `r.require`, `r.onlyDependOn`,
  `r.forbidDependents`, `r.requireDependents`, `r.onlyDependedOnBy`,
  `r.acyclic` (with `folderDepth` for cycles between folders), `r.resolvable`,
  `r.declares`, `r.declaresNone`, `r.exportsOnly`, `r.forbidUse`,
  `r.requireUse`, `r.prefix`, `r.suffix`, `r.maxLines`, and `r.custom`. They
  take `kinds`, `transitive`, `localOnly`, `severity`, and `reason` options where
  those apply. Also the declaration predicates `p.*` and the usage helpers
  `use.looseEquality`, `use.globals`, and `use.imported`.
- Selector combinators: an array is a union, `{ not }` negates, and `{ all }`
  intersects. `layer:<name>` refers to a layer.
- The root functions `assertArchitecture`, `run`, `renderReport`, `check`,
  `graphOf`, and `dispose`. `check` and `graphOf` test a policy against a graph
  in memory, without TypeScript or files. Errors keep their `_tag`.
- The `@lucasacoutinho/archer/effect` entry with the Effect surface: the
  schemas, `run` and `checkGraph`, the `Analyzer` service with `typescript`,
  `memory`, and `replay` layers, `ArcherLive`, `GraphFile` with
  `formatGraphFile` and `readGraphFile`, and the typed errors, including
  `GraphFileInvalid`.
- Saved graphs. `archer graph -o <file>` writes the analyzed graph, and
  `archer check --graph <file>` checks it without starting TypeScript.
  `Analyzer.replay` does the same in Effect programs.
- Reports list stale baseline entries and the rules that select no source file.
  `archer baseline prune` removes stale entries. Archer writes baselines through
  a temporary file and a rename.
- The `archer` agent skill in `skills/archer` is rewritten for the new config
  and CLI. It still ships in the npm package.
- Specification and verification: Lean 4 contracts and proofs under `lean/`, a
  Lean oracle, and differential tests that compare the TypeScript port with the
  oracle on 400 seeded inputs. See `docs/contracts/README.md` for what is proved
  and what is evidence only.

## 0.2.1 - 2026-10-24

### Fixed

- Moved `typescript` from `peerDependencies` to `dependencies` (`^5.9.0`).
  Archer uses the TypeScript compiler API to parse imports, and TypeScript 7
  ships no JavaScript API, so projects on TypeScript 7 could not install or load
  Archer. Archer now brings its own TypeScript, and the project no longer needs
  to install it.

## 0.2.0 - 2026-10-24

### Breaking changes

- Renamed the package from `@usescherie/archer` to `@lucasacoutinho/archer`.
  Update imports, setup files, and preloads to the new scope. No public
  consumers of the old name exist; it was only published to a private registry.

### Changed

- Licensed Archer under Apache-2.0 and added a `NOTICE` file.
- Moved the repository to `github.com/lucasacoutinho/archer`.
- Publishing now targets the public npm registry through npm trusted
  publishing (OIDC) with provenance, replacing private GitHub Packages
  publication.

## 0.1.0 - 2026-07-31

- Initial release.
