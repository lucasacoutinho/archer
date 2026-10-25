import Archer.Model

/-!
# Rules, violations, and evidence

A rule is data. `docs/contracts/README.md` states what each assertion
means; `Archer.Spec` states it as propositions.
-/

namespace Archer

inductive Severity where
  | error
  | warning
  | info
  deriving DecidableEq, Repr

inductive Direction where
  /-- The subject's dependencies. -/
  | outgoing
  /-- The source files that depend on the subject. -/
  | incoming
  deriving DecidableEq, Repr

/-- `forbid`: no considered target may match. `require`: at least one must. -/
inductive Relation where
  | forbid
  | require
  deriving DecidableEq, Repr

inductive Quantifier where
  | every
  | none
  deriving DecidableEq, Repr

inductive DeclarationPredicate where
  | kind (kinds : List DeclarationKind)
  | abstract
  | exported
  | readonlyProperties
  | extends (name : String)
  | implements (name : String)
  | decorator (name : String)
  /-- Declares every named method, with the visibility when one is given. -/
  | hasMethods (names : List String) (visibility : Option Visibility)
  | onlyPublicMethods
  | all (predicates : List DeclarationPredicate)
  deriving Repr

mutual
def DeclarationPredicate.holds : DeclarationPredicate → Declaration → Bool
  | .kind ks, d => decide (d.kind ∈ ks)
  | .abstract, d => d.abstract
  | .exported, d => d.exported
  | .readonlyProperties, d => d.readonlyProperties
  | .extends n, d => decide (n ∈ d.extended)
  | .implements n, d => decide (n ∈ d.implemented)
  | .decorator n, d => decide (n ∈ d.decorators)
  | .hasMethods names v, d => names.all fun n => d.methods.any fun m =>
      m.name == n && match v with
        | none => true
        | some v => m.visibility == v
  | .onlyPublicMethods, d => d.methods.all (·.visibility == .public)
  | .all ps, d => DeclarationPredicate.holdsAll ps d

def DeclarationPredicate.holdsAll : List DeclarationPredicate → Declaration → Bool
  | [], _ => true
  | p :: ps, d => p.holds d && DeclarationPredicate.holdsAll ps d
end

inductive UseSpec where
  | looseEquality
  /-- Calls of these names that resolve to no declaration. -/
  | globals (names : List String)
  /-- Calls that resolve to these exports of `source`. -/
  | imported (source : String) (names : List String)
  deriving DecidableEq, Repr

def UseSpec.matches : UseSpec → Use → Bool
  | .looseEquality, u => u.kind == .looseEquality
  | .globals names, u => u.kind == .call && u.binding == .global && decide (u.name ∈ names)
  | .imported source names, u => u.kind == .call && match u.binding with
      | .imported i => i.source == source && decide (i.name ∈ names)
      | _ => false

inductive Affix where
  | «prefix»
  | «suffix»
  deriving DecidableEq, Repr

def Affix.holds : Affix → String → String → Bool
  | .prefix, value, name => value.toList.isPrefixOf name.toList
  | .suffix, value, name => value.toList.reverse.isPrefixOf name.toList.reverse

/-- `σ` is the selector type: `Selector` in a checked policy, and
`ConfigSelector`, which can name layers, in a configuration. -/
inductive Assertion (σ : Type) where
  | reach (direction : Direction) (relation : Relation) (object : σ) (edges : EdgeFilter)
  /-- With `folderDepth`, files collapse to their folder prefix of that many
  segments before cycles are detected. -/
  | acyclic (edges : EdgeFilter) (folderDepth : Option Nat)
  | resolvable (allowComputed : Bool)
  | declares (quantifier : Quantifier) (predicate : DeclarationPredicate)
  | exportsOnly (names : List String)
  | uses (relation : Relation) (use : UseSpec)
  | named (relation : Relation) (affix : Affix) (value : String)
  | maxLines (max : Nat)
  /-- A closure from the configuration, named here so the rule stays data. -/
  | custom (name : String)
  deriving Repr

structure RuleOf (σ : Type) where
  id : String
  severity : Severity
  subject : σ
  assertion : Assertion σ
  deriving Repr

abbrev Rule := RuleOf Selector

abbrev Policy := List Rule

/-- Policy premise established by configuration decoding: rule IDs are unique. -/
def Policy.WellFormed (p : Policy) : Prop :=
  (p.map (·.id)).Nodup

inductive Evidence where
  /-- For a transitive rule: a forbidden target and the shortest considered
  walk to it. For an incoming rule, the target is the dependent source file
  and the walk runs from it to the subject. -/
  | walk (target : Target) (edges : List Edge)
  /-- A `require` assertion found nothing. -/
  | missing
  /-- The shortest cycle through the subject. -/
  | cycle (edges : List Edge)
  /-- One import site: a direct dependency rule's violation, or an
  unresolvable dependency. -/
  | dependency (edge : Edge)
  | declaration (name : String) (location : Location)
  | «export» (name : String)
  | use (use : Use)
  | name (basename : String)
  | lines (count : Nat)
  | custom (message : String)
  deriving DecidableEq, Repr

/-- What identifies a violation within one rule and subject. A walk or
cycle is identified without its edges, so a rule reports each forbidden
target once and each cycle subject once. -/
inductive EvidenceKey where
  | target (target : Target)
  | missing
  | cycle
  | dependency (edge : Edge)
  | declaration (name : String) (location : Location)
  | «export» (name : String)
  | use (use : Use)
  | name
  | lines
  | custom (message : String)
  deriving DecidableEq, Repr

def Evidence.key : Evidence → EvidenceKey
  | .walk t _ => .target t
  | .missing => .missing
  | .cycle _ => .cycle
  | .dependency e => .dependency e
  | .declaration n l => .declaration n l
  | .export n => .export n
  | .use u => .use u
  | .name _ => .name
  | .lines _ => .lines
  | .custom m => .custom m

structure Violation where
  ruleId : String
  severity : Severity
  /-- A source file, or a folder for a collapsed cycle rule. -/
  subject : FilePath
  evidence : Evidence
  deriving DecidableEq, Repr

def Violation.key (v : Violation) : String × FilePath × EvidenceKey :=
  (v.ruleId, v.subject, v.evidence.key)

/-- The closures behind `custom` assertions: rule name, graph, subject, to
messages. They are a trust boundary of the model. -/
abbrev CustomRules := String → Graph → FilePath → List String

/-! ## Graph transformations used by the semantics -/

def basename (p : FilePath) : String :=
  p.getLast?.getD ""

/-- The subgraph a cycle rule reads: the given files, and only the
dependencies between them. -/
def Graph.restrict (g : Graph) (keep : FilePath → Bool) : Graph where
  files := (g.files.filter fun f => keep f.path).map fun f =>
    { f with dependencies := f.dependencies.filter fun d => match d.target with
        | .file q => keep q
        | _ => false }

/-- The folder a file collapses to: the first `depth` segments of its
directory. -/
def folderOf (depth : Nat) (p : FilePath) : FilePath :=
  p.dropLast.take depth

/-- The folder graph: one node per folder, with an edge for each file-level
dependency that crosses folders. Facts other than dependencies are empty. -/
def Graph.collapse (g : Graph) (depth : Nat) : Graph where
  files := ((g.files.map fun f => folderOf depth f.path).eraseDups).map fun folder =>
    { path := folder
      dependencies := (g.files.filter fun f => folderOf depth f.path == folder).flatMap fun f =>
        f.dependencies.filterMap fun d => match d.target with
          | .file q => if folderOf depth q == folder then none
              else some { d with target := .file (folderOf depth q) }
          | _ => none
      declarations := []
      exports := []
      uses := []
      lines := 0 }

end Archer

namespace Archer

/-- The selectors an assertion contains besides the rule's subject. -/
def Assertion.selectors {σ : Type} : Assertion σ → List σ
  | .reach _ _ object _ => [object]
  | _ => []

def Assertion.map {σ τ : Type} (f : σ → τ) : Assertion σ → Assertion τ
  | .reach d r object ef => .reach d r (f object) ef
  | .acyclic ef depth => .acyclic ef depth
  | .resolvable allowComputed => .resolvable allowComputed
  | .declares q p => .declares q p
  | .exportsOnly names => .exportsOnly names
  | .uses r u => .uses r u
  | .named r a v => .named r a v
  | .maxLines m => .maxLines m
  | .custom n => .custom n

end Archer

namespace Archer

/-- E1: the IDs of the rules whose subject selects no source file, in
policy order. Reports list them as information so a mistyped glob is
visible; they are not violations, so baselines never see them. -/
def emptySubjects (p : Policy) (g : Graph) : List String :=
  (p.filter fun r => (g.subjects r.subject).isEmpty).map (·.id)

end Archer

namespace Archer

mutual
/-- Whether a selector names source files by a path glob outside any `not`.
A mistyped glob under `not` makes the selector match more, never nothing,
so only positive occurrences can reveal a typo. -/
def Selector.mentionsGlob : Selector → Bool
  | .glob _ => true
  | .any ss => Selector.mentionsGlobAny ss
  | .all ss => Selector.mentionsGlobAny ss
  | .not _ => false
  | _ => false

def Selector.mentionsGlobAny : List Selector → Bool
  | [] => false
  | s :: ss => s.mentionsGlob || Selector.mentionsGlobAny ss
end

/-- E2: the IDs of the dependency rules whose object refers to source files
by a glob but selects none of them, in policy order. Forbidding an absent
package is normal; naming files that do not exist is almost always a
mistyped path. Reports list these as information, apart from violations. -/
def emptyObjects (p : Policy) (g : Graph) : List String :=
  (p.filter fun r => match r.assertion with
    | .reach _ _ object _ => object.mentionsGlob && g.files.all fun f => !object.selects (.file f.path)
    | _ => false).map (·.id)

end Archer
