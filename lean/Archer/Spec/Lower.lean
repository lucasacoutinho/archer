import Archer.Config
import Archer.Spec.Check

/-!
# Specification of lowering

Lowering resolves layer references, turns the layer tables into
dependency rules, and rejects invalid configurations. Contract prose:
`docs/verification.md`.
-/

namespace Archer.Spec

open Archer

abbrev LowerFn := Config → Except ConfigError Policy

def layerSelects (c : Config) (name : String) (t : Target) : Bool :=
  (ConfigSelector.layer name).selects c.layers t

/-- Layer semantics, stated without rules: a file of layer `name` depends
directly on file `q`, and `q` belongs to another layer that `name` may not
depend on. Files outside every layer are unconstrained. -/
def LayerViolation (c : Config) (name : String) (g : Graph) (v : Violation) : Prop :=
  v.ruleId = layerRuleId name ∧ v.severity = .error ∧
    ∃ f ∈ g.files, f.path = v.subject ∧ layerSelects c name (.file f.path) = true ∧
      ∃ d ∈ f.dependencies, ∃ q, d.target = .file q ∧
        v.evidence = .dependency ⟨f.path, d⟩ ∧
        layerSelects c name (.file q) = false ∧
        ∃ m ∈ c.layers, m.name ≠ name ∧ m.name ∉ c.allowed name ∧
          m.selector.selects (.file q) = true

/-- Public API semantics: a file outside the layer depends directly on a
file of the layer that is not an entry. -/
def PublicApiViolation (c : Config) (api : PublicApi) (g : Graph) (v : Violation) : Prop :=
  v.ruleId = publicApiRuleId api.layer ∧ v.severity = .error ∧
    ∃ f ∈ g.files, f.path = v.subject ∧ layerSelects c api.layer (.file f.path) = false ∧
      ∃ d ∈ f.dependencies, ∃ q, d.target = .file q ∧
        v.evidence = .dependency ⟨f.path, d⟩ ∧
        layerSelects c api.layer (.file q) = true ∧ api.entry.selects (.file q) = false

structure LowerSpec (lower : LowerFn) : Prop where
  /-- L1: lowering fails exactly on invalid configurations. -/
  rejects : ∀ c, (∃ e, lower c = .error e) ↔ c.Invalid
  /-- L2: the policy has unique rule IDs and at least one rule. -/
  wellFormed : ∀ c p, lower c = .ok p → p.WellFormed ∧ p ≠ []
  /-- L3: each configured rule keeps its ID, severity, and assertion, and
  each selector keeps its meaning with layer references resolved. -/
  preserves : ∀ c p, lower c = .ok p → ∀ cr ∈ c.rules, ∃ r ∈ p,
    r.id = cr.id ∧ r.severity = cr.severity ∧
    ∃ resolve : ConfigSelector → Selector,
      (∀ cs ∈ cr.subject :: cr.assertion.selectors, ∀ t, (resolve cs).selects t = cs.selects c.layers t) ∧
      r.subject = resolve cr.subject ∧ r.assertion = cr.assertion.map resolve
  /-- L4: each constrained layer has a rule whose violations on every graph
  are exactly the layer violations. -/
  layers : ∀ c p, lower c = .ok p → ∀ l ∈ c.layers, c.constrained l.name = true →
    ∃ r ∈ p, r.id = layerRuleId l.name ∧
      ∀ custom g v, Admissible custom g r v ↔ LayerViolation c l.name g v
  /-- L5: each public API has a rule whose violations on every graph are
  exactly the public API violations. -/
  publicApis : ∀ c p, lower c = .ok p → ∀ api ∈ c.publicApis,
    ∃ r ∈ p, r.id = publicApiRuleId api.layer ∧
      ∀ custom g v, Admissible custom g r v ↔ PublicApiViolation c api g v
  /-- L6: the policy contains no other rules. -/
  exhaustive : ∀ c p, lower c = .ok p → (p.map (·.id)).Perm c.ruleIds

end Archer.Spec
