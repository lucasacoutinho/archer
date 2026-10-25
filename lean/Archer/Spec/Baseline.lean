import Archer.Fingerprint

/-!
# Specification of fingerprint encoding, baselines, and the verdict

Contract prose: `docs/contracts/README.md`.
-/

namespace Archer.Spec

open Archer

/-- A baseline file stores encoded fingerprints, one string each. -/
abbrev EncodeFn := Fingerprint → String
abbrev DecodeFn := String → Option Fingerprint

structure EncodeSpec (encode : EncodeFn) (decode : DecodeFn) : Prop where
  /-- F1: decoding recovers every encoded fingerprint, so two different
  fingerprints never share an encoding and a baseline entry suppresses
  only its own violations. -/
  roundTrip : ∀ x, decode (encode x) = some x
  /-- F2: an encoding is one line. -/
  singleLine : ∀ x, '\n' ∉ (encode x).toList

structure Applied where
  kept : List Violation
  suppressed : List Violation
  /-- Baseline entries that no current violation has. -/
  stale : List Fingerprint
  deriving Repr

abbrev ApplyFn := List Fingerprint → List Violation → Applied
abbrev RecordFn := List Violation → List Fingerprint

structure BaselineSpec (apply : ApplyFn) (record : RecordFn) : Prop where
  /-- B1: kept violations are those whose fingerprint is not in the
  baseline, in their original order. -/
  kept : ∀ b vs, (apply b vs).kept = vs.filter fun v => decide (v.fingerprint ∉ b)
  /-- B2: suppressed violations are the others, in their original order. -/
  suppressed : ∀ b vs, (apply b vs).suppressed = vs.filter fun v => decide (v.fingerprint ∈ b)
  /-- B3: an entry is stale exactly when no violation has it. -/
  stale : ∀ b vs x, x ∈ (apply b vs).stale ↔ x ∈ b ∧ ∀ v ∈ vs, v.fingerprint ≠ x
  /-- B4: stale entries are listed once each. -/
  staleUnique : ∀ b vs, ((apply b vs).stale).Nodup
  /-- B5: a recorded baseline holds exactly the fingerprints of its violations,
  once each. -/
  recorded : ∀ vs x, x ∈ record vs ↔ ∃ v ∈ vs, v.fingerprint = x
  recordUnique : ∀ vs, (record vs).Nodup

/-- The verdict of a report: it fails on a kept error, or on a kept warning
when warnings fail. -/
def fails (failOnWarnings : Bool) (kept : List Violation) : Bool :=
  kept.any fun v => v.severity == .error || (failOnWarnings && v.severity == .warning)

end Archer.Spec
