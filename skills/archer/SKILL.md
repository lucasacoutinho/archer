---
name: archer
description: Add, configure, run, and repair Archer architecture tests for JavaScript and TypeScript projects. Use when an agent needs to enforce module boundaries, named layers, dependency direction, public entrypoints, cycles, declaration conventions, or import rules; integrate Archer with its CLI, Vitest, Jest, Bun, or node:test; or interpret and fix Archer violations.
---

# Archer

Use Archer to make architectural constraints executable. Prefer rules that describe an existing design decision and produce a specific source change when they fail.

## Inspect the project

1. Read `package.json`, workspace configuration, and relevant `tsconfig` files.
2. Find existing `archer.config.*` and architecture tests before adding another entrypoint.
3. Identify real dependency directions from imports. Do not infer layers from folder names alone when the code says otherwise.
4. Read the installed Archer README or declarations when its version may differ from this skill.

## Set up Archer

Install `@lucasacoutinho/archer` and `typescript` as development dependencies with the repository's package manager. Prefer the CLI for a runner-independent check:

```ts
import { defineConfig } from '@lucasacoutinho/archer'

export default defineConfig({
  rules(archer) {
    archer
      .expect('src/domain/**')
      .not.toDependOn('src/infrastructure/**')
      .as('boundaries/domain-isolation')
      .because('Domain code must remain independent of adapters.')

    archer.expect('src/**').toBeFreeOfCycles().as('dependencies/no-cycles')
  },
})
```

Run the locally installed binary. With npm, use `npx --no-install archer check`; use the package manager's equivalent local-exec command elsewhere. Add that command to CI after it passes locally.

Use `arch()` when the check should be registered as a test:

```ts
import { arch } from '@lucasacoutinho/archer/vitest'

arch('domain boundaries').expect('src/domain/**').not.toDependOn('src/infrastructure/**')
```

Replace `vitest` with `jest`, `bun`, or `node` for another adapter.

Use the matcher plugin when a project prefers `expect` assertions. Add `@lucasacoutinho/archer/vitest/plugin` to Vitest `setupFiles`, `@lucasacoutinho/archer/jest/plugin` to Jest `setupFilesAfterEnv`, or `@lucasacoutinho/archer/bun/plugin` to Bun's test `preload`. Then await `expect(archer).toRespectArchitecture()` in a dedicated architecture test.

## Write rules

- Start with high-confidence boundaries, cycles, and public entrypoints.
- Give durable rules an ID with `.as()` and record the reason with `.because()`.
- Use `.localDependencies()` for layer allow-lists so npm and platform modules do not need repetition.
- Use dependency-kind modifiers when type-only, runtime, or dynamic coupling has different meaning.
- Treat `dynamic:unknown` as unproven. Do not allow it just to make a check pass.
- Avoid broad ignores. Narrow an exception to the smallest selector and explain it.

Read [references/rules.md](references/rules.md) for selectors, dependency modifiers, named layers, semantic expectations, and presets.

## Diagnose and fix findings

Run:

```sh
npx --no-install archer check --reporter agent
```

The first line contains the status and counts. Each remaining line is one finding with location, severity, rule ID, message, and any dependency, source, reason, or import chain.

1. Open the reported file and follow the import chain when present.
2. Fix the source dependency or declaration that violates the stated rule.
3. Re-run the narrow Archer command, then the repository's normal checks.
4. Do not weaken a rule, add an ignore, or update the baseline unless the user explicitly approves that policy change.

Use `--update-baseline` only for deliberate staged adoption in an existing codebase. Commit the baseline when the project treats it as policy.

## Report the result

State which rules or files changed and include the final Archer summary. Separate source fixes from rule-policy changes. If computed imports, runtime injection, or generated code prevent static proof, name that limitation instead of claiming the boundary passed.
