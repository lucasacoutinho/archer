import Archer

/-!
# Challenge examples for the check specification

Hand-built cases that the contracts must accept or reject. They are
checked by `lake env lean Challenge.lean` and are not part of the library.
If one stops checking, the specification changed meaning.
-/

open Archer Archer.Spec

namespace Challenge

def loc : Location := ⟨1, 1⟩

def toB : Dependency := ⟨.file ["b.ts"], .static, "./b.js", loc⟩
def toC : Dependency := ⟨.file ["c.ts"], .static, "./c.js", loc⟩

def file (name : String) (deps : List Dependency) : SourceFile :=
  ⟨[name], deps, [], [], [], 1⟩

def fa := file "a.ts" [toB]
def fb := file "b.ts" [toC]
def fc := file "c.ts" []

/-- `a.ts → b.ts → c.ts` -/
def g : Graph := ⟨[fa, fb, fc]⟩

def startsWith (c : Char) : Selector := .glob [.segment [.literal c, .star]]

def direct : EdgeFilter := ⟨[.static], false, false⟩
def transitive : EdgeFilter := ⟨[.static], false, true⟩

def forbidB : Rule := ⟨"forbid-b", .error, startsWith 'a', .reach .outgoing .forbid (startsWith 'b') direct⟩
def forbidC : Rule := ⟨"forbid-c", .error, startsWith 'a', .reach .outgoing .forbid (startsWith 'c') transitive⟩
def requireC : Rule := ⟨"require-c", .error, startsWith 'a', .reach .outgoing .require (startsWith 'c') transitive⟩
def directForbidC : Rule := ⟨"direct-c", .error, startsWith 'a', .reach .outgoing .forbid (startsWith 'c') direct⟩

theorem walk_length_pos {g ef s w t} (h : Walk g ef s w t) : 1 ≤ w.length := by
  cases h <;> simp

theorem a_subject (r : Rule) (h : r.subject = startsWith 'a') : IsSubject g r ["a.ts"] :=
  ⟨fa, by rw [h]; decide, rfl⟩

/-- Inversion of a one-edge walk, with the start generalized. -/
theorem walk_single {g ef s e t} (h : Walk g ef s [e] t) :
    ∃ f ∈ g.files, f.path = s ∧ ∃ d ∈ f.dependencies, t = d.target := by
  cases h with
  | last hf hd _ => exact ⟨_, hf, rfl, _, hd, rfl⟩
  | step _ _ _ _ hrest => cases hrest

theorem files_of_g {f : SourceFile} (hf : f ∈ g.files) : f = fa ∨ f = fb ∨ f = fc := by
  simpa [g] using hf

/-- A direct import of a forbidden file is a violation, one per import site. -/
example (custom : CustomRules) :
    Admissible custom g forbidB ⟨"forbid-b", .error, ["a.ts"], .dependency ⟨["a.ts"], toB⟩⟩ := by
  refine ⟨rfl, rfl, a_subject forbidB rfl, ?_⟩
  exact ⟨fa, by simp [g], rfl, toB, by simp [fa, file], rfl, by decide,
    Or.inl (by decide)⟩

/-- A file that is reached only transitively does not violate a direct rule. -/
example (custom : CustomRules) (v : Violation) : ¬ Admissible custom g directForbidC v := by
  rintro ⟨-, -, ⟨f', hf', hp'⟩, f, hf, hpath, d, hd, -, -, hsel⟩
  rcases files_of_g hf with rfl | rfl | rfl
  · simp only [fa, file, List.mem_singleton] at hd
    subst hd
    rcases hsel with h | h
    · revert h; decide
    · cases h
  · -- `b.ts` imports `c.ts`, but it is not a subject of the rule
    simp only [Graph.subjects, List.mem_filter] at hf'
    have hs := hf'.2
    rw [hp'.trans hpath.symm] at hs
    revert hs; decide
  · simp [fc, file] at hd

/-- The transitive witness `a.ts → b.ts → c.ts` is admissible: it is a
walk, and no walk to `c.ts` from `a.ts` is shorter. -/
example (custom : CustomRules) :
    Admissible custom g forbidC
      ⟨"forbid-c", .error, ["a.ts"], .walk (.file ["c.ts"]) [⟨["a.ts"], toB⟩, ⟨["b.ts"], toC⟩]⟩ := by
  refine ⟨rfl, rfl, a_subject forbidC rfl, .file ["c.ts"], _, rfl, ⟨⟨?_, Or.inl rfl⟩, ?_⟩,
    Or.inl (by decide)⟩
  · exact Walk.step (f := fa) (by simp [g]) (by simp [fa, file]) (by decide) rfl
      (Walk.last (f := fb) (by simp [g]) (by simp [fb, file]) (by decide))
  · rintro w' ⟨hw, _⟩
    match w', hw with
    | [], hw => exact absurd (walk_length_pos hw) (by simp)
    | [_], hw =>
        -- a single edge from `a.ts` targets `b.ts`, not `c.ts`
        obtain ⟨f, hf, hp, d, hd, ht⟩ := walk_single hw
        rcases files_of_g hf with rfl | rfl | rfl
        · simp only [fa, file, List.mem_singleton] at hd
          subst hd
          simp [toB] at ht
        all_goals simp [fb, fc, file] at hp
    | _ :: _ :: _, _ => simp

/-- `require` is not violated when a considered walk reaches the object. -/
example (custom : CustomRules) (v : Violation) (hs : v.subject = ["a.ts"]) :
    ¬ Admissible custom g requireC v := by
  rintro ⟨_, _, _, _, hnone⟩
  apply hnone
  refine ⟨[⟨["a.ts"], toB⟩, ⟨["b.ts"], toC⟩], .file ["c.ts"], ⟨?_, Or.inl rfl⟩, by simp, by decide⟩
  rw [hs]
  exact Walk.step (f := fa) (by simp [g]) (by simp [fa, file]) (by decide) rfl
    (Walk.last (f := fb) (by simp [g]) (by simp [fb, file]) (by decide))

end Challenge

namespace Challenge

/-- E2 flags a mistyped file glob and leaves a forbidden absent package alone. -/
example : emptyObjects
    [⟨"typo", .error, startsWith 'a', .reach .outgoing .forbid (startsWith 'q') direct⟩,
     ⟨"absent-package", .error, startsWith 'a', .reach .outgoing .forbid (.package (some "lodash")) direct⟩,
     forbidB] g = ["typo"] := by decide

end Challenge

namespace Challenge

/-- E2 does not flag "depends only on" when every file is allowed: the
object `not (a* or b* or c*)` selects no file, but negation cannot reveal a
typo. -/
example : emptyObjects
    [⟨"only", .error, startsWith 'a',
      .reach .outgoing .forbid (.not (.any [startsWith 'a', startsWith 'b', startsWith 'c'])) direct⟩] g = [] := by
  decide

end Challenge
