# Contracts and obligations

Archer's pure core is specified in Lean 4 under `lean/`. Each contract is a
structure of propositions over an implementation (`ReachSpec reach`,
`CheckSpec check`, and so on). The specification files never define the
implementation, so a proof cannot bend the contract to fit the code.

| File | Role | Who changes it |
| --- | --- | --- |
| `Archer/Pattern.lean` | List patterns, the glob matcher, and its proofs | Contract owner |
| `Archer/Model.lean`, `Rule.lean`, `Config.lean`, `Fingerprint.lean` | Data and the definitional semantics of selectors, predicates, and transformations | Contract owner |
| `Archer/Spec/*.lean` | Obligations as propositions | Contract owner |
| `Archer/Impl/*.lean` | Executable implementations and their proofs | Implementers |
| `Challenge.lean` | Hand-built cases that the specifications must accept or reject | Contract owner |
| `Audit.lean` | Axiom audit of every required theorem | Contract owner |

Rules for implementers: the contract files are read-only. When an
obligation looks false, report the counterexample goal; do not edit the
specification. `sorry`, `admit`, custom axioms, and `native_decide` are not
allowed. Every executable definition is structurally recursive, so the kernel
can evaluate examples with `decide`.

## Verification commands

From `lean/`:

```sh
npm run lean    # scripts/lean-audit.sh: builds every module, checks Challenge.lean,
                # and fails unless each theorem in Audit.lean uses only standard axioms
```

## Obligations

| ID | Obligation | Theorem | Status |
| --- | --- | --- | --- |
| P1 | The glob matcher decides the list-pattern specification | `Pattern.accepts_iff` | proved |
| P2 | `*` and `**` alone accept everything | `Pattern.many_matches_all` | proved |
| P3 | A pattern without `*` or `**` accepts only lists of its length | `Pattern.sat_only_length` | proved |
| P4 | A plain directory path selects every file under it | `Pattern.extend_many` | proved |
| R1–R3 | Reachability reports exactly the reachable targets, once each, with shortest witnesses | `Impl.reach_spec : ReachSpec reach` | proved |
| C1–C3 | The check reports exactly the admissible violations, once per key | `Impl.check_spec : CheckSpec check` | proved |
| L1–L6 | Lowering rejects exactly the invalid configurations, preserves user rules, and turns layer tables and public APIs into rules with the stated meaning | `Impl.lower_spec : LowerSpec lower` | proved |
| F1–F2 | Fingerprint encoding is decodable and takes one line | `Impl.encode_spec : EncodeSpec encode decode` | proved |
| B1–B5 | Baseline application partitions violations by fingerprint, and recording captures exactly the current fingerprints | `Impl.baseline_spec : BaselineSpec apply record` | proved |
| O1 | Reports list violations in one canonical order | The order of `Impl.check` (rules, then subjects, then evidence), fixed by the definition and compared by the differential tests. Reporters may group for display but do not reorder the data. Another order would be specified in Lean first | specified by definition |
| S1–S6 | Selector text parses as [selector-text.md](selector-text.md) states, and printing a parsed selector parses back to it | `Impl.text_spec : TextSpec parse print` | proved |
| E1 | Reports list the rules whose subject selects no source file, apart from the violations | `emptySubjects`, defined in `Archer/Rule.lean`; it never enters fingerprints or baselines | specified by definition |
| E2 | Reports list the dependency rules whose object names files by a glob but selects none of them | `emptyObjects`, defined in `Archer/Rule.lean`, with a challenge example in `Challenge.lean` | specified by definition |
| T1 | The TypeScript port of each implementation corresponds to the Lean definition | none. Evidence: `test/differential/core.test.ts` compares complete outputs with the Lean oracle on 400 seeded inputs (every op, every evidence kind), and planted bugs fail it | pending, by design |

## Trust boundaries

- **Analyzer.** The [analyzer contract](analyzer.md) is prose. The Lean model
  takes the graph as given and assumes `Graph.WellFormed`. The analyzer
  contract suite tests that boundary but does not prove it.
- **Custom rules.** `CustomRules` closures are opaque. The model reports
  exactly what they return.
- **Schema guards.** Decoding establishes premises that the Lean types do
  not encode. Examples are non-empty `EdgeFilter.kinds`, non-empty segments,
  and positive line limits. A rule with `kinds = []` is legal in the model
  and vacuous there. The TypeScript schemas also require `maxLines.max ≥ 1`
  and `folderDepth ≥ 0`, which the model allows to be 0.

## Semantic decisions recorded in the specifications

- **Granularity.** Direct dependency rules report one violation per import
  site (`Evidence.dependency`). Transitive rules report one violation per
  forbidden target (`Evidence.walk`), with a shortest witness.
- **Computed imports fail closed.** For `forbid` rules, a computed import
  violates whatever the object selects (`Spec.Forbidden`). It never satisfies
  `require`. Layer rules use `localOnly` edges, so computed imports do not
  reach them.
- **Incoming rules.** A file is never its own dependent (`Spec.Dependent`).
- **Unconstrained files.** Layer rules constrain only dependencies on files
  of other declared layers. Files outside every layer are unconstrained, as
  in ArchUnit's layered architecture. Layer and public-API rules have error
  severity.
- **Vacuous declarations.** `declares every P` holds for a file without
  declarations.
- **Ties between shortest witnesses.** The specification admits any
  shortest witness. The Lean implementation fixes the order: breadth-first
  search in graph file order and dependency order. The TypeScript port must
  produce the same witness, and differential tests compare complete output.
- **Fingerprint encoding.** One line of `|`-separated fields with
  backslash escapes, specified by the grammar in `Archer/Impl/Baseline.lean`.
  The encoding also escapes `\r`, which F2 does not require. A fingerprint
  leaves out locations, so one baseline entry suppresses every violation
  with the same rule, subject, and key.
- **Global calls.** A use is global only when its name resolves to no
  declaration (`Binding.global`), so a call to a locally declared `eval` is
  not a global use.
