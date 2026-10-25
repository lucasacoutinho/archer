# Contract: list patterns

Lean: `lean/Archer/Pattern.lean`. Status: see the obligation table.

Archer matches globs in two places with the same structure:

- A **segment pattern** matches one path segment, a list of characters.
  `*` matches any run of characters, including none, and `?` matches exactly
  one character. A literal character matches itself.
- A **path pattern** matches a path, a list of segments. `**` matches any run
  of segments, including none. A segment pattern matches exactly one segment.

Both are instances of one **list pattern** over an alphabet `α`: a list of
tokens, where `sat p` consumes one element satisfying `p` and `many`
consumes any run of elements. Literal and `?` are `sat`. `*` and `**` are
`many`. The path level uses `sat (segment pattern matches ·)`.

Globs are never compiled to regular expressions. The parser from selector
text to tokens is a separate slice, with its own contract in `selector.md`.

## Specification

`Matches ps xs` is the inductive relation:

| Case | Rule |
| --- | --- |
| empty | `Matches [] []` |
| sat | `p x = true` and `Matches ps xs` give `Matches (sat p :: ps) (x :: xs)` |
| many, stop | `Matches ps xs` gives `Matches (many :: ps) xs` |
| many, take | `Matches (many :: ps) xs` gives `Matches (many :: ps) (x :: xs)` |

## Obligations

| ID | Proposition | Implementation | Status |
| --- | --- | --- | --- |
| P1 | `accepts ps xs = true ↔ Matches ps xs` for all `ps`, `xs` | `Archer.Pattern.accepts` | proved: `accepts_iff` |
| P2 | `[many]` matches every list | follows from P1 | proved: `many_matches_all` |
| P3 | A pattern of only `sat` tokens matches only lists of its own length | follows from P1 | proved: `sat_only_length` |
| P4 | Appending `many` to a pattern that matches `xs` matches every extension of `xs` | follows from P1 | proved: `extend_many` |

P2 guards against a matcher that rejects everything. P3 guards against one
that accepts everything.

## Representation and premises

- Paths are lists of segments, and segments are lists of characters. Root
  normalization (separators, `.` and `..`) happens before matching and is
  part of the analyzer contract.
- `*` and `**` match names that start with a dot (`*.ts` matches `.ts`,
  `**` enters `.config/`). The first design behaved the same way
  (`dot: true`). This is a semantic choice, not an omission.
- The executable matcher backtracks, so its worst-case cost is exponential
  in the number of `many` tokens. Selectors in policies are short. The
  bound is a performance note, not a correctness premise.

## Production correspondence

The TypeScript matcher is a handwritten port of `accepts`. Its
correspondence is pending. Differential tests against the Lean definition
are evidence for it, not a proof.
