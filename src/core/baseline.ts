/** Port of `record` and `apply` in lean/Archer/Impl/Baseline.lean. */
import { Schema } from "effect"
import { Fingerprint, fingerprint } from "./fingerprint.ts"
import { Violation } from "./rule.ts"
import { dedupStructural, structuralKey } from "./structural.ts"

export interface Applied {
  readonly kept: ReadonlyArray<Violation>
  readonly suppressed: ReadonlyArray<Violation>
  /** Baseline entries that no current violation has. */
  readonly stale: ReadonlyArray<Fingerprint>
}

export const Applied: Schema.Codec<Applied> = Schema.Struct({
  kept: Schema.Array(Violation),
  suppressed: Schema.Array(Violation),
  /** Baseline entries that no current violation has. */
  stale: Schema.Array(Fingerprint),
})

/** The fingerprints of the violations, once each, in order of first occurrence. */
export const record = (violations: ReadonlyArray<Violation>): Array<Fingerprint> =>
  dedupStructural(violations.map(fingerprint))

/** Splits violations by a baseline. */
export const apply = (baseline: ReadonlyArray<Fingerprint>, violations: ReadonlyArray<Violation>): Applied => {
  const baselineKeys = new Set(baseline.map(structuralKey))
  const current = violations.map((violation) => structuralKey(fingerprint(violation)))
  const currentKeys = new Set(current)
  return {
    kept: violations.filter((_, index) => !baselineKeys.has(current[index] ?? "")),
    suppressed: violations.filter((_, index) => baselineKeys.has(current[index] ?? "")),
    stale: dedupStructural(baseline).filter((entry) => !currentKeys.has(structuralKey(entry))),
  }
}
