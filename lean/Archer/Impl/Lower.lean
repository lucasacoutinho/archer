import Archer.Spec.Lower

/-!
# Lowering

`lower` validates a configuration, resolves layer references in user rules,
and turns the layer tables and public APIs into dependency rules. The policy
lists the rules in `Config.ruleIds` order. Contract: `Archer.Spec.LowerSpec`.
-/

namespace Archer.Impl

open Archer Archer.Spec

/-! ## Validation -/

/-- The first element that occurs again later in the list. -/
def firstDup : List String → Option String
  | [] => none
  | x :: xs => if x ∈ xs then some x else firstDup xs

/-- `firstDup` finds nothing exactly when the list has no duplicates. -/
theorem firstDup_eq_none : ∀ l : List String, firstDup l = none ↔ l.Nodup
  | [] => by simp [firstDup]
  | x :: xs => by
    have ih := firstDup_eq_none xs
    by_cases h : x ∈ xs <;> simp [firstDup, h, ih, List.nodup_cons]

/-- The first referenced layer that no layer defines. -/
def firstUnknown (names refs : List String) : Option String :=
  refs.find? fun n => decide (n ∉ names)

/-- `firstUnknown` finds nothing exactly when every reference is defined. -/
theorem firstUnknown_eq_none (names refs : List String) :
    firstUnknown names refs = none ↔ ∀ n ∈ refs, n ∈ names := by
  simp [firstUnknown, List.find?_eq_none]

/-- The first validation error, in the order: duplicate layer, unknown
layer, duplicate rule id, empty policy. -/
def validate (c : Config) : Option ConfigError :=
  match firstDup (c.layers.map (·.name)) with
  | some n => some (.duplicateLayer n)
  | none =>
    match firstUnknown (c.layers.map (·.name)) c.referencedLayers with
    | some n => some (.unknownLayer n)
    | none =>
      match firstDup c.ruleIds with
      | some n => some (.duplicateRuleId n)
      | none => if c.ruleIds.isEmpty then some .emptyPolicy else none

/-- Validation passes exactly on configurations that are not invalid. -/
theorem validate_eq_none (c : Config) : validate c = none ↔ ¬ c.Invalid := by
  unfold validate Config.Invalid
  rcases h1 : firstDup (c.layers.map (·.name)) with _ | n
  · have e1 := (firstDup_eq_none _).1 h1
    simp only [h1]
    rcases h2 : firstUnknown (c.layers.map (·.name)) c.referencedLayers with _ | n
    · have e2 := (firstUnknown_eq_none _ _).1 h2
      simp only [h2]
      rcases h3 : firstDup c.ruleIds with _ | n
      · have e3 := (firstDup_eq_none _).1 h3
        have e2' : ¬ ∃ n ∈ c.referencedLayers, n ∉ c.layers.map (·.name) :=
          fun ⟨n, hn, hn'⟩ => hn' (e2 n hn)
        by_cases h4 : c.ruleIds.isEmpty
        · simp [List.isEmpty_iff.1 h4]
        · have : c.ruleIds ≠ [] := fun h => h4 (by simp [h])
          simp [h4, e1, e3]
          exact ⟨by simpa using e2, this⟩
      · have e3 : ¬ c.ruleIds.Nodup := fun h => by
          have := (firstDup_eq_none _).2 h; simp_all
        simp [e3]
    · have e2 : ¬ ∀ n ∈ c.referencedLayers, n ∈ c.layers.map (·.name) := fun h => by
        have := (firstUnknown_eq_none _ _).2 h; simp_all
      have : ∃ n ∈ c.referencedLayers, n ∉ c.layers.map (·.name) := by
        refine Classical.byContradiction fun hc => e2 fun n hn => ?_
        exact Classical.byContradiction fun hn' => hc ⟨n, hn, hn'⟩
      simp only [h2, reduceCtorEq, false_iff]
      exact fun h => h (Or.inr (Or.inl this))
  · have e1 : ¬ (c.layers.map (·.name)).Nodup := fun h => by
      have := (firstDup_eq_none _).2 h; simp_all
    simp only [h1]
    simp [e1]

/-! ## Resolving selectors -/

mutual
/-- Substitute each `layer n` by the selector of the first layer named `n`. -/
def resolve (layers : List Layer) : ConfigSelector → Selector
  | .base s => s
  | .layer n => (lookupLayer layers n).getD (.any [])
  | .any ss => .any (resolveList layers ss)
  | .all ss => .all (resolveList layers ss)
  | .not s => .not (resolve layers s)

def resolveList (layers : List Layer) : List ConfigSelector → List Selector
  | [] => []
  | s :: ss => resolve layers s :: resolveList layers ss
end

mutual
/-- Resolving a selector preserves what it selects. -/
theorem resolve_selects (layers : List Layer) :
    ∀ (cs : ConfigSelector) (t : Target), (resolve layers cs).selects t = cs.selects layers t
  | .base s, t => by simp [resolve, ConfigSelector.selects]
  | .layer n, t => by
    simp only [resolve, ConfigSelector.selects]
    cases lookupLayer layers n <;> simp [Selector.selects, Selector.selectsAny]
  | .any ss, t => by
    simp only [resolve, ConfigSelector.selects, Selector.selects]
    exact resolveList_selectsAny layers ss t
  | .all ss, t => by
    simp only [resolve, ConfigSelector.selects, Selector.selects]
    exact resolveList_selectsAll layers ss t
  | .not s, t => by
    simp only [resolve, ConfigSelector.selects, Selector.selects]
    rw [resolve_selects layers s t]

theorem resolveList_selectsAny (layers : List Layer) :
    ∀ (ss : List ConfigSelector) (t : Target),
      Selector.selectsAny (resolveList layers ss) t = ConfigSelector.selectsAny layers ss t
  | [], t => by simp [resolveList, Selector.selectsAny, ConfigSelector.selectsAny]
  | s :: ss, t => by
    simp only [resolveList, Selector.selectsAny, ConfigSelector.selectsAny]
    rw [resolve_selects layers s t, resolveList_selectsAny layers ss t]

theorem resolveList_selectsAll (layers : List Layer) :
    ∀ (ss : List ConfigSelector) (t : Target),
      Selector.selectsAll (resolveList layers ss) t = ConfigSelector.selectsAll layers ss t
  | [], t => by simp [resolveList, Selector.selectsAll, ConfigSelector.selectsAll]
  | s :: ss, t => by
    simp only [resolveList, Selector.selectsAll, ConfigSelector.selectsAll]
    rw [resolve_selects layers s t, resolveList_selectsAll layers ss t]
end

/-! ## Rules -/

/-- A user rule with its layer references resolved. -/
def lowerRule (layers : List Layer) (r : RuleOf ConfigSelector) : Rule where
  id := r.id
  severity := r.severity
  subject := resolve layers r.subject
  assertion := r.assertion.map (resolve layers)

/-- Selects files of another layer that `name` may not depend on. -/
def disallowed (c : Config) (name : String) : Selector :=
  .any ((c.layers.filter fun m => m.name != name && decide (m.name ∉ c.allowed name)).map
    (·.selector))

/-- The object of a layer rule: a file in a disallowed layer and not in the
layer itself. -/
def layerObject (c : Config) (l : Layer) : Selector :=
  .all [disallowed c l.name, .not l.selector]

/-- The rule of a constrained layer. -/
def layerRule (c : Config) (l : Layer) : Rule where
  id := layerRuleId l.name
  severity := .error
  subject := l.selector
  assertion := .reach .outgoing .forbid (layerObject c l) layerEdges

/-- What the layer named by a public API selects. -/
def apiLayer (c : Config) (api : PublicApi) : Selector :=
  resolve c.layers (.layer api.layer)

/-- The rule of a public API: outside files must not import non-entry files
of the layer. -/
def publicApiRule (c : Config) (api : PublicApi) : Rule where
  id := publicApiRuleId api.layer
  severity := .error
  subject := .not (apiLayer c api)
  assertion := .reach .outgoing .forbid (.all [apiLayer c api, .not api.entry]) layerEdges

/-- The policy of a valid configuration, in `Config.ruleIds` order. -/
def build (c : Config) : Policy :=
  c.rules.map (lowerRule c.layers) ++
    (c.layers.filter fun l => c.constrained l.name).map (layerRule c) ++
    c.publicApis.map (publicApiRule c)

/-- Lowering: the first validation error, or the policy. -/
def lower : LowerFn := fun c =>
  match validate c with
  | some e => .error e
  | none => .ok (build c)

/-! ## Proofs -/

theorem build_ids (c : Config) : (build c).map (·.id) = c.ruleIds := by
  simp [build, Config.ruleIds, lowerRule, layerRule, publicApiRule, Function.comp_def,
    List.map_append, List.map_map]

theorem build_ne_nil_of_ruleIds (c : Config) (h : c.ruleIds ≠ []) : build c ≠ [] := by
  intro hb
  apply h
  rw [← build_ids, hb]; rfl

/-- With distinct layer names, the first layer named like `l` is `l`. -/
theorem lookupLayer_of_nodup {layers : List Layer} (hn : (layers.map (·.name)).Nodup)
    {l : Layer} (hl : l ∈ layers) : lookupLayer layers l.name = some l.selector := by
  induction layers with
  | nil => cases hl
  | cons m ms ih =>
    rw [List.map_cons, List.nodup_cons] at hn
    unfold lookupLayer
    rw [List.find?_cons]
    by_cases h : m.name = l.name
    · have : l = m := by
        rcases List.mem_cons.1 hl with rfl | hl'
        · rfl
        · exact absurd (h ▸ List.mem_map_of_mem hl') hn.1
      subst this; simp
    · have h' : (m.name == l.name) = false := by simpa using h
      rcases List.mem_cons.1 hl with rfl | hl'
      · exact absurd rfl h
      · simp only [h']
        exact ih hn.2 hl'

theorem layerSelects_of_nodup {c : Config} (hn : (c.layers.map (·.name)).Nodup)
    {l : Layer} (hl : l ∈ c.layers) (t : Target) :
    layerSelects c l.name t = l.selector.selects t := by
  simp [layerSelects, ConfigSelector.selects, lookupLayer_of_nodup hn hl]

theorem layerSelects_apiLayer (c : Config) (api : PublicApi) (t : Target) :
    (apiLayer c api).selects t = layerSelects c api.layer t := by
  simp [apiLayer, layerSelects, resolve_selects]

theorem selectsAny_map_iff (ms : List Layer) (t : Target) :
    Selector.selectsAny (ms.map (·.selector)) t = true ↔
      ∃ m ∈ ms, m.selector.selects t = true := by
  induction ms with
  | nil => simp [Selector.selectsAny]
  | cons m ms ih => simp [Selector.selectsAny, ih]

theorem disallowed_selects (c : Config) (name : String) (t : Target) :
    (disallowed c name).selects t = true ↔
      ∃ m ∈ c.layers, m.name ≠ name ∧ m.name ∉ c.allowed name ∧
        m.selector.selects t = true := by
  simp only [disallowed, Selector.selects, selectsAny_map_iff, List.mem_filter,
    Bool.and_eq_true, bne_iff_ne, ne_eq, decide_eq_true_eq]
  constructor
  · rintro ⟨m, ⟨hm, h1, h2⟩, h3⟩; exact ⟨m, hm, h1, h2, h3⟩
  · rintro ⟨m, hm, h1, h2, h3⟩; exact ⟨m, ⟨hm, h1, h2⟩, h3⟩

/-- The layer edge filter admits exactly the dependencies on source files. -/
theorem layerEdges_admits (d : Dependency) :
    layerEdges.admits d = true ↔ ∃ q, d.target = .file q := by
  obtain ⟨t, k, s, loc⟩ := d
  cases t <;> cases k <;> simp [EdgeFilter.admits, layerEdges]

theorem layerEdges_transitive : layerEdges.transitive = false := rfl

theorem layerRule_admissible (c : Config) (hn : (c.layers.map (·.name)).Nodup)
    {l : Layer} (hl : l ∈ c.layers) (custom : CustomRules) (g : Graph) (v : Violation) :
    Admissible custom g (layerRule c l) v ↔ LayerViolation c l.name g v := by
  unfold Admissible LayerViolation Forbidden
  simp only [layerRule, layerObject, layerEdges_transitive, layerSelects_of_nodup hn hl]
  constructor
  · rintro ⟨hid, hsev, ⟨f', hf', hp'⟩, f, hf, hpath, d, hd, hev, hadm, hforb⟩
    obtain ⟨q, hq⟩ := (layerEdges_admits d).1 hadm
    have hsel : l.selector.selects (.file f.path) = true := by
      simp only [Graph.subjects, List.mem_filter] at hf'
      rw [hpath, ← hp']; exact hf'.2
    refine ⟨hid, hsev, f, hf, hpath, hsel, d, hd, q, hq, hev, ?_⟩
    rcases hforb with h | h
    · rw [hq] at h
      simp only [Selector.selects, Selector.selectsAll, Bool.and_eq_true, Bool.and_true,
        Bool.not_eq_true'] at h
      exact ⟨Bool.eq_false_iff.2 (by simpa using h.2), (disallowed_selects c l.name _).1 h.1⟩
    · rw [hq] at h; cases h
  · rintro ⟨hid, hsev, f, hf, hpath, hsel, d, hd, q, hq, hev, hnot, hm⟩
    refine ⟨hid, hsev, ⟨f, ?_, hpath⟩, f, hf, hpath, d, hd, hev,
      (layerEdges_admits d).2 ⟨q, hq⟩, Or.inl ?_⟩
    · simp only [Graph.subjects, List.mem_filter]
      rw [hpath] at hsel ⊢; exact ⟨hf, hsel⟩
    · rw [hq]
      simp only [Selector.selects, Selector.selectsAll, Bool.and_eq_true, Bool.and_true, hnot]
      exact ⟨(disallowed_selects c l.name _).2 hm, rfl⟩

theorem publicApiRule_admissible (c : Config) (api : PublicApi) (custom : CustomRules)
    (g : Graph) (v : Violation) :
    Admissible custom g (publicApiRule c api) v ↔ PublicApiViolation c api g v := by
  unfold Admissible PublicApiViolation Forbidden
  simp only [publicApiRule, layerEdges_transitive]
  constructor
  · rintro ⟨hid, hsev, ⟨f', hf', hp'⟩, f, hf, hpath, d, hd, hev, hadm, hforb⟩
    obtain ⟨q, hq⟩ := (layerEdges_admits d).1 hadm
    have hsel : layerSelects c api.layer (.file f.path) = false := by
      simp only [Graph.subjects, List.mem_filter, Selector.selects, Bool.not_eq_true'] at hf'
      rw [hpath, ← hp', ← layerSelects_apiLayer]; exact hf'.2
    refine ⟨hid, hsev, f, hf, hpath, hsel, d, hd, q, hq, hev, ?_⟩
    rcases hforb with h | h
    · rw [hq] at h
      simp only [Selector.selects, Selector.selectsAll, Bool.and_eq_true, Bool.and_true,
        Bool.not_eq_true'] at h
      exact ⟨by rw [← layerSelects_apiLayer]; exact h.1, h.2⟩
    · rw [hq] at h; cases h
  · rintro ⟨hid, hsev, f, hf, hpath, hsel, d, hd, q, hq, hev, hin, hentry⟩
    refine ⟨hid, hsev, ⟨f, ?_, hpath⟩, f, hf, hpath, d, hd, hev,
      (layerEdges_admits d).2 ⟨q, hq⟩, Or.inl ?_⟩
    · simp only [Graph.subjects, List.mem_filter, Selector.selects]
      rw [hpath] at hsel ⊢
      refine ⟨hf, ?_⟩
      rw [layerSelects_apiLayer, hsel]; rfl
    · rw [hq]
      simp only [Selector.selects, Selector.selectsAll, Bool.and_eq_true, Bool.and_true, hentry]
      exact ⟨by rw [layerSelects_apiLayer]; exact hin, rfl⟩

theorem invalid_of_validate_some {c : Config} {e : ConfigError} (h : validate c = some e) :
    c.Invalid :=
  Classical.byContradiction fun hI => by
    have := (validate_eq_none c).2 hI
    rw [h] at this; cases this

theorem not_invalid_parts {c : Config} (h : ¬ c.Invalid) :
    (c.layers.map (·.name)).Nodup ∧ c.ruleIds.Nodup ∧ c.ruleIds ≠ [] := by
  refine ⟨Classical.byContradiction fun h' => h (Or.inl h'),
    Classical.byContradiction fun h' => h (Or.inr (Or.inr (Or.inl h'))),
    fun h' => h (Or.inr (Or.inr (Or.inr h')))⟩

/-- Facts about a successful lowering: the configuration is valid and the
policy is `build c`. -/
theorem lower_ok {c : Config} {p : Policy} (h : lower c = .ok p) : ¬ c.Invalid ∧ p = build c := by
  unfold lower at h
  rcases hv : validate c with _ | e
  · rw [hv] at h
    exact ⟨(validate_eq_none c).1 hv, (Except.ok.inj h).symm⟩
  · rw [hv] at h; cases h

/-- The lowering function meets the lowering contract. -/
theorem lower_spec : LowerSpec lower where
  rejects c := by
    rcases hv : validate c with _ | e
    · simp only [lower, hv]
      exact ⟨fun ⟨_, h⟩ => (nomatch h), fun hI => absurd hI ((validate_eq_none c).1 hv)⟩
    · simp only [lower, hv]
      exact ⟨fun _ => invalid_of_validate_some hv, fun _ => ⟨e, rfl⟩⟩
  wellFormed c p h := by
    obtain ⟨hI, rfl⟩ := lower_ok h
    obtain ⟨-, hids, hne⟩ := not_invalid_parts hI
    exact ⟨by unfold Policy.WellFormed; rw [build_ids]; exact hids,
      build_ne_nil_of_ruleIds c hne⟩
  preserves c p h cr hcr := by
    obtain ⟨-, rfl⟩ := lower_ok h
    refine ⟨lowerRule c.layers cr, ?_, rfl, rfl, resolve c.layers, ?_, rfl, rfl⟩
    · simp only [build, List.mem_append]
      exact Or.inl (Or.inl (List.mem_map_of_mem hcr))
    · intro cs _ t
      exact resolve_selects c.layers cs t
  layers c p h l hl hc := by
    obtain ⟨hI, rfl⟩ := lower_ok h
    obtain ⟨hn, -, -⟩ := not_invalid_parts hI
    refine ⟨layerRule c l, ?_, rfl, layerRule_admissible c hn hl⟩
    simp only [build, List.mem_append]
    exact Or.inl (Or.inr (List.mem_map_of_mem (List.mem_filter.2 ⟨hl, hc⟩)))
  publicApis c p h api hapi := by
    obtain ⟨-, rfl⟩ := lower_ok h
    refine ⟨publicApiRule c api, ?_, rfl, publicApiRule_admissible c api⟩
    simp only [build, List.mem_append]
    exact Or.inr (List.mem_map_of_mem hapi)
  exhaustive c p h := by
    obtain ⟨-, rfl⟩ := lower_ok h
    rw [build_ids]

/-! ## Examples -/

private def sel (s : String) : Selector := .glob [.segment (s.toList.map .literal), .globstar]

private def three : Config where
  layers := [⟨"ui", sel "ui"⟩, ⟨"app", sel "app"⟩, ⟨"domain", sel "domain"⟩]
  stack := ["ui", "app", "domain"]
  allow := []
  publicApis := [⟨"domain", sel "domain-index"⟩]
  rules := [⟨"no-eval", .error, .layer "app", .maxLines 10⟩]

/-- A valid three-layer stack lowers to one user rule, three layer rules and
one public API rule, in id order. -/
example : (match lower three with
    | .ok p => p.map (·.id)
    | .error _ => []) =
    ["no-eval", "layer/ui", "layer/app", "layer/domain", "public-api/domain"] := by
  decide

/-- A reference to an undefined layer is rejected. -/
example : lower { three with stack := ["ui", "missing"] } =
    .error (.unknownLayer "missing") := by rfl

/-- Duplicate layer names are rejected before anything else. -/
example : lower { three with layers := three.layers ++ [⟨"ui", sel "x"⟩], stack := ["nope"] } =
    .error (.duplicateLayer "ui") := by rfl

/-- A rule id that collides with a layer rule id is rejected. -/
example : lower { three with rules := [⟨"layer/ui", .error, .layer "app", .maxLines 10⟩] } =
    .error (.duplicateRuleId "layer/ui") := by rfl

/-- A configuration without rules is rejected. -/
example : lower ⟨[], [], [], [], []⟩ = .error .emptyPolicy := by rfl

end Archer.Impl

#print axioms Archer.Impl.lower_spec
