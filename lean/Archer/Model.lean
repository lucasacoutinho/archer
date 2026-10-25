import Archer.Pattern

/-!
# Graph model

The data that the analyzer produces and that every rule reads. Terms follow
Contract: `docs/verification.md`.
-/

namespace Archer

/-- A root-relative path as its segments: `src/domain/order.ts` is
`["src", "domain", "order.ts"]`. The analyzer contract guarantees that
segments are non-empty and contain no `/`, `.`, or `..`. -/
abbrev FilePath := List String

inductive Runtime where
  | node
  | bun
  deriving DecidableEq, Repr

inductive Target where
  | file (path : FilePath)
  /-- An installed package and the subpath imported from it. -/
  | package (name : String) (subpath : List String)
  | builtin (runtime : Runtime) (name : String)
  | unresolved (specifier : String)
  /-- An `import()` expression without a static specifier. -/
  | computed
  deriving DecidableEq, Repr

inductive DependencyKind where
  | static
  | type
  | require
  | dynamic
  deriving DecidableEq, Repr

structure Location where
  line : Nat
  column : Nat
  deriving DecidableEq, Repr

structure Dependency where
  target : Target
  kind : DependencyKind
  specifier : String
  location : Location
  deriving DecidableEq, Repr

inductive DeclarationKind where
  | «class»
  | «interface»
  | «enum»
  | «function»
  | «type»
  | variable
  deriving DecidableEq, Repr

inductive Visibility where
  | «public»
  | «protected»
  | «private»
  deriving DecidableEq, Repr

structure Method where
  name : String
  visibility : Visibility
  isStatic : Bool
  deriving DecidableEq, Repr

structure Declaration where
  name : String
  kind : DeclarationKind
  exported : Bool
  abstract : Bool
  extended : List String
  implemented : List String
  decorators : List String
  methods : List Method
  readonlyProperties : Bool
  location : Location
  deriving DecidableEq, Repr

inductive UseKind where
  | call
  | looseEquality
  deriving DecidableEq, Repr

/-- The module and export name that an imported call resolves to. -/
structure ImportedName where
  source : String
  name : String
  deriving DecidableEq, Repr

/-- What the called name resolves to. -/
inductive Binding where
  /-- No declaration in the program: a global such as `eval`. -/
  | «global»
  /-- A declaration in the same file or a non-import binding. -/
  | «local»
  | imported (name : ImportedName)
  deriving DecidableEq, Repr

structure Use where
  kind : UseKind
  name : String
  binding : Binding
  location : Location
  deriving DecidableEq, Repr

structure SourceFile where
  path : FilePath
  dependencies : List Dependency
  declarations : List Declaration
  exports : List String
  uses : List Use
  lines : Nat
  deriving DecidableEq, Repr

structure Graph where
  files : List SourceFile
  deriving DecidableEq, Repr

/-- Premises from the analyzer contract that the rule semantics rely on:
each source file appears once. -/
def Graph.WellFormed (g : Graph) : Prop :=
  (g.files.map (·.path)).Nodup

def Graph.paths (g : Graph) : List FilePath :=
  g.files.map (·.path)

def Graph.find? (g : Graph) (p : FilePath) : Option SourceFile :=
  g.files.find? (·.path == p)

/-! ## Selectors -/

inductive SegmentToken where
  | literal (char : Char)
  /-- `?` -/
  | one
  /-- `*` -/
  | star
  deriving DecidableEq, Repr

inductive PathToken where
  | segment (tokens : List SegmentToken)
  /-- `**` -/
  | globstar
  deriving DecidableEq, Repr

def SegmentToken.denote : SegmentToken → Pattern.Token Char
  | .literal c => .sat (· == c)
  | .one => .sat fun _ => true
  | .star => .many

def segmentAccepts (tokens : List SegmentToken) (segment : String) : Bool :=
  Pattern.accepts (tokens.map SegmentToken.denote) segment.toList

def PathToken.denote : PathToken → Pattern.Token String
  | .segment tokens => .sat (segmentAccepts tokens)
  | .globstar => .many

def pathAccepts (tokens : List PathToken) (path : FilePath) : Bool :=
  Pattern.accepts (tokens.map PathToken.denote) path

inductive Selector where
  | glob (tokens : List PathToken)
  /-- `npm:<name>` with `some name`, `npm:*` with `none`. Any subpath. -/
  | package (name : Option String)
  /-- `node:fs`, `node:*`, `bun:*`. -/
  | builtin (runtime : Runtime) (name : Option String)
  | unresolved
  | computed
  | any (selectors : List Selector)
  | all (selectors : List Selector)
  | not (selector : Selector)
  deriving Repr

mutual
/-- Selector semantics. `any []` selects nothing and `all []` selects
everything. -/
def Selector.selects : Selector → Target → Bool
  | .glob tokens, .file p => pathAccepts tokens p
  | .glob _, _ => false
  | .package none, .package _ _ => true
  | .package (some n), .package m _ => n == m
  | .package _, _ => false
  | .builtin r none, .builtin r' _ => r == r'
  | .builtin r (some n), .builtin r' m => r == r' && n == m
  | .builtin _ _, _ => false
  | .unresolved, .unresolved _ => true
  | .unresolved, _ => false
  | .computed, .computed => true
  | .computed, _ => false
  | .any ss, t => Selector.selectsAny ss t
  | .all ss, t => Selector.selectsAll ss t
  | .not s, t => !s.selects t

def Selector.selectsAny : List Selector → Target → Bool
  | [], _ => false
  | s :: ss, t => s.selects t || Selector.selectsAny ss t

def Selector.selectsAll : List Selector → Target → Bool
  | [], _ => true
  | s :: ss, t => s.selects t && Selector.selectsAll ss t
end

/-- Rules range over source files: the subjects of a selector. -/
def Graph.subjects (g : Graph) (s : Selector) : List SourceFile :=
  g.files.filter fun f => s.selects (.file f.path)

/-! ## Edges and walks -/

structure EdgeFilter where
  kinds : List DependencyKind
  localOnly : Bool
  transitive : Bool
  deriving DecidableEq, Repr

def EdgeFilter.admits (ef : EdgeFilter) (d : Dependency) : Bool :=
  decide (d.kind ∈ ef.kinds) &&
    (!ef.localOnly || match d.target with
      | .file _ => true
      | _ => false)

/-- One import site: the importing file and the dependency it wrote. -/
structure Edge where
  source : FilePath
  dependency : Dependency
  deriving DecidableEq, Repr

/-- `Walk g ef s w t`: following the admitted edges `w` from source file `s`
ends at target `t`. Every intermediate node is a source file of `g`. -/
inductive Walk (g : Graph) (ef : EdgeFilter) : FilePath → List Edge → Target → Prop where
  | last {f d} : f ∈ g.files → d ∈ f.dependencies → ef.admits d = true →
      Walk g ef f.path [⟨f.path, d⟩] d.target
  | step {f d q w t} : f ∈ g.files → d ∈ f.dependencies → ef.admits d = true →
      d.target = .file q → Walk g ef q w t →
      Walk g ef f.path (⟨f.path, d⟩ :: w) t

/-- The walks a rule considers: all walks when the filter is transitive,
single edges otherwise. -/
def Considered (g : Graph) (ef : EdgeFilter) (s : FilePath) (w : List Edge) (t : Target) : Prop :=
  Walk g ef s w t ∧ (ef.transitive = true ∨ w.length = 1)

end Archer
