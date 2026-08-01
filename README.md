# Archer

Architecture tests for TypeScript and JavaScript. Archer builds a resolved
module graph, lets you describe boundaries with a fluent API, and reports a
normal test failure when the code stops matching the design.

It takes its readable rule style from [Pest architecture testing](https://pestphp.com/docs/arch-testing),
but models files, packages, imports, exports, and TypeScript declarations.

## Install

```sh
npm install --save-dev @usescherie/archer typescript
```

Archer supports Node.js 20 and newer and TypeScript 5.7 through 6.x. The core
package has no test-runner dependency.

## Start with the CLI

Create `archer.config.ts`:

```ts
import { defineConfig } from '@usescherie/archer'

export default defineConfig({
  include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
  exclude: ['**/*.generated.ts'],

  rules(archer) {
    archer
      .expect('src/domain/**')
      .not.toDependOn('src/infrastructure/**')
      .because('The domain must remain portable.')
      .as('boundaries/domain-isolation')

    archer.expect('src/**').toBeFreeOfCycles()
  },
})
```

Then run:

```sh
npx archer check
npx archer check --watch
```

`archer init` creates a starter config. Config paths, output paths, and the
project root are resolved relative to the config file.

## Test-runner adapters

Each adapter registers a test immediately and returns the same rule builder.

```ts
// test/architecture.test.ts
import { arch } from '@usescherie/archer/vitest'

arch('the domain stays independent')
  .expect('src/domain/**')
  .not.toDependOn('src/infrastructure/**')
  .and.toOnlyDependOn(['src/domain/**', 'src/shared/**'])
```

The other entry points are:

```ts
import { arch } from '@usescherie/archer/jest'
import { arch } from '@usescherie/archer/bun'
import { arch } from '@usescherie/archer/node'
```

Jest and Bun accept `timeout` as an Archer adapter option. The Node adapter
accepts built-in `node:test` options under `test`.

## Vitest config plugin

Vitest can run Archer once, before it starts collecting tests. The plugin loads
`archer.config.*` from the Vitest project root by default:

```ts
// vitest.config.ts
import { archer } from '@usescherie/archer/vitest'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [archer()],
})
```

Pass `config`, `reporter`, `baseline`, `output`, or `failOnWarnings` to
`archer()` when the defaults are not enough. This is a configuration plugin,
so it performs one architecture check for the Vitest project instead of
registering a test in every worker.

## Matcher setup modules

Vitest, Jest, and Bun can also install Archer as an `expect` plugin. This keeps
the runner integration in its normal setup hook and lets architecture tests use
the same assertion in every runner.

For Vitest, add the plugin to `setupFiles`:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['@usescherie/archer/vitest/plugin'],
  },
})
```

For Jest, add it to `setupFilesAfterEnv`:

```ts
// jest.config.ts
export default {
  setupFilesAfterEnv: ['@usescherie/archer/jest/plugin'],
}
```

For Bun, preload it from `bunfig.toml`:

```toml
[test]
preload = ["@usescherie/archer/bun/plugin"]
```

Then create a normal test and await the asynchronous matcher:

```ts
import { createArcher } from '@usescherie/archer'

test('the architecture is respected', async () => {
  const archer = createArcher()
  archer.expect('src/domain/**').not.toDependOn('src/infrastructure/**')

  await expect(archer).toRespectArchitecture()
})
```

The plugin installs the matcher; it does not silently inject a test into every
worker. Use the `arch()` adapter when the fluent one-call form is preferable.

## Dependency rules

```ts
archer
  .expect('src/application/**')
  .toDependOn('src/domain/**')
  .not.toDependOn('src/web/**')
  .toOnlyDependOn(['src/application/**', 'src/domain/**', 'npm:zod'])
  .toBeDependedOnBy('src/http/**')
  .toOnlyBeDependedOnBy(['src/http/**', 'src/jobs/**'])
```

Aliases are available for Pest-style wording: `toUse`, `toOnlyUse`,
`toBeUsedIn`, `toOnlyBeUsedIn`, `toUseNothing`, and `toBeUsed`.

Modifiers apply to the next dependency rule and then reset:

```ts
archer
  .expect('src/application/**')
  .typeDependencies()
  .toOnlyDependOn('src/contracts/**')
  .runtimeDependencies()
  .not.toDependOn('src/testing/**')
  .dynamicDependencies()
  .not.toDependOn('src/admin/**')
  .localDependencies()
  .toOnlyDependOn(['src/application/**', 'src/domain/**'])
  .toTransitivelyDependOn('src/domain/events.ts')
```

Use `includingDependencyKinds('static', 'require')` for an exact combination,
or `.transitively().toDependOn(...)` for explicit reachability. Transitive
violations include the shortest discovered import chain.

### Selectors and resolution

| Selector        | Meaning                                          |
| --------------- | ------------------------------------------------ |
| `src/domain/**` | Files resolved inside the configured root        |
| `npm:react`     | An installed package and its subpaths            |
| `node:fs`       | A Node built-in                                  |
| `bun:test`      | A Bun built-in                                   |
| `unresolved:*`  | Imports TypeScript could not resolve             |
| `dynamic:*`     | Computed dynamic imports without a static target |

Archer resolves path aliases, package exports, project references, workspace
packages, symlinks, `.js` imports of TypeScript sources, re-exports,
`import type`, import types, CommonJS `require`, and lazy imports.

Literal lazy imports such as `import('./admin.js')` are normal resolved edges.
A computed import such as `import(moduleName)` becomes `dynamic:unknown`.
Negative boundary rules fail closed on that edge because the target cannot be
proven safe; an allow-list can explicitly include `dynamic:*`.

## Named layers and public APIs

```ts
const layers = archer.layers({
  domain: 'src/domain/**',
  application: 'src/application/**',
  infrastructure: 'src/infrastructure/**',
})

layers.where('domain').mayNotDependOn('infrastructure')
layers.where('application').mayOnlyDependOn('domain')
layers.where('domain').mayOnlyBeUsedBy('application')
layers.where('domain').exposeThrough('src/domain/index.ts')
layers.toBeFreeOfCycles()
```

Layer rules only constrain local project dependencies. External packages do
not need to be repeated in every layer allow-list. `exposeThrough` rejects
deep imports into a layer from outside it.

For directory-level cycles, collapse file nodes to a fixed depth:

```ts
archer.expect('src/**').toBeFreeOfFolderCycles(2)
```

## TypeScript-aware rules

Archer uses the configured TypeScript programs for declarations, resolved
heritage, exports, decorators, method visibility, and global-call detection.

```ts
archer
  .expect('src/controllers/**')
  .toBeClasses()
  .toExtend('BaseController')
  .toImplement('Runnable')
  .toHaveDecorator('Controller')
  .toHaveReadonlyProperties()
  .toHaveMethods('execute')
  .toHavePublicMethods('execute')
  .toHaveProtectedMethods('reset')
  .toOnlyHavePublicMethods()
  .toBeExported()

archer.expect('src/contracts/**').toBeInterfaces()
archer.expect('src/base-controller.ts').toBeAbstract()
archer.expect('src/status.ts').toBeEnums()
archer.expect('src/factories/**').toBeFunctions()
archer.expect('src/models/**').toBeTypes()
archer.expect('src/index.ts').toOnlyExport('Client', 'ClientOptions')
archer.expect('src/**').toUseStrictEquality()
archer.expect('src/**').not.toUseGlobals('eval', 'Function')
archer.expect('src/**').not.toUseImportedSymbols('react', 'useEffect')
archer.expect('src/**').toHaveResolvableDependencies()
archer.expect('src/index.ts').toBePublicApi()
```

Naming and size rules remain available through `toHavePrefix`,
`toHaveSuffix`, and `toHaveLineCountLessThan`.

These are static checks. Runtime dependency injection, reflection-generated
exports, and targets hidden behind computed imports cannot be inferred.

### Imported API policies

`toUseImportedSymbols()` matches calls by their original module and export. It
recognizes named-import aliases, namespace calls, default-import property
calls, element access with a literal name, and CommonJS destructuring.

That keeps framework names out of Archer's rule engine. A React policy can be
written from generic rules:

```ts
archer
  .expect('src/frontend/components/**/*.{ts,tsx}')
  .not.toBeClasses()
  .and.not.toUseImportedSymbols('react', 'useEffect', 'useContext')

archer.expect('src/frontend/state/**').toDependOn('npm:zustand')
```

The same call rule can reject Vue `provide` and `inject`, or Svelte
`setContext` and `getContext`, in JavaScript and TypeScript modules:

```ts
archer.expect('src/vue/**').not.toUseImportedSymbols('vue', 'provide', 'inject')
archer.expect('src/svelte/**').not.toUseImportedSymbols('svelte', 'setContext', 'getContext')
```

Vue and Svelte single-file components need their compiler parsers because a
`.vue` or `.svelte` file is not a TypeScript source file. Archer does not parse
those formats as TypeScript or claim that their template dependencies were
checked. They belong in source-analyzer integrations, while the core rules
remain framework-neutral.

## Rule metadata, custom rules, and presets

Rules default to error severity. Stable IDs make baselines and CI annotations
less sensitive to wording changes.

```ts
archer
  .expect('src/legacy/**')
  .not.toDependOn('src/new-core/**')
  .as('migration/no-new-core')
  .because('Legacy code is being removed, not expanded.')
  .withSeverity('warning')
```

Custom rules may be synchronous or asynchronous:

```ts
archer.expect('src/features/**').toSatisfy('features/one-entrypoint', ({ modules }) =>
  modules.flatMap((module) =>
    module.exports.length > 1
      ? [
          {
            file: module.path,
            message: 'Feature exports more than one symbol.',
            rule: 'features expose one entrypoint',
            severity: 'error',
          },
        ]
      : [],
  ),
)
```

Built-in presets are `strict`, `node`, and `security`:

```ts
archer.preset('strict')
archer.preset('node')

registerPreset('company', (suite) => {
  suite.expect('src/**').not.toDependOn('npm:deprecated-sdk')
})
```

## Monorepos and project references

Archer discovers npm/Yarn and pnpm workspaces plus referenced tsconfigs. You
can also declare projects and override their source selection:

```ts
export default defineConfig({
  projects: [
    'packages/core/tsconfig.json',
    {
      tsconfig: 'apps/*/tsconfig.json',
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
    },
  ],
  rules(archer) {
    archer.expect('packages/**').toBeFreeOfCycles()
  },
})
```

Set `workspaces: false`, `followSymlinks: false`, `cache: false`, or
`tsconfig: false` to override the corresponding defaults.

## Reports and baselines

The CLI supports `pretty`, `agent`, `llm`, `json`, `sarif`, `github`, and `dot` reporters.
`agent` and its `llm` alias emit one stable, single-line record per finding without ANSI output:

```sh
npx archer check --reporter agent
npx archer check --reporter sarif --output reports/archer.sarif
npx archer check --reporter github
npx archer check --reporter dot --output reports/dependencies.dot
```

Adopt Archer in an existing codebase without accepting new violations:

```sh
npx archer check --update-baseline
npx archer check
```

The default baseline is `.archer-baseline.json`. Use `--baseline <file>` or
the config `baseline` field to choose another path. `--fail-on-warnings` makes
warning-level rules affect the CLI exit code.

The core API exposes the same data for integrations:

```ts
import { ArchitectureError, createArcher } from '@usescherie/archer'

const archer = createArcher({ root: process.cwd() })
archer.expect('src/**').toBeFreeOfCycles()

const result = await archer.check()
if (!result.ok) throw new ArchitectureError(result)
```

## Agent skill

Archer ships a portable [Agent Skill](https://openagentskills.dev/) in
`skills/archer`. Its source is versioned with the engine and included in the npm
package, so it is not tied to one developer's local agent configuration.

Install it into any supported coding agent with the Skills CLI:

```sh
npx skills add usescherie/archer --skill archer
```

Agents can then use `$archer` to set up rules, diagnose findings, and fix source
violations without weakening architecture policy.

## Development

Archer dogfoods its rules in both `test/architecture.test.ts` and
`archer.config.ts`. The repository checks Node 20, 22, and 24 on Linux and
Windows, plus Jest, Bun, `node:test`, the CLI, package exports, and type
definitions.

```sh
npm install
npm run fmt
npm run lint
npm run check
npm run check:package
npm run release:check
```

To cross-test the adjacent tiacore checkout, build tiacore once and run:

```sh
npm run test:tia
npm run test:tia:verify
```

The scripts prefer an installed `@usescherie/tiacore` package and otherwise
use `../tiacore`. Set `TIACORE_VITEST_ENTRY` or `TIACORE_CLI` for a checkout in
another location.
