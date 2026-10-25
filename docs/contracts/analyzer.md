# Contract: the analyzer

The analyzer is the trust boundary between TypeScript and the Lean model.
The model takes the graph as given and assumes `Graph.WellFormed`. This
contract is prose. `test/analyzer/contract.ts` checks it against every
adapter, but does not prove it:

- `Analyzer.typescript` analyzes the workspace with TypeScript's native API.
- `Analyzer.memory(graph)` returns a graph built in memory.
- `Analyzer.replay(path)` reads a graph that `archer graph` saved. The file
  is `{"format": "archer-graph", "version": 1, "graph": …}`, with the graph
  in the schema encoding that the oracle also reads. The version changes
  whenever the graph schema does. Replay ignores the workspace.

## Guarantees of every adapter

1. **Whole or failing.** `analyze` returns the whole graph or an
   `AnalysisError` (`ProjectNotFound`, `ProjectParseFailed`,
   `AnalyzerUnavailable`, and `GraphFileInvalid` for replay). It never returns a partial graph. An unresolved
   specifier is data (`Unresolved`), not an error.
2. **Deterministic.** The same workspace content gives a byte-identical
   encoded graph. Every ordering compares UTF-16 code units (JavaScript's
   `<` on strings), never the locale:
   - files by their joined root-relative path
   - dependencies by line, column, specifier, kind
   - uses by line, column, kind, name
   - exports by name
3. **Paths.** Paths are root-relative segments of real paths, with no `.`,
   `..`, or empty segments.
4. **Source set.** The source set is the union of the tsconfigs' file lists,
   minus declaration files, JSON, files under `node_modules`, and files
   outside the root. A file belongs to the first project, in `projects`
   order, that lists it. Every `File` target is a source file of the graph.
5. **One dependency per import site.** The kinds are:
   - `type` for `import type` and `export type`, for imports whose named
     specifiers are all inline `type`, and for `import("x")` type nodes;
   - `require` for `require()` and `import x = require()`;
   - `dynamic` for `import()` expressions;
   - `static` otherwise.

   An empty `import {} from "m"` still runs the module, so it is `static`.
   Imports inside JSDoc comments are not dependencies.
6. **Targets.**
   - Without a literal specifier, the target is `Computed`. This applies to
     both `import(expr)` and `require(expr)`.
   - Otherwise a built-in is decided by the specifier. A `node:` or `bun:`
     prefix always makes a built-in, and a bare name is one when it is in
     Node's `builtinModules`.
   - Otherwise the target is decided by the file the checker resolved to:
     `Package` under `node_modules`, `File` inside the source set, and
     `Unresolved` for everything else.
   - Package names are scope-aware, and pnpm and nested layouts name the
     package after the last `node_modules`. The specifier keeps its subpath.
     `@types/a__b` is named `@a/b`.
7. **Checker gaps.** TypeScript resolves `require()` only in JavaScript
   files, and it does not resolve packages that ship no types. For those
   cases the adapter matches relative specifiers against the source set,
   trying extensions and `index` files, and looks packages up in the
   `node_modules` directories above the file. Path aliases do not apply to
   these lookups.
8. **Uses.**
   - A call `f()` is recorded with its binding: `Imported` when `f` comes
     from an import or `require()`, `Local` when the file declares `f`, and
     `Global` otherwise.
   - `ns.f()` and `ns["f"]()` are recorded only when `ns` is a namespace or
     default import.
   - Loose equality sites carry the binding `Local`. The model reads only
     their kind.
9. **Declarations.**
   - Overload signatures collapse into one entry.
   - Constructor parameter properties count as properties.
   - A variable statement gives one declaration per bound name.
   - Names exported through `export { a as b }` or `export default a`
     count as exported.
10. **Locations.** Lines and columns are 1-based, and columns count UTF-16
    code units. A location points at:
    - the specifier of a dependency
    - the callee of a call
    - the operator of a loose equality
    - the statement of a declaration
11. **Lines.** A trailing newline ends the last line instead of starting
    another, and an empty file has no lines.
12. **Lifecycle.** The TypeScript server starts on the first `analyze` and
    stops with the layer's scope. Concurrent calls run one after another.
    Each call reads every file again, so a watcher can call `analyze`
    repeatedly. An interrupted analysis completes before the
    interruption takes effect, so its requests never interleave with the next
    analysis on the same server. A failure that makes the server unusable also stops it, and
    the next call starts a new server.
13. **Server exit.** TypeScript's async client never rejects a request that
    is in flight when the server dies. The adapter reads the client's
    private child process (`src/analyzer/server-exit.ts`) and fails the
    analysis when it ends. That is a dependency on TypeScript's internals,
    held in place by the exact version pin and by
    `test/analyzer/server-exit.test.ts`, which fails when the field moves.
