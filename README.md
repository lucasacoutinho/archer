# Archer

Write architecture rules as tests for TypeScript and JavaScript projects.
Archer resolves imports with your `tsconfig.json`, so path aliases, type-only
imports, re-exports, CommonJS `require()`, and static dynamic imports are part
of the same dependency graph.

Archer is an early package. Its rule names borrow the fluent style of
[Pest architecture tests](https://pestphp.com/docs/arch-testing), but its model
uses files and module dependencies rather than PHP namespaces and classes.

## Install

```sh
npm install --save-dev archer typescript
```

Node.js 20 or newer and TypeScript 5.7 or newer are required. Install the test
runner you plan to use. The core `archer` import has no test-runner dependency.

## Use with Vitest

Create a normal test file:

```ts
// test/architecture.test.ts
import { arch } from 'archer/vitest'

arch('the domain stays independent')
  .expect('src/domain/**')
  .not.toDependOn('src/infrastructure/**')
  .and.toOnlyDependOn([
    'src/domain/**',
    'src/shared/**',
    'npm:decimal.js',
  ])

arch('repositories are infrastructure details')
  .expect('src/infrastructure/**/*.repository.ts')
  .toOnlyBeDependedOnBy('src/application/**')
  .and.toHaveSuffix('.repository.ts')
```

Run Vitest as usual:

```sh
npx vitest run
```

## Other test runners

Every adapter exports the same `arch()` builder. Only its test-runner options
differ.

### Jest

```ts
import { arch } from 'archer/jest'

arch('the domain stays independent', {
  timeout: 10_000,
})
  .expect('src/domain/**')
  .not.toDependOn('src/infrastructure/**')
```

Jest 29 and 30 are supported. The adapter uses Jest's explicit
`@jest/globals` API.

### Bun

```ts
import { arch } from 'archer/bun'

arch('the domain stays independent', {
  timeout: 10_000,
})
  .expect('src/domain/**')
  .not.toDependOn('src/infrastructure/**')
```

Run the file with `bun test`.

### Node

```ts
import { arch } from 'archer/node'

arch('the domain stays independent', {
  test: { timeout: 10_000 },
})
  .expect('src/domain/**')
  .not.toDependOn('src/infrastructure/**')
```

Run the file with `node --test`. The `test` object accepts the options from
Node's built-in test runner.

An invalid import fails at its source location:

```text
1 architecture violation:

  src/domain/order.ts:3:25
  Imports '../infrastructure/database.js', resolved as 'src/infrastructure/database.ts'.
  Rule: 'src/domain/**' must not depend on 'src/infrastructure/**'
```

## Use without a test adapter

The core package returns a structured result and does not depend on Vitest:

```ts
import { ArchitectureError, createArcher } from 'archer'

const archer = createArcher({
  root: process.cwd(),
  include: ['packages/*/src/**/*.ts'],
  exclude: ['**/*.generated.ts'],
  tsconfig: 'tsconfig.json',
})

archer
  .expect('packages/core/src/**')
  .not.toUse(['packages/web/**', 'npm:react'])

const result = await archer.check()
if (!result.ok) {
  throw new ArchitectureError(result)
}
```

## Selectors

Source selectors are project-relative globs:

```ts
archer.expect('src/domain/**')
archer.expect(['src/domain/**', 'src/shared/**'])
```

Dependency selectors use these forms:

| Selector | Matches |
| --- | --- |
| `src/domain/**` | Files resolved inside the project root |
| `npm:react` | A package and its subpath imports |
| `npm:@scope/*` | Scoped packages matched by a glob |
| `node:fs` | A Node built-in module |
| `unresolved:*` | Imports TypeScript could not resolve |
| `dynamic:*` | Computed dynamic imports that have no static target |

Archer includes type-only imports in dependency rules. This is deliberate: a
type dependency can still cross a boundary and couple two packages at build
time.

Literal lazy imports such as `import('../infrastructure/database.js')` resolve
to their project file and follow every normal dependency rule. Archer records
computed imports such as `import(moduleName)` as `dynamic:unknown`. Negative
dependency rules fail on that unknown target because Archer cannot prove the
boundary. An allow-list rule must include `dynamic:*` to accept the indirection.

## Rules

The first release has dependency, ownership, naming, size, and cycle rules:

```ts
archer.expect('src/domain/**')
  .toDependOn('src/shared/**')
  .not.toDependOn('src/infrastructure/**')
  .toOnlyDependOn(['src/domain/**', 'src/shared/**'])
  .toBeDependedOnBy('src/application/**')
  .toOnlyBeDependedOnBy('src/application/**')
  .toBeFreeOfCycles()
  .toHavePrefix('domain-')
  .toHaveSuffix('.ts')
  .toHaveLineCountLessThan(300)
```

Pest-style aliases are available for dependency rules:

- `toUse()` maps to `toDependOn()`.
- `toOnlyUse()` maps to `toOnlyDependOn()`.
- `toBeUsedIn()` maps to `toBeDependedOnBy()`.
- `toOnlyBeUsedIn()` maps to `toOnlyBeDependedOnBy()`.
- `toUseNothing()` rejects every import from the selected files.
- `toBeUsed()` requires at least one incoming project import.

Add `.not` before a rule to negate that rule. Negation resets after the next
rule, so `.not.toHavePrefix('legacy-').toHaveSuffix('.ts')` reads as expected.
Use `.ignoring('src/domain/legacy/**')` to remove files from every rule built
from that `expect()` call. Empty source selections fail instead of passing by
vacuous truth.

## Current boundary

Archer analyzes syntax and module resolution. It does not run the TypeScript
type checker, inspect runtime dependency injection, or infer framework-specific
class roles. Rules such as `toExtend()` and presets for NestJS or Next.js need a
semantic type graph and are not claimed by this release.

## Development

```sh
npm install
npm run check
npm run check:package
npm run release:check
```
