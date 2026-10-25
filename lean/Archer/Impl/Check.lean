import Archer.Spec.Check

/-!
# The check, parameterized by reachability

`checkWith reach` evaluates a policy against a graph. It reads transitive
facts only through `reach`, so `checkWith_spec` needs nothing about `reach`
but `ReachSpec reach`.

## Order (the TypeScript port mirrors it exactly)

1. Rules run in policy order.
2. Within a rule, subjects run in graph file order (`Graph.subjects`).
3. Within a subject, evidence order depends on the assertion:
   - transitive outgoing `forbid`: the order of `reach g ef subject`;
   - direct outgoing `forbid`, `resolvable`: the subject's dependency list order;
   - incoming `forbid`: dependents in graph file order (`dependents`); for
     each dependent, the order of `reach g ef dependent` (transitive) or of
     its dependency list (direct);
   - `require` rules: one `missing`, no ordering;
   - `acyclic`: nodes of the cycle graph in its file order, then the order of
     `reach cycleGraph (cycleFilter ef) node`;
   - `declares`: declaration order; `exportsOnly`: export order;
     `uses`: use order; `custom`: the closure's message order.
4. All violations are concatenated in that order, then deduplicated by
   `Violation.key`, keeping the first occurrence (`dedupByKey`). Duplicates
   arise from identical dependency entries or identical custom messages.
   The deduplication is global, so `CheckSpec.unique` holds without any
   premise on the policy.
-/

open Archer Archer.Spec

namespace Archer.Impl

/-- One step of `dedupByKey`: keep `v` only when no kept violation has its key. -/
def dedupStep (acc : List Violation) (v : Violation) : List Violation :=
  if acc.any (fun w => w.key == v.key) then acc else v :: acc

/-- Drop every violation whose key an earlier violation already has. -/
def dedupByKey (vs : List Violation) : List Violation :=
  (vs.foldl dedupStep []).reverse

/-- Invariants of the deduplication fold: keys stay `Nodup`, nothing kept is lost, nothing is invented, and every input key survives. -/
theorem dedupStep_prop (vs : List Violation) : ∀ acc : List Violation,
    (acc.map Violation.key).Nodup →
    ((vs.foldl dedupStep acc).map Violation.key).Nodup ∧
    (∀ x ∈ acc, x ∈ vs.foldl dedupStep acc) ∧
    (∀ x ∈ vs.foldl dedupStep acc, x ∈ acc ∨ x ∈ vs) ∧
    (∀ v ∈ vs, ∃ v' ∈ vs.foldl dedupStep acc, v'.key = v.key) := by
  induction vs with
  | nil => intro acc h; simp [h]
  | cons v vs ih =>
    intro acc h
    simp only [List.foldl_cons]
    by_cases hk : acc.any (fun w => w.key == v.key) = true
    · have step : dedupStep acc v = acc := by simp [dedupStep, hk]
      rw [step]
      obtain ⟨h1, h2, h3, h4⟩ := ih acc h
      refine ⟨h1, h2, ?_, ?_⟩
      · intro x hx
        rcases h3 x hx with h | h
        · exact Or.inl h
        · exact Or.inr (List.mem_cons_of_mem _ h)
      · intro w hw
        rcases List.mem_cons.1 hw with rfl | hw
        · obtain ⟨x, hx, hxk⟩ := List.any_eq_true.1 hk
          exact ⟨x, h2 x hx, by simpa using hxk⟩
        · exact h4 w hw
    · have hk' : acc.any (fun w => w.key == v.key) = false := by simpa using hk
      have step : dedupStep acc v = v :: acc := by simp [dedupStep, hk']
      rw [step]
      have hnd : ((v :: acc).map Violation.key).Nodup := by
        rw [List.map_cons, List.nodup_cons]
        refine ⟨?_, h⟩
        intro hm
        obtain ⟨x, hx, hxk⟩ := List.mem_map.1 hm
        have := List.any_eq_false.1 hk' x hx
        simp [hxk] at this
      obtain ⟨h1, h2, h3, h4⟩ := ih (v :: acc) hnd
      refine ⟨h1, fun x hx => h2 x (List.mem_cons_of_mem _ hx), ?_, ?_⟩
      · intro x hx
        rcases h3 x hx with h | h
        · rcases List.mem_cons.1 h with rfl | h
          · exact Or.inr (List.mem_cons_self ..)
          · exact Or.inl h
        · exact Or.inr (List.mem_cons_of_mem _ h)
      · intro w hw
        rcases List.mem_cons.1 hw with rfl | hw
        · exact ⟨w, h2 w (List.mem_cons_self ..), rfl⟩
        · exact h4 w hw

/-- The output of `dedupByKey` has pairwise distinct keys. -/
theorem dedupByKey_nodup (vs : List Violation) : ((dedupByKey vs).map Violation.key).Nodup := by
  unfold dedupByKey
  rw [List.map_reverse]
  exact (List.reverse_perm _).nodup_iff.2 (dedupStep_prop vs [] (by simp)).1

/-- Deduplication only removes violations. -/
theorem mem_dedupByKey {vs : List Violation} {v : Violation} (h : v ∈ dedupByKey vs) : v ∈ vs := by
  unfold dedupByKey at h
  rw [List.mem_reverse] at h
  rcases (dedupStep_prop vs [] (by simp)).2.2.1 v h with h | h
  · simp at h
  · exact h

/-- Every input violation keeps a representative with its key. -/
theorem dedupByKey_complete {vs : List Violation} {v : Violation} (h : v ∈ vs) :
    ∃ v' ∈ dedupByKey vs, v'.key = v.key := by
  unfold dedupByKey
  obtain ⟨v', hv', hk⟩ := (dedupStep_prop vs [] (by simp)).2.2.2 v h
  exact ⟨v', List.mem_reverse.2 hv', hk⟩


/-! ## Definitions -/

/-- Subject and evidence; the rule contributes the id and severity. -/
abbrev Finding := FilePath × Evidence

/-- The Boolean form of `Forbidden`: computed imports fail closed. -/
def forbiddenB (object : Selector) (t : Target) : Bool :=
  object.selects t || t == .computed

/-- The Boolean form of `Unresolvable`. -/
def unresolvableB (allowComputed : Bool) : Target → Bool
  | .unresolved _ => true
  | .computed => !allowComputed
  | _ => false

/-- Candidate dependents of `s` for an incoming rule, in graph file order: files
other than `s` that `object` selects. -/
def dependents (g : Graph) (object : Selector) (s : FilePath) : List SourceFile :=
  g.files.filter fun x => x.path != s && object.selects (.file x.path)

/-- Transitive: one finding per forbidden target in `reach` order. Direct: one
finding per admitted, forbidden import site in dependency order. -/
def outgoingForbid (reach : ReachFn) (g : Graph) (r : Rule) (object : Selector) (ef : EdgeFilter) :
    List Finding :=
  (g.subjects r.subject).flatMap fun f =>
    if ef.transitive then
      ((reach g ef f.path).filter fun p => forbiddenB object p.1).map fun p =>
        (f.path, Evidence.walk p.1 p.2)
    else
      (f.dependencies.filter fun d => ef.admits d && forbiddenB object d.target).map fun d =>
        (f.path, Evidence.dependency ⟨f.path, d⟩)

/-- A `missing` finding for each subject whose `reach` has no non-computed
target that `object` selects. -/
def outgoingRequire (reach : ReachFn) (g : Graph) (r : Rule) (object : Selector) (ef : EdgeFilter) :
    List Finding :=
  ((g.subjects r.subject).filter fun f =>
    !((reach g ef f.path).any fun p => p.1 != .computed && object.selects p.1)).map fun f =>
      (f.path, Evidence.missing)

/-- Transitive: for each dependent, the `reach` entry that targets the subject.
Direct: each admitted import site of a dependent that targets the subject. -/
def incomingForbid (reach : ReachFn) (g : Graph) (r : Rule) (object : Selector) (ef : EdgeFilter) :
    List Finding :=
  (g.subjects r.subject).flatMap fun f =>
    (dependents g object f.path).flatMap fun x =>
      if ef.transitive then
        ((reach g ef x.path).filter fun p => p.1 == .file f.path).map fun p =>
          (f.path, Evidence.walk (.file x.path) p.2)
      else
        (x.dependencies.filter fun d => ef.admits d && d.target == .file f.path).map fun d =>
          (f.path, Evidence.dependency ⟨x.path, d⟩)

/-- A `missing` finding for each subject that no dependent reaches. -/
def incomingRequire (reach : ReachFn) (g : Graph) (r : Rule) (object : Selector) (ef : EdgeFilter) :
    List Finding :=
  ((g.subjects r.subject).filter fun f =>
    (dependents g object f.path).all fun x =>
      !((reach g ef x.path).any fun p => p.1 == .file f.path)).map fun f =>
        (f.path, Evidence.missing)

/-- For each node of the cycle graph, the `reach` entry that targets the node itself. -/
def acyclicFindings (reach : ReachFn) (g : Graph) (r : Rule) (ef : EdgeFilter)
    (depth : Option Nat) : List Finding :=
  (cycleGraph g r depth).paths.flatMap fun p =>
    ((reach (cycleGraph g r depth) (cycleFilter ef) p).filter fun q => q.1 == .file p).map fun q =>
      (p, Evidence.cycle q.2)

/-- One finding per unresolvable import site. -/
def resolvableFindings (g : Graph) (r : Rule) (allowComputed : Bool) : List Finding :=
  (g.subjects r.subject).flatMap fun f =>
    (f.dependencies.filter fun d => unresolvableB allowComputed d.target).map fun d =>
      (f.path, Evidence.dependency ⟨f.path, d⟩)

/-- The truth value of the predicate on a violating declaration. -/
def quantifierBad : Quantifier → Bool
  | .every => false
  | .none => true

/-- The truth value of the affix test on a violating name. -/
def relationBad : Relation → Bool
  | .require => false
  | .forbid => true

/-- One finding per declaration on which the predicate has the violating value. -/
def declaresFindings (g : Graph) (r : Rule) (q : Quantifier) (pr : DeclarationPredicate) :
    List Finding :=
  (g.subjects r.subject).flatMap fun f =>
    (f.declarations.filter fun d =>
      pr.holds d == quantifierBad q).map fun d =>
        (f.path, Evidence.declaration d.name d.location)

/-- One finding per export outside `names`. -/
def exportsOnlyFindings (g : Graph) (r : Rule) (names : List String) : List Finding :=
  (g.subjects r.subject).flatMap fun f =>
    (f.exports.filter fun e => decide (e ∉ names)).map fun e => (f.path, Evidence.export e)

/-- One finding per matching use. -/
def usesForbidFindings (g : Graph) (r : Rule) (use : UseSpec) : List Finding :=
  (g.subjects r.subject).flatMap fun f =>
    (f.uses.filter fun u => use.matches u).map fun u => (f.path, Evidence.use u)

/-- A `missing` finding for each subject without a matching use. -/
def usesRequireFindings (g : Graph) (r : Rule) (use : UseSpec) : List Finding :=
  ((g.subjects r.subject).filter fun f => f.uses.all fun u => !use.matches u).map fun f =>
    (f.path, Evidence.missing)

/-- A finding for each subject whose basename has the violating affix result. -/
def namedFindings (g : Graph) (r : Rule) (relation : Relation) (affix : Affix) (value : String) :
    List Finding :=
  ((g.subjects r.subject).filter fun f =>
    affix.holds value (basename f.path) == relationBad relation).map fun f => (f.path, Evidence.name (basename f.path))

/-- A finding for each subject with more than `max` lines. -/
def maxLinesFindings (g : Graph) (r : Rule) (max : Nat) : List Finding :=
  ((g.subjects r.subject).filter fun f => decide (max < f.lines)).map fun f =>
    (f.path, Evidence.lines f.lines)

/-- Each message that the closure returns for each subject. -/
def customFindings (custom : CustomRules) (g : Graph) (r : Rule) (name : String) : List Finding :=
  (g.subjects r.subject).flatMap fun f =>
    (custom name g f.path).map fun m => (f.path, Evidence.custom m)

/-- The findings of one rule, before deduplication. -/
def findings (reach : ReachFn) (custom : CustomRules) (g : Graph) (r : Rule) : List Finding :=
  match r.assertion with
  | .reach .outgoing .forbid object ef => outgoingForbid reach g r object ef
  | .reach .outgoing .require object ef => outgoingRequire reach g r object ef
  | .reach .incoming .forbid object ef => incomingForbid reach g r object ef
  | .reach .incoming .require object ef => incomingRequire reach g r object ef
  | .acyclic ef depth => acyclicFindings reach g r ef depth
  | .resolvable allowComputed => resolvableFindings g r allowComputed
  | .declares q pr => declaresFindings g r q pr
  | .exportsOnly names => exportsOnlyFindings g r names
  | .uses .forbid use => usesForbidFindings g r use
  | .uses .require use => usesRequireFindings g r use
  | .named relation affix value => namedFindings g r relation affix value
  | .maxLines max => maxLinesFindings g r max
  | .custom name => customFindings custom g r name

/-- The violations of one rule, before deduplication. -/
def ruleViolations (reach : ReachFn) (custom : CustomRules) (g : Graph) (r : Rule) :
    List Violation :=
  (findings reach custom g r).map fun p => ⟨r.id, r.severity, p.1, p.2⟩

/-- The check: every rule's violations in policy order, deduplicated by key. -/
def checkWith (reach : ReachFn) : CheckFn := fun custom p g =>
  dedupByKey (p.flatMap (ruleViolations reach custom g))


/-! ## Basic lemmas -/

/-- Membership in `Graph.subjects`. -/
theorem mem_subjects {g : Graph} {s : Selector} {f : SourceFile} :
    f ∈ g.subjects s ↔ f ∈ g.files ∧ s.selects (.file f.path) = true := by
  simp [Graph.subjects]

/-- A `Nodup` image makes `f` injective on the list. -/
theorem eq_of_nodup_map {α β : Type} (f : α → β) :
    ∀ {l : List α}, (l.map f).Nodup → ∀ {x y}, x ∈ l → y ∈ l → f x = f y → x = y := by
  intro l
  induction l with
  | nil => intro _ x y hx; cases hx
  | cons a l ih =>
    intro hn x y hx hy hxy
    rw [List.map_cons, List.nodup_cons] at hn
    rcases List.mem_cons.1 hx with rfl | hx' <;> rcases List.mem_cons.1 hy with rfl | hy'
    · rfl
    · exact absurd (by rw [hxy]; exact List.mem_map_of_mem hy') hn.1
    · exact absurd (by rw [← hxy]; exact List.mem_map_of_mem hx') hn.1
    · exact ih hn.2 hx' hy' hxy

/-- In a well-formed graph, a path identifies its file. -/
theorem files_ext {g : Graph} (hg : g.WellFormed) {f f' : SourceFile} (hf : f ∈ g.files)
    (hf' : f' ∈ g.files) (h : f.path = f'.path) : f = f' :=
  eq_of_nodup_map _ hg hf hf' h

/-- `forbiddenB` decides `Forbidden`. -/
theorem forbiddenB_iff {o : Selector} {t : Target} : forbiddenB o t = true ↔ Forbidden o t := by
  simp [forbiddenB, Forbidden]

/-- `unresolvableB` decides `Unresolvable`. -/
theorem unresolvableB_iff {a : Bool} {t : Target} :
    unresolvableB a t = true ↔ Unresolvable a t := by
  cases t <;> simp [unresolvableB, Unresolvable]

/-- Membership in `dependents`. -/
theorem mem_dependents {g : Graph} {o : Selector} {s : FilePath} {x : SourceFile} :
    x ∈ dependents g o s ↔ x ∈ g.files ∧ x.path ≠ s ∧ o.selects (.file x.path) = true := by
  simp [dependents]

/-- `Dependent` is membership in `dependents`, up to the path. -/
theorem dependent_iff {g : Graph} {o : Selector} {s y : FilePath} :
    Dependent g o s y ↔ ∃ x ∈ dependents g o s, x.path = y := by
  constructor
  · rintro ⟨hy, hne, hsel⟩
    obtain ⟨x, hx, rfl⟩ := List.mem_map.1 hy
    exact ⟨x, mem_dependents.2 ⟨hx, hne, hsel⟩, rfl⟩
  · rintro ⟨x, hx, rfl⟩
    obtain ⟨hf, hne, hsel⟩ := mem_dependents.1 hx
    exact ⟨List.mem_map.2 ⟨x, hf, rfl⟩, hne, hsel⟩

/-- Reported walks are considered walks. -/
theorem reach_considered {reach : ReachFn} (h : ReachSpec reach) {g : Graph} (hg : g.WellFormed)
    {ef : EdgeFilter} {s : FilePath} {t : Target} {w : List Edge}
    (hm : (t, w) ∈ reach g ef s) : Considered g ef s w t :=
  (h.sound g ef s t w hg hm).1

/-- Reported walks are shortest. -/
theorem reach_shortest {reach : ReachFn} (h : ReachSpec reach) {g : Graph} (hg : g.WellFormed)
    {ef : EdgeFilter} {s : FilePath} {t : Target} {w : List Edge}
    (hm : (t, w) ∈ reach g ef s) : Shortest g ef s w t :=
  h.sound g ef s t w hg hm

/-- A considered walk to `t` makes `reach` report `t`. -/
theorem considered_reach {reach : ReachFn} (h : ReachSpec reach) {g : Graph} (hg : g.WellFormed)
    {ef : EdgeFilter} {s : FilePath} {t : Target} {w : List Edge}
    (hc : Considered g ef s w t) : ∃ w', (t, w') ∈ reach g ef s :=
  h.complete g ef s t w hg hc

/-! ## Outgoing forbid -/

/-- Every finding of the outgoing `forbid` family is admissible. -/
theorem outgoingForbid_sound {reach : ReachFn} (h : ReachSpec reach) {g : Graph}
    (hg : g.WellFormed) (custom : CustomRules) (r : Rule) (object : Selector) (ef : EdgeFilter)
    (hr : r.assertion = .reach .outgoing .forbid object ef) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ outgoingForbid reach g r object ef) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  simp only [outgoingForbid, List.mem_flatMap] at hm
  obtain ⟨f, hf, hm⟩ := hm
  by_cases ht : ef.transitive = true
  · simp only [ht, ↓reduceIte] at hm ⊢
    obtain ⟨⟨t, w⟩, hq, heq⟩ := List.mem_map.1 hm
    obtain ⟨hq, hfb⟩ := List.mem_filter.1 hq
    obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
    exact ⟨⟨f, hf, rfl⟩, t, w, rfl, reach_shortest h hg hq, forbiddenB_iff.1 hfb⟩
  · have ht' : ef.transitive = false := by simpa using ht
    simp only [ht', Bool.false_eq_true, ↓reduceIte] at hm ⊢
    obtain ⟨d, hd, heq⟩ := List.mem_map.1 hm
    obtain ⟨hd, hfb⟩ := List.mem_filter.1 hd
    obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
    obtain ⟨hfb1, hfb2⟩ := Bool.and_eq_true_iff.1 hfb
    exact ⟨⟨f, hf, rfl⟩, f, (mem_subjects.1 hf).1, rfl, d, hd, rfl, hfb1, forbiddenB_iff.1 hfb2⟩

/-- Every admissible violation of the outgoing `forbid` family has a finding with its key. -/
theorem outgoingForbid_complete {reach : ReachFn} (h : ReachSpec reach) {g : Graph}
    (hg : g.WellFormed) (custom : CustomRules) (r : Rule) (object : Selector) (ef : EdgeFilter)
    (hr : r.assertion = .reach .outgoing .forbid object ef) {v : Violation}
    (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ outgoingForbid reach g r object ef ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, ⟨f, hf, hfp⟩, hrest⟩ := hv
  subst hfp
  unfold outgoingForbid
  by_cases ht : ef.transitive = true
  · simp only [ht] at hrest
    obtain ⟨t, w, hev, hsh, hfb⟩ := hrest
    obtain ⟨w', hw'⟩ := considered_reach h hg hsh.1
    refine ⟨.walk t w', List.mem_flatMap.2 ⟨f, hf, ?_⟩, by simp [hev, Evidence.key]⟩
    simp only [ht, ↓reduceIte]
    exact List.mem_map.2 ⟨(t, w'), List.mem_filter.2 ⟨hw', forbiddenB_iff.2 hfb⟩, rfl⟩
  · have ht' : ef.transitive = false := by simpa using ht
    simp only [ht'] at hrest
    obtain ⟨f', hf', hfp', d, hd, hev, hadm, hfb⟩ := hrest
    have hff : f' = f := files_ext hg hf' (mem_subjects.1 hf).1 hfp'
    subst hff
    refine ⟨e, List.mem_flatMap.2 ⟨f', hf, ?_⟩, rfl⟩
    simp only [ht', Bool.false_eq_true, ↓reduceIte]
    rw [hev]
    exact List.mem_map.2 ⟨d, List.mem_filter.2 ⟨hd, by simp [hadm, forbiddenB_iff.2 hfb]⟩, rfl⟩

/-! ## Outgoing require -/

/-- Every finding of the outgoing `require` family is admissible. -/
theorem outgoingRequire_sound {reach : ReachFn} (h : ReachSpec reach) {g : Graph}
    (hg : g.WellFormed) (custom : CustomRules) (r : Rule) (object : Selector) (ef : EdgeFilter)
    (hr : r.assertion = .reach .outgoing .require object ef) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ outgoingRequire reach g r object ef) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  obtain ⟨f, hf, heq⟩ := List.mem_map.1 hm
  obtain ⟨hf, hflt⟩ := List.mem_filter.1 hf
  obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
  refine ⟨⟨f, hf, rfl⟩, rfl, ?_⟩
  rintro ⟨w, t, hc, hne, hsel⟩
  obtain ⟨w', hw'⟩ := considered_reach h hg hc
  have hany : ((reach g ef f.path).any fun p => p.1 != .computed && object.selects p.1) = true :=
    List.any_eq_true.2 ⟨(t, w'), hw', by simp [hne, hsel]⟩
  simp [hany] at hflt

/-- Every admissible violation of the outgoing `require` family has a finding with its key. -/
theorem outgoingRequire_complete {reach : ReachFn} (h : ReachSpec reach) {g : Graph}
    (hg : g.WellFormed) (custom : CustomRules) (r : Rule) (object : Selector) (ef : EdgeFilter)
    (hr : r.assertion = .reach .outgoing .require object ef) {v : Violation}
    (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ outgoingRequire reach g r object ef ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, ⟨f, hf, hfp⟩, hev, hnone⟩ := hv
  subst hfp
  refine ⟨.missing, List.mem_map.2 ⟨f, List.mem_filter.2 ⟨hf, ?_⟩, rfl⟩, by simp [hev, Evidence.key]⟩
  simp only [Bool.not_eq_true', List.any_eq_false]
  intro q hq
  intro hcon
  apply hnone
  have hcon' : (q.1 != .computed && object.selects q.1) = true := hcon
  obtain ⟨hc1, hc2⟩ := Bool.and_eq_true_iff.1 hcon'
  exact ⟨q.2, q.1, reach_considered h hg hq, by simpa using hc1, hc2⟩

/-! ## Incoming forbid -/

/-- Every finding of the incoming `forbid` family is admissible. -/
theorem incomingForbid_sound {reach : ReachFn} (h : ReachSpec reach) {g : Graph}
    (hg : g.WellFormed) (custom : CustomRules) (r : Rule) (object : Selector) (ef : EdgeFilter)
    (hr : r.assertion = .reach .incoming .forbid object ef) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ incomingForbid reach g r object ef) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  simp only [incomingForbid, List.mem_flatMap] at hm
  obtain ⟨f, hf, x, hx, hm⟩ := hm
  by_cases ht : ef.transitive = true
  · simp only [ht, ↓reduceIte] at hm ⊢
    obtain ⟨⟨t, w⟩, hq, heq⟩ := List.mem_map.1 hm
    obtain ⟨hq, hbeq⟩ := List.mem_filter.1 hq
    obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
    have htf : t = .file f.path := by simpa using hbeq
    subst htf
    exact ⟨⟨f, hf, rfl⟩, x.path, w, rfl, dependent_iff.2 ⟨x, hx, rfl⟩, reach_shortest h hg hq⟩
  · have ht' : ef.transitive = false := by simpa using ht
    simp only [ht', Bool.false_eq_true, ↓reduceIte] at hm ⊢
    obtain ⟨d, hd, heq⟩ := List.mem_map.1 hm
    obtain ⟨hd, hfb⟩ := List.mem_filter.1 hd
    obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
    obtain ⟨hfb1, hfb2⟩ := Bool.and_eq_true_iff.1 hfb
    exact ⟨⟨f, hf, rfl⟩, x, (mem_dependents.1 hx).1, d, hd, rfl,
      dependent_iff.2 ⟨x, hx, rfl⟩, hfb1, by simpa using hfb2⟩

/-- Every admissible violation of the incoming `forbid` family has a finding with its key. -/
theorem incomingForbid_complete {reach : ReachFn} (h : ReachSpec reach) {g : Graph}
    (hg : g.WellFormed) (custom : CustomRules) (r : Rule) (object : Selector) (ef : EdgeFilter)
    (hr : r.assertion = .reach .incoming .forbid object ef) {v : Violation}
    (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ incomingForbid reach g r object ef ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, ⟨f, hf, hfp⟩, hrest⟩ := hv
  subst hfp
  unfold incomingForbid
  by_cases ht : ef.transitive = true
  · simp only [ht] at hrest
    obtain ⟨x, w, hev, hdep, hsh⟩ := hrest
    obtain ⟨x', hx', rfl⟩ := dependent_iff.1 hdep
    obtain ⟨w', hw'⟩ := considered_reach h hg hsh.1
    refine ⟨.walk (.file x'.path) w', List.mem_flatMap.2 ⟨f, hf, List.mem_flatMap.2 ⟨x', hx', ?_⟩⟩,
      by simp [hev, Evidence.key]⟩
    simp only [ht, ↓reduceIte]
    exact List.mem_map.2 ⟨(.file f.path, w'), List.mem_filter.2 ⟨hw', by simp⟩, rfl⟩
  · have ht' : ef.transitive = false := by simpa using ht
    simp only [ht'] at hrest
    obtain ⟨f', hf', d, hd, hev, hdep, hadm, htgt⟩ := hrest
    obtain ⟨x, hx, hxp⟩ := dependent_iff.1 hdep
    have hxf : x = f' := files_ext hg (mem_dependents.1 hx).1 hf' hxp
    subst hxf
    refine ⟨e, List.mem_flatMap.2 ⟨f, hf, List.mem_flatMap.2 ⟨x, hx, ?_⟩⟩, rfl⟩
    simp only [ht', Bool.false_eq_true, ↓reduceIte]
    rw [hev]
    exact List.mem_map.2 ⟨d, List.mem_filter.2 ⟨hd, by simp [hadm, htgt]⟩, rfl⟩

/-! ## Incoming require -/

/-- Every finding of the incoming `require` family is admissible. -/
theorem incomingRequire_sound {reach : ReachFn} (h : ReachSpec reach) {g : Graph}
    (hg : g.WellFormed) (custom : CustomRules) (r : Rule) (object : Selector) (ef : EdgeFilter)
    (hr : r.assertion = .reach .incoming .require object ef) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ incomingRequire reach g r object ef) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  obtain ⟨f, hf, heq⟩ := List.mem_map.1 hm
  obtain ⟨hf, hflt⟩ := List.mem_filter.1 hf
  obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
  refine ⟨⟨f, hf, rfl⟩, rfl, ?_⟩
  rintro ⟨x, w, hdep, hc⟩
  obtain ⟨x', hx', rfl⟩ := dependent_iff.1 hdep
  obtain ⟨w', hw'⟩ := considered_reach h hg hc
  have hall := List.all_eq_true.1 hflt x' hx'
  have hany : ((reach g ef x'.path).any fun p => p.1 == .file f.path) = true :=
    List.any_eq_true.2 ⟨(.file f.path, w'), hw', by simp⟩
  simp [hany] at hall

/-- Every admissible violation of the incoming `require` family has a finding with its key. -/
theorem incomingRequire_complete {reach : ReachFn} (h : ReachSpec reach) {g : Graph}
    (hg : g.WellFormed) (custom : CustomRules) (r : Rule) (object : Selector) (ef : EdgeFilter)
    (hr : r.assertion = .reach .incoming .require object ef) {v : Violation}
    (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ incomingRequire reach g r object ef ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, ⟨f, hf, hfp⟩, hev, hnone⟩ := hv
  subst hfp
  refine ⟨.missing, List.mem_map.2 ⟨f, List.mem_filter.2 ⟨hf, ?_⟩, rfl⟩, by simp [hev, Evidence.key]⟩
  rw [List.all_eq_true]
  intro x hx
  simp only [Bool.not_eq_true', List.any_eq_false]
  intro q hq
  intro hcon
  apply hnone
  have hqf : q.1 = .file f.path := by simpa using hcon
  refine ⟨x.path, q.2, dependent_iff.2 ⟨x, hx, rfl⟩, ?_⟩
  have := reach_considered h hg hq
  rwa [hqf] at this


/-! ## Acyclic -/

/-- `eraseDups` has no duplicates and only keeps members (strong induction on length). -/
theorem eraseDups_prop {α : Type} [BEq α] [LawfulBEq α] :
    ∀ (n : Nat) (l : List α), l.length ≤ n → l.eraseDups.Nodup ∧ ∀ x ∈ l.eraseDups, x ∈ l := by
  intro n
  induction n with
  | zero => intro l hl; cases l with
    | nil => simp
    | cons a as => simp at hl
  | succ n ih =>
    intro l hl
    cases l with
    | nil => simp
    | cons a as =>
      rw [List.eraseDups_cons]
      have hlen : (as.filter fun b => !b == a).length ≤ n :=
        Nat.le_trans (List.length_filter_le _ _) (by simpa using hl)
      obtain ⟨hn, hm⟩ := ih _ hlen
      refine ⟨List.nodup_cons.2 ⟨?_, hn⟩, ?_⟩
      · intro h
        have := hm a h
        simp at this
      · intro x hx
        rcases List.mem_cons.1 hx with rfl | hx
        · simp
        · have := hm x hx
          simp at this
          simp [this.1]

/-- `eraseDups` has no duplicates. -/
theorem nodup_eraseDups {α : Type} [BEq α] [LawfulBEq α] (l : List α) : l.eraseDups.Nodup :=
  (eraseDups_prop l.length l (Nat.le_refl _)).1

/-- Restricting a well-formed graph keeps it well-formed: the files are a sublist. -/
theorem restrict_wf {g : Graph} (keep : FilePath → Bool) (h : g.WellFormed) :
    (g.restrict keep).WellFormed := by
  unfold Graph.WellFormed Graph.restrict at *
  simp only [List.map_map]
  exact List.Nodup.sublist (List.Sublist.map _ (List.filter_sublist)) h

/-- Collapsing always yields distinct folders. -/
theorem collapse_wf (g : Graph) (n : Nat) : (g.collapse n).WellFormed := by
  unfold Graph.WellFormed Graph.collapse
  simp only [List.map_map]
  simpa [Function.comp_def] using nodup_eraseDups (α := FilePath) (g.files.map fun f => folderOf n f.path)


/-- The graph a cycle rule reads is well-formed when `g` is. -/
theorem cycleGraph_wf {g : Graph} (r : Rule) (depth : Option Nat) (hg : g.WellFormed) :
    (cycleGraph g r depth).WellFormed := by
  cases depth with
  | none => exact restrict_wf _ hg
  | some n => exact collapse_wf _ n

/-- Every finding of the `acyclic` family is admissible. -/
theorem acyclic_sound {reach : ReachFn} (h : ReachSpec reach) {g : Graph}
    (hg : g.WellFormed) (custom : CustomRules) (r : Rule) (ef : EdgeFilter) (depth : Option Nat)
    (hr : r.assertion = .acyclic ef depth) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ acyclicFindings reach g r ef depth) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  simp only [acyclicFindings, List.mem_flatMap] at hm
  obtain ⟨p', hp', hm⟩ := hm
  obtain ⟨⟨t, w⟩, hq, heq⟩ := List.mem_map.1 hm
  obtain ⟨hq, hbeq⟩ := List.mem_filter.1 hq
  obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
  have htf : t = .file p' := by simpa using hbeq
  subst htf
  exact ⟨hp', w, rfl, reach_shortest h (cycleGraph_wf r depth hg) hq⟩

/-- Every admissible violation of the `acyclic` family has a finding with its key. -/
theorem acyclic_complete {reach : ReachFn} (h : ReachSpec reach) {g : Graph}
    (hg : g.WellFormed) (custom : CustomRules) (r : Rule) (ef : EdgeFilter) (depth : Option Nat)
    (hr : r.assertion = .acyclic ef depth) {v : Violation}
    (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ acyclicFindings reach g r ef depth ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, hp, w, hev, hsh⟩ := hv
  obtain ⟨w', hw'⟩ := considered_reach h (cycleGraph_wf r depth hg) hsh.1
  refine ⟨.cycle w', ?_, by simp [hev, Evidence.key]⟩
  simp only [acyclicFindings, List.mem_flatMap]
  exact ⟨p, hp, List.mem_map.2 ⟨(.file p, w'), List.mem_filter.2 ⟨hw', by simp⟩, rfl⟩⟩

/-! ## Resolvable -/

/-- Every finding of the `resolvable` family is admissible. -/
theorem resolvable_sound (custom : CustomRules) (g : Graph) (r : Rule) (allowComputed : Bool)
    (hr : r.assertion = .resolvable allowComputed) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ resolvableFindings g r allowComputed) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  simp only [resolvableFindings, List.mem_flatMap] at hm
  obtain ⟨f, hf, hm⟩ := hm
  obtain ⟨d, hd, heq⟩ := List.mem_map.1 hm
  obtain ⟨hd, hun⟩ := List.mem_filter.1 hd
  obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
  exact ⟨f, hf, rfl, d, hd, rfl, unresolvableB_iff.1 hun⟩

/-- Every admissible violation of the `resolvable` family has a finding with its key. -/
theorem resolvable_complete (custom : CustomRules) (g : Graph) (r : Rule) (allowComputed : Bool)
    (hr : r.assertion = .resolvable allowComputed) {v : Violation}
    (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ resolvableFindings g r allowComputed ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, f, hf, hfp, d, hd, hev, hun⟩ := hv
  subst hfp
  refine ⟨e, ?_, rfl⟩
  simp only [resolvableFindings, List.mem_flatMap]
  rw [hev]
  exact ⟨f, hf, List.mem_map.2 ⟨d, List.mem_filter.2 ⟨hd, unresolvableB_iff.2 hun⟩, rfl⟩⟩

/-! ## Declares -/

/-- Every finding of the `declares` family is admissible. -/
theorem declares_sound (custom : CustomRules) (g : Graph) (r : Rule) (q : Quantifier)
    (pr : DeclarationPredicate) (hr : r.assertion = .declares q pr) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ declaresFindings g r q pr) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  simp only [declaresFindings, List.mem_flatMap] at hm
  obtain ⟨f, hf, hm⟩ := hm
  obtain ⟨d, hd, heq⟩ := List.mem_map.1 hm
  obtain ⟨hd, hpred⟩ := List.mem_filter.1 hd
  obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
  exact ⟨f, hf, rfl, d, hd, rfl, by cases q <;> simpa [quantifierBad] using hpred⟩

/-- Every admissible violation of the `declares` family has a finding with its key. -/
theorem declares_complete (custom : CustomRules) (g : Graph) (r : Rule) (q : Quantifier)
    (pr : DeclarationPredicate) (hr : r.assertion = .declares q pr) {v : Violation}
    (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ declaresFindings g r q pr ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, f, hf, hfp, d, hd, hev, hpred⟩ := hv
  subst hfp
  refine ⟨e, ?_, rfl⟩
  simp only [declaresFindings, List.mem_flatMap]
  rw [hev]
  exact ⟨f, hf, List.mem_map.2 ⟨d, List.mem_filter.2 ⟨hd, by cases q <;> simpa [quantifierBad] using hpred⟩, rfl⟩⟩

/-! ## Exports only -/

/-- Every finding of the `exportsOnly` family is admissible. -/
theorem exportsOnly_sound (custom : CustomRules) (g : Graph) (r : Rule) (names : List String)
    (hr : r.assertion = .exportsOnly names) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ exportsOnlyFindings g r names) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  simp only [exportsOnlyFindings, List.mem_flatMap] at hm
  obtain ⟨f, hf, hm⟩ := hm
  obtain ⟨x, hx, heq⟩ := List.mem_map.1 hm
  obtain ⟨hx, hn⟩ := List.mem_filter.1 hx
  obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
  exact ⟨f, hf, rfl, x, hx, by simpa using hn, rfl⟩

/-- Every admissible violation of the `exportsOnly` family has a finding with its key. -/
theorem exportsOnly_complete (custom : CustomRules) (g : Graph) (r : Rule) (names : List String)
    (hr : r.assertion = .exportsOnly names) {v : Violation}
    (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ exportsOnlyFindings g r names ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, f, hf, hfp, x, hx, hn, hev⟩ := hv
  subst hfp
  refine ⟨e, ?_, rfl⟩
  simp only [exportsOnlyFindings, List.mem_flatMap]
  rw [hev]
  exact ⟨f, hf, List.mem_map.2 ⟨x, List.mem_filter.2 ⟨hx, by simpa using hn⟩, rfl⟩⟩

/-! ## Uses -/

/-- Every finding of the `uses` `forbid` family is admissible. -/
theorem usesForbid_sound (custom : CustomRules) (g : Graph) (r : Rule) (use : UseSpec)
    (hr : r.assertion = .uses .forbid use) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ usesForbidFindings g r use) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  simp only [usesForbidFindings, List.mem_flatMap] at hm
  obtain ⟨f, hf, hm⟩ := hm
  obtain ⟨u, hu, heq⟩ := List.mem_map.1 hm
  obtain ⟨hu, hmatch⟩ := List.mem_filter.1 hu
  obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
  exact ⟨f, hf, rfl, u, hu, hmatch, rfl⟩

/-- Every admissible violation of the `uses` `forbid` family has a finding with its key. -/
theorem usesForbid_complete (custom : CustomRules) (g : Graph) (r : Rule) (use : UseSpec)
    (hr : r.assertion = .uses .forbid use) {v : Violation}
    (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ usesForbidFindings g r use ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, f, hf, hfp, u, hu, hmatch, hev⟩ := hv
  subst hfp
  refine ⟨e, ?_, rfl⟩
  simp only [usesForbidFindings, List.mem_flatMap]
  rw [hev]
  exact ⟨f, hf, List.mem_map.2 ⟨u, List.mem_filter.2 ⟨hu, hmatch⟩, rfl⟩⟩

/-- Every finding of the `uses` `require` family is admissible. -/
theorem usesRequire_sound (custom : CustomRules) (g : Graph) (r : Rule) (use : UseSpec)
    (hr : r.assertion = .uses .require use) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ usesRequireFindings g r use) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  obtain ⟨f, hf, heq⟩ := List.mem_map.1 hm
  obtain ⟨hf, hall⟩ := List.mem_filter.1 hf
  obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
  refine ⟨f, hf, rfl, rfl, fun u hu => ?_⟩
  simpa using List.all_eq_true.1 hall u hu

/-- Every admissible violation of the `uses` `require` family has a finding with its key. -/
theorem usesRequire_complete (custom : CustomRules) (g : Graph) (r : Rule) (use : UseSpec)
    (hr : r.assertion = .uses .require use) {v : Violation}
    (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ usesRequireFindings g r use ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, f, hf, hfp, hev, hnone⟩ := hv
  subst hfp
  refine ⟨e, ?_, rfl⟩
  rw [hev]
  refine List.mem_map.2 ⟨f, List.mem_filter.2 ⟨hf, List.all_eq_true.2 fun u hu => ?_⟩, rfl⟩
  simp [hnone u hu]

/-! ## Named, max lines, custom -/

/-- Every finding of the `named` family is admissible. -/
theorem named_sound (custom : CustomRules) (g : Graph) (r : Rule) (relation : Relation)
    (affix : Affix) (value : String) (hr : r.assertion = .named relation affix value)
    {p : FilePath} {e : Evidence} (hm : (p, e) ∈ namedFindings g r relation affix value) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  obtain ⟨f, hf, heq⟩ := List.mem_map.1 hm
  obtain ⟨hf, hpred⟩ := List.mem_filter.1 hf
  obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
  exact ⟨f, hf, rfl, rfl, by cases relation <;> simpa [relationBad] using hpred⟩

/-- Every admissible violation of the `named` family has a finding with its key. -/
theorem named_complete (custom : CustomRules) (g : Graph) (r : Rule) (relation : Relation)
    (affix : Affix) (value : String) (hr : r.assertion = .named relation affix value)
    {v : Violation} (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ namedFindings g r relation affix value ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, f, hf, hfp, hev, hpred⟩ := hv
  subst hfp
  refine ⟨e, ?_, rfl⟩
  rw [hev]
  exact List.mem_map.2 ⟨f, List.mem_filter.2 ⟨hf, by cases relation <;> simpa [relationBad] using hpred⟩, rfl⟩

/-- Every finding of the `maxLines` family is admissible. -/
theorem maxLines_sound (custom : CustomRules) (g : Graph) (r : Rule) (max : Nat)
    (hr : r.assertion = .maxLines max) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ maxLinesFindings g r max) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  obtain ⟨f, hf, heq⟩ := List.mem_map.1 hm
  obtain ⟨hf, hlt⟩ := List.mem_filter.1 hf
  obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
  exact ⟨f, hf, rfl, rfl, by simpa using hlt⟩

/-- Every admissible violation of the `maxLines` family has a finding with its key. -/
theorem maxLines_complete (custom : CustomRules) (g : Graph) (r : Rule) (max : Nat)
    (hr : r.assertion = .maxLines max) {v : Violation} (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ maxLinesFindings g r max ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, f, hf, hfp, hev, hlt⟩ := hv
  subst hfp
  refine ⟨e, ?_, rfl⟩
  rw [hev]
  exact List.mem_map.2 ⟨f, List.mem_filter.2 ⟨hf, by simpa using hlt⟩, rfl⟩

/-- Every finding of the `custom` family is admissible. -/
theorem custom_sound (custom : CustomRules) (g : Graph) (r : Rule) (name : String)
    (hr : r.assertion = .custom name) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ customFindings custom g r name) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  unfold Admissible
  rw [hr]
  dsimp only
  refine ⟨rfl, rfl, ?_⟩
  simp only [customFindings, List.mem_flatMap] at hm
  obtain ⟨f, hf, hm⟩ := hm
  obtain ⟨m, hmm, heq⟩ := List.mem_map.1 hm
  obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
  exact ⟨⟨f, hf, rfl⟩, m, hmm, rfl⟩

/-- Every admissible violation of the `custom` family has a finding with its key. -/
theorem custom_complete (custom : CustomRules) (g : Graph) (r : Rule) (name : String)
    (hr : r.assertion = .custom name) {v : Violation} (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ customFindings custom g r name ∧ e'.key = v.evidence.key := by
  obtain ⟨vid, vsev, p, e⟩ := v
  unfold Admissible at hv
  rw [hr] at hv
  dsimp only at hv
  obtain ⟨-, -, ⟨f, hf, hfp⟩, m, hm, hev⟩ := hv
  subst hfp
  refine ⟨e, ?_, rfl⟩
  simp only [customFindings, List.mem_flatMap]
  rw [hev]
  exact ⟨f, hf, List.mem_map.2 ⟨m, hm, rfl⟩⟩


/-! ## Assembly -/

/-- C1 for one rule's findings. -/
theorem findings_sound {reach : ReachFn} (h : ReachSpec reach) {g : Graph} (hg : g.WellFormed)
    (custom : CustomRules) (r : Rule) {p : FilePath} {e : Evidence}
    (hm : (p, e) ∈ findings reach custom g r) :
    Admissible custom g r ⟨r.id, r.severity, p, e⟩ := by
  obtain ⟨id, sev, subj, a⟩ := r
  cases a with
  | reach d rel o ef =>
    cases d <;> cases rel
    · exact outgoingForbid_sound h hg custom _ o ef rfl hm
    · exact outgoingRequire_sound h hg custom _ o ef rfl hm
    · exact incomingForbid_sound h hg custom _ o ef rfl hm
    · exact incomingRequire_sound h hg custom _ o ef rfl hm
  | acyclic ef depth => exact acyclic_sound h hg custom _ ef depth rfl hm
  | resolvable a => exact resolvable_sound custom g _ a rfl hm
  | declares q pr => exact declares_sound custom g _ q pr rfl hm
  | exportsOnly names => exact exportsOnly_sound custom g _ names rfl hm
  | uses rel u =>
    cases rel
    · exact usesForbid_sound custom g _ u rfl hm
    · exact usesRequire_sound custom g _ u rfl hm
  | named rel a v => exact named_sound custom g _ rel a v rfl hm
  | maxLines m => exact maxLines_sound custom g _ m rfl hm
  | custom n => exact custom_sound custom g _ n rfl hm

/-- C2 for one rule's findings: the same subject and key. -/
theorem findings_complete {reach : ReachFn} (h : ReachSpec reach) {g : Graph} (hg : g.WellFormed)
    (custom : CustomRules) (r : Rule) {v : Violation} (hv : Admissible custom g r v) :
    ∃ e', (v.subject, e') ∈ findings reach custom g r ∧ e'.key = v.evidence.key := by
  obtain ⟨id, sev, subj, a⟩ := r
  cases a with
  | reach d rel o ef =>
    cases d <;> cases rel
    · exact outgoingForbid_complete h hg custom _ o ef rfl hv
    · exact outgoingRequire_complete h hg custom _ o ef rfl hv
    · exact incomingForbid_complete h hg custom _ o ef rfl hv
    · exact incomingRequire_complete h hg custom _ o ef rfl hv
  | acyclic ef depth => exact acyclic_complete h hg custom _ ef depth rfl hv
  | resolvable a => exact resolvable_complete custom g _ a rfl hv
  | declares q pr => exact declares_complete custom g _ q pr rfl hv
  | exportsOnly names => exact exportsOnly_complete custom g _ names rfl hv
  | uses rel u =>
    cases rel
    · exact usesForbid_complete custom g _ u rfl hv
    · exact usesRequire_complete custom g _ u rfl hv
  | named rel a v => exact named_complete custom g _ rel a v rfl hv
  | maxLines m => exact maxLines_complete custom g _ m rfl hv
  | custom n => exact custom_complete custom g _ n rfl hv

/-- C1 for one rule. -/
theorem ruleViolations_sound {reach : ReachFn} (h : ReachSpec reach) {g : Graph}
    (hg : g.WellFormed) (custom : CustomRules) (r : Rule) {v : Violation}
    (hm : v ∈ ruleViolations reach custom g r) : Admissible custom g r v := by
  obtain ⟨⟨p, e⟩, hf, rfl⟩ := List.mem_map.1 hm
  exact findings_sound h hg custom r hf

/-- C2 for one rule. -/
theorem ruleViolations_complete {reach : ReachFn} (h : ReachSpec reach) {g : Graph}
    (hg : g.WellFormed) (custom : CustomRules) (r : Rule) {v : Violation}
    (hv : Admissible custom g r v) :
    ∃ v' ∈ ruleViolations reach custom g r, v'.key = v.key := by
  obtain ⟨e', hm, hk⟩ := findings_complete h hg custom r hv
  refine ⟨⟨r.id, r.severity, v.subject, e'⟩, List.mem_map.2 ⟨(v.subject, e'), hm, rfl⟩, ?_⟩
  simp only [Violation.key, hk, hv.1]

/-- C1, C2, and C3 for the check built on any reachability function that meets
`ReachSpec`. Uniqueness holds by construction and needs no policy premise. -/
theorem checkWith_spec (reach : ReachFn) (h : ReachSpec reach) : CheckSpec (checkWith reach) where
  sound custom p g v hg hv := by
    obtain ⟨r, hr, hm⟩ := List.mem_flatMap.1 (mem_dedupByKey hv)
    exact ⟨r, hr, ruleViolations_sound h hg custom r hm⟩
  complete custom p g r v hg hr hv := by
    obtain ⟨v', hv', hk⟩ := ruleViolations_complete h hg custom r hv
    obtain ⟨v'', hv'', hk'⟩ := dedupByKey_complete (List.mem_flatMap.2 ⟨r, hr, hv'⟩)
    exact ⟨v'', hv'', hk'.trans hk⟩
  unique custom p g _ := dedupByKey_nodup _


/-! ## Examples

A direct-only stand-in for reachability keeps the examples small. It is not a
`ReachFn` that meets `ReachSpec`; the examples exercise ordering and
deduplication, not transitivity. -/

namespace Examples

def loc : Location := ⟨1, 1⟩
def toB : Dependency := ⟨.file ["b.ts"], .static, "./b.js", loc⟩
def toC : Dependency := ⟨.file ["c.ts"], .static, "./c.js", loc⟩
def file (name : String) (deps : List Dependency) : SourceFile := ⟨[name], deps, [], [], [], 1⟩
def startsWith (c : Char) : Selector := .glob [.segment [.literal c, .star]]
def direct : EdgeFilter := ⟨[.static], false, false⟩

def directReach : ReachFn := fun g ef s =>
  match g.find? s with
  | none => []
  | some f => (f.dependencies.filter ef.admits).map fun d => (d.target, [⟨s, d⟩])

def noCustom : CustomRules := fun _ _ _ => []

/-- `a.ts` imports `b.ts` twice (identical entries) and `c.ts` once. -/
def g : Graph := ⟨[file "a.ts" [toB, toC, toB], file "b.ts" [toC], file "c.ts" []]⟩

def forbidB : Rule :=
  ⟨"forbid-b", .error, startsWith 'a', .reach .outgoing .forbid (startsWith 'b') direct⟩

/-- Identical import sites collapse to one violation. -/
example : checkWith directReach noCustom [forbidB] g =
    [⟨"forbid-b", .error, ["a.ts"], .dependency ⟨["a.ts"], toB⟩⟩] := by decide

/-- Rules run in policy order, then subjects in file order, then import order. -/
example :
    (checkWith directReach noCustom
      [⟨"r2", .warning, startsWith 'a', .reach .outgoing .forbid (startsWith 'c') direct⟩, forbidB]
      g).map (fun v => (v.ruleId, v.evidence)) =
    [("r2", .dependency ⟨["a.ts"], toC⟩), ("forbid-b", .dependency ⟨["a.ts"], toB⟩)] := by decide

/-- A `require` finds nothing, so the subject has a `missing` violation. -/
example :
    checkWith directReach noCustom
      [⟨"needs-a", .error, startsWith 'c', .reach .outgoing .require (startsWith 'a') direct⟩] g =
    [⟨"needs-a", .error, ["c.ts"], .missing⟩] := by decide

/-- Identical custom messages collapse to one violation. -/
example :
    checkWith directReach (fun _ _ _ => ["m", "m"])
      [⟨"c", .info, startsWith 'b', .custom "x"⟩] g =
    [⟨"c", .info, ["b.ts"], .custom "m"⟩] := by decide

end Examples

end Archer.Impl

#print axioms Archer.Impl.checkWith_spec
