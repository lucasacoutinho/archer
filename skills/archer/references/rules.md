# Archer rule reference

## Selectors

Use project-relative globs for source files. Dependency selectors also accept:

| Selector        | Matches                                              |
| --------------- | ---------------------------------------------------- |
| `src/domain/**` | Resolved local files                                 |
| `npm:react`     | A package and its subpaths                           |
| `node:fs`       | A Node built-in                                      |
| `bun:test`      | A Bun built-in                                       |
| `unresolved:*`  | Imports TypeScript cannot resolve                    |
| `dynamic:*`     | Computed imports or requires without a static target |

Archer resolves aliases, project references, workspace packages, re-exports, type imports, CommonJS requires, and literal dynamic imports.

## Dependency rules

```ts
archer
  .expect('src/application/**')
  .toDependOn('src/domain/**')
  .not.toDependOn('src/web/**')
  .toOnlyDependOn(['src/application/**', 'src/domain/**'])
  .toBeDependedOnBy('src/http/**')
  .toOnlyBeDependedOnBy(['src/http/**', 'src/jobs/**'])
```

Aliases include `toUse`, `toOnlyUse`, `toUseNothing`, `toBeUsed`, `toBeUsedIn`, and `toOnlyBeUsedIn`.

Apply a modifier to the next dependency rule:

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

Use `includingDependencyKinds(...)`, `transitively()`, and `toTransitivelyBeDependedOnBy(...)` for other combinations.

## Layers and cycles

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

archer.expect('src/**').toBeFreeOfFolderCycles(2)
```

## TypeScript-aware expectations

- Kinds: `toBeClasses`, `toBeInterfaces`, `toBeEnums`, `toBeFunctions`, `toBeTypes`
- Declarations: `toBeAbstract`, `toBeExported`, `toExtend`, `toImplement`, `toHaveDecorator`
- Members: `toHaveReadonlyProperties`, `toHaveMethods`, `toHavePublicMethods`, `toHaveProtectedMethods`, `toHavePrivateMethods`, `toOnlyHavePublicMethods`
- Modules: `toOnlyExport`, `toHaveResolvableDependencies`, `toBePublicApi`
- Source: `toUseStrictEquality`, `toUseGlobals`, `toHavePrefix`, `toHaveSuffix`, `toHaveLineCountLessThan`
- Imported calls: `toUseImportedSymbols('react', 'useEffect')`; aliases and namespace calls resolve to the original module export

Negate supported rules with `.not`. Remove selected files with `.ignoring(...)`. Attach `.as(id)`, `.because(reason)`, and `.withSeverity('warning' | 'info' | 'error')` after a rule.

## Presets and custom checks

Built-in presets are `strict`, `node`, and `security`:

```ts
archer.preset('strict')
```

Use `toSatisfy(id, evaluator)` for selector-scoped custom rules or `archer.rule(id, evaluator)` for a graph-wide rule. Return structured `ArchitectureViolation` objects. Prefer built-in rules when they express the same constraint.
