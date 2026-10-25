/-!
# List patterns

One pattern language serves both glob levels. Segment patterns run over
characters, where a literal or `?` is `sat` and `*` is `many`. Path
patterns run over segments, where a segment pattern is `sat` and `**` is
`many`. Contract: `docs/contracts/pattern.md`.
-/

namespace Archer.Pattern

inductive Token (α : Type) where
  | sat (p : α → Bool)
  | many

open Token

/-- Specification: the lists a pattern denotes. -/
inductive Matches {α : Type} : List (Token α) → List α → Prop where
  | empty : Matches [] []
  | sat {p ps x xs} : p x = true → Matches ps xs → Matches (sat p :: ps) (x :: xs)
  | stop {ps xs} : Matches ps xs → Matches (many :: ps) xs
  | take {ps x xs} : Matches (many :: ps) xs → Matches (many :: ps) (x :: xs)

/-- `f` accepts some suffix of the list. -/
def anySuffix {α : Type} (f : List α → Bool) : List α → Bool
  | [] => f []
  | x :: xs => f (x :: xs) || anySuffix f xs

/-- Executable matcher. Structural on the pattern, so the kernel evaluates
it: `many :: ps` accepts a list when `ps` accepts one of its suffixes. -/
def accepts {α : Type} : List (Token α) → List α → Bool
  | [], xs => xs.isEmpty
  | sat _ :: _, [] => false
  | sat p :: ps, x :: xs => p x && accepts ps xs
  | many :: ps, xs => anySuffix (accepts ps) xs

theorem spec_many_of_suffix {α : Type} {ps : List (Token α)} :
    ∀ {xs : List α} (f : List α → Bool), (∀ ys, f ys = true → Matches ps ys) →
      anySuffix f xs = true → Matches (many :: ps) xs
  | [], _, hf, h => .stop (hf [] (by simpa [anySuffix] using h))
  | x :: xs, f, hf, h => by
      simp only [anySuffix, Bool.or_eq_true] at h
      cases h with
      | inl h => exact .stop (hf _ h)
      | inr h => exact .take (spec_many_of_suffix f hf h)

theorem accepts_sound {α : Type} :
    ∀ (ps : List (Token α)) (xs : List α), accepts ps xs = true → Matches ps xs
  | [], xs, h => by
      cases xs with
      | nil => exact .empty
      | cons => simp [accepts] at h
  | sat _ :: _, [], h => by simp [accepts] at h
  | sat p :: ps, x :: xs, h => by
      simp only [accepts, Bool.and_eq_true] at h
      exact .sat h.1 (accepts_sound ps xs h.2)
  | many :: ps, xs, h => spec_many_of_suffix (accepts ps) (accepts_sound ps) h

theorem anySuffix_of_self {α : Type} (f : List α → Bool) :
    ∀ {xs : List α}, f xs = true → anySuffix f xs = true
  | [], h => by simpa [anySuffix] using h
  | _ :: _, h => by simp [anySuffix, h]

theorem anySuffix_cons {α : Type} (f : List α → Bool) (x : α) {xs : List α}
    (h : anySuffix f xs = true) : anySuffix f (x :: xs) = true := by
  simp [anySuffix, h]

theorem accepts_complete {α : Type} {ps : List (Token α)} {xs : List α}
    (h : Matches ps xs) : accepts ps xs = true := by
  induction h with
  | empty => rfl
  | sat hp _ ih => simp [accepts, hp, ih]
  | stop _ ih => exact anySuffix_of_self _ ih
  | take _ ih => exact anySuffix_cons _ _ ih

/-- P1: the matcher decides the specification. -/
theorem accepts_iff {α : Type} (ps : List (Token α)) (xs : List α) :
    accepts ps xs = true ↔ Matches ps xs :=
  ⟨accepts_sound ps xs, accepts_complete⟩

theorem many_spec_all {α : Type} (ps : List (Token α)) (hps : Matches ps []) :
    ∀ xs : List α, Matches (many :: ps) xs
  | [] => .stop hps
  | _ :: xs => .take (many_spec_all ps hps xs)

/-- P2: `*` and `**` alone accept everything. -/
theorem many_matches_all {α : Type} (xs : List α) : accepts [many] xs = true :=
  accepts_complete (many_spec_all [] .empty xs)

/-- A pattern without `many` tokens. -/
def SatOnly {α : Type} (ps : List (Token α)) : Prop :=
  ∀ t ∈ ps, ∃ p, t = sat p

/-- P3: a pattern without `many` accepts only lists of its own length. -/
theorem sat_only_length {α : Type} {ps : List (Token α)} {xs : List α}
    (hs : SatOnly ps) (h : accepts ps xs = true) : xs.length = ps.length := by
  have hm := accepts_sound ps xs h
  clear h
  induction hm with
  | empty => rfl
  | sat _ _ ih =>
      have := ih (fun t ht => hs t (List.mem_cons_of_mem _ ht))
      simp [this]
  | stop _ _ =>
      obtain ⟨_, h⟩ := hs many (List.mem_cons_self ..)
      cases h
  | take _ _ =>
      obtain ⟨_, h⟩ := hs many (List.mem_cons_self ..)
      cases h

theorem spec_extend_many {α : Type} {ps : List (Token α)} {xs : List α}
    (h : Matches ps xs) : ∀ ys : List α, Matches (ps ++ [many]) (xs ++ ys) := by
  induction h with
  | empty => exact fun ys => many_spec_all [] .empty ys
  | sat hp _ ih => exact fun ys => .sat hp (ih ys)
  | stop _ ih => exact fun ys => .stop (ih ys)
  | take _ ih => exact fun ys => .take (ih ys)

/-- P4: appending `many` keeps every match and accepts every extension.
A selector written as a plain directory path uses this to select the
files under it. -/
theorem extend_many {α : Type} {ps : List (Token α)} {xs : List α}
    (h : accepts ps xs = true) (ys : List α) :
    accepts (ps ++ [many]) (xs ++ ys) = true :=
  accepts_complete (spec_extend_many (accepts_sound ps xs h) ys)

end Archer.Pattern
