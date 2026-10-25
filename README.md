# Archer

Architecture tests for TypeScript and JavaScript. You describe which parts of
your code may depend on which. Archer analyzes the project with TypeScript and
reports every import that breaks the rules.

```sh
npm install --save-dev @lucasacoutinho/archer
```

Archer needs Node 22.18 or newer and is ESM only.

## Quick start

```sh
npx archer init     # writes archer.config.ts
npx archer check    # exit 0: pass, 1: violations, 2: cannot check
```

```ts
// archer.config.ts
import { defineConfig, presets, r } from "@lucasacoutinho/archer"

export default defineConfig({
  layers: {
    app: "src/app",
    domain: "src/domain",
    infrastructure: "src/infrastructure",
  },
  // Top to bottom: a layer may depend only on the layers below it.
  stack: ["app", "domain"],
  // Further dependencies, by layer.
  allow: { infrastructure: ["domain"] },
  rules: [
    ...presets.recommended, // no import cycles, every import resolves
    r.forbid("domain/pure", "layer:domain", ["npm:*", "node:*"]),
  ],
})
```

To run the same check in your test suite, add one test. This works in Vitest,
`node:test`, Bun, and Jest in ESM mode:

```ts
import { assertArchitecture } from "@lucasacoutinho/archer"

test("architecture", () => assertArchitecture())
```

## Selectors

A selector is a string, an array of selectors (any of them), `{ not: … }`, or
`{ all: [...] }`.

| Text | Selects |
| --- | --- |
| `src/domain` | Every file at or under `src/domain` |
| `src/**/*.ts`, `src/*/index.ts`, `src/a?.ts` | Path globs: `**` spans directories, `*` and `?` stay within one name |
| `{src/a,src/b}/**` | Either alternative |
| `npm:react`, `npm:@scope/pkg`, `npm:*` | Installed packages, with any subpath |
| `node:fs`, `node:*`, `bun:*` | Built-in modules |
| `layer:domain` | The files of a layer |
| `unresolved:*` | Imports that TypeScript could not resolve |
| `computed:*` | `import(x)` and `require(x)` without a literal specifier |

Paths are relative to the project root and always use `/`.

## Rules

Every rule takes a stable ID first. Findings and baselines key on it.

```text
r.forbid(id, subject, object, options?)
```

| Rule | Meaning |
| --- | --- |
| `r.forbid` | The subject must not depend on the object |
| `r.require` | The subject must depend on something the object selects |
| `r.onlyDependOn` | The subject may depend only on the object |
| `r.forbidDependents` | Files the object selects must not depend on the subject |
| `r.requireDependents` | Some file the object selects must depend on the subject |
| `r.onlyDependedOnBy` | Only files the object selects may depend on the subject |
| `r.acyclic(id, subject, { folderDepth? })` | No import cycles, among files or among folders |
| `r.resolvable(id, subject, { allowComputed? })` | Every import resolves |
| `r.declares(id, subject, predicate)` / `r.declaresNone` | Every (or no) declaration satisfies a `p.*` predicate |
| `r.exportsOnly(id, subject, names)` | The files export only these names |
| `r.forbidUse(id, subject, use)` / `r.requireUse` | Calls and `==` checks, from `use.*` |
| `r.prefix` / `r.suffix(id, subject, text)` | File names start or end with `text` |
| `r.maxLines(id, subject, max)` | Files have at most `max` lines |
| `r.custom(id, subject, ({ graph, subject }) => messages)` | Your own check; each message is a finding |

Options for every rule: `severity` (`"error"`, `"warning"`, or `"info"`) and
`reason`. Dependency rules also take:

- `transitive: true` follows imports through other files. A finding then shows
  the shortest import chain.
- `kinds` limits the import kinds: `"static"`, `"type"`, `"require"`, or
  `"dynamic"`.
- `localOnly: true` ignores packages and built-ins.

Predicates for `r.declares`:

```ts
import { p, use } from "@lucasacoutinho/archer"

p.kind("class")
p.extends("Base")
p.implements("Runnable")
p.decorator("Controller")
p.hasMethods(["run"], "public")
p.onlyPublicMethods
p.abstract
p.exported
p.readonlyProperties
p.all(p.kind("class"), p.exported)
```

Uses for `r.forbidUse`:

```ts
use.looseEquality
use.globals("eval")
use.imported("react", "useEffect")
```

Archer applies these semantics:

- **Unknown imports fail closed.** An import whose target Archer cannot know
  (`computed:*`) breaks every `forbid` rule. Allow it explicitly when you mean
  it.
- **Layer rules check direct imports between declared layers.** Files outside
  every layer are unconstrained.
- **Mistyped paths are listed, not failed.** A rule that selects no files is
  listed as information under `emptySubjects`, and a rule whose target glob
  matches nothing is listed under `emptyObjects`.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `layers`, `stack`, `allow` | | Layers and the dependencies allowed between them |
| `publicApis` | | `{ domain: "src/domain/index.ts" }`: other layers may import a layer only through its entry |
| `rules` | | Rules from `r.*` and `presets` |
| `root` | `.` | The project root, relative to the config file |
| `projects` | `["tsconfig.json"]` | The tsconfigs whose files Archer analyzes |
| `baseline` | `.archer-baseline` | The baseline file, or `false` |
| `failOnWarnings` | `false` | Whether warnings fail the check |

## CLI

| Command | Does |
| --- | --- |
| `archer check` | Checks and prints a report |
| `archer check -w` | Checks again after every change, in a fresh process |
| `archer baseline record` | Accepts every current violation |
| `archer baseline prune` | Drops baseline entries that no violation has |
| `archer graph -o graph.json` | Saves the analysis. `archer check --graph graph.json` checks it without TypeScript |
| `archer init` | Writes a starter config |

`check` options:

| Option | Meaning |
| --- | --- |
| `-c, --config <file>` | The config file. Default: `archer.config.{ts,mts,js,mjs}` |
| `-r, --reporter <name>` | `pretty`, `agent` (one line per finding, for tools and agents), `json`, `sarif`, `github` (annotations), or `dot` (the import graph) |
| `-o, --output <file>` | Write the report to a file |
| `--ignore-baseline` | Report every violation |

## Baselines

To adopt Archer in a codebase with existing violations, run
`archer baseline record` and commit `.archer-baseline`. Later checks fail
only on new violations. When you fix old violations, run
`archer baseline prune`.

## Programmatic use

```ts
import { check, graphOf, run } from "@lucasacoutinho/archer"
import config from "./archer.config.ts"

const { report } = await run({ config: "archer.config.ts" })

// Test a policy against a graph in memory, without TypeScript:
const result = check(config, graphOf({ "src/domain/a.ts": ["src/app/b.ts"], "src/app/b.ts": [] }))
```

`@lucasacoutinho/archer/effect` exposes the same operations as Effect values.
It also exposes the `Analyzer` service, with `typescript`, `memory`, and
`replay` adapters.

## Agent skill

[`skills/archer`](skills/archer/SKILL.md) teaches a coding agent to set up
Archer, read `archer check -r agent`, and fix violations in source. Install it
with `npx skills add lucasacoutinho/archer --skill archer`.

## Development

```sh
npm install      # also patches tsc with @effect/tsgo
npm run check    # Lean proofs, type check, tests, build, Archer on itself
```

`npm run check` needs [elan](https://github.com/leanprover/elan): Lean is
pinned in `lean/lean-toolchain`. See [architecture](docs/architecture.md) for
how Archer is built, and [verification](docs/verification.md) for what is
proved and how the proofs reach the code.

Releases publish from the `Publish package` workflow when you publish a
GitHub release. The workflow uses npm trusted publishing with provenance.
Add the release to [CHANGELOG.md](CHANGELOG.md) first.

## License

[Apache 2.0](LICENSE). See [NOTICE](NOTICE).
