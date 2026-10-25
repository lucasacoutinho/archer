import Archer.Text

/-!
# Specification of selector text

Contract prose: `docs/verification.md`.
-/

namespace Archer.Spec

open Archer

abbrev ParseFn := String → Except ParseError ConfigSelector
abbrev PrintFn := ConfigSelector → Option String

/-- The prefixes that make a string something other than a path glob. -/
def prefixes : List String := ["npm:", "node:", "bun:", "layer:", "unresolved:", "computed:"]

def Prefixed (text : String) : Prop :=
  ∃ p ∈ prefixes, p.toList.IsPrefix text.toList

/-- A path glob's segments are non-empty and are neither `.` nor `..`. -/
def ValidSegments (segments : List String) : Prop :=
  ∀ s ∈ segments, s ≠ "" ∧ s ≠ "." ∧ s ≠ ".."

def unsupportedChars : List Char := ['\\', '[', ']']

def braceChars : List Char := ['{', '}', ',']

/-- No brace syntax. Brace expansion happens before a string is classified,
so the clauses about one form read brace-free text. -/
def BraceFree (text : String) : Prop :=
  ∀ c ∈ text.toList, c ∉ braceChars

def selectsText (s : ConfigSelector) (t : Target) : Bool :=
  s.selects [] t

/-- One segment of a glob without braces: `**` alone is a globstar, `*` and
`?` are wildcards, any other character is literal. -/
def segmentTokens (segment : String) : PathToken :=
  .segment (segment.toList.map fun
    | '*' => .star
    | '?' => .one
    | c => .literal c)

def globTokens (segments : List String) : List PathToken :=
  segments.map fun s => if s = "**" then .globstar else segmentTokens s

/-- A package name that `npm:` accepts: unscoped without `/`, or
`@scope/name`. -/
def ValidPackageName (name : String) : Prop :=
  BraceFree name ∧ name ≠ "" ∧ name ≠ "*" ∧
    (('/' ∉ name.toList) ∨
      ∃ scope pkg, name.toList = '@' :: scope ++ '/' :: pkg ∧ scope ≠ [] ∧ pkg ≠ [] ∧
        '/' ∉ scope ∧ '/' ∉ pkg)

structure TextSpec (parse : ParseFn) (print : PrintFn) : Prop where
  /-- S1: every parsed selector prints, and the printed text parses back to
  the same selector. -/
  roundTrip : ∀ text s, parse text = .ok s →
    ∃ text', print s = some text' ∧ parse text' = .ok s
  /-- S2: a plain path selects exactly the files at or under it. -/
  plain : ∀ text, ¬ Prefixed text → PlainPath text → (∀ c ∈ text.toList, c ∉ unsupportedChars) →
    ValidSegments (plainSegments text) →
    ∃ s, parse text = .ok s ∧ ∀ p, selectsText s (.file p) = true ↔ (plainSegments text).IsPrefix p
  /-- S3: a glob with a wildcard and no braces means its tokens, with no
  implicit `**`. -/
  glob : ∀ text, ¬ Prefixed text → ('*' ∈ text.toList ∨ '?' ∈ text.toList) →
    BraceFree text → (∀ c ∈ text.toList, c ∉ unsupportedChars) →
    ValidSegments (plainSegments text) →
    parse text = .ok (.base (.glob (globTokens (plainSegments text))))
  /-- S4: braces denote the union of their alternatives, which may be of
  different forms (`{src/**,npm:react}`, `npm:{react,zod}`). -/
  braces : ∀ pre a b post t, BraceFree (pre ++ a ++ b ++ post) →
    ∀ sa sb, parse (pre ++ a ++ post) = .ok sa → parse (pre ++ b ++ post) = .ok sb →
      ∃ s, parse (pre ++ "{" ++ a ++ "," ++ b ++ "}" ++ post) = .ok s ∧
        (selectsText s t = (selectsText sa t || selectsText sb t))
  /-- S5: the prefixed forms. -/
  packages : ∀ name, ValidPackageName name →
    parse ("npm:" ++ name) = .ok (.base (.package (some name)))
  anyPackage : parse "npm:*" = .ok (.base (.package none))
  builtins : ∀ (runtime : Runtime) (name : String), BraceFree name → name ≠ "" → name ≠ "*" →
    parse ((match runtime with | .node => "node:" | .bun => "bun:") ++ name) =
      .ok (.base (.builtin runtime (some name)))
  anyBuiltin : ∀ runtime : Runtime,
    parse (match runtime with | .node => "node:*" | .bun => "bun:*") = .ok (.base (.builtin runtime none))
  layers : ∀ name, BraceFree name → name ≠ "" → parse ("layer:" ++ name) = .ok (.layer name)
  unresolved : parse "unresolved:*" = .ok (.base .unresolved)
  computed : parse "computed:*" = .ok (.base .computed)
  /-- S6: rejections. -/
  empty : parse "" = .error .empty
  unsupported : ∀ text c, ¬ Prefixed text → BraceFree text → c ∈ text.toList → c ∈ unsupportedChars →
    ∃ c', parse text = .error (.unsupported c')
  invalidSegment : ∀ text, ¬ Prefixed text → BraceFree text → (∀ c ∈ text.toList, c ∉ unsupportedChars) →
    ¬ ValidSegments (plainSegments text) → text ≠ "" →
    ∃ seg, parse text = .error (.invalidSegment seg)
  /-- A prefixed form whose name is invalid is rejected, never read as a path. -/
  invalidName : ∀ text, Prefixed text → BraceFree text → (∀ s, parse text ≠ .ok s) →
    ∃ k n, parse text = .error (.invalidName k n)

end Archer.Spec
