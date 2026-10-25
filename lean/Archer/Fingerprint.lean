import Archer.Rule

/-!
# Fingerprints

A fingerprint identifies a violation across runs. It leaves out source
locations and witness edges, so moving an import or finding another
shortest path does not change it. Contract: `docs/verification.md`.
-/

namespace Archer

inductive FingerprintKey where
  | target (target : Target)
  | missing
  | cycle
  | dependency (target : Target) (specifier : String) (kind : DependencyKind)
  | declaration (name : String)
  | «export» (name : String)
  | use (kind : UseKind) (name : String) (binding : Binding)
  | name
  | lines
  | custom (message : String)
  deriving DecidableEq, Repr

def EvidenceKey.stable : EvidenceKey → FingerprintKey
  | .target t => .target t
  | .missing => .missing
  | .cycle => .cycle
  | .dependency e => .dependency e.dependency.target e.dependency.specifier e.dependency.kind
  | .declaration n _ => .declaration n
  | .export n => .export n
  | .use u => .use u.kind u.name u.binding
  | .name => .name
  | .lines => .lines
  | .custom m => .custom m

structure Fingerprint where
  ruleId : String
  subject : FilePath
  key : FingerprintKey
  deriving DecidableEq, Repr

def Violation.fingerprint (v : Violation) : Fingerprint :=
  ⟨v.ruleId, v.subject, v.evidence.key.stable⟩

end Archer
