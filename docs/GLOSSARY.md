# Archer glossary

Archer's domain vocabulary. Design records, Lean contracts, TypeScript names,
and tests use these terms with these meanings. Design-structure vocabulary
(module, interface, seam, adapter, depth, leverage, locality) follows the
codebase-design glossary. Archer's own unit of code is a **source file**, not a
"module", so the two vocabularies do not collide.

## Graph

**Source file**: a file Archer analyzed, identified by its root-relative path
with `/` separators. Only source files have outgoing dependencies.
_Avoid_: module (reserved for design vocabulary), SourceModule.

**Target**: anything a dependency can point at. A target is exactly one of:
a source file, a package (`npm:<name>`), a built-in (`node:<name>`,
`bun:<name>`), an unresolved specifier, or a computed import that has no
static target.

**Dependency**: a directed edge from a source file to a target. It is
created by one import site and carries a **dependency kind** and a source
location.

**Dependency kind**: how the edge was written. The kinds are `static`
(value import or re-export), `type` (type-only import or re-export, or an
`import()` type), `require` (CommonJS), and `dynamic` (`import()` expression).

**Graph**: the set of source files and their dependencies for one analysis
run. A graph is immutable after it is built.

**Facts**: per-source-file semantic data other than dependencies:
declarations, exports, calls to imported or global symbols, loose
equality sites, and line count.

**Analyzer**: the producer of a graph and its facts from a workspace. It is
the only part of Archer that talks to TypeScript.

**Workspace**: the root directory plus the tsconfig projects Archer loads.

**Project**: one tsconfig and the source files it includes.

## Rules

**Selector**: a predicate over target identifiers. Path globs select source
files. Prefixed forms (`npm:`, `node:`, `bun:`, `unresolved:`, `computed:`, `layer:`)
select other targets.

**Subject**: a source file selected by a rule's selector. Rules make claims
about their subjects.

**Assertion**: the claim a rule makes about each subject, such as "depends
only on X" or "declares only classes".

**Edge filter**: the restriction on which dependencies an assertion
considers: dependency kinds, local-only, and direct versus transitive.

**Rule**: a selector, an assertion, an edge filter where relevant, and rule
metadata. A rule is data; evaluating it is a separate step.

**Rule metadata**: the rule's stable **rule ID**, **reason**, and
**severity** (`error`, `warning`, `info`).

**Layer**: a named selector. A layer rule is defined in terms of dependency
rules over layers.

**Policy**: the complete set of rules evaluated together.
_Avoid_: suite, architecture (as a noun for the rule set).

## Results

**Check**: evaluating a policy against a graph. A check is a pure function
of the policy and the graph.

**Violation**: one failure of one rule on one subject. A violation can carry
a **witness**.

**Witness**: the evidence for a violation. For a transitive dependency
violation, it is the dependency chain from the subject to the forbidden
target. For a cycle, it is the closed chain.

**Fingerprint**: a stable identity of a violation that does not depend on
line numbers or message wording.

**Baseline**: a recorded set of fingerprints that a check accepts as
existing violations.

**Report**: the result of a check after the baseline is applied: the
violations, their counts by severity, and the verdict.

**Verdict**: pass or fail. A report fails when it contains an error
violation, or a warning violation when warnings are configured to fail.

**Reporter**: a function from a report to an output format (pretty, agent,
JSON, SARIF, GitHub annotations, DOT).

## Verification

**Contract**, **obligation**, **invariant**, **model**, **refinement**, and
**trust boundary** follow the LDD glossary. The Lean model lives in `lean/`.
The TypeScript implementation is a handwritten port of the Lean model, so
its correspondence to the model is an explicit obligation, not an assumption.
