# 0003: The shell around the verified core

Status: steps 1–6 done, including the `replay` analyzer, `archer graph`, and
`archer check --graph`. `npm run check` runs the Lean audit, the type check,
the tests, the build, and Archer on itself. A vitest test also runs Archer
on itself through `assertArchitecture`. The debts listed at the end are done.

Open:

- The Windows CI job has never run. Whether `prepare` (`effect-tsgo patch`)
  works on win32 is unknown. The verified core (contracts in
[`docs/contracts/`](../contracts/README.md)) and the analyzer are done. This
record fixes the order and decisions for everything that turns user input
into a check and a check into output.

## Order of work

1. **Selector text (S1).** This is a full LDD slice, and it comes first
   because the configuration, the `r.*` constructors, and the public `check`
   all depend on it. It is also the last place where TypeScript and Lean
   must agree character for character. Contract: `parse : String → Except
   ParseError ConfigSelector`, `print`, and `parse (print s) = .ok s` on the
   printable subset. The slice adds an oracle op and random selector strings
   to the differential generator. In TypeScript, the parser is a schema
   transformation from `String` to `ConfigSelector`, written without regex.
2. **Public configuration.** Reshape the caller's configuration into the
   Lean `Config`: records become lists, selector text becomes
   `ConfigSelector`, and `r.*` constructors return `RuleOf<ConfigSelector>`.
   The reshaping contains no logic beyond that. A property test checks that
   it is total on generated public configurations.
3. **`run`.** The Effect pipeline: load the configuration, decode it, lower
   it, analyze, check, read the baseline, apply it, and give the verdict.
   It is exposed from `./effect`, and the root export wraps it in Promises.
4. **Reporters:** pretty, agent, JSON, SARIF, GitHub, DOT.
5. **CLI:** `check [--watch] [--reporter] [--output] [--graph]`,
   `baseline record|prune`, `graph`, `init`.
6. **Dogfooding.** An `archer.config.ts` for Archer itself runs in `npm run
   check`. It is the acceptance test for the whole shell.

## Decisions

- **Rule IDs are required** on every rule the caller writes. Lowered layer
  and public-API rules get theirs from `layerRuleId` and `publicApiRuleId`.
  A derived ID would change whenever the rule's content changes, and its
  fingerprints and baseline entries would change with it.
- **Layer names may not look like array indexes.** `layers` and `allow` are
  records, and JavaScript enumerates integer-like keys before the others,
  while Lean's rule order follows `layers` order. Decoding rejects layer
  names such as `"0"` or `"12"` with a structural check, so record order is
  insertion order.
- **The baseline file** starts with the header line `archer-baseline 1`,
  followed by one `encode` line per fingerprint in `record` order. The
  header is read and checked outside the Lean decoder, which works per line.
  Any other header is a `BaselineError`.
- **Custom rule crashes** become one `Custom` message under the rule's ID
  (see [0002](0002-interface.md)).
- **Configuration loading.** The configuration file is loaded with native
  `import()` of `archer.config.ts`. It must work in packages with
  `"type": "module"` and in packages without a `type` field, and with
  sibling imports that use the `.ts` extension. Watch mode adds a query
  string to the import to bypass the module cache. That reaches only the
  configuration file: edits to modules it imports need a restart, because
  Node keeps them cached. Fixing this would need a loader hook or a worker
  per reload. Node never frees a module instance, so the loader reuses the
  last instance while the file's text is unchanged. Watch mode avoids the
  problem altogether: each run is a child process (`node <cli> check …`
  without `--watch`), so every module reloads and nothing is retained. The
  watcher ignores its own `--output` file, and also watches the
  configuration file's directory, which covers modules beside the
  configuration.
- **The pretty reporter** reads source lines through `FileSystem`. When a
  read fails, it prints the finding without the line.
- **Report order** is the check's order (O1). Reporters may group findings
  by file for display, but they never reorder the data.

## Performance

The TypeScript check computes the same output as the Lean definition, order
included, and the differential tests compare every byte. Within that
constraint:

- `reach` is memoized for the duration of one check, and each result is
  indexed by target. Incoming rules ask whether a dependent reaches a
  subject, so that question costs a lookup, not a search.
- Incoming direct rules use a reverse index of import sites, built once per
  rule in graph file order and then dependency order. That is the order the
  Lean definition produces.
- Cycle rules search only from files in a strongly connected component with
  more than one file, or that import themselves. Only those files can reach
  themselves. Each search stops when it discovers the subject. Breadth-first
  search discovers each target once, so the witness is the one the full
  search would report.
- Hot loops compare paths and targets with `keys.ts`, not `structuralKey`.
- `./effect` provides only the file system and path services, not
  `NodeServices`, which also loads HTTP and sockets. This halves the import
  time of the root export.

On a synthetic 1,000-file graph that is one strongly connected tangle,
incoming transitive rules went from 22.7 s to 0.16 s and cycle rules from
8.9 s to 0.34 s. At 4,000 files, the cycle rule previously ran out of
memory; it now takes 4 s. `test/core/scale.test.ts` guards against a return
to superlinear growth.

## Debts carried from the first design

These existed in `.legacy/`. All of them exist again:

- the user README
- `.github` CI. It needs elan and `npm run check`, and `npm ci` must run
  `prepare`, which patches `tsc` with the Effect diagnostics.
- the publish workflow with trusted publishing
- the shipped agent skill `skills/archer`
- a CHANGELOG entry for the breaking 0.3.0 release
