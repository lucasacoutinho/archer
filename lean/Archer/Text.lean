import Archer.Config

/-!
# Selector text

The strings callers write in a configuration (`src/domain/**`, `npm:react`,
`layer:app`) and the reasons a string is rejected. Contract:
`docs/contracts/selector-text.md`; obligations in `Archer.Spec.Text`.
-/

namespace Archer

inductive ParseError where
  | empty
  /-- A `prefix:` form without a name, or with a name the prefix forbids. -/
  | invalidName (kind name : String)
  /-- `a//b`, a leading or trailing `/`, or a `.` or `..` segment. -/
  | invalidSegment (text : String)
  /-- `\`, `[`, or `]`: Windows separators and character classes are not
  supported. -/
  | unsupported (char : Char)
  /-- `{` without its `}`, `}` without its `{`, or `,` outside braces. -/
  | unbalancedBraces
  deriving DecidableEq, Repr

/-- Characters that make a string a pattern rather than a plain path. -/
def wildcardChars : List Char := ['*', '?', '{', '}', ',']

/-- A plain path: no wildcard or brace syntax. A plain path selects the file
or directory it names and everything under it. -/
def PlainPath (text : String) : Prop :=
  ∀ c ∈ text.toList, c ∉ wildcardChars

/-- The segments a plain path names, after an optional leading `./`. -/
def plainSegments (text : String) : List String :=
  let chars := text.toList
  let chars := if chars.take 2 = ['.', '/'] then chars.drop 2 else chars
  (chars.splitOn '/').map String.ofList

end Archer
