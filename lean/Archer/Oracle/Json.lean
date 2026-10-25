import Lean.Data.Json
import Archer.Config
import Archer.Fingerprint
import Archer.Spec.Baseline

/-!
# JSON codecs of the oracle protocol

Shapes follow the table in `docs/verification.md`. Recursive decoders take
a fuel bound on nesting depth.
-/

namespace Archer.Oracle

open Lean (Json)

abbrev Dec (α : Type) := Json → Except String α
abbrev Enc (α : Type) := α → Json

def fuel : Nat := 512

def tagged (t : String) (fs : List (String × Json) := []) : Json :=
  Json.mkObj (("_tag", Json.str t) :: fs)

def optField {α : Type} (k : String) (e : Enc α) : Option α → List (String × Json)
  | none => []
  | some a => [(k, e a)]

def encList {α : Type} (e : Enc α) (l : List α) : Json := Json.arr (l.map e).toArray

def encStr : Enc String := Json.str
def encBool : Enc Bool := Json.bool
def encNat : Enc Nat := fun n => Json.num n
def encChar : Enc Char := fun c => Json.str (String.singleton c)

def encPair {α β : Type} (ea : Enc α) (eb : Enc β) : Enc (α × β) := fun (a, b) =>
  Json.arr #[ea a, eb b]

def getField {α : Type} (j : Json) (k : String) (d : Dec α) : Except String α :=
  match j.getObjVal? k with
  | .ok v => (d v).mapError fun e => k ++ ": " ++ e
  | .error _ => .error s!"missing field {k}"

def getOpt {α : Type} (j : Json) (k : String) (d : Dec α) : Except String (Option α) :=
  match j.getObjVal? k with
  | .ok .null => pure none
  | .ok v => (some <$> d v).mapError fun e => k ++ ": " ++ e
  | .error _ => pure none

def getTag (j : Json) : Except String String := getField j "_tag" Json.getStr?

def badTag {α : Type} (ty t : String) : Except String α := throw s!"unknown {ty} tag {t}"

def decStr : Dec String := Json.getStr?
def decBool : Dec Bool := Json.getBool?
def decNat : Dec Nat := Json.getNat?

def decChar : Dec Char := fun j => do
  match (← j.getStr?).toList with
  | [c] => pure c
  | _ => throw "expected a one-code-point string"

def decList {α : Type} (d : Dec α) : Dec (List α) := fun j => do
  (← j.getArr?).toList.mapM d

def decPair {α β : Type} (da : Dec α) (db : Dec β) : Dec (α × β) := fun j => do
  match (← j.getArr?).toList with
  | [a, b] => pure (← da a, ← db b)
  | _ => throw "expected a two-element array"

def decEnum {α : Type} (ty : String) (tbl : List (String × α)) : Dec α := fun j => do
  let s ← j.getStr?
  match tbl.lookup s with
  | some a => pure a
  | none => throw s!"unknown {ty} {s}"

/-! ## Model -/

def encRuntime : Enc Runtime
  | .node => "node"
  | .bun => "bun"

def decRuntime : Dec Runtime := decEnum "runtime" [("node", .node), ("bun", .bun)]

def encDependencyKind : Enc DependencyKind
  | .static => "static"
  | .type => "type"
  | .require => "require"
  | .dynamic => "dynamic"

def decDependencyKind : Dec DependencyKind :=
  decEnum "dependency kind"
    [("static", .static), ("type", .type), ("require", .require), ("dynamic", .dynamic)]

def encTarget : Enc Target
  | .file p => tagged "File" [("path", encList encStr p)]
  | .package n s => tagged "Package" [("name", encStr n), ("subpath", encList encStr s)]
  | .builtin r n => tagged "Builtin" [("runtime", encRuntime r), ("name", encStr n)]
  | .unresolved s => tagged "Unresolved" [("specifier", encStr s)]
  | .computed => tagged "Computed"

def decTarget : Dec Target := fun j => do
  match ← getTag j with
  | "File" => .file <$> getField j "path" (decList decStr)
  | "Package" => pure (.package (← getField j "name" decStr) (← getField j "subpath" (decList decStr)))
  | "Builtin" => pure (.builtin (← getField j "runtime" decRuntime) (← getField j "name" decStr))
  | "Unresolved" => .unresolved <$> getField j "specifier" decStr
  | "Computed" => pure .computed
  | t => badTag "target" t

def encLocation : Enc Location := fun l =>
  Json.mkObj [("line", encNat l.line), ("column", encNat l.column)]

def decLocation : Dec Location := fun j => do
  pure ⟨← getField j "line" decNat, ← getField j "column" decNat⟩

def encDependency : Enc Dependency := fun d =>
  Json.mkObj [("target", encTarget d.target), ("kind", encDependencyKind d.kind),
    ("specifier", encStr d.specifier), ("location", encLocation d.location)]

def decDependency : Dec Dependency := fun j => do
  pure ⟨← getField j "target" decTarget, ← getField j "kind" decDependencyKind,
    ← getField j "specifier" decStr, ← getField j "location" decLocation⟩

def encDeclarationKind : Enc DeclarationKind
  | .class => "class"
  | .interface => "interface"
  | .enum => "enum"
  | .function => "function"
  | .type => "type"
  | .variable => "variable"

def decDeclarationKind : Dec DeclarationKind :=
  decEnum "declaration kind"
    [("class", .class), ("interface", .interface), ("enum", .enum),
     ("function", .function), ("type", .type), ("variable", .variable)]

def encVisibility : Enc Visibility
  | .public => "public"
  | .protected => "protected"
  | .private => "private"

def decVisibility : Dec Visibility :=
  decEnum "visibility" [("public", .public), ("protected", .protected), ("private", .private)]

def encMethod : Enc Method := fun m =>
  Json.mkObj [("name", encStr m.name), ("visibility", encVisibility m.visibility),
    ("isStatic", encBool m.isStatic)]

def decMethod : Dec Method := fun j => do
  pure ⟨← getField j "name" decStr, ← getField j "visibility" decVisibility,
    ← getField j "isStatic" decBool⟩

def encDeclaration : Enc Declaration := fun d =>
  Json.mkObj [("name", encStr d.name), ("kind", encDeclarationKind d.kind),
    ("exported", encBool d.exported), ("abstract", encBool d.abstract),
    ("extended", encList encStr d.extended), ("implemented", encList encStr d.implemented),
    ("decorators", encList encStr d.decorators), ("methods", encList encMethod d.methods),
    ("readonlyProperties", encBool d.readonlyProperties), ("location", encLocation d.location)]

def decDeclaration : Dec Declaration := fun j => do
  pure ⟨← getField j "name" decStr, ← getField j "kind" decDeclarationKind,
    ← getField j "exported" decBool, ← getField j "abstract" decBool,
    ← getField j "extended" (decList decStr), ← getField j "implemented" (decList decStr),
    ← getField j "decorators" (decList decStr), ← getField j "methods" (decList decMethod),
    ← getField j "readonlyProperties" decBool, ← getField j "location" decLocation⟩

def encUseKind : Enc UseKind
  | .call => "call"
  | .looseEquality => "looseEquality"

def decUseKind : Dec UseKind :=
  decEnum "use kind" [("call", .call), ("looseEquality", .looseEquality)]

def encImportedName : Enc ImportedName := fun i =>
  Json.mkObj [("source", encStr i.source), ("name", encStr i.name)]

def decImportedName : Dec ImportedName := fun j => do
  pure ⟨← getField j "source" decStr, ← getField j "name" decStr⟩

def encBinding : Enc Binding
  | .global => tagged "Global"
  | .local => tagged "Local"
  | .imported n => tagged "Imported" [("name", encImportedName n)]

def decBinding : Dec Binding := fun j => do
  match ← getTag j with
  | "Global" => pure .global
  | "Local" => pure .local
  | "Imported" => .imported <$> getField j "name" decImportedName
  | t => badTag "binding" t

def encUse : Enc Use := fun u =>
  Json.mkObj [("kind", encUseKind u.kind), ("name", encStr u.name),
    ("binding", encBinding u.binding), ("location", encLocation u.location)]

def decUse : Dec Use := fun j => do
  pure ⟨← getField j "kind" decUseKind, ← getField j "name" decStr,
    ← getField j "binding" decBinding, ← getField j "location" decLocation⟩

def encSourceFile : Enc SourceFile := fun f =>
  Json.mkObj [("path", encList encStr f.path),
    ("dependencies", encList encDependency f.dependencies),
    ("declarations", encList encDeclaration f.declarations),
    ("exports", encList encStr f.exports), ("uses", encList encUse f.uses),
    ("lines", encNat f.lines)]

def decSourceFile : Dec SourceFile := fun j => do
  pure ⟨← getField j "path" (decList decStr),
    ← getField j "dependencies" (decList decDependency),
    ← getField j "declarations" (decList decDeclaration),
    ← getField j "exports" (decList decStr), ← getField j "uses" (decList decUse),
    ← getField j "lines" decNat⟩

def encGraph : Enc Graph := fun g => Json.mkObj [("files", encList encSourceFile g.files)]

def decGraph : Dec Graph := fun j => do
  pure ⟨← getField j "files" (decList decSourceFile)⟩

/-! ## Selectors -/

def encSegmentToken : Enc SegmentToken
  | .literal c => tagged "Literal" [("char", encChar c)]
  | .one => tagged "One"
  | .star => tagged "Star"

def decSegmentToken : Dec SegmentToken := fun j => do
  match ← getTag j with
  | "Literal" => .literal <$> getField j "char" decChar
  | "One" => pure .one
  | "Star" => pure .star
  | t => badTag "segment token" t

def encPathToken : Enc PathToken
  | .segment ts => tagged "Segment" [("tokens", encList encSegmentToken ts)]
  | .globstar => tagged "Globstar"

def decPathToken : Dec PathToken := fun j => do
  match ← getTag j with
  | "Segment" => .segment <$> getField j "tokens" (decList decSegmentToken)
  | "Globstar" => pure .globstar
  | t => badTag "path token" t

mutual
def encSelector : Selector → Json
  | .glob ts => tagged "Glob" [("tokens", encList encPathToken ts)]
  | .package n => tagged "Package" (optField "name" encStr n)
  | .builtin r n => tagged "Builtin" (("runtime", encRuntime r) :: optField "name" encStr n)
  | .unresolved => tagged "Unresolved"
  | .computed => tagged "Computed"
  | .any ss => tagged "Any" [("selectors", Json.arr (encSelectors ss).toArray)]
  | .all ss => tagged "All" [("selectors", Json.arr (encSelectors ss).toArray)]
  | .not s => tagged "Not" [("selector", encSelector s)]

def encSelectors : List Selector → List Json
  | [] => []
  | s :: ss => encSelector s :: encSelectors ss
end

def decSelector : Nat → Dec Selector
  | 0, _ => throw "selector nested too deeply"
  | n + 1, j => do
    match ← getTag j with
    | "Glob" => .glob <$> getField j "tokens" (decList decPathToken)
    | "Package" => .package <$> getOpt j "name" decStr
    | "Builtin" => pure (.builtin (← getField j "runtime" decRuntime) (← getOpt j "name" decStr))
    | "Unresolved" => pure .unresolved
    | "Computed" => pure .computed
    | "Any" => .any <$> getField j "selectors" (decList (decSelector n))
    | "All" => .all <$> getField j "selectors" (decList (decSelector n))
    | "Not" => .not <$> getField j "selector" (decSelector n)
    | t => badTag "selector" t

def encEdgeFilter : Enc EdgeFilter := fun e =>
  Json.mkObj [("kinds", encList encDependencyKind e.kinds), ("localOnly", encBool e.localOnly),
    ("transitive", encBool e.transitive)]

def decEdgeFilter : Dec EdgeFilter := fun j => do
  pure ⟨← getField j "kinds" (decList decDependencyKind), ← getField j "localOnly" decBool,
    ← getField j "transitive" decBool⟩

def encEdge : Enc Edge := fun e =>
  Json.mkObj [("source", encList encStr e.source), ("dependency", encDependency e.dependency)]

def decEdge : Dec Edge := fun j => do
  pure ⟨← getField j "source" (decList decStr), ← getField j "dependency" decDependency⟩

/-! ## Rules -/

def encSeverity : Enc Severity
  | .error => "error"
  | .warning => "warning"
  | .info => "info"

def decSeverity : Dec Severity :=
  decEnum "severity" [("error", .error), ("warning", .warning), ("info", .info)]

def encDirection : Enc Direction
  | .outgoing => "outgoing"
  | .incoming => "incoming"

def decDirection : Dec Direction :=
  decEnum "direction" [("outgoing", .outgoing), ("incoming", .incoming)]

def encRelation : Enc Relation
  | .forbid => "forbid"
  | .require => "require"

def decRelation : Dec Relation := decEnum "relation" [("forbid", .forbid), ("require", .require)]

def encQuantifier : Enc Quantifier
  | .every => "every"
  | .none => "none"

def decQuantifier : Dec Quantifier :=
  decEnum "quantifier" [("every", .every), ("none", .none)]

def encAffix : Enc Affix
  | .prefix => "prefix"
  | .suffix => "suffix"

def decAffix : Dec Affix := decEnum "affix" [("prefix", .prefix), ("suffix", .suffix)]

mutual
def encPredicate : DeclarationPredicate → Json
  | .kind ks => tagged "Kind" [("kinds", encList encDeclarationKind ks)]
  | .abstract => tagged "Abstract"
  | .exported => tagged "Exported"
  | .readonlyProperties => tagged "ReadonlyProperties"
  | .extends n => tagged "Extends" [("name", encStr n)]
  | .implements n => tagged "Implements" [("name", encStr n)]
  | .decorator n => tagged "Decorator" [("name", encStr n)]
  | .hasMethods ns v =>
      tagged "HasMethods" (("names", encList encStr ns) :: optField "visibility" encVisibility v)
  | .onlyPublicMethods => tagged "OnlyPublicMethods"
  | .all ps => tagged "All" [("predicates", Json.arr (encPredicates ps).toArray)]

def encPredicates : List DeclarationPredicate → List Json
  | [] => []
  | p :: ps => encPredicate p :: encPredicates ps
end

def decPredicate : Nat → Dec DeclarationPredicate
  | 0, _ => throw "predicate nested too deeply"
  | n + 1, j => do
    match ← getTag j with
    | "Kind" => .kind <$> getField j "kinds" (decList decDeclarationKind)
    | "Abstract" => pure .abstract
    | "Exported" => pure .exported
    | "ReadonlyProperties" => pure .readonlyProperties
    | "Extends" => .extends <$> getField j "name" decStr
    | "Implements" => .implements <$> getField j "name" decStr
    | "Decorator" => .decorator <$> getField j "name" decStr
    | "HasMethods" =>
        pure (.hasMethods (← getField j "names" (decList decStr))
          (← getOpt j "visibility" decVisibility))
    | "OnlyPublicMethods" => pure .onlyPublicMethods
    | "All" => .all <$> getField j "predicates" (decList (decPredicate n))
    | t => badTag "declaration predicate" t

def encUseSpec : Enc UseSpec
  | .looseEquality => tagged "LooseEquality"
  | .globals ns => tagged "Globals" [("names", encList encStr ns)]
  | .imported s ns => tagged "Imported" [("source", encStr s), ("names", encList encStr ns)]

def decUseSpec : Dec UseSpec := fun j => do
  match ← getTag j with
  | "LooseEquality" => pure .looseEquality
  | "Globals" => .globals <$> getField j "names" (decList decStr)
  | "Imported" =>
      pure (.imported (← getField j "source" decStr) (← getField j "names" (decList decStr)))
  | t => badTag "use spec" t

def encAssertion {σ : Type} (es : Enc σ) : Enc (Assertion σ)
  | .reach d r o ef =>
      tagged "Reach" [("direction", encDirection d), ("relation", encRelation r),
        ("object", es o), ("edges", encEdgeFilter ef)]
  | .acyclic ef depth =>
      tagged "Acyclic" (("edges", encEdgeFilter ef) :: optField "folderDepth" encNat depth)
  | .resolvable b => tagged "Resolvable" [("allowComputed", encBool b)]
  | .declares q p => tagged "Declares" [("quantifier", encQuantifier q), ("predicate", encPredicate p)]
  | .exportsOnly ns => tagged "ExportsOnly" [("names", encList encStr ns)]
  | .uses r u => tagged "Uses" [("relation", encRelation r), ("use", encUseSpec u)]
  | .named r a v =>
      tagged "Named" [("relation", encRelation r), ("affix", encAffix a), ("value", encStr v)]
  | .maxLines m => tagged "MaxLines" [("max", encNat m)]
  | .custom n => tagged "Custom" [("name", encStr n)]

def decAssertion {σ : Type} (ds : Dec σ) : Dec (Assertion σ) := fun j => do
  match ← getTag j with
  | "Reach" =>
      pure (.reach (← getField j "direction" decDirection) (← getField j "relation" decRelation)
        (← getField j "object" ds) (← getField j "edges" decEdgeFilter))
  | "Acyclic" =>
      pure (.acyclic (← getField j "edges" decEdgeFilter) (← getOpt j "folderDepth" decNat))
  | "Resolvable" => .resolvable <$> getField j "allowComputed" decBool
  | "Declares" =>
      pure (.declares (← getField j "quantifier" decQuantifier)
        (← getField j "predicate" (decPredicate fuel)))
  | "ExportsOnly" => .exportsOnly <$> getField j "names" (decList decStr)
  | "Uses" => pure (.uses (← getField j "relation" decRelation) (← getField j "use" decUseSpec))
  | "Named" =>
      pure (.named (← getField j "relation" decRelation) (← getField j "affix" decAffix)
        (← getField j "value" decStr))
  | "MaxLines" => .maxLines <$> getField j "max" decNat
  | "Custom" => .custom <$> getField j "name" decStr
  | t => badTag "assertion" t

def encRuleOf {σ : Type} (es : Enc σ) : Enc (RuleOf σ) := fun r =>
  Json.mkObj [("id", encStr r.id), ("severity", encSeverity r.severity),
    ("subject", es r.subject), ("assertion", encAssertion es r.assertion)]

def decRuleOf {σ : Type} (ds : Dec σ) : Dec (RuleOf σ) := fun j => do
  pure ⟨← getField j "id" decStr, ← getField j "severity" decSeverity,
    ← getField j "subject" ds, ← getField j "assertion" (decAssertion ds)⟩

def encRule : Enc Rule := encRuleOf encSelector
def decRule : Dec Rule := decRuleOf (decSelector fuel)

/-! ## Configuration -/

mutual
def encConfigSelector : ConfigSelector → Json
  | .base s => tagged "Base" [("selector", encSelector s)]
  | .layer n => tagged "Layer" [("name", encStr n)]
  | .any ss => tagged "Any" [("selectors", Json.arr (encConfigSelectors ss).toArray)]
  | .all ss => tagged "All" [("selectors", Json.arr (encConfigSelectors ss).toArray)]
  | .not s => tagged "Not" [("selector", encConfigSelector s)]

def encConfigSelectors : List ConfigSelector → List Json
  | [] => []
  | s :: ss => encConfigSelector s :: encConfigSelectors ss
end

def decConfigSelector : Nat → Dec ConfigSelector
  | 0, _ => throw "selector nested too deeply"
  | n + 1, j => do
    match ← getTag j with
    | "Base" => .base <$> getField j "selector" (decSelector fuel)
    | "Layer" => .layer <$> getField j "name" decStr
    | "Any" => .any <$> getField j "selectors" (decList (decConfigSelector n))
    | "All" => .all <$> getField j "selectors" (decList (decConfigSelector n))
    | "Not" => .not <$> getField j "selector" (decConfigSelector n)
    | t => badTag "config selector" t

def encLayer : Enc Layer := fun l =>
  Json.mkObj [("name", encStr l.name), ("selector", encSelector l.selector)]

def decLayer : Dec Layer := fun j => do
  pure ⟨← getField j "name" decStr, ← getField j "selector" (decSelector fuel)⟩

def encPublicApi : Enc PublicApi := fun a =>
  Json.mkObj [("layer", encStr a.layer), ("entry", encSelector a.entry)]

def decPublicApi : Dec PublicApi := fun j => do
  pure ⟨← getField j "layer" decStr, ← getField j "entry" (decSelector fuel)⟩

def encConfig : Enc Config := fun c =>
  Json.mkObj [("layers", encList encLayer c.layers), ("stack", encList encStr c.stack),
    ("allow", encList (encPair encStr (encList encStr)) c.allow),
    ("publicApis", encList encPublicApi c.publicApis),
    ("rules", encList (encRuleOf encConfigSelector) c.rules)]

def decConfig : Dec Config := fun j => do
  pure ⟨← getField j "layers" (decList decLayer), ← getField j "stack" (decList decStr),
    ← getField j "allow" (decList (decPair decStr (decList decStr))),
    ← getField j "publicApis" (decList decPublicApi),
    ← getField j "rules" (decList (decRuleOf (decConfigSelector fuel)))⟩

def encConfigError : Enc ConfigError
  | .duplicateLayer n => tagged "DuplicateLayer" [("name", encStr n)]
  | .unknownLayer n => tagged "UnknownLayer" [("name", encStr n)]
  | .duplicateRuleId i => tagged "DuplicateRuleId" [("id", encStr i)]
  | .emptyPolicy => tagged "EmptyPolicy"

def decConfigError : Dec ConfigError := fun j => do
  match ← getTag j with
  | "DuplicateLayer" => .duplicateLayer <$> getField j "name" decStr
  | "UnknownLayer" => .unknownLayer <$> getField j "name" decStr
  | "DuplicateRuleId" => .duplicateRuleId <$> getField j "id" decStr
  | "EmptyPolicy" => pure .emptyPolicy
  | t => badTag "config error" t

/-! ## Violations and fingerprints -/

def encEvidence : Enc Evidence
  | .walk t es => tagged "Walk" [("target", encTarget t), ("edges", encList encEdge es)]
  | .missing => tagged "Missing"
  | .cycle es => tagged "Cycle" [("edges", encList encEdge es)]
  | .dependency e => tagged "Dependency" [("edge", encEdge e)]
  | .declaration n l => tagged "Declaration" [("name", encStr n), ("location", encLocation l)]
  | .export n => tagged "Export" [("name", encStr n)]
  | .use u => tagged "Use" [("use", encUse u)]
  | .name b => tagged "Name" [("basename", encStr b)]
  | .lines c => tagged "Lines" [("count", encNat c)]
  | .custom m => tagged "Custom" [("message", encStr m)]

def decEvidence : Dec Evidence := fun j => do
  match ← getTag j with
  | "Walk" => pure (.walk (← getField j "target" decTarget) (← getField j "edges" (decList decEdge)))
  | "Missing" => pure .missing
  | "Cycle" => .cycle <$> getField j "edges" (decList decEdge)
  | "Dependency" => .dependency <$> getField j "edge" decEdge
  | "Declaration" =>
      pure (.declaration (← getField j "name" decStr) (← getField j "location" decLocation))
  | "Export" => .export <$> getField j "name" decStr
  | "Use" => .use <$> getField j "use" decUse
  | "Name" => .name <$> getField j "basename" decStr
  | "Lines" => .lines <$> getField j "count" decNat
  | "Custom" => .custom <$> getField j "message" decStr
  | t => badTag "evidence" t

def encViolation : Enc Violation := fun v =>
  Json.mkObj [("ruleId", encStr v.ruleId), ("severity", encSeverity v.severity),
    ("subject", encList encStr v.subject), ("evidence", encEvidence v.evidence)]

def decViolation : Dec Violation := fun j => do
  pure ⟨← getField j "ruleId" decStr, ← getField j "severity" decSeverity,
    ← getField j "subject" (decList decStr), ← getField j "evidence" decEvidence⟩

def encFingerprintKey : Enc FingerprintKey
  | .target t => tagged "Target" [("target", encTarget t)]
  | .missing => tagged "Missing"
  | .cycle => tagged "Cycle"
  | .dependency t s k =>
      tagged "Dependency" [("target", encTarget t), ("specifier", encStr s),
        ("kind", encDependencyKind k)]
  | .declaration n => tagged "Declaration" [("name", encStr n)]
  | .export n => tagged "Export" [("name", encStr n)]
  | .use k n b =>
      tagged "Use" [("kind", encUseKind k), ("name", encStr n), ("binding", encBinding b)]
  | .name => tagged "Name"
  | .lines => tagged "Lines"
  | .custom m => tagged "Custom" [("message", encStr m)]

def decFingerprintKey : Dec FingerprintKey := fun j => do
  match ← getTag j with
  | "Target" => .target <$> getField j "target" decTarget
  | "Missing" => pure .missing
  | "Cycle" => pure .cycle
  | "Dependency" =>
      pure (.dependency (← getField j "target" decTarget) (← getField j "specifier" decStr)
        (← getField j "kind" decDependencyKind))
  | "Declaration" => .declaration <$> getField j "name" decStr
  | "Export" => .export <$> getField j "name" decStr
  | "Use" =>
      pure (.use (← getField j "kind" decUseKind) (← getField j "name" decStr)
        (← getField j "binding" decBinding))
  | "Name" => pure .name
  | "Lines" => pure .lines
  | "Custom" => .custom <$> getField j "message" decStr
  | t => badTag "fingerprint key" t

def encFingerprint : Enc Fingerprint := fun f =>
  Json.mkObj [("ruleId", encStr f.ruleId), ("subject", encList encStr f.subject),
    ("key", encFingerprintKey f.key)]

def decFingerprint : Dec Fingerprint := fun j => do
  pure ⟨← getField j "ruleId" decStr, ← getField j "subject" (decList decStr),
    ← getField j "key" decFingerprintKey⟩

def encApplied : Enc Spec.Applied := fun a =>
  Json.mkObj [("kept", encList encViolation a.kept),
    ("suppressed", encList encViolation a.suppressed), ("stale", encList encFingerprint a.stale)]

def decApplied : Dec Spec.Applied := fun j => do
  pure ⟨← getField j "kept" (decList decViolation),
    ← getField j "suppressed" (decList decViolation),
    ← getField j "stale" (decList decFingerprint)⟩

end Archer.Oracle
