# Archer rule reference

Open this when you write, read, or change a rule. Everything here is exported from `@lucasacoutinho/archer`: `defineConfig`, `r` (rule constructors), `p` (declaration predicates), `use` (call and operator matchers), and `presets`.

Contents: [Configuration fields](#configuration-fields), [Selectors](#selectors), [Rule options](#rule-options), [Dependency rules](#dependency-rules), [Cycles and resolution](#cycles-and-resolution), [Declarations and exports](#declarations-and-exports), [Calls and operators](#calls-and-operators), [Names and size](#names-and-size), [Custom rules](#custom-rules), [Declaration predicates](#declaration-predicates-p), [Use matchers](#use-matchers-use), [Presets](#presets), [Test a rule without the filesystem](#test-a-rule-without-the-filesystem).

## Configuration fields

`archer.config.ts` default-exports `defineConfig({ ... })`. Every field is optional, but the config must produce at least one rule.

| Field | Meaning |
| --- | --- |
| `root` | Analysis root, relative to the config file. Default `"."`. |
| `projects` | tsconfig files relative to `root`, as a non-empty list. Default `["tsconfig.json"]`. The source set is the union of their file lists, minus declaration files, JSON, and `node_modules`. A file that no listed tsconfig includes is invisible to every rule. |
| `layers` | Layer name to selector. Names are non-empty and must not look like array indexes (`"0"`). A layer selector cannot contain `layer:`. |
| `stack` | Layer names from top to bottom. Each layer may import the layers listed after it. |
| `allow` | Layer name to further layers it may import. |
| `publicApis` | Layer name to the selector of the files that other layers may import. |
| `rules` | `r.*` rules. |
| `baseline` | Baseline file relative to `root`. Default `".archer-baseline"`. `false` turns baselines off. |
| `failOnWarnings` | When `true`, warnings fail the check. Default `false`. |

Archer lowers `layers`, `stack`, `allow`, and `publicApis` into rules with fixed ids:

- `layer/<name>` for each constrained layer, meaning one named in `stack` or as a key of `allow`. The layer may import itself and the layers it is allowed, and nothing else that belongs to a declared layer.
- `public-api/<layer>` for each entry in `publicApis`. Files outside the layer may import only the entry files.

Both are `error` rules over direct imports of local source files. They ignore packages, built-ins, computed imports, and files that belong to no layer. A constrained layer may not import a declared layer that is neither in its allowed list nor itself, even when that layer is unconstrained.

## Selectors

Anywhere a rule takes a selector, it takes selector text, an array (union), `{ not: selector }`, or `{ all: [selectors] }` (intersection).

| Text | Selects |
| --- | --- |
| `src/domain` | That file or directory and everything under it. Same as `src/domain/**`. |
| `src/domain/*` | Direct children only. A pattern with a wildcard means exactly its segments. |
| `src/**/*.test.ts` | `**` as a whole segment matches any number of segments, including none. `*` matches within one segment. `?` matches one character. All match names that start with a dot. |
| `src/{api,web}/**` | Braces give a union and may nest. They may span segments and mix forms: `{src/**,npm:react}`, `npm:{react,zod}`. |
| `npm:*`, `npm:react`, `npm:@scope/name` | Any package, or that package with any subpath. A name containing `/` must be `@scope/name`. |
| `node:*`, `node:fs`, `node:fs/promises` | Node built-ins. `bun:*` and `bun:test` do the same for Bun. |
| `layer:domain` | The layer with that name. Only in rules, not in `layers` or `publicApis`. |
| `unresolved:*` | Every import that TypeScript could not resolve. |
| `computed:*` | Every import without a static specifier, such as `import(name)`. |

Paths are root-relative with `/` separators, and a leading `./` is dropped. Selector text is rejected when it is empty, has braces that do not balance, has a stray `,` outside braces, uses `\`, `[`, or `]`, or has an empty, `.`, or `..` segment (which covers a leading or trailing `/` and `a//b`). A prefixed form with a bad name is rejected, not read as a path.

A rule's subject selects source files only, so `npm:*` as a subject selects nothing. An object selects any target. `{ not: "src/domain" }` as an object also covers every package, built-in, unresolved import, and computed import.

```ts
import { defineConfig, r } from "@lucasacoutinho/archer"

export default defineConfig({
  layers: { domain: "src/domain", adapters: ["src/http", "src/db"] },
  rules: [
    r.forbid("selectors/union", ["src/http", "src/db"], "npm:{lodash,moment}"),
    r.forbid("selectors/not", { not: "layer:adapters" }, "node:{fs,child_process}"),
    r.forbid("selectors/all", { all: ["src", { not: "**/*.test.ts" }] }, "unresolved:*"),
    r.forbid("selectors/globs", "src/**/{legacy,old}-*.ts", ["computed:*", "bun:*"]),
  ],
})
```

## Rule options

Every constructor takes an id first and an options object last. The id must be unique, and it should stay stable, because findings and baseline entries use it.

| Option | Applies to | Meaning |
| --- | --- | --- |
| `reason` | every rule | Text that the report prints with each finding as `reason=`. Write why the rule exists. |
| `severity` | every rule | `"error"` (default), `"warning"`, or `"info"`. |
| `kinds` | the dependency rules and `acyclic` | Which imports count, from `"static"` (value imports and re-exports), `"type"` (type-only imports), `"require"`, `"dynamic"` (`import()`). Default: all four. |
| `transitive` | the dependency rules | Follow imports through other files. Default `false`. A direct rule reports one finding per import site. A transitive rule reports one finding per reached target, with the shortest chain. |
| `localOnly` | the dependency rules and `acyclic` | Count only imports of source files. Packages, built-ins, unresolved imports, and computed imports are skipped. Default `false`. |
| `folderDepth` | `acyclic` | Collapse files into their first n directory segments before looking for cycles. |
| `allowComputed` | `resolvable` | Accept computed imports. Default `false`. |
| `forbid` | `prefix`, `suffix` | Invert the rule: the name must not start or end with the value. |

Narrowing `kinds`, setting `localOnly`, or setting `allowComputed` weakens a rule. Treat each one as a policy change.

## Dependency rules

Each takes `(id, subject, object, options?)`. Incoming rules never count a file as its own dependent.

```ts
import { defineConfig, r } from "@lucasacoutinho/archer"

export default defineConfig({
  layers: { domain: "src/domain", application: "src/application" },
  rules: [
    // r.forbid: the subject must not reach the object. A computed import always violates it.
    r.forbid("domain/no-infra", "layer:domain", "src/infrastructure"),
    r.forbid("web/no-db-chain", "src/web", "src/db", { transitive: true }),

    // r.require: the subject must reach something the object selects. A computed import never counts.
    r.require("handlers/use-logger", "src/handlers", "src/shared/logger.ts"),

    // r.onlyDependOn: the subject may reach only what the object selects.
    // Packages and built-ins are targets too, so list the ones the layer needs.
    r.onlyDependOn("domain/closed", "layer:domain", ["layer:domain", "npm:zod"]),

    // r.forbidDependents: no source file the object selects may reach the subject.
    r.forbidDependents("internal/not-imported-by-web", "src/internal", "src/web"),

    // r.requireDependents: some source file the object selects must reach the subject.
    r.requireDependents("plugins/registered", "src/plugins", "src/registry.ts"),

    // r.onlyDependedOnBy: only source files the object selects may reach the subject.
    r.onlyDependedOnBy("db/only-from-repositories", "src/db", "src/repositories", {
      reason: "Everything else goes through a repository.",
    }),
  ],
})
```

A `require`-style rule reports `does not satisfy the rule's requirement` once per subject file.

## Cycles and resolution

```ts
import { defineConfig, r } from "@lucasacoutinho/archer"

export default defineConfig({
  rules: [
    // r.acyclic(id, subject, options?): no import cycle among the subject's files.
    // Cycles through files outside the subject are not seen.
    r.acyclic("src/acyclic", "src"),

    // folderDepth collapses files to their first n directories, so the rule finds cycles between folders.
    r.acyclic("src/folders-acyclic", "src", { folderDepth: 2, severity: "warning" }),

    // r.resolvable(id, subject, options?): every import must resolve to a file, package, or built-in.
    // Unresolved imports and computed imports are findings unless allowComputed is set.
    r.resolvable("src/resolvable", "src"),
    r.resolvable("loader/resolvable", "src/plugins/load.ts", {
      allowComputed: true,
      reason: "The loader imports plugins by name.",
    }),
  ],
})
```

A finding from a folder rule has the folder as its `subject`.

## Declarations and exports

```ts
import { defineConfig, p, r } from "@lucasacoutinho/archer"

export default defineConfig({
  rules: [
    // r.declares(id, subject, predicate): every declaration in the subject satisfies the predicate.
    // A file without declarations passes.
    r.declares("entities/classes", "src/domain/entities", p.kind("class")),

    // r.declaresNone(id, subject, predicate): no declaration in the subject satisfies the predicate.
    r.declaresNone("no-enums", "src", p.kind("enum")),

    // r.exportsOnly(id, subject, names): the subject exports no name outside the list.
    r.exportsOnly("api/root", "src/index.ts", ["createClient", "Client"]),
  ],
})
```

A declaration finding names the declaration and points at it.

## Calls and operators

```ts
import { defineConfig, r, use } from "@lucasacoutinho/archer"

export default defineConfig({
  rules: [
    // r.forbidUse(id, subject, use): the subject must not contain a matching call or operator.
    r.forbidUse("no-eval", "src", use.globals("eval")),
    r.forbidUse("no-loose-equality", "src", use.looseEquality),

    // r.requireUse(id, subject, use): every subject file must contain a match.
    r.requireUse("handlers/audit", "src/handlers", use.imported("@acme/audit", "audit")),
  ],
})
```

## Names and size

```ts
import { defineConfig, r } from "@lucasacoutinho/archer"

export default defineConfig({
  rules: [
    // r.prefix and r.suffix test the file name with its extension, so "Service" does not match UserService.ts.
    r.suffix("services/naming", "src/services", "Service.ts"),
    r.prefix("hooks/naming", "src/hooks", "use", { severity: "warning" }),
    r.prefix("no-tmp-files", "src", "tmp-", { forbid: true }),

    // r.maxLines(id, subject, max): files longer than max lines. max is at least 1.
    r.maxLines("size/files", "src", 400, { severity: "warning", reason: "A file this long is due for a split." }),
  ],
})
```

## Custom rules

`r.custom(id, subject, check, options?)` runs `check` once per subject file. The check gets `{ graph, subject }`, where `subject` is the file's root-relative path joined with `/`, and returns a list of messages. Each message is one finding. A check that throws, or returns something other than a list of strings, becomes one finding. A custom finding has no `at`.

```ts
import { defineConfig, r } from "@lucasacoutinho/archer"

export default defineConfig({
  rules: [
    r.custom(
      "handlers/one-export",
      "src/handlers",
      ({ graph, subject }) => {
        const file = graph.files.find((candidate) => candidate.path.join("/") === subject)
        return file !== undefined && file.exports.length > 1 ? [`exports ${file.exports.length} names, expected one`] : []
      },
      { reason: "One handler per file keeps routing readable." },
    ),
  ],
})
```

Prefer a built-in rule when one expresses the constraint.

## Declaration predicates (p)

For `r.declares` and `r.declaresNone`. They apply to classes, interfaces, enums, functions, type aliases, and variables. A variable statement gives one declaration per bound name.

| Predicate | True when the declaration |
| --- | --- |
| `p.kind(...kinds)` | has one of the kinds `"class"`, `"interface"`, `"enum"`, `"function"`, `"type"`, `"variable"` |
| `p.abstract` | is abstract |
| `p.exported` | is exported, including `export { a as b }` and `export default a` |
| `p.readonlyProperties` | is a class or interface with at least one property, all of them readonly (constructor parameter properties count) |
| `p.extends(name)` | extends `name`, written without type arguments |
| `p.implements(name)` | is a class that implements `name` |
| `p.decorator(name)` | is a class with the decorator `name`, written without `@` |
| `p.hasMethods(names, visibility?)` | declares every named method, with that visibility when given (`"public"`, `"protected"`, `"private"`) |
| `p.onlyPublicMethods` | has no protected or private methods |
| `p.all(...predicates)` | satisfies every predicate |

```ts
import { defineConfig, p, r } from "@lucasacoutinho/archer"

export default defineConfig({
  rules: [
    r.declares("services/injectable", "src/services", p.all(p.kind("class"), p.decorator("Injectable"))),
    r.declares("errors/extend-base", "src/errors", p.all(p.kind("class"), p.extends("AppError"))),
    r.declaresNone("no-private-methods", "src/domain", p.hasMethods(["save"], "private")),
    r.declares("events/immutable", "src/domain/events", p.all(p.kind("class"), p.readonlyProperties)),
  ],
})
```

## Use matchers (use)

For `r.forbidUse` and `r.requireUse`.

| Matcher | Matches |
| --- | --- |
| `use.looseEquality` | Each `==` and `!=`. |
| `use.globals(...names)` | Bare calls such as `eval()` or `setTimeout()` where the name resolves to no declaration in the program. Member calls such as `console.log()` are not recorded. |
| `use.imported(source, ...names)` | Calls of those exports of `source`, where `source` is the module specifier as written in the import. Relative specifiers differ from file to file, so this fits packages best. Namespace and default imports count: `cp.execSync()` matches `use.imported("node:child_process", "execSync")`. |

## Presets

`presets.recommended` is an array of two rules, `archer/acyclic` (no cycles among source files) and `archer/resolvable` (every import resolves, computed imports included), both over `**`. Spread it into `rules`. To exempt one file from either rule you must write your own rules in its place. That is a policy change.

```ts
import { defineConfig, presets, r } from "@lucasacoutinho/archer"

export default defineConfig({
  rules: [...presets.recommended, r.maxLines("size/files", "src", 400, { severity: "warning" })],
})
```

## Test a rule without the filesystem

`check(config, graph)` evaluates a config against a graph built in memory, with no TypeScript and no files. `graphOf` takes root-relative paths and the paths they import, so it tests file-to-file rules only: no packages, no declarations, no calls. `check` throws a tagged `ConfigInvalid` or `ConfigRejected` error for an invalid config.

Only subjects are checked for emptiness. A mistyped object selector makes a `forbid` rule pass without a trace, so run a new rule against a small graph that should violate it:

```ts
import { check, defineConfig, graphOf, r } from "@lucasacoutinho/archer"

const config = defineConfig({
  rules: [r.forbid("domain/no-infra", "src/domain", "src/infrastructure")],
})

const report = check(
  config,
  graphOf({
    "src/domain/order.ts": ["src/infrastructure/db.ts"],
    "src/infrastructure/db.ts": [],
  }),
)

console.log(report.violations.map((violation) => violation.ruleId))
```
