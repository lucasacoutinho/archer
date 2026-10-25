---
name: archer
description: Set up, run, and fix architecture rules in TypeScript and JavaScript repositories with Archer (@lucasacoutinho/archer). Covers archer.config.ts (layers, stack, allow, publicApis, r.* rules), `archer check -r agent`, repairing violations in source without weakening the policy, baselines for adopting Archer on existing debt, and the one-line architecture test. Use when the user wants to enforce layers, module boundaries, dependency direction, import cycles, or public entrypoints, when the repo has an archer.config.* file, or when `archer check` or an architecture test reports findings. Do not use for ESLint import rules or other dependency linters.
---

# Archer

Archer turns architecture decisions into rules that fail the build. A rule is plain data in `archer.config.ts`. `archer check` analyzes the project with TypeScript and reports every violation with its import site.

The rules are the user's policy. When a rule fails, change the source.

## Ground rules

- Fix findings in source. Do not delete or loosen a rule, lower a severity, widen `allow`, add a `{ not: ... }` exclusion, set `localOnly`, narrow `kinds`, set `allowComputed`, or record a baseline to get a green check.
- Make any of those changes only when the user asks for it. If a finding looks wrong or the rule looks outdated, say so and propose the change.
- Never claim a boundary holds when Archer could not prove it. Say what it could not see (see "Computed imports").

## Inspect first

1. Look for `archer.config.{ts,mts,js,mjs}`, `.archer-baseline`, and an existing architecture test. Update what exists instead of adding a second entrypoint.
2. Read `package.json` and the tsconfig files. Archer analyzes only the files that the tsconfigs in `projects` list (default `tsconfig.json`). A file outside them is invisible to every rule, so list each package's tsconfig in a monorepo.
3. Read real imports before choosing layers. Folder names suggest layers, but the imports show which directions the code already follows. Ask the user when the intended direction is not clear.
4. If the installed version may differ from this skill, read `node_modules/@lucasacoutinho/archer/dist/index.d.ts`.

## Set up

Install `@lucasacoutinho/archer` as a dev dependency with the repo's package manager. It needs Node 22.18 or later. Run `npx archer init` (or the package manager's local-exec equivalent) to write a starter `archer.config.ts`, then edit it to match the repo:

```ts
import { defineConfig, presets, r } from "@lucasacoutinho/archer"

export default defineConfig({
  layers: {
    web: "src/web",
    application: "src/application",
    domain: "src/domain",
    infrastructure: "src/infrastructure",
  },
  stack: ["web", "application", "domain"],
  allow: { infrastructure: ["application", "domain"] },
  publicApis: { domain: "src/domain/index.ts" },
  rules: [
    ...presets.recommended,
    r.forbid("domain/pure", "layer:domain", ["npm:*", "node:*"], {
      reason: "The domain stays free of frameworks and I/O.",
    }),
  ],
})
```

- `layers` names a selector per layer. Rules refer to it as `layer:name`.
- `stack` lists layers from top to bottom. Each layer may import the layers listed after it.
- `allow` adds layers a layer may import beyond its position in the stack.
- `publicApis` names, per layer, the entry files that other layers must import through.
- `rules` takes `r.*` constructors. Every rule needs an id that is unique and stays stable, because findings and baselines key on it.
- `projects`, `root`, `baseline`, and `failOnWarnings` are described in [references/rules.md](references/rules.md), together with every `r.*` constructor and the selector grammar. Open it when writing or reading a rule.

Layer rules constrain only direct imports of local files that belong to another declared layer. They ignore packages, built-ins, files outside every layer, and computed imports. Use `r.forbid` or `r.onlyDependOn` with `npm:*` or `node:*` for those. A layer named in neither `stack` nor `allow` has no limits of its own, but constrained layers may not import it unless `allow` says so, so put shared code at the bottom of `stack`.

The starter config names `src/app`, which may not exist. A rule whose subject matches no file passes, and so does the generated `layer/<name>` rule of an empty layer. Both are listed in `emptySubjects` in the summary line. Read that list after every run, and fix a non-empty one unless the code is meant to appear later.

A dependency rule whose target names files by a glob but selects none is listed in `emptyObjects`. That is almost always a mistyped path. A target that names only packages is never listed, so for package targets run the new rule against a minimal case (see "Test a rule without the filesystem" in the reference).

If the first run shows many violations, check the layer order and selectors before you blame the code.

## Run

```sh
npx archer check -r agent
```

The command exits 0 when the verdict is `pass` and 1 when it is `fail`. It exits 2 when it cannot check, including on an unknown flag or value. The output has one `finding` line per violation and a `summary` line last:

```text
finding id="layer/domain|/src/domain/order.ts|dependency|static|../infrastructure/db.ts|file|/src/infrastructure/db.ts" severity=error rule="layer/domain" subject="src/domain/order.ts" at="src/domain/order.ts:1:25" message="imports src/infrastructure/db.ts ('../infrastructure/db.ts')"
summary verdict=fail errors=1 warnings=0 infos=0 suppressed=0 stale=0 files=2 dependencies=1 emptySubjects=[] emptyObjects=[]
```

- `id` is the fingerprint: rule, file, and what was found, with no line numbers or wording. It survives moving lines but changes when the specifier or target changes, so a finding is fixed when its `id` no longer appears. A file that repeats one import produces several lines with the same `id`.
- `severity`: `error` fails the check, `warning` fails it only with `failOnWarnings: true`, `info` never does.
- `rule` is a rule id from the config, or a generated `layer/<name>` or `public-api/<layer>`.
- `subject` is the file that breaks the rule.
- `at` is `file:line:column` of the import, call, or declaration. Findings about a whole file (missing dependency, export, file name, line count) have no `at`.
- `message` says what Archer found. `reason` is the rule's stated reason, when it has one. Read it before you choose a fix.
- In the summary, `suppressed` counts findings the baseline hides, `stale` counts baseline entries that no finding matches, `emptySubjects` lists rule ids that select no file, and `emptyObjects` lists dependency rules whose file-glob target selects nothing.

Other flags:

- `-c <file>` picks a config.
- `-o <file>` writes the report to a file.
- `-w` re-runs on change.
- `--ignore-baseline` reports baselined findings too.
- `--graph <file>` checks a graph saved with `archer graph -o <file>`. The other reporters are `pretty` (the default), `json`, `sarif`, `github`, and `dot`.

Exit code 2 means Archer could not check at all, and the message says why. Typical causes:

- **Invalid configuration, with a list of issues.** A field has the wrong shape. A selector does not parse (`[a-z]`, `a//b`, unbalanced braces, a bad `npm:` name). A layer is named like an integer such as `"0"`. A `layers` or `publicApis` selector uses `layer:`.
- **Invalid configuration, with one reason.** A rule, `stack`, `allow`, or `publicApis` refers to an unknown layer. Two rules share an id, and a generated `layer/<name>` counts. Or the config produces no rules at all.
- **No configuration file.** No `archer.config.*` is in the current directory. Pass `-c`.
- **No tsconfig, or one that does not parse.** A tsconfig in `projects` is missing or invalid. Check `projects` and `root`.

## Fix findings

Read the summary line first. Then take findings by rule, open the file at `at`, read `reason`, and change the code. After each batch, re-run `archer check -r agent`, then the repo's typecheck and tests.

| Finding | Usual fix |
| --- | --- |
| `layer/*`, `r.forbid`, `r.onlyDependOn`: "imports X" | Move the code into a layer that may own it. Or invert the dependency: put an interface in the lower layer, implement it in the higher one, and pass the implementation in. Deleting the import is a fix only when the code does not need it. |
| `public-api/*` | Import through the layer's entry file. If the symbol belongs to the public surface, export it from that entry file. |
| `archer/acyclic`: "is part of a dependency cycle: a.ts → b.ts → a.ts" | Move what both sides need into a third file that neither imports back. Every file in a cycle gets its own finding, so one fix clears several. |
| Transitive rule: "depends on x.ts through a.ts → b.ts → x.ts" | Cut the chain at the link that crosses the boundary. `at` is the first import in the chain, and the wrong link may be further down. |
| "does not satisfy the rule's requirement" | A `require`-style rule found nothing. Add the dependency, dependent, or call it asks for. |
| Declarations, exports, calls, file names, line counts | Change the declaration, narrow the exports, replace the call, rename the file, or split it. |
| Custom rule | The message is whatever the rule's check wrote. Read the check in the config. |

A fix that moves a file changes which layer it belongs to, so check that the new location is the one the layer selectors expect.

### Computed imports

An `import(expr)` or `require(expr)` with a non-literal specifier has no static target, so Archer fails closed. `r.forbid` and `r.onlyDependOn` report it whatever the rule's object is, because it might load anything. `r.require` is never satisfied by one. `archer/resolvable`, which `presets.recommended` includes, reports it too. Layer rules skip it, because they follow local files only.

Replace the computed specifier with literals, so every target is analyzed and checked against the layers:

```ts
const locales = {
  en: () => import("./locales/en.ts"),
  pt: () => import("./locales/pt.ts"),
}
```

If the dynamic load is deliberate, such as a plugin loader, tell the user. The usual policy for that is a narrow `r.resolvable(..., { allowComputed: true, reason })` on that one file, plus excluding the file from the subjects of the other rules that flag it. Apply that only after the user agrees, and name the file as unverified in your report.

## Baselines

A baseline is for adopting Archer in a codebase that already has violations. Use it only when the user agrees to accept the current debt.

1. Run `npx archer check -r agent`, fix what is cheap, and confirm that every remaining finding is debt the user accepts.
2. Run `npx archer baseline record`. It replaces `.archer-baseline` (the `baseline` field sets the path) with the fingerprints of all current findings. Commit the file.
3. From then on, the baselined findings are hidden and counted in `suppressed`. A new error still fails the check.
4. As the debt gets fixed, `stale` grows. Run `npx archer baseline prune` to drop entries that no finding matches. It never adds an entry.

One entry hides every finding with that `id`, so a second copy of an already baselined import in the same file is hidden too. Do not run `record` to clear a failing check, and do not edit the baseline by hand. Renaming a rule id orphans that rule's entries, and its old findings come back.

## Add the test

Add one test next to the repo's other tests, written for its runner:

```ts
import { assertArchitecture, dispose } from "@lucasacoutinho/archer"
import { afterAll, test } from "vitest"

afterAll(dispose)

test("architecture", () => assertArchitecture(), 60_000)
```

`assertArchitecture` runs the whole check and rejects with an `ArchitectureError` when the verdict is `fail`. The error message is the pretty report, and `error.report` holds the data. It takes `{ config, cwd }`: `config` is a file path or an inline config, and `cwd` defaults to the process directory, so pass it when the runner starts elsewhere. Analysis can take a while on a large repo, so raise the runner's timeout. `dispose` stops the TypeScript server that the first run started, as Archer's own test does.

Add `archer check` to the repo's CI or a `package.json` script when the user wants the check outside the test run.

## Report

List the findings you fixed and the ones that remain, by `rule` and `id`. Report policy changes (rules, baseline, config) separately from source fixes, and say whether the user asked for them. Name anything Archer could not see: computed imports, files outside the tsconfigs, rules in `emptySubjects` or `emptyObjects`. End with the final `summary` line.
