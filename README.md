# Archer

Architecture tests for TypeScript and JavaScript projects. Archer reads your imports with TypeScript's native compiler API, builds the dependency graph, and checks it against rules that you write as plain data: layers, dependency rules, import cycles, declaration rules, and custom checks. A finding names the file, the import site, and for a transitive rule the shortest chain of imports. You run the check from the `archer` command or from a test in Vitest, Jest, or `node:test`.

## Install

```sh
npm install --save-dev @lucasacoutinho/archer
```

Archer needs Node.js 22.18 or newer. It loads `archer.config.ts` with Node's built-in TypeScript support, so you need no loader. The package is ESM only and ships no CommonJS build. Archer depends on TypeScript 7 and uses its own copy, so the project does not need to install TypeScript.

## Quick start

In this section you set up Archer for a small project and watch it reject an import. The project has three layers: `src/app`, `src/domain`, and `src/infrastructure`. Archer analyzes the files that the project's `tsconfig.json` includes, so make sure that it includes `src`.

First, create three files. The domain file breaks two rules on purpose.

```ts
// src/infrastructure/db.ts
export const save = (value: { id: string }) => value
```

```ts
// src/domain/order.ts
import { randomUUID } from "node:crypto"
import { save } from "../infrastructure/db.ts"

export const newOrder = () => save({ id: randomUUID() })
```

```ts
// src/app/main.ts
import { newOrder } from "../domain/order.ts"

console.log(newOrder())
```

Then create the config.

```sh
npx archer init
```

`archer init` writes `archer.config.ts` to the current directory. It does not overwrite an existing file. The file contains:

```ts
import { defineConfig, presets, r } from "@lucasacoutinho/archer"

export default defineConfig({
  layers: {
    app: "src/app",
    domain: "src/domain",
    infrastructure: "src/infrastructure",
  },
  stack: ["app", "domain"],
  allow: { infrastructure: ["domain"] },
  rules: [...presets.recommended, r.forbid("domain/pure", "layer:domain", ["npm:*", "node:*"])],
})
```

Run the check.

```sh
npx archer check
```

Archer prints both findings and exits with code 1:

```text
src/domain/order.ts
  1:28  error  domain/pure  imports node:crypto ('node:crypto')
    1 | import { randomUUID } from "node:crypto"
      |                            ^
  2:22  error  layer/domain  imports src/infrastructure/db.ts ('../infrastructure/db.ts')
    2 | import { save } from "../infrastructure/db.ts"
      |                      ^

Archer: fail. 2 findings (2 errors, 0 warnings, 0 info) in 3 files and 3 dependencies.
```

The `domain/pure` finding comes from the rule in the config. The `layer/domain` finding comes from `stack` and `allow`. The domain is last in the stack and `allow` gives it nothing, so it may import no other layer.

Now fix the domain. Replace `src/domain/order.ts` with a version that imports nothing:

```ts
// src/domain/order.ts
export const newOrder = () => ({ id: "order-1" })
```

Run `npx archer check` again. Archer exits with code 0 and prints:

```text
Archer: pass. No findings in 3 files and 1 dependency.
```

From here:

- [Configure layers and rules](#config-file) for your project.
- [Run the check in a test](#run-archer-in-a-test) so that `npm test` enforces it.
- [Accept existing violations](#baselines) to adopt Archer in a codebase that already breaks rules.

## Config file

Archer looks for the first of `archer.config.ts`, `archer.config.mts`, `archer.config.js`, and `archer.config.mjs` in the current directory. The file default-exports a config object. `defineConfig` returns its argument unchanged and only adds type checking. Archer imports the file with native `import()`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `root` | `string` | `"."` | The analysis root. Selectors, `projects`, and `baseline` are relative to it. The value itself is relative to the config file. |
| `projects` | `[string, ...string[]]` | `["tsconfig.json"]` | The tsconfig files to analyze, relative to `root`. |
| `layers` | `Record<string, SelectorInput>` | none | Named [selectors](#selectors). |
| `stack` | `string[]` | `[]` | Layer names from top to bottom. Each layer may import the layers below it. |
| `allow` | `Record<string, string[]>` | `{}` | For a layer, further layers that it may import. |
| `publicApis` | `Record<string, SelectorInput>` | `{}` | For a layer, the files that other files may import. |
| `rules` | `RuleSpec[]` | `[]` | [Rules](#rules) built with `r.*`. |
| `baseline` | `string \| false` | `".archer-baseline"` | The [baseline](#baselines) file, relative to `root`. `false` checks without a baseline. |
| `failOnWarnings` | `boolean` | `false` | Fail the check on warnings as well as errors. |

A config needs at least one rule. A rule can come from `rules`, from a layer that `stack` or `allow` constrains, or from a `publicApis` entry. Otherwise Archer rejects the config with `EmptyPolicy`.

Archer analyzes the files that the listed tsconfigs include, minus declaration files, JSON files, and anything under `node_modules` or outside `root`. A tsconfig lists JavaScript files only when it sets `allowJs`. A file that several tsconfigs include belongs to the first one in `projects` order. An import of a file that no listed tsconfig includes is an `unresolved` target. TypeScript 7 parses each tsconfig. A tsconfig with errors stops the run with `ProjectParseFailed`, and a missing one stops it with `ProjectNotFound`.

### Layers

A layer is a name for a selector. The three layer fields turn into rules before the check runs:

- `stack` lists layers from top to bottom. A layer may import every layer below it, not only the next one. It may not import a layer above it.
- `allow` adds layers to a layer's permitted imports. Use it for layers that sit outside the stack, such as `infrastructure` in the quick start.
- `publicApis` maps a layer to the files that code outside the layer may import. Every source file outside the layer, including files in no layer, may import only those entry files.

The generated rules are named `layer/<name>` and `public-api/<name>`. They have `error` severity. Their ids are reserved, so no rule of yours may use them.

Layer rules constrain only imports between declared layers. They cover direct imports of source files, of every kind. Packages, built-ins, unresolved imports, and computed imports are outside their scope. A file that belongs to no layer is not constrained, and a constrained layer may import it. A layer that appears in neither `stack` nor `allow` gets no rule of its own, but a constrained layer may not import it unless `allow` lists it. A layer may import itself.

Layer names may not look like array indexes, such as `"0"` or `"12"`. JavaScript enumerates integer-like keys before the others, which would reorder your layers. Archer rejects such a name when it decodes the config. Reference a layer in any selector with `layer:<name>`. A selector in `layers` or `publicApis` cannot use `layer:`.

```ts
import { defineConfig, presets } from "@lucasacoutinho/archer"

export default defineConfig({
  layers: {
    web: "src/web",
    app: "src/app",
    domain: "src/domain",
    infra: "src/infra",
  },
  stack: ["web", "app", "domain"],
  allow: { infra: ["app", "domain"] },
  publicApis: { domain: "src/domain/index.ts" },
  rules: presets.recommended,
})
```

### Selectors

Everywhere that a field takes a `SelectorInput`, you can write a string, an array, or a combination:

| Input | Selects |
| --- | --- |
| `"src/domain"` | The file or directory with that name and everything under it. Same as `"src/domain/**"`. |
| `"src/domain/*"` | The files directly inside `src/domain`. A path with a wildcard means exactly its tokens. |
| `"src/**/*.test.ts"` | `**` as a whole segment matches any number of segments, including none. `*` matches any run of characters within a segment. `?` matches one character. `*` and `**` also match names that start with a dot. |
| `"src/{app,web}/**"` | Braces list alternatives. They may nest and may span segments. |
| `"npm:react"` | The package `react` and its subpaths. Scoped packages are `"npm:@scope/name"`. |
| `"npm:*"` | Any package. |
| `"node:fs"`, `"node:fs/promises"` | A Node built-in. `"node:*"` selects every Node built-in. |
| `"bun:test"` | A Bun built-in. `"bun:*"` selects every Bun built-in. |
| `"layer:app"` | The files of the layer named `app`. |
| `"unresolved:*"` | Imports that TypeScript could not resolve. |
| `"computed:*"` | Imports without a static specifier, such as `import(name)` and `require(name)`. |
| `["src/a", "npm:zod"]` | The union of the entries. |
| `{ not: "src/gen" }` | Every target that the inner selector does not select. |
| `{ all: ["src", { not: "src/gen" }] }` | The intersection of the entries. |

Paths are relative to `root`, use `/` on every platform, and may start with `./`. Archer rejects a path selector that contains `[`, `]`, or `\` because character classes are not part of the syntax. It also rejects an empty string, an empty segment, a `.` or `..` segment, unbalanced braces, a comma outside braces, and a prefixed form with a missing or invalid name, such as `npm:` or `npm:a/b`. An empty segment includes a leading or trailing `/`. The config error names the field, for example `rules[0].assertion: 'npm:' is not a selector (InvalidName)`.

A rule's subject selects source files only. `npm:*` as a subject selects nothing. The object of an outgoing rule can select any target. The object of an incoming rule selects source files only. The [selector grammar](docs/contracts/selector-text.md) states the full syntax.

### Rules

Each constructor in `r` returns plain data. The first argument is the rule id, which every rule must have. Ids must be unique within the config. A baseline entry contains the id, so renaming a rule makes its accepted violations reappear. Pick ids that you will not change, such as `domain/pure`.

```ts
import { defineConfig, p, presets, r, use } from "@lucasacoutinho/archer"

export default defineConfig({
  layers: { domain: "src/domain", infra: "src/infra", web: "src/web" },
  stack: ["web", "domain"],
  allow: { infra: ["domain"] },
  rules: [
    ...presets.recommended,
    r.forbid("web/no-pg", "layer:web", "npm:pg", { transitive: true, reason: "Go through a repository." }),
    r.onlyDependOn("domain/closed", "layer:domain", ["layer:domain", "npm:zod"]),
    r.acyclic("features/folders", "src/features", { folderDepth: 3 }),
    r.declares("controllers/shape", "src/controllers", p.all(p.kind("class"), p.extends("BaseController"))),
    r.forbidUse("no-eval", "src", use.globals("eval")),
    r.suffix("services/naming", "src/services", "-service.ts"),
    r.maxLines("size/files", "src", 400, { severity: "warning" }),
  ],
})
```

Archer checks itself. Its own [`archer.config.ts`](archer.config.ts) is a larger working example.

#### Dependency rules

| Constructor | A subject file violates the rule when |
| --- | --- |
| `r.forbid(id, subject, object, options?)` | it reaches a target that `object` selects. |
| `r.require(id, subject, object, options?)` | it reaches no target that `object` selects. |
| `r.onlyDependOn(id, subject, allowed, options?)` | it reaches a target that `allowed` does not select. |
| `r.forbidDependents(id, subject, object, options?)` | a source file that `object` selects reaches it. |
| `r.requireDependents(id, subject, object, options?)` | no source file that `object` selects reaches it. |
| `r.onlyDependedOnBy(id, subject, allowed, options?)` | a source file that `allowed` does not select reaches it. |

A subject file reaches a target when it imports the target. With `transitive: true`, it also reaches the targets that its imports import. `allowed` must select the subject itself when files of the subject import each other. Otherwise `r.onlyDependOn` reports those imports. A file is never its own dependent in the incoming rules.

The `options` of a dependency rule:

| Option | Default | Meaning |
| --- | --- | --- |
| `kinds` | all four | The dependency kinds to follow. `"static"` is a value `import` or `export ... from`. `"type"` is `import type`, `export type`, an import whose specifiers are all inline `type`, and an `import("x")` type. `"require"` is `require()` and `import x = require()`. `"dynamic"` is an `import()` expression. |
| `transitive` | `false` | Follow chains of imports instead of direct imports only. |
| `localOnly` | `false` | Count imports of source files only. Packages, built-ins, unresolved imports, and computed imports are ignored. |
| `severity` | `"error"` | `"error"`, `"warning"`, or `"info"`. |
| `reason` | none | Text that reporters show with each finding of the rule. |

A direct rule reports one violation per import site. A transitive rule reports one violation per forbidden target, with the shortest chain of imports as evidence.

A computed import has no static target, so Archer cannot prove that it is safe. `r.forbid` and `r.onlyDependOn` therefore always report one, whatever the object selects. `r.require` and `r.requireDependents` never count one as satisfying the requirement. Set `localOnly: true` to make a rule ignore computed imports.

#### Cycles and resolution

| Constructor | Meaning |
| --- | --- |
| `r.acyclic(id, subject, options?)` | The files of the subject form no import cycle among themselves. Each file on a cycle gets one violation with the shortest cycle through it. `options` takes `kinds`, `localOnly`, `severity`, `reason`, and `folderDepth`. With `folderDepth: n`, Archer first collapses each file to the first `n` segments of its directory and looks for cycles among those folders. |
| `r.resolvable(id, subject, options?)` | Every import of the subject resolves. Unresolved imports always violate. Computed imports violate unless `allowComputed: true`. |

#### Declaration rules

| Constructor | Meaning |
| --- | --- |
| `r.declares(id, subject, predicate, options?)` | Every top-level declaration in each subject file satisfies `predicate`. A file without declarations passes. |
| `r.declaresNone(id, subject, predicate, options?)` | No top-level declaration in a subject file satisfies `predicate`. |
| `r.exportsOnly(id, subject, names, options?)` | The subject exports no name outside `names`. |

Declarations are the top-level classes, interfaces, enums, functions, type aliases, and variables of a file. A variable statement gives one declaration per bound name.

Build a `predicate` from `p`:

| Predicate | Holds for a declaration that |
| --- | --- |
| `p.kind(...kinds)` | has one of the kinds `"class"`, `"interface"`, `"enum"`, `"function"`, `"type"`, `"variable"`. |
| `p.abstract` | is abstract. |
| `p.exported` | is exported, directly or through `export { a as b }` or `export default a`. |
| `p.readonlyProperties` | has at least one property, and every property is `readonly`. Constructor parameter properties count. |
| `p.extends(name)` | extends `name`. Archer compares the text of the heritage expression. |
| `p.implements(name)` | implements `name`, compared the same way. |
| `p.decorator(name)` | has the decorator `@name` or `@name(...)`. |
| `p.hasMethods(names, visibility?)` | declares every method in `names`, with the given visibility when you pass one. |
| `p.onlyPublicMethods` | declares only public methods. |
| `p.all(...predicates)` | satisfies every predicate. |

#### Usage rules

| Constructor | Meaning |
| --- | --- |
| `r.forbidUse(id, subject, use, options?)` | No subject file contains the use. Each occurrence is a violation. |
| `r.requireUse(id, subject, use, options?)` | Every subject file contains the use at least once. |

Build a `use` from the `use` helper:

| Use | Matches |
| --- | --- |
| `use.looseEquality` | The operators `==` and `!=`. |
| `use.globals(...names)` | Calls of these names that resolve to no declaration, such as `eval`. A call of a locally declared `eval` does not match. |
| `use.imported(source, ...names)` | Calls that resolve to these exports of the module `source`, written as in the `import` statement. Aliases, namespace imports, default-import property calls, and `require()` destructuring all resolve to the original export. |

#### Naming and size rules

| Constructor | Meaning |
| --- | --- |
| `r.prefix(id, subject, value, options?)` | The file name starts with `value`. |
| `r.suffix(id, subject, value, options?)` | The file name ends with `value`. |
| `r.maxLines(id, subject, max, options?)` | The file has at most `max` lines, where `max` is 1 or more. |

The file name includes its extension. Pass `forbid: true` in the options of `r.prefix` or `r.suffix` to require that the name does not start or end with `value`.

#### Custom rules

`r.custom(id, subject, check, options?)` runs `check` once for each subject file. `check` receives `{ graph, subject }`, where `subject` is the file's path joined with `/`, and returns an array of messages. Each message is one finding. The function must be synchronous.

```ts
import { defineConfig, r } from "@lucasacoutinho/archer"

export default defineConfig({
  rules: [
    r.custom("features/single-export", "src/features", ({ graph, subject }) => {
      const file = graph.files.find((candidate) => candidate.path.join("/") === subject)
      return file !== undefined && file.exports.length > 1 ? [`exports ${file.exports.length} names`] : []
    }),
  ],
})
```

A throw becomes one finding with the message `custom rule crashed: <message>`. A return value that is not an array of strings becomes one finding as well. A baseline entry for a custom rule includes the message, so keep the wording stable.

#### Presets

`presets.recommended` is an array of two rules: `archer/acyclic` on `**` and `archer/resolvable` on `**`. Spread it into `rules`. Presets are plain arrays, so you build your own the same way.

#### Rules that select no files

A rule passes when its subject selects no source file. Archer lists the rule separately, so a mistyped path stays visible. The pretty reporter prints `info  rule <id> selects no source files`, and the report lists the id in `emptySubjects`.

The same goes for a dependency rule whose target names files by a path glob but selects none of them, which is almost always a mistyped path. Archer prints `info  rule <id> names files that do not exist` and lists the id in `emptyObjects`. A target that names only packages or built-ins is never listed, because forbidding a package the project does not use is normal. These notes never fail a check.

## Run Archer in a test

Add one test to your suite:

```ts
import { test } from "vitest"
import { assertArchitecture } from "@lucasacoutinho/archer"

test("architecture", () => assertArchitecture())
```

The type of a `node:test` callback allows only `Promise<void>`, so await the call there:

```ts
import { test } from "node:test"
import { assertArchitecture } from "@lucasacoutinho/archer"

test("architecture", async () => {
  await assertArchitecture()
})
```

`assertArchitecture` loads the config from the current directory, analyzes the project, applies the baseline, and resolves with the report. When the verdict is `fail`, it rejects with an `ArchitectureError`. Its `message` is the pretty report and its `report` property holds the report data. Archer needs no test-runner adapter or setup file.

Analysis time grows with the size of the project. If the runner's default timeout is too short, raise it, for example `test("architecture", () => assertArchitecture(), 60_000)` in Vitest.

`run` starts one TypeScript server per process and reuses it. The test above exits cleanly without cleanup. Call `dispose()` in an `afterAll` hook if you want to stop the server before the process ends, for example in watch mode.

Jest needs a note: it cannot load an ESM-only package from a CommonJS test file. Run Jest in its [ESM mode](https://jestjs.io/docs/ecmascript-modules): set `"type": "module"` in `package.json` and start Jest with `NODE_OPTIONS=--experimental-vm-modules`. `bun test` runs the same one-line test; `npm run smoke:bun` checks that.

### Root exports

| Export | Purpose |
| --- | --- |
| `defineConfig(config)` | Returns the config unchanged. Adds type checking. |
| `r`, `p`, `use`, `presets` | Rule constructors, declaration predicates, usage helpers, and the recommended preset. |
| `assertArchitecture(options?)` | Resolves with the `Report`, or rejects with `ArchitectureError` when the verdict is `fail`. |
| `run(options?)` | Resolves with `{ report, graph, root }` and does not judge the verdict. |
| `renderReport(result, format?)` | Resolves with the report as text in one of the [reporter](#reporters) formats. The default is `"pretty"`. |
| `check(config, graph)` | Checks a config against a graph in memory. Synchronous. |
| `graphOf(adjacency)` | Builds a `Graph` from a table of paths. |
| `dispose()` | Stops the TypeScript server. |
| `ArchitectureError` | The error that `assertArchitecture` throws. It has `report` and a pretty `message`. |

The options of `run` and `assertArchitecture`:

| Option | Default | Meaning |
| --- | --- | --- |
| `config` | the first `archer.config.*` in `cwd` | An `ArcherConfig` object, or the path of a config file. |
| `cwd` | the current directory | Where Archer looks for the config and resolves a relative config path. With an inline `config` object, `root` is relative to `cwd`. |
| `baseline` | `"apply"` | `"apply"` reads the baseline. `"ignore"` skips it. `"record"` writes every current violation. `"prune"` removes entries that no violation matches. |

Every error that these functions throw keeps its `_tag` and its fields, and is an `instanceof Error`:

| `_tag` | Cause |
| --- | --- |
| `ConfigNotFound` | No config file exists. `searched` lists the paths. |
| `ConfigLoadError` | Importing the config file threw. `path` and `cause` say why. |
| `ConfigInvalid` | The config has the wrong shape or a bad selector. `issues` lists every problem with its location in the config. |
| `ConfigRejected` | The config is well formed but inconsistent. `error._tag` is `UnknownLayer`, `DuplicateLayer`, `DuplicateRuleId`, or `EmptyPolicy`. |
| `ProjectNotFound` | A tsconfig in `projects` does not exist. |
| `ProjectParseFailed` | A tsconfig has errors. `diagnostics` lists them. |
| `AnalyzerUnavailable` | The TypeScript server failed to start or crashed. |
| `GraphFileInvalid` | A [saved graph](#saved-graphs) cannot be read. |
| `BaselineError` | The baseline file is unreadable, unwritable, or malformed. `reason` is `Unreadable`, `UnsupportedHeader`, `MalformedLine`, or `Unwritable`. |

## Test a policy against a graph in memory

`check` runs a config against a graph that you build in memory. It needs no TypeScript server and no files on disk, so a policy gets a fast unit test:

```ts
import { expect, test } from "vitest"
import { check, defineConfig, graphOf } from "@lucasacoutinho/archer"

const config = defineConfig({
  layers: { app: "src/app", domain: "src/domain" },
  stack: ["app", "domain"],
})

test("the domain may not import the app", () => {
  const report = check(
    config,
    graphOf({
      "src/domain/order.ts": ["src/app/main.ts"],
      "src/app/main.ts": [],
    }),
  )
  expect(report.verdict).toBe("fail")
  expect(report.violations.map((violation) => violation.ruleId)).toEqual(["layer/domain"])
})
```

`graphOf` takes each file's root-relative path and the paths it imports. The graph holds static imports between files and nothing else: no packages, built-ins, or computed imports, no declarations, no exports, no usages, and no line counts. Use `check` and `graphOf` for layer and file-to-file dependency rules. Rules about `npm:` selectors, declarations, usages, and sizes find nothing to check in such a graph. `check` ignores `root`, `projects`, and `baseline`. It throws a `ConfigInvalid` or `ConfigRejected` error for a bad config.

## CLI reference

```sh
archer check [-c <file>] [-r <reporter>] [-o <file>] [-w] [--ignore-baseline] [--graph <file>]
archer baseline record|prune [-c <file>]
archer graph -o <file> [-c <file>]
archer init
```

`archer --help` lists the commands, and `archer <command> --help` lists the flags of one.

| Command | Does |
| --- | --- |
| `archer check` | Analyzes the project, checks the rules, applies the baseline, and prints the report. |
| `archer baseline record` | Replaces the baseline with every current violation. |
| `archer baseline prune` | Removes the baseline entries that no current violation matches. |
| `archer graph` | Writes the analyzed graph to a file. |
| `archer init` | Creates a starter `archer.config.ts` in the current directory, unless one exists. |

`archer check` exits with one of three codes:

| Exit code | Meaning |
| --- | --- |
| `0` | The report passes. |
| `1` | The report fails. |
| `2` | Archer cannot check at all: an unknown flag or value, a missing or invalid config, a tsconfig that is missing or has errors, an unreadable baseline, or an invalid saved graph. |

When Archer cannot check, it prints the cause to standard error as a message, for example:

```text
Invalid configuration:
  - layers.a: 'src//x' is not a selector (InvalidSegment)
```

`archer baseline` and `archer graph` exit with 2 in the same cases and with 0 otherwise. `archer init` exits with 1 when `archer.config.ts` already exists.

Flags of `archer check`:

| Flag | Meaning |
| --- | --- |
| `-c`, `--config <file>` | The config file. Default: the first `archer.config.{ts,mts,js,mjs}` in the current directory. |
| `-r`, `--reporter <name>` | `pretty` (default), `agent`, `json`, `sarif`, `github`, or `dot`. |
| `-o`, `--output <file>` | Write the report to a file instead of standard output. |
| `-w`, `--watch` | Run again when a file under `root` or beside the configuration file changes. Archer waits 200 ms for changes to settle and ignores `node_modules`, `.git`, and its own `--output` file. Each run is a fresh process, so edits to `archer.config.ts` and to the modules it imports take effect, and nothing accumulates in memory. |
| `--ignore-baseline` | Report every violation, including the ones that the [baseline](#baselines) accepts. |
| `--graph <file>` | Check a [saved graph](#saved-graphs) instead of analyzing the project. |

`archer baseline` and `archer graph` take `-c`, `--config` as well. `archer graph` requires `-o`, `--output`. `archer baseline` prints the report in the `agent` format. With `baseline: false` in the config, neither `record` nor `prune` writes a file.

## Reporters

Choose a reporter with `archer check -r <name>` or pass its name to `renderReport`.

| Reporter | Output |
| --- | --- |
| `pretty` | Findings grouped by file, each with the source line and a caret under the import. Color appears only on a terminal and only without `--output`. A footer lists rules that select no source files, the number of findings that the baseline accepted, and stale baseline entries. |
| `agent` | One line per finding, then one `summary` line. Each line holds `key=value` pairs with JSON-quoted values and no color. The `id` of a finding is its [baseline](#baselines) entry. |
| `json` | The report as indented JSON. |
| `sarif` | SARIF 2.1.0. Walks and cycles become code flows, and the baseline entry is the `archer` partial fingerprint. |
| `github` | GitHub Actions workflow commands such as `::error file=src/a.ts,line=1,col=8,title=rule-id::message`. A finding with `info` severity becomes a `notice`. |
| `dot` | A Graphviz graph of the imports between source files. It shows the graph, not the findings. Edges for `type`, `require`, and `dynamic` imports are styled differently. The exit code still follows the verdict. |

Example `agent` output, for the quick-start project when `src/domain/order.ts` imports only `../infrastructure/db.ts`:

```text
finding id="layer/domain|/src/domain/order.ts|dependency|static|../infrastructure/db.ts|file|/src/infrastructure/db.ts" severity=error rule="layer/domain" subject="src/domain/order.ts" at="src/domain/order.ts:1:22" message="imports src/infrastructure/db.ts ('../infrastructure/db.ts')"
summary verdict=fail errors=1 warnings=0 infos=0 suppressed=0 stale=0 files=3 dependencies=2 emptySubjects=[] emptyObjects=[]
```

The `json` reporter and the `Report` type share one shape:

| Field | Content |
| --- | --- |
| `verdict` | `"pass"` or `"fail"`. The verdict is `fail` when an `error` violation remains, or a `warning` violation remains and `failOnWarnings` is `true`. |
| `violations` | The violations that the baseline does not accept, in rule order, then file order. Each has `ruleId`, `severity`, `subject` (the file's path segments), and `evidence`. |
| `counts` | The number of violations by `error`, `warning`, and `info`. |
| `suppressed` | The number of violations that the baseline accepted. |
| `stale` | The baseline entries that match no current violation. |
| `emptySubjects` | The ids of rules that select no source file. |
| `emptyObjects` | The ids of dependency rules whose target names files by a glob but selects none. |
| `rules` | The `id`, `severity`, and `reason` of every rule. |
| `stats` | `files` and `dependencies`. |

The `_tag` of a violation's `evidence` says which rules produced it:

| `evidence._tag` | Produced by |
| --- | --- |
| `Dependency` | Direct dependency rules, layer rules, and `r.resolvable`. One import site. |
| `Walk` | Transitive dependency rules. The forbidden `target` and the chain of `edges`. |
| `Missing` | `r.require`, `r.requireDependents`, and `r.requireUse`. |
| `Cycle` | `r.acyclic`. The chain of `edges` that closes the cycle. |
| `Declaration` | `r.declares` and `r.declaresNone`. |
| `Export` | `r.exportsOnly`. |
| `Use` | `r.forbidUse`. |
| `Name` | `r.prefix` and `r.suffix`. |
| `Lines` | `r.maxLines`. |
| `Custom` | `r.custom`. The `message`. |

## Baselines

A baseline lets a project adopt Archer without first fixing every existing violation. Record the current violations, commit the file, and the check fails only on new ones.

```sh
npx archer baseline record
npx archer check
```

Archer writes the file named by the `baseline` field, `.archer-baseline` under `root` by default. The first line is the header `archer-baseline 1`. Every other line is one accepted violation: the rule id, the file, and the evidence, separated by `|`.

A baseline entry holds no line numbers, no hashes, and no message wording. Editing the code around an accepted violation does not revive it. One entry accepts every violation with the same rule, file, and evidence, so a file that imports the same specifier twice needs one entry. A violation in a different file or against a different target is new and fails the check.

The baseline behaves as follows:

- A missing baseline file is an empty baseline.
- An entry that matches no current violation is stale. The pretty reporter and the report count stale entries, and the check does not fail on them. Run `archer baseline prune` to remove them.
- `archer baseline record` replaces the file with the current violations, including those it already accepted. Archer writes through a temporary file and a rename, so a reader never sees half a baseline.

Archer rejects a file whose first line is not `archer-baseline 1`, such as a 0.2 `.archer-baseline.json`, with a `BaselineError` whose `reason` is `UnsupportedHeader`. To see every violation once, run `archer check --ignore-baseline`, or call `run({ baseline: "ignore" })` from code. To turn the baseline off for the project, set `baseline: false`.

## Saved graphs

`archer graph` analyzes the project and writes the graph to a file, ignoring the baseline:

```sh
npx archer graph -o archer-graph.json
npx archer check --graph archer-graph.json
```

`archer check --graph` loads the config as usual and applies the baseline, but it reads the graph from the file instead of starting TypeScript. The `projects` field has no effect. A file that `archer graph` did not write fails with `GraphFileInvalid`, and `archer check` exits with 2. Use it to try new rules without analyzing again, to split analysis and checking across CI jobs, and to attach the exact graph to a bug report. The file is one line of JSON with the keys `format` (`"archer-graph"`), `version` (`1`), and `graph`.

## Effect API

Archer is built with [Effect](https://effect.website). The root export wraps that code in plain Promises and adds no Effect types to its signatures. The `@lucasacoutinho/archer/effect` entry exposes the Effect surface for Effect programs and for integrations. Archer depends on `effect` 4.0.6. Use the same version in your project, or your package manager can install two copies whose types do not match.

```ts
import { Effect } from "effect"
import { ArcherLive, run } from "@lucasacoutinho/archer/effect"

const result = await Effect.runPromise(run({ cwd: process.cwd() }).pipe(Effect.provide(ArcherLive)))
console.log(result.report.verdict)
```

`./effect` exports:

- `run` and `checkGraph`: the pipeline and its pure part. `checkGraph` returns a `Result` instead of throwing.
- `Analyzer`, `Workspace`, and `ArcherLive`. `Analyzer.typescript` analyzes with TypeScript. `Analyzer.memory(graph)` returns a fixed graph. `Analyzer.replay(path)` reads a [saved graph](#saved-graphs) and fails with `GraphFileInvalid` when the file is not one. `ArcherLive` is `Analyzer.typescript` plus Node's platform services.
- The schemas `ArcherConfig`, `ConfigSelector`, `SelectorText`, `Graph`, `SourceFile`, `Target`, `Selector`, `Rule`, `Violation`, `Report`, and `GraphFile`, with `decodeConfiguration`, `formatGraphFile` (graph to file text), and `readGraphFile` (file to graph).
- `render` and the `Format` schema.
- The tagged errors from the table above.

## How Archer's correctness is established

Archer's pure core is specified in Lean 4 under [`lean/`](lean/). It covers the glob matcher, reachability with shortest witnesses, the check, the lowering of layers into rules, fingerprints, the baseline, and selector text. A contract is a structure of propositions over an implementation, and it never defines that implementation. For each contract, Lean's kernel checks a theorem that the Lean implementation satisfies it. `npm run lean` fails unless every theorem depends only on Lean's standard axioms. Two obligations are fixed by definition and not proved: the order of violations in a report, and the listing of rules that select no source file.

The proofs have limits:

- The code that runs is a TypeScript port of the Lean definitions, and Archer does not prove the port. The evidence is a compiled Lean program, the oracle. Differential tests send 400 seeded random inputs, covering every operation and every kind of evidence, to the oracle and to the port, and compare complete outputs. Planted bugs fail those tests. The oracle runs compiled Lean code, so this evidence also trusts Lean's compiler and runtime.
- The analyzer, which turns TypeScript's view of your code into the graph, has a contract in prose. A contract suite tests it against every analyzer, and nothing proves it. The Lean model takes the graph as given.
- Custom rules are opaque functions. The model reports exactly what they return.

The [contracts and obligations](docs/contracts/README.md) list every proved property and each assumption. The [oracle protocol](docs/contracts/oracle.md), the [analyzer contract](docs/contracts/analyzer.md), the [selector grammar](docs/contracts/selector-text.md), and the [pattern contract](docs/contracts/pattern.md) each have their own page.

## Agent skill

The package ships an [Agent Skill](https://openagentskills.dev/) in [`skills/archer`](skills/archer/SKILL.md). It guides a coding agent through writing `archer.config.ts`, running `archer check -r agent`, and fixing violations in source without loosening the policy. Install it with the Skills CLI:

```sh
npx skills add lucasacoutinho/archer --skill archer
```

## Development

```sh
npm install
npm run check
```

`npm run check` runs the Lean audit, the type check, the tests, the build, and Archer on its own source. It needs [elan](https://github.com/leanprover/elan) with Lean 4.34.1, which `lean/lean-toolchain` pins. `npm install` runs the `prepare` script, which patches `tsc` with the Effect diagnostics from `@effect/tsgo`. `npm ci` runs it too.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `npm run check` on Linux with Node 22, 24, and 26. It also checks the npm tarball, and it runs the type check and the tests that need no Lean on Windows.

| Script | Does |
| --- | --- |
| `npm run lean` | Builds the Lean packages and the `archer-oracle` binary, checks `Challenge.lean`, and audits the axioms of every theorem. |
| `npm run typecheck` | Type checks `src` and `test`. |
| `npm test` | Runs the tests with Vitest. The differential tests need the oracle binary, so run `npm run lean` first. |
| `npm run build` | Compiles `src` to `dist`. |
| `npm run dogfood` | Runs `dist/cli/main.js check` on this repository. Run `npm run build` first. |

The design records in [`docs/design/`](docs/design/) explain why the interface looks the way it does. [`docs/GLOSSARY.md`](docs/GLOSSARY.md) defines the terms.

## Releasing

Releases publish to the public npm registry from the `Publish package` workflow ([`.github/workflows/publish.yml`](.github/workflows/publish.yml)) with npm trusted publishing, so the repository stores no npm token and npm attaches provenance automatically. The workflow runs when you publish a GitHub release or start it by hand. It runs `npm run check`, checks the tarball contents, and then runs `npm publish --provenance`.

npm can attach a trusted publisher only to a package that already exists, so a maintainer publishes the first version by hand, with two-factor authentication. After that, link the workflow once:

```sh
npm trust github @lucasacoutinho/archer --file publish.yml --repo lucasacoutinho/archer --allow-publish
```

Add the release to [`CHANGELOG.md`](CHANGELOG.md) before you publish it.

## License

Archer is licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
