import Archer.Impl.Reach
import Archer.Impl.Check

/-!
# The checked implementation

`check` is the function that the TypeScript port mirrors: the check
parameterized by the proved breadth-first reachability.
-/

namespace Archer.Impl

/-- The check, with `reach` as its reachability. -/
def check : Archer.Spec.CheckFn := checkWith reach

/-- C1–C3 for the check that production ports. -/
theorem check_spec : Archer.Spec.CheckSpec check :=
  checkWith_spec reach reach_spec

end Archer.Impl
