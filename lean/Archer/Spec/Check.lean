import Archer.Rule

/-!
# Specification of reachability and of the check

Each structure is a contract over an implementation that this file does not
define. An obligation is discharged only by a theorem `ReachSpec reach` or
`CheckSpec check` about the implementation that production ports. Contract
prose: `docs/contracts/README.md`.
-/

namespace Archer.Spec

open Archer

/-- For a graph, an edge filter, and a source file, each reached target
paired with one witness walk. -/
abbrev ReachFn := Graph → EdgeFilter → FilePath → List (Target × List Edge)

/-- `w` is a considered walk to `t`, and no considered walk to `t` is
shorter. -/
def Shortest (g : Graph) (ef : EdgeFilter) (s : FilePath) (w : List Edge) (t : Target) : Prop :=
  Considered g ef s w t ∧ ∀ w', Considered g ef s w' t → w.length ≤ w'.length

structure ReachSpec (reach : ReachFn) : Prop where
  /-- R1: every reported witness is a shortest considered walk. -/
  sound : ∀ g ef s t w, g.WellFormed → (t, w) ∈ reach g ef s → Shortest g ef s w t
  /-- R2: every target with a considered walk is reported. -/
  complete : ∀ g ef s t w, g.WellFormed → Considered g ef s w t → ∃ w', (t, w') ∈ reach g ef s
  /-- R3: each target is reported once. -/
  unique : ∀ g ef s, ((reach g ef s).map Prod.fst).Nodup

def IsSubject (g : Graph) (r : Rule) (p : FilePath) : Prop :=
  ∃ f ∈ g.subjects r.subject, f.path = p

/-- The graph a cycle rule reads: the subjects and the dependencies between
them, collapsed to folders when a depth is given. -/
def cycleGraph (g : Graph) (r : Rule) : Option Nat → Graph
  | none => g.restrict fun p => r.subject.selects (.file p)
  | some n => (g.restrict fun p => r.subject.selects (.file p)).collapse n

def cycleFilter (ef : EdgeFilter) : EdgeFilter :=
  { ef with transitive := true }

/-- A target that a `forbid` dependency rule rejects. Computed imports
fail closed: they are rejected whatever the object selects. -/
def Forbidden (object : Selector) (t : Target) : Prop :=
  object.selects t = true ∨ t = .computed

/-- `x` is a candidate dependent of subject `s` for an incoming rule: a
source file other than `s` that the object selects. A file does not count
as its own dependent. -/
def Dependent (g : Graph) (object : Selector) (s x : FilePath) : Prop :=
  x ∈ g.paths ∧ x ≠ s ∧ object.selects (.file x) = true

/-- A target that `resolvable` rejects. -/
def Unresolvable (allowComputed : Bool) : Target → Prop
  | .unresolved _ => True
  | .computed => allowComputed = false
  | _ => False

/-- `v` is a correct violation of `r` on `g`. Each case is the meaning of
one assertion. -/
def Admissible (custom : CustomRules) (g : Graph) (r : Rule) (v : Violation) : Prop :=
  v.ruleId = r.id ∧ v.severity = r.severity ∧
  match r.assertion with
  | .reach .outgoing .forbid object ef =>
      IsSubject g r v.subject ∧ (match ef.transitive with
        | true => ∃ t w, v.evidence = .walk t w ∧
            Shortest g ef v.subject w t ∧ Forbidden object t
        | false => ∃ f ∈ g.files, f.path = v.subject ∧ ∃ d ∈ f.dependencies,
            v.evidence = .dependency ⟨f.path, d⟩ ∧ ef.admits d = true ∧ Forbidden object d.target)
  | .reach .outgoing .require object ef =>
      IsSubject g r v.subject ∧ v.evidence = .missing ∧
        ¬ ∃ w t, Considered g ef v.subject w t ∧ t ≠ .computed ∧ object.selects t = true
  | .reach .incoming .forbid object ef =>
      IsSubject g r v.subject ∧ (match ef.transitive with
        | true => ∃ x w, v.evidence = .walk (.file x) w ∧ Dependent g object v.subject x ∧
            Shortest g ef x w (.file v.subject)
        | false => ∃ f ∈ g.files, ∃ d ∈ f.dependencies,
            v.evidence = .dependency ⟨f.path, d⟩ ∧ Dependent g object v.subject f.path ∧
            ef.admits d = true ∧ d.target = .file v.subject)
  | .reach .incoming .require object ef =>
      IsSubject g r v.subject ∧ v.evidence = .missing ∧
        ¬ ∃ x w, Dependent g object v.subject x ∧ Considered g ef x w (.file v.subject)
  | .acyclic ef depth =>
      v.subject ∈ (cycleGraph g r depth).paths ∧ ∃ w, v.evidence = .cycle w ∧
        Shortest (cycleGraph g r depth) (cycleFilter ef) v.subject w (.file v.subject)
  | .resolvable allowComputed =>
      ∃ f ∈ g.subjects r.subject, f.path = v.subject ∧ ∃ d ∈ f.dependencies,
        v.evidence = .dependency ⟨f.path, d⟩ ∧ Unresolvable allowComputed d.target
  | .declares quantifier predicate =>
      ∃ f ∈ g.subjects r.subject, f.path = v.subject ∧ ∃ d ∈ f.declarations,
        v.evidence = .declaration d.name d.location ∧
        predicate.holds d = (match quantifier with
          | .every => false
          | .none => true)
  | .exportsOnly names =>
      ∃ f ∈ g.subjects r.subject, f.path = v.subject ∧ ∃ e ∈ f.exports,
        e ∉ names ∧ v.evidence = .export e
  | .uses .forbid use =>
      ∃ f ∈ g.subjects r.subject, f.path = v.subject ∧ ∃ u ∈ f.uses,
        use.matches u = true ∧ v.evidence = .use u
  | .uses .require use =>
      ∃ f ∈ g.subjects r.subject, f.path = v.subject ∧ v.evidence = .missing ∧
        ∀ u ∈ f.uses, use.matches u = false
  | .named relation affix value =>
      ∃ f ∈ g.subjects r.subject, f.path = v.subject ∧
        v.evidence = .name (basename f.path) ∧
        affix.holds value (basename f.path) = (match relation with
          | .require => false
          | .forbid => true)
  | .maxLines max =>
      ∃ f ∈ g.subjects r.subject, f.path = v.subject ∧
        v.evidence = .lines f.lines ∧ max < f.lines
  | .custom name =>
      IsSubject g r v.subject ∧ ∃ m ∈ custom name g v.subject, v.evidence = .custom m

abbrev CheckFn := CustomRules → Policy → Graph → List Violation

structure CheckSpec (check : CheckFn) : Prop where
  /-- C1: every reported violation is a correct violation of a policy rule. -/
  sound : ∀ custom p g v, g.WellFormed → v ∈ check custom p g →
    ∃ r ∈ p, Admissible custom g r v
  /-- C2: every correct violation is reported, possibly with another
  witness of the same key. -/
  complete : ∀ custom p g r v, g.WellFormed → r ∈ p → Admissible custom g r v →
    ∃ v' ∈ check custom p g, v'.key = v.key
  /-- C3: no violation is reported twice. -/
  unique : ∀ custom p g, p.WellFormed → ((check custom p g).map Violation.key).Nodup

end Archer.Spec
