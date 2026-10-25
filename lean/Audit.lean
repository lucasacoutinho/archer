import Archer

/-! Axiom audit for every required theorem. Run from `lean/`:
`lake build && lake env lean Audit.lean`. Each line must list only
`propext`, `Classical.choice`, or `Quot.sound`. -/

#print axioms Archer.Pattern.accepts_iff
#print axioms Archer.Pattern.many_matches_all
#print axioms Archer.Pattern.sat_only_length
#print axioms Archer.Pattern.extend_many
#print axioms Archer.Impl.reach_spec
#print axioms Archer.Impl.check_spec
#print axioms Archer.Impl.lower_spec
#print axioms Archer.Impl.encode_spec
#print axioms Archer.Impl.baseline_spec
#print axioms Archer.Impl.text_spec
