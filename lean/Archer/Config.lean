import Archer.Rule

/-!
# Configuration

What a caller writes, before lowering. Selectors can name layers; layer
tables say which layers may depend on which. Lowering turns a configuration
into a policy without layers. Contract: `docs/contracts/README.md`.
-/

namespace Archer

/-- A selector that can also refer to a layer by name (`layer:domain`). -/
inductive ConfigSelector where
  | base (selector : Selector)
  | layer (name : String)
  | any (selectors : List ConfigSelector)
  | all (selectors : List ConfigSelector)
  | not (selector : ConfigSelector)
  deriving Repr

mutual
/-- The layer names a selector refers to. -/
def ConfigSelector.layerNames : ConfigSelector → List String
  | .base _ => []
  | .layer n => [n]
  | .any ss => ConfigSelector.layerNamesAll ss
  | .all ss => ConfigSelector.layerNamesAll ss
  | .not s => s.layerNames

def ConfigSelector.layerNamesAll : List ConfigSelector → List String
  | [] => []
  | s :: ss => s.layerNames ++ ConfigSelector.layerNamesAll ss
end

structure Layer where
  name : String
  selector : Selector
  deriving Repr

def lookupLayer (layers : List Layer) (name : String) : Option Selector :=
  (layers.find? (·.name == name)).map (·.selector)

mutual
/-- Specification of a configuration selector: what it selects when its
layers are defined by `layers`. A reference to an undefined layer selects
nothing; lowering rejects such a reference before this matters. -/
def ConfigSelector.selects (layers : List Layer) : ConfigSelector → Target → Bool
  | .base s, t => s.selects t
  | .layer n, t => match lookupLayer layers n with
      | some s => s.selects t
      | none => false
  | .any ss, t => ConfigSelector.selectsAny layers ss t
  | .all ss, t => ConfigSelector.selectsAll layers ss t
  | .not s, t => !s.selects layers t

def ConfigSelector.selectsAny (layers : List Layer) : List ConfigSelector → Target → Bool
  | [], _ => false
  | s :: ss, t => s.selects layers t || ConfigSelector.selectsAny layers ss t

def ConfigSelector.selectsAll (layers : List Layer) : List ConfigSelector → Target → Bool
  | [], _ => true
  | s :: ss, t => s.selects layers t && ConfigSelector.selectsAll layers ss t
end

structure PublicApi where
  layer : String
  /-- The files of the layer that other layers may import. -/
  entry : Selector
  deriving Repr

structure Config where
  layers : List Layer
  /-- Top to bottom: each layer may depend on the layers listed after it. -/
  stack : List String
  /-- Further layers each layer may depend on. -/
  allow : List (String × List String)
  publicApis : List PublicApi
  rules : List (RuleOf ConfigSelector)
  deriving Repr

/-- A layer is constrained when the stack or the allow table mentions it as
the depending layer. -/
def Config.constrained (c : Config) (name : String) : Bool :=
  decide (name ∈ c.stack) || c.allow.any (·.1 == name)

/-- The layers a constrained layer may depend on, besides itself. -/
def Config.allowed (c : Config) (name : String) : List String :=
  (c.stack.dropWhile (· != name)).drop 1 ++
    (c.allow.filter (·.1 == name)).flatMap (·.2)

/-- The edge filter of layer and public-API rules: direct dependencies on
source files, of every kind. -/
def layerEdges : EdgeFilter where
  kinds := [.static, .type, .require, .dynamic]
  localOnly := true
  transitive := false

inductive ConfigError where
  | duplicateLayer (name : String)
  | unknownLayer (name : String)
  | duplicateRuleId (id : String)
  | emptyPolicy
  deriving DecidableEq, Repr

def layerRuleId (name : String) : String := "layer/" ++ name

def publicApiRuleId (name : String) : String := "public-api/" ++ name

/-- Every layer name the configuration refers to. -/
def Config.referencedLayers (c : Config) : List String :=
  c.stack ++ c.allow.flatMap (fun (n, ns) => n :: ns) ++ c.publicApis.map (·.layer) ++
    c.rules.flatMap fun r => r.subject.layerNames ++ r.assertion.selectors.flatMap (·.layerNames)

/-- The rule IDs the lowered policy has. -/
def Config.ruleIds (c : Config) : List String :=
  c.rules.map (·.id) ++
    (c.layers.filter fun l => c.constrained l.name).map (layerRuleId ·.name) ++
    c.publicApis.map (publicApiRuleId ·.layer)

def Config.Invalid (c : Config) : Prop :=
  ¬ (c.layers.map (·.name)).Nodup ∨
    (∃ n ∈ c.referencedLayers, n ∉ c.layers.map (·.name)) ∨
    ¬ c.ruleIds.Nodup ∨
    c.ruleIds = []

end Archer
