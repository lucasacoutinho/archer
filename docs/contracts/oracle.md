# Oracle protocol

The Lean oracle (`lean/Oracle.lean`, built as `lake build archer-oracle`)
runs the checked Lean implementation on JSON input. Differential tests send
the same input to the TypeScript port and compare complete outputs. This is
evidence for obligation T1, not a proof of it.

## JSON shape of Lean values

The TypeScript schemas encode to the same JSON. The shape follows
mechanically from the Lean declarations:

| Lean | JSON |
| --- | --- |
| `structure` | Object with the Lean field names |
| Inductive whose constructors all have no arguments | String: the constructor name, such as `"static"`, `"looseEquality"`, `"outgoing"` |
| Any other inductive | Object with `"_tag"`: the constructor name with its first letter capitalized, plus one field per named argument, such as `{"_tag": "File", "path": ["src", "a.ts"]}` and `{"_tag": "Computed"}` |
| `Option α` field | The field is omitted for `none` |
| `List α`, `FilePath` | Array |
| `α × β` | Two-element array |
| `Nat` | Non-negative integer |
| `Char` | String of one code point |
| `String`, `Bool` | String, boolean |

`Rule`, `Policy`, `Config`, `Violation`, `Evidence`, `Fingerprint`, and
`Applied` all follow this table. For example, `Assertion.reach .outgoing
.forbid s ef` is
`{"_tag": "Reach", "direction": "outgoing", "relation": "forbid", "object": …, "edges": …}`.

## Requests

The oracle reads one JSON array of requests from standard input. It writes
one JSON array of responses, in the same order, to standard output. Each
request is an object with an `op` field:

| `op` | Fields | Response | Lean function |
| --- | --- | --- | --- |
| `pathAccepts` | `tokens: PathToken[]`, `path: FilePath` | boolean | `pathAccepts` |
| `selects` | `selector: Selector`, `target: Target` | boolean | `Selector.selects` |
| `reach` | `graph: Graph`, `edges: EdgeFilter`, `source: FilePath` | `[Target, Edge[]][]` | `Impl.reach` |
| `check` | `policy: Rule[]`, `graph: Graph`, `custom: CustomResult[]` | `Violation[]` | `Impl.check` |
| `lower` | `config: Config` | `{"ok": Rule[]}` or `{"error": ConfigError}` | `Impl.lower` |
| `encode` | `fingerprint: Fingerprint` | string | `Impl.encode` |
| `decode` | `line: string` | `Fingerprint`, or `null` | `Impl.decode` |
| `record` | `violations: Violation[]` | `Fingerprint[]` | `Impl.record` |
| `apply` | `baseline: Fingerprint[]`, `violations: Violation[]` | `Applied` | `Impl.apply` |
| `fingerprint` | `violation: Violation` | `Fingerprint` | `Violation.fingerprint` |
| `emptySubjects` | `policy: Rule[]`, `graph: Graph` | `string[]` | `emptySubjects` |
| `emptyObjects` | `policy: Rule[]`, `graph: Graph` | `string[]` | `emptyObjects` |
| `parse` | `text: string` | `{"ok": ConfigSelector}` or `{"error": ParseError}` | `Impl.parse` |
| `print` | `selector: ConfigSelector` | string, or `null` | `Impl.print` |

A `CustomResult` is `{"name": string, "subject": FilePath, "messages":
string[]}`. The oracle's `CustomRules` function returns the messages of the
first entry with that name and subject, and `[]` when there is none.

A malformed request gets the response `{"invalid": "<reason>"}`. The oracle
fails the whole batch only when standard input is not a JSON array.

## Trust

The oracle runs Lean's compiled code, so the Lean compiler and runtime are
trusted for this evidence. The proofs are checked by the kernel and do not
depend on the oracle.
