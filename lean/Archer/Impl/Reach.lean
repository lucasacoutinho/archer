import Archer.Spec.Check

/-!
# Reachability

An executable breadth-first search that discharges `Spec.ReachSpec`.
Contract: `docs/verification.md` (R1-R3).

## Canonical output order

The result lists targets in discovery order. The search proceeds in rounds.
Round 1 expands the source file `s`; round `k + 1` expands the files first
discovered in round `k`, in the order of discovery. Expanding a file visits
its dependencies in list order and skips dependencies the filter does not
admit. A dependency whose target was already discovered is skipped. Otherwise
its target is appended to the result with the witness `w ++ [edge]`, where `w`
is the witness of the expanded file (empty for `s`). Hence each target is
listed once, with the witness of its first discovery, and that witness is a
shortest walk. The source `s` is not pre-discovered, so `(.file s, w)`
appears when `s` lies on a cycle. Only targets `.file q` with `q` a source
file of the graph are expanded: other targets are leaves. A filter that is
not transitive stops after round 1.

Files are looked up by path with `Graph.find?`. The search runs at most
`|files| + 1` rounds; a counting argument shows that it stops earlier.
-/

namespace Archer.Impl

open Archer Archer.Spec

/-- Discovered targets with their witnesses, in discovery order. -/
abbrev Found := List (Target × List Edge)

/-- Files to expand in the current round, each with the witness of its
discovery. -/
abbrev Front := List (SourceFile × List Edge)

/-- Expand the dependencies `ds` of `f`, whose own witness is `w`: append each
admitted target not yet discovered. -/
def discover (ef : EdgeFilter) (f : SourceFile) (w : List Edge) :
    List Dependency → Found → Found
  | [], res => res
  | d :: ds, res =>
    discover ef f w ds
      (if ef.admits d = true ∧ d.target ∉ res.map Prod.fst
       then res ++ [(d.target, w ++ [⟨f.path, d⟩])] else res)

/-- Expand every file of the frontier, in order. -/
def expandFront (ef : EdgeFilter) : Front → Found → Found
  | [], res => res
  | (f, w) :: fr, res => expandFront ef fr (discover ef f w f.dependencies res)

/-- The next frontier: the newly discovered targets that are source files of
the graph, in discovery order. -/
def next (g : Graph) (ext : Found) : Front :=
  ext.filterMap fun x =>
    match x.1 with
    | .file q => (g.find? q).map fun f => (f, x.2)
    | _ => none

/-- Run at most `fuel` rounds from the frontier `fr`, given the targets `res`
found so far. -/
def search (g : Graph) (ef : EdgeFilter) : Nat → Front → Found → Found
  | 0, _, res => res
  | fuel + 1, fr, res =>
    match fr with
    | [] => res
    | _ :: _ =>
      let res' := expandFront ef fr res
      if ef.transitive = true then search g ef fuel (next g (res'.drop res.length)) res'
      else res'

/-- The initial frontier: the source file `s`, when the graph has it. -/
def start (g : Graph) (s : FilePath) : Front :=
  (g.find? s).toList.map fun f => (f, [])

/-- Breadth-first reachability from `s`. See the module documentation for
the output order. -/
def reach : ReachFn := fun g ef s =>
  search g ef (g.files.length + 1) (start g s) []

/-! ## Walks -/

/-- Every walk has at least one edge. -/
theorem walk_length_pos {g : Graph} {ef : EdgeFilter} {p : FilePath} {w : List Edge}
    {t : Target} (h : Walk g ef p w t) : 0 < w.length := by
  cases h <;> simp

/-- A walk ends with an admitted edge of a source file: either it is that
single edge from `p`, or it extends a walk to the file. -/
theorem walk_last {g : Graph} {ef : EdgeFilter} {p : FilePath} {w : List Edge}
    {t : Target} (h : Walk g ef p w t) :
    ∃ f ∈ g.files, ∃ d ∈ f.dependencies, ef.admits d = true ∧ d.target = t ∧
      ((w = [⟨f.path, d⟩] ∧ f.path = p) ∨
        ∃ w0, w = w0 ++ [⟨f.path, d⟩] ∧ Walk g ef p w0 (.file f.path)) := by
  induction h with
  | last hf hd ha => exact ⟨_, hf, _, hd, ha, rfl, Or.inl ⟨rfl, rfl⟩⟩
  | @step f d q w t hf hd ha ht hw ih =>
    obtain ⟨f2, hf2, d2, hd2, ha2, ht2, h2⟩ := ih
    refine ⟨f2, hf2, d2, hd2, ha2, ht2, Or.inr ?_⟩
    rcases h2 with ⟨hw, hq⟩ | ⟨w0, hw, hw0⟩
    · subst hw
      refine ⟨[⟨f.path, d⟩], rfl, ?_⟩
      have := Walk.last hf hd ha
      rw [ht, ← hq] at this
      exact this
    · subst hw
      exact ⟨⟨f.path, d⟩ :: w0, rfl, Walk.step hf hd ha ht hw0⟩

/-- Extending a walk to a file by an admitted edge of that file. -/
theorem walk_snoc {g : Graph} {ef : EdgeFilter} {p : FilePath} {w : List Edge}
    {t : Target} (h : Walk g ef p w t) :
    ∀ {q : FilePath} {f : SourceFile} {d : Dependency}, t = .file q → f ∈ g.files →
      f.path = q → d ∈ f.dependencies → ef.admits d = true →
      Walk g ef p (w ++ [⟨f.path, d⟩]) d.target := by
  induction h with
  | last hf0 hd0 ha0 =>
    intro q f d ht hf hq hd ha
    subst hq
    exact Walk.step hf0 hd0 ha0 ht (Walk.last hf hd ha)
  | step hf0 hd0 ha0 ht0 _ ih =>
    intro q f d ht hf hq hd ha
    exact Walk.step hf0 hd0 ha0 ht0 (ih ht hf hq hd ha)

/-! ## Lookup by path -/

/-- Elements of a list with equal keys are equal when the keys are distinct. -/
theorem eq_of_nodup_map {α β : Type} {f : α → β} :
    ∀ {l : List α}, (l.map f).Nodup → ∀ {a b : α}, a ∈ l → b ∈ l → f a = f b → a = b
  | [], _, _, _, ha, _, _ => by simp at ha
  | x :: l, h, a, b, ha, hb, hab => by
    rw [List.map_cons, List.nodup_cons] at h
    rcases List.mem_cons.1 ha with rfl | ha' <;> rcases List.mem_cons.1 hb with rfl | hb'
    · rfl
    · exact absurd (hab ▸ List.mem_map_of_mem hb') h.1
    · exact absurd (hab.symm ▸ List.mem_map_of_mem ha') h.1
    · exact eq_of_nodup_map h.2 ha' hb' hab

theorem find?_mem {g : Graph} {q : FilePath} {f : SourceFile} (h : g.find? q = some f) :
    f ∈ g.files ∧ f.path = q := by
  refine ⟨List.mem_of_find?_eq_some h, ?_⟩
  simpa using List.find?_some h

/-- On a well-formed graph, lookup by path agrees with membership. -/
theorem find?_of_mem {g : Graph} (hwf : g.WellFormed) {f : SourceFile} (hf : f ∈ g.files) :
    g.find? f.path = some f := by
  cases h : g.find? f.path with
  | none =>
    have := List.find?_eq_none.1 h f hf
    simp at this
  | some f' =>
    obtain ⟨hf', hp⟩ := find?_mem h
    rw [eq_of_nodup_map hwf hf' hf hp]

/-! ## One expansion and one round -/

theorem discover_pos {ef : EdgeFilter} {f : SourceFile} {w : List Edge} {d : Dependency}
    {ds : List Dependency} {res : Found}
    (hc : ef.admits d = true ∧ d.target ∉ res.map Prod.fst) :
    discover ef f w (d :: ds) res =
      discover ef f w ds (res ++ [(d.target, w ++ [⟨f.path, d⟩])]) := by
  simp [discover, hc]

theorem discover_neg {ef : EdgeFilter} {f : SourceFile} {w : List Edge} {d : Dependency}
    {ds : List Dependency} {res : Found}
    (hc : ¬(ef.admits d = true ∧ d.target ∉ res.map Prod.fst)) :
    discover ef f w (d :: ds) res = discover ef f w ds res := by
  simp only [discover]
  split
  · exact absurd ‹_› hc
  · rfl

theorem discover_extends (ef : EdgeFilter) (f : SourceFile) (w : List Edge) :
    ∀ (ds : List Dependency) (res : Found), ∃ ext,
      discover ef f w ds res = res ++ ext ∧
      ∀ x ∈ ext, ∃ d ∈ ds, ef.admits d = true ∧ x = (d.target, w ++ [⟨f.path, d⟩])
  | [], res => ⟨[], by simp [discover], by simp⟩
  | d :: ds, res => by
    by_cases hc : ef.admits d = true ∧ d.target ∉ res.map Prod.fst
    · obtain ⟨ext, he, hx⟩ := discover_extends ef f w ds (res ++ [(d.target, w ++ [⟨f.path, d⟩])])
      refine ⟨(d.target, w ++ [⟨f.path, d⟩]) :: ext, ?_, ?_⟩
      · rw [discover_pos hc, he]; simp
      · intro x hxm
        rcases List.mem_cons.1 hxm with rfl | hxm
        · exact ⟨d, by simp, hc.1, rfl⟩
        · obtain ⟨d', hd', h1, h2⟩ := hx x hxm
          exact ⟨d', List.mem_cons_of_mem _ hd', h1, h2⟩
    · obtain ⟨ext, he, hx⟩ := discover_extends ef f w ds res
      refine ⟨ext, ?_, ?_⟩
      · rw [discover_neg hc, he]
      · intro x hxm
        obtain ⟨d', hd', h1, h2⟩ := hx x hxm
        exact ⟨d', List.mem_cons_of_mem _ hd', h1, h2⟩

theorem discover_nodup (ef : EdgeFilter) (f : SourceFile) (w : List Edge) :
    ∀ (ds : List Dependency) (res : Found), (res.map Prod.fst).Nodup →
      ((discover ef f w ds res).map Prod.fst).Nodup
  | [], res, h => by simpa [discover] using h
  | d :: ds, res, h => by
    by_cases hc : ef.admits d = true ∧ d.target ∉ res.map Prod.fst
    · rw [discover_pos hc]
      apply discover_nodup
      simp only [List.map_append, List.map_cons, List.map_nil]
      refine List.nodup_append.2 ⟨h, by simp, ?_⟩
      intro a ha b hb heq
      rw [List.mem_singleton] at hb
      subst hb
      subst heq
      exact hc.2 ha
    · rw [discover_neg hc]
      exact discover_nodup ef f w ds res h

theorem discover_closed (ef : EdgeFilter) (f : SourceFile) (w : List Edge) :
    ∀ (ds : List Dependency) (res : Found), ∀ d ∈ ds, ef.admits d = true →
      ∃ w2, (d.target, w2) ∈ discover ef f w ds res
  | [], res, d, hd, _ => by simp at hd
  | d' :: ds, res, d, hd, ha => by
    by_cases hc : ef.admits d' = true ∧ d'.target ∉ res.map Prod.fst
    · rw [discover_pos hc]
      rcases List.mem_cons.1 hd with rfl | hd
      · obtain ⟨ext, he, _⟩ := discover_extends ef f w ds
          (res ++ [(d.target, w ++ [⟨f.path, d⟩])])
        exact ⟨w ++ [⟨f.path, d⟩], by rw [he]; simp⟩
      · exact discover_closed ef f w ds _ d hd ha
    · rw [discover_neg hc]
      rcases List.mem_cons.1 hd with rfl | hd
      · have hm : d.target ∈ res.map Prod.fst :=
          Classical.byContradiction fun hn => hc ⟨ha, hn⟩
        obtain ⟨x, hx, hxe⟩ := List.mem_map.1 hm
        obtain ⟨ext, he, _⟩ := discover_extends ef f w ds res
        exact ⟨x.2, by rw [he]; exact List.mem_append_left _ (hxe ▸ hx)⟩
      · exact discover_closed ef f w ds _ d hd ha

theorem expand_extends (ef : EdgeFilter) :
    ∀ (fr : Front) (res : Found), ∃ ext, expandFront ef fr res = res ++ ext ∧
      ∀ x ∈ ext, ∃ f w, (f, w) ∈ fr ∧ ∃ d ∈ f.dependencies, ef.admits d = true ∧
        x = (d.target, w ++ [⟨f.path, d⟩])
  | [], res => ⟨[], by simp [expandFront], by simp⟩
  | (f, w) :: fr, res => by
    obtain ⟨e1, h1, p1⟩ := discover_extends ef f w f.dependencies res
    obtain ⟨e2, h2, p2⟩ := expand_extends ef fr (discover ef f w f.dependencies res)
    refine ⟨e1 ++ e2, ?_, ?_⟩
    · simp only [expandFront]; rw [h2, h1, List.append_assoc]
    · intro x hx
      rcases List.mem_append.1 hx with hx | hx
      · obtain ⟨d, hd, ha, he⟩ := p1 x hx
        exact ⟨f, w, by simp, d, hd, ha, he⟩
      · obtain ⟨f', w', hm, r⟩ := p2 x hx
        exact ⟨f', w', List.mem_cons_of_mem _ hm, r⟩

theorem expand_nodup (ef : EdgeFilter) :
    ∀ (fr : Front) (res : Found), (res.map Prod.fst).Nodup →
      ((expandFront ef fr res).map Prod.fst).Nodup
  | [], res, h => by simpa [expandFront] using h
  | (f, w) :: fr, res, h => by
    simp only [expandFront]
    exact expand_nodup ef fr _ (discover_nodup ef f w _ res h)

theorem expand_closed (ef : EdgeFilter) :
    ∀ (fr : Front) (res : Found), ∀ f w, (f, w) ∈ fr → ∀ d ∈ f.dependencies,
      ef.admits d = true → ∃ w2, (d.target, w2) ∈ expandFront ef fr res
  | [], res, f, w, hm, _, _, _ => by simp at hm
  | (f', w') :: fr, res, f, w, hm, d, hd, ha => by
    simp only [expandFront]
    rcases List.mem_cons.1 hm with h | h
    · obtain ⟨rfl, rfl⟩ := Prod.mk.inj h
      obtain ⟨w2, hw2⟩ := discover_closed ef f w f.dependencies res d hd ha
      obtain ⟨ext, he, _⟩ := expand_extends ef fr (discover ef f w f.dependencies res)
      exact ⟨w2, by rw [he]; exact List.mem_append_left _ hw2⟩
    · exact expand_closed ef fr _ f w h d hd ha

/-! ## Frontier and counting -/

theorem next_mem {g : Graph} {ext : Found} {f : SourceFile} {w : List Edge}
    (h : (f, w) ∈ next g ext) :
    (Target.file f.path, w) ∈ ext ∧ g.find? f.path = some f := by
  simp only [next, List.mem_filterMap] at h
  obtain ⟨⟨t, w'⟩, hx, hm⟩ := h
  cases t with
  | file q =>
    simp only [Option.map_eq_some_iff, Prod.mk.injEq] at hm
    obtain ⟨f', hf', rfl, rfl⟩ := hm
    have := (find?_mem hf').2
    rw [this]
    exact ⟨hx, hf'⟩
  | package _ _ => simp at hm
  | builtin _ _ => simp at hm
  | unresolved _ => simp at hm
  | computed => simp at hm

theorem mem_next {g : Graph} {ext : Found} {f : SourceFile} {w : List Edge}
    (hwf : g.WellFormed) (hf : f ∈ g.files) (h : (Target.file f.path, w) ∈ ext) :
    (f, w) ∈ next g ext := by
  simp only [next, List.mem_filterMap]
  exact ⟨_, h, by simp [find?_of_mem hwf hf]⟩

/-- The discovered targets that are source files of the graph. -/
def known (g : Graph) (res : Found) : List Target :=
  (res.map Prod.fst).filter fun t =>
    match t with
    | .file q => (g.find? q).isSome
    | _ => false

theorem known_append (g : Graph) (res ext : Found) :
    known g (res ++ ext) = known g res ++ known g ext := by
  simp [known, List.filter_append]

/-- Distinct source files bound the targets found. -/
theorem known_length_le (g : Graph) {res : Found} (h : (res.map Prod.fst).Nodup) :
    (known g res).length ≤ g.files.length := by
  have hnd : (known g res).Nodup := List.Pairwise.sublist List.filter_sublist h
  have hsub : known g res ⊆ g.paths.map Target.file := by
    intro t ht
    simp only [known, List.mem_filter] at ht
    obtain ⟨_, hp⟩ := ht
    cases t with
    | file q =>
      simp only [Option.isSome_iff_exists] at hp
      obtain ⟨f, hf⟩ := hp
      obtain ⟨hm, hq⟩ := find?_mem hf
      exact List.mem_map.2 ⟨q, List.mem_map.2 ⟨f, hm, hq⟩, rfl⟩
    | package _ _ => simp at hp
    | builtin _ _ => simp at hp
    | unresolved _ => simp at hp
    | computed => simp at hp
  have := hnd.length_le_of_subset hsub
  simpa [Graph.paths] using this

theorem known_ne_nil {g : Graph} {ext : Found} (h : next g ext ≠ []) : known g ext ≠ [] := by
  obtain ⟨⟨f, w⟩, hm⟩ := List.exists_mem_of_ne_nil _ h
  obtain ⟨hx, hf⟩ := next_mem hm
  refine List.ne_nil_of_mem (a := Target.file f.path) ?_
  simp only [known, List.mem_filter]
  exact ⟨List.mem_map.2 ⟨_, hx, rfl⟩, by simp [hf]⟩

/-! ## The loop invariant

`Inv g ef s k fr res` describes the state before round `k + 1`: `res` holds
the targets found by rounds `1..k`, and `fr` is the frontier of round `k + 1`. -/

structure Inv (g : Graph) (ef : EdgeFilter) (s : FilePath) (k : Nat) (fr : Front)
    (res : Found) : Prop where
  /-- Each target is found once. -/
  nodup : (res.map Prod.fst).Nodup
  /-- Each witness is a walk of at most `k` edges. -/
  walk : ∀ t w, (t, w) ∈ res → Walk g ef s w t ∧ w.length ≤ k
  /-- The frontier holds source files discovered by `k` edges. -/
  front : ∀ f w, (f, w) ∈ fr → f ∈ g.files ∧ w.length = k ∧
    ((k = 0 ∧ f.path = s) ∨ (Target.file f.path, w) ∈ res)
  /-- Every walk of at most `k` edges has its target found, no later. -/
  dist : ∀ w' t, Walk g ef s w' t → w'.length ≤ k →
    ∃ w, (t, w) ∈ res ∧ w.length ≤ w'.length
  /-- A source file expanded in an earlier round has its targets found. -/
  expanded : ∀ f ∈ g.files,
    ((f.path = s ∧ 1 ≤ k) ∨ ∃ w, (Target.file f.path, w) ∈ res ∧ w.length < k) →
    ∀ d ∈ f.dependencies, ef.admits d = true → ∃ w, (d.target, w) ∈ res
  /-- The frontier holds every source file discovered in the last round. -/
  frontier : ∀ f ∈ g.files,
    ((k = 0 ∧ f.path = s → (f, []) ∈ fr) ∧
      ∀ w, (Target.file f.path, w) ∈ res → w.length = k → (f, w) ∈ fr)

theorem inv_start {g : Graph} (ef : EdgeFilter) (s : FilePath) (hwf : g.WellFormed) :
    Inv g ef s 0 (start g s) [] where
  nodup := by simp
  walk := by simp
  front := by
    intro f w hm
    simp only [start, List.mem_map, Option.mem_toList] at hm
    obtain ⟨f', hf', he⟩ := hm
    obtain ⟨rfl, rfl⟩ := Prod.mk.inj he
    obtain ⟨hm, hp⟩ := find?_mem hf'
    exact ⟨hm, rfl, Or.inl ⟨rfl, hp⟩⟩
  dist := by
    intro w' t hw hl
    have := walk_length_pos hw
    omega
  expanded := by
    intro f _ h
    rcases h with ⟨_, h⟩ | ⟨w, hw, _⟩
    · omega
    · simp at hw
  frontier := by
    intro f hf
    refine ⟨?_, by simp⟩
    rintro ⟨_, hp⟩
    simp only [start, List.mem_map, Option.mem_toList]
    exact ⟨f, by rw [← hp]; exact find?_of_mem hwf hf, rfl⟩

/-! ## One round preserves the invariant -/

/-- A source file that is the start or was found no later than round `k`
has its targets found once the round has run. -/
theorem processed {g : Graph} {ef : EdgeFilter} {s : FilePath} {k : Nat} {fr : Front}
    {res : Found} (h : Inv g ef s k fr res) {f : SourceFile} (hf : f ∈ g.files)
    (hr : f.path = s ∨ ∃ w, (Target.file f.path, w) ∈ res ∧ w.length ≤ k)
    {d : Dependency} (hd : d ∈ f.dependencies) (ha : ef.admits d = true) :
    ∃ w2, (d.target, w2) ∈ expandFront ef fr res := by
  have key : (∃ w, (f, w) ∈ fr) ∨ ∃ w2, (d.target, w2) ∈ res := by
    rcases hr with hp | ⟨w, hw, hle⟩
    · cases k with
      | zero => exact Or.inl ⟨[], (h.frontier f hf).1 ⟨rfl, hp⟩⟩
      | succ k => exact Or.inr (h.expanded f hf (Or.inl ⟨hp, by omega⟩) d hd ha)
    · by_cases heq : w.length = k
      · exact Or.inl ⟨w, (h.frontier f hf).2 w hw heq⟩
      · exact Or.inr (h.expanded f hf (Or.inr ⟨w, hw, by omega⟩) d hd ha)
  rcases key with ⟨w, hm⟩ | ⟨w2, hm⟩
  · exact expand_closed ef fr res f w hm d hd ha
  · obtain ⟨ext, he, _⟩ := expand_extends ef fr res
    exact ⟨w2, by rw [he]; exact List.mem_append_left _ hm⟩

theorem inv_step {g : Graph} {ef : EdgeFilter} {s : FilePath} {k : Nat} {fr : Front}
    {res : Found} (hwf : g.WellFormed) (h : Inv g ef s k fr res) :
    ∃ ext, expandFront ef fr res = res ++ ext ∧
      Inv g ef s (k + 1) (next g ext) (res ++ ext) := by
  obtain ⟨ext, he, hx⟩ := expand_extends ef fr res
  refine ⟨ext, he, ?_⟩
  have hext : ∀ x ∈ ext, Walk g ef s x.2 x.1 ∧ x.2.length = k + 1 := by
    intro x hxm
    obtain ⟨f, w, hfw, d, hd, ha, rfl⟩ := hx x hxm
    obtain ⟨hf, hlen, hk⟩ := h.front f w hfw
    refine ⟨?_, by simp [hlen]⟩
    rcases hk with ⟨hk0, hp⟩ | hmem
    · have hw : w = [] := List.length_eq_zero_iff.1 (by omega)
      subst hw
      show Walk g ef s [⟨f.path, d⟩] d.target
      rw [← hp]
      exact Walk.last hf hd ha
    · exact walk_snoc (h.walk _ _ hmem).1 rfl hf rfl hd ha
  have hlen : ∀ t w, (t, w) ∈ res ++ ext → w.length ≤ k + 1 := by
    intro t w hm
    rcases List.mem_append.1 hm with hm | hm
    · have := (h.walk t w hm).2
      omega
    · have := (hext _ hm).2
      simp only at this
      omega
  have hproc : ∀ f ∈ g.files, (f.path = s ∨ ∃ w, (Target.file f.path, w) ∈ res ∧ w.length ≤ k) →
      ∀ d ∈ f.dependencies, ef.admits d = true → ∃ w2, (d.target, w2) ∈ res ++ ext := by
    intro f hf hr d hd ha
    obtain ⟨w2, hm⟩ := processed h hf hr hd ha
    exact ⟨w2, by rw [he] at hm; exact hm⟩
  exact
    { nodup := by
        have := expand_nodup ef fr res h.nodup
        rwa [he] at this
      walk := by
        intro t w hm
        refine ⟨?_, hlen t w hm⟩
        rcases List.mem_append.1 hm with hm | hm
        · exact (h.walk t w hm).1
        · exact (hext _ hm).1
      front := by
        intro f w hm
        obtain ⟨hx', hfind⟩ := next_mem hm
        exact ⟨(find?_mem hfind).1, (hext _ hx').2, Or.inr (List.mem_append_right _ hx')⟩
      dist := by
        intro w' t hw hl
        by_cases hle : w'.length ≤ k
        · obtain ⟨w2, hm, hl2⟩ := h.dist w' t hw hle
          exact ⟨w2, List.mem_append_left _ hm, hl2⟩
        · obtain ⟨f, hf, d, hd, ha, hdt, hcase⟩ := walk_last hw
          have hr : f.path = s ∨ ∃ w, (Target.file f.path, w) ∈ res ∧ w.length ≤ k := by
            rcases hcase with ⟨_, hp⟩ | ⟨w0, hw0e, hw0⟩
            · exact Or.inl hp
            · right
              have : w0.length ≤ k := by
                subst hw0e
                simp at hl
                omega
              obtain ⟨w2, hm, hl2⟩ := h.dist w0 _ hw0 this
              exact ⟨w2, hm, by omega⟩
          obtain ⟨w3, hm3⟩ := hproc f hf hr d hd ha
          rw [hdt] at hm3
          exact ⟨w3, hm3, by have := hlen _ _ hm3; omega⟩
      expanded := by
        intro f hf hcond d hd ha
        refine hproc f hf ?_ d hd ha
        rcases hcond with ⟨hp, _⟩ | ⟨w, hm, hlt⟩
        · exact Or.inl hp
        · right
          rcases List.mem_append.1 hm with hm | hm
          · exact ⟨w, hm, by omega⟩
          · have := (hext _ hm).2
            simp only at this
            omega
      frontier := by
        intro f hf
        refine ⟨by omega, ?_⟩
        intro w hm hl
        rcases List.mem_append.1 hm with hm | hm
        · have := (h.walk _ _ hm).2
          omega
        · exact mem_next hwf hf hm }

/-! ## Termination and completeness -/

/-- With an empty frontier every walk from a found or start file ends at a
found target. -/
theorem closure {g : Graph} {ef : EdgeFilter} {s : FilePath} {k : Nat} {res : Found}
    (h : Inv g ef s k [] res) {p : FilePath} {w : List Edge} {t : Target}
    (hw : Walk g ef p w t) :
    (p = s ∨ ∃ w0, (Target.file p, w0) ∈ res) → ∃ w2, (t, w2) ∈ res := by
  have conv : ∀ f ∈ g.files, ∀ {d : Dependency}, d ∈ f.dependencies → ef.admits d = true →
      (f.path = s ∨ ∃ w0, (Target.file f.path, w0) ∈ res) → ∃ w2, (d.target, w2) ∈ res := by
    intro f hf d hd ha hr
    have hr' : f.path = s ∨ ∃ w0, (Target.file f.path, w0) ∈ res ∧ w0.length ≤ k := by
      rcases hr with hp | ⟨w0, hm⟩
      · exact Or.inl hp
      · exact Or.inr ⟨w0, hm, (h.walk _ _ hm).2⟩
    simpa [expandFront] using processed h hf hr' hd ha
  induction hw with
  | last hf hd ha => intro hr; exact conv _ hf hd ha hr
  | step hf hd ha ht _ ih =>
    intro hr
    obtain ⟨w2, hm⟩ := conv _ hf hd ha hr
    rw [ht] at hm
    exact ih (Or.inr ⟨w2, hm⟩)

theorem search_nil (g : Graph) (ef : EdgeFilter) (fuel : Nat) (res : Found) :
    search g ef fuel [] res = res := by
  cases fuel <;> simp [search]

/-- The search ends in a state from which the specification follows. -/
theorem search_inv {g : Graph} {ef : EdgeFilter} {s : FilePath} (hwf : g.WellFormed) :
    ∀ (fuel k : Nat) (fr : Front) (res : Found), Inv g ef s k fr res →
      (ef.transitive = true ∨ k = 0) →
      g.files.length + 1 ≤ fuel + (known g res).length →
      ∃ k' fr', Inv g ef s k' fr' (search g ef fuel fr res) ∧
        (ef.transitive = true ∨ k' ≤ 1) ∧ (fr' = [] ∨ (ef.transitive = false ∧ k' = 1))
  | 0, k, fr, res, h, hk, hc => by
    have := known_length_le g h.nodup
    omega
  | fuel + 1, k, [], res, h, hk, hc => by
    refine ⟨k, [], ?_, ?_, Or.inl rfl⟩
    · simpa [search] using h
    · rcases hk with hk | hk
      · exact Or.inl hk
      · exact Or.inr (by omega)
  | fuel + 1, k, x :: xs, res, h, hk, hc => by
    obtain ⟨ext, he, h'⟩ := inv_step hwf h
    by_cases ht : ef.transitive = true
    · have hs : search g ef (fuel + 1) (x :: xs) res =
          search g ef fuel (next g ext) (res ++ ext) := by
        simp only [search, ht, ite_true]
        rw [he, List.drop_left]
      rw [hs]
      by_cases hne : next g ext = []
      · refine ⟨k + 1, next g ext, ?_, Or.inl ht, Or.inl hne⟩
        rw [hne, search_nil]
        rw [hne] at h'
        exact h'
      · have hcount := known_ne_nil hne
        obtain ⟨k', fr', hI, h1, h2⟩ := search_inv hwf fuel (k + 1) (next g ext) (res ++ ext) h'
          (Or.inl ht) (by
            rw [known_append]
            have : 0 < (known g ext).length := List.length_pos_iff.2 hcount
            simp only [List.length_append]
            omega)
        exact ⟨k', fr', hI, h1, h2⟩
    · have hk0 : k = 0 := by
        rcases hk with hk | hk
        · exact absurd hk ht
        · exact hk
      subst hk0
      have hs : search g ef (fuel + 1) (x :: xs) res = res ++ ext := by
        simp only [search, ht]
        simpa using he
      rw [hs]
      exact ⟨1, next g ext, h', Or.inr (Nat.le_refl _), Or.inr ⟨by simpa using ht, rfl⟩⟩

/-- Each target is found once, whatever the graph. -/
theorem search_nodup (g : Graph) (ef : EdgeFilter) :
    ∀ (fuel : Nat) (fr : Front) (res : Found), (res.map Prod.fst).Nodup →
      ((search g ef fuel fr res).map Prod.fst).Nodup
  | 0, _, _, h => by simpa [search] using h
  | fuel + 1, [], res, h => by simpa [search] using h
  | fuel + 1, x :: xs, res, h => by
    have h' := expand_nodup ef (x :: xs) res h
    by_cases ht : ef.transitive = true
    · simp only [search, ht, ite_true]
      exact search_nodup g ef fuel _ _ h'
    · simp only [search, ht]
      simpa using h'

/-! ## The specification -/

/-- What a terminal state of the search entails. -/
theorem spec_of_inv {g : Graph} {ef : EdgeFilter} {s : FilePath} {k : Nat} {fr : Front}
    {res : Found} (h : Inv g ef s k fr res)
    (h1 : ef.transitive = true ∨ k ≤ 1) (h2 : fr = [] ∨ (ef.transitive = false ∧ k = 1)) :
    (∀ t w, (t, w) ∈ res → Shortest g ef s w t) ∧
      (∀ w' t, Considered g ef s w' t → ∃ w, (t, w) ∈ res) := by
  refine ⟨?_, ?_⟩
  · intro t w hm
    obtain ⟨hw, hlen⟩ := h.walk t w hm
    have hcons : Considered g ef s w t := by
      refine ⟨hw, ?_⟩
      rcases h1 with h1 | h1
      · exact Or.inl h1
      · have := walk_length_pos hw
        exact Or.inr (by omega)
    refine ⟨hcons, ?_⟩
    intro w' hw'
    by_cases hle : w'.length ≤ k
    · obtain ⟨w2, hm2, hl2⟩ := h.dist w' t hw'.1 hle
      have : (t, w2) = (t, w) := eq_of_nodup_map h.nodup hm2 hm rfl
      have hw2 : w2 = w := (Prod.mk.inj this).2
      subst hw2
      exact hl2
    · omega
  · intro w' t hc
    rcases h2 with rfl | ⟨ht, hk⟩
    · exact closure h hc.1 (Or.inl rfl)
    · have hl : w'.length = 1 := by
        rcases hc.2 with hc2 | hc2
        · rw [ht] at hc2; exact absurd hc2 (by simp)
        · exact hc2
      obtain ⟨w, hm, _⟩ := h.dist w' t hc.1 (by omega)
      exact ⟨w, hm⟩

/-- Breadth-first reachability meets the specification (R1-R3). -/
theorem reach_spec : ReachSpec reach where
  sound := by
    intro g ef s t w hwf hm
    obtain ⟨k, fr, hI, h1, h2⟩ := search_inv hwf (g.files.length + 1) 0 (start g s) []
      (inv_start ef s hwf) (Or.inr rfl) (by simp [known])
    exact (spec_of_inv hI h1 h2).1 t w hm
  complete := by
    intro g ef s t w hwf hc
    obtain ⟨k, fr, hI, h1, h2⟩ := search_inv hwf (g.files.length + 1) 0 (start g s) []
      (inv_start ef s hwf) (Or.inr rfl) (by simp [known])
    exact (spec_of_inv hI h1 h2).2 w t hc
  unique := by
    intro g ef s
    exact search_nodup g ef _ _ _ (by simp)

/-! ## Examples -/

section Examples

private def dep (t : Target) : Dependency := ⟨t, .static, "", ⟨1, 1⟩⟩

private def src (name : String) (ts : List Target) : SourceFile :=
  ⟨[name], ts.map dep, [], [], [], 0⟩

private def all (transitive : Bool) : EdgeFilter :=
  ⟨[.static, .type, .require, .dynamic], false, transitive⟩

private def edge (a : String) (t : Target) : Edge := ⟨[a], dep t⟩

/-- A chain `a → b → c` reports `b` and `c` with shortest witnesses. -/
example :
    reach ⟨[src "a" [.file ["b"]], src "b" [.file ["c"]], src "c" []]⟩ (all true) ["a"] =
      [(.file ["b"], [edge "a" (.file ["b"])]),
       (.file ["c"], [edge "a" (.file ["b"]), edge "b" (.file ["c"])])] := by
  decide

/-- A cycle `a → b → a` reports the source itself. -/
example :
    reach ⟨[src "a" [.file ["b"]], src "b" [.file ["a"]]]⟩ (all true) ["a"] =
      [(.file ["b"], [edge "a" (.file ["b"])]),
       (.file ["a"], [edge "a" (.file ["b"]), edge "b" (.file ["a"])])] := by
  decide

/-- A direct-only filter reports single edges and does not follow them. -/
example :
    reach ⟨[src "a" [.file ["b"]], src "b" [.file ["c"]], src "c" []]⟩ (all false) ["a"] =
      [(.file ["b"], [edge "a" (.file ["b"])])] := by
  decide

/-- A computed import is a leaf; the shorter route to `c` wins. -/
example :
    reach ⟨[src "a" [.file ["b"], .computed, .file ["c"]], src "b" [.file ["c"]],
        src "c" []]⟩ (all true) ["a"] =
      [(.file ["b"], [edge "a" (.file ["b"])]),
       (.computed, [edge "a" .computed]),
       (.file ["c"], [edge "a" (.file ["c"])])] := by
  decide

end Examples

end Archer.Impl

#print axioms Archer.Impl.reach_spec
