import Archer.Oracle.Json

namespace Archer.Oracle.Examples

def roundTrips {α : Type} [BEq α] (e : Enc α) (d : Dec α) (x : α) : Bool :=
  match d (e x) with
  | .ok y => y == x
  | .error _ => false

def loc : Location := ⟨3, 4⟩
def tFile : Target := .file ["src", "a.ts"]
def dep : Dependency := ⟨.package "zod" ["v4"], .type, "zod/v4", loc⟩
def edge : Edge := ⟨["src", "a.ts"], dep⟩
def use : Use := ⟨.call, "f", .imported ⟨"m", "f"⟩, loc⟩
def decl : Declaration :=
  ⟨"C", .class, true, false, ["B"], ["I"], ["d"], [⟨"m", .private, true⟩], true, loc⟩
def sf : SourceFile := ⟨["src", "a.ts"], [dep], [decl], ["C"], [use], 10⟩
def ef : EdgeFilter := ⟨[.static, .type], true, false⟩

example : roundTrips encTarget decTarget tFile = true := by decide
example : roundTrips encTarget decTarget (.builtin .bun "test") = true := by decide
example : roundTrips encTarget decTarget .computed = true := by decide
example : roundTrips encDependency decDependency dep = true := by decide
example : roundTrips encDeclaration decDeclaration decl = true := by decide
example : roundTrips encUse decUse use = true := by decide
example : roundTrips encBinding decBinding .global = true := by decide
example : roundTrips encSourceFile decSourceFile sf = true := by decide
example : roundTrips encGraph decGraph ⟨[sf]⟩ = true := by decide
example : roundTrips encEdgeFilter decEdgeFilter ef = true := by decide
example : roundTrips encEdge decEdge edge = true := by decide
example : roundTrips encUseSpec decUseSpec (.imported "m" ["f"]) = true := by decide
example : roundTrips encEvidence decEvidence (.walk tFile [edge]) = true := by decide
example : roundTrips encEvidence decEvidence (.declaration "C" loc) = true := by decide
example : roundTrips encConfigError decConfigError (.duplicateRuleId "r") = true := by decide
example : roundTrips encFingerprint decFingerprint
    ⟨"r", ["src"], .use .call "f" (.imported ⟨"m", "f"⟩)⟩ = true := by decide
example : roundTrips encFingerprintKey decFingerprintKey (.dependency tFile "./a" .static) = true := by
  decide
example : roundTrips encViolation decViolation ⟨"r", .warning, ["src"], .lines 4⟩ = true := by decide
example : roundTrips encPathToken decPathToken (.segment [.literal 'a', .one, .star]) = true := by
  decide

end Archer.Oracle.Examples
