import { Schema } from "effect"
import type { Applied } from "../core/baseline.ts"
import { Fingerprint } from "../core/fingerprint.ts"
import type { Graph } from "../core/model.ts"
import { Severity, Violation } from "../core/rule.ts"

/** What reporters need about a rule that the checked policy does not carry. */
export interface RuleInfo {
  readonly id: string
  readonly severity: Severity
  readonly reason?: string
}

export const RuleInfo: Schema.Codec<RuleInfo> = Schema.Struct({
  id: Schema.String,
  severity: Severity,
  reason: Schema.optionalKey(Schema.String),
})

export interface Report {
  /** Violations the baseline does not accept, in check order (O1). */
  readonly violations: ReadonlyArray<Violation>
  readonly suppressed: number
  readonly stale: ReadonlyArray<Fingerprint>
  readonly emptySubjects: ReadonlyArray<string>
  /** Dependency rules whose object names files by a glob but selects none: usually a mistyped path. */
  readonly emptyObjects: ReadonlyArray<string>
  readonly rules: ReadonlyArray<RuleInfo>
  readonly counts: { readonly error: number; readonly warning: number; readonly info: number }
  readonly stats: { readonly files: number; readonly dependencies: number }
  readonly verdict: "pass" | "fail"
}

export const Report: Schema.Codec<Report> = Schema.Struct({
  /** Violations the baseline does not accept, in check order (O1). */
  violations: Schema.Array(Violation),
  suppressed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stale: Schema.Array(Fingerprint),
  emptySubjects: Schema.Array(Schema.String),
  emptyObjects: Schema.Array(Schema.String),
  rules: Schema.Array(RuleInfo),
  counts: Schema.Struct({
    error: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    warning: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    info: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  stats: Schema.Struct({
    files: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    dependencies: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  verdict: Schema.Literals(["pass", "fail"]),
})

/** Port of `Archer.Spec.fails`. */
export const fails = (failOnWarnings: boolean, kept: ReadonlyArray<Violation>): boolean =>
  kept.some((violation) => violation.severity === "error" || (failOnWarnings && violation.severity === "warning"))

const count = (violations: ReadonlyArray<Violation>, severity: Severity): number =>
  violations.filter((violation) => violation.severity === severity).length

export const makeReport = (input: {
  readonly applied: Applied
  readonly emptySubjects: ReadonlyArray<string>
  readonly emptyObjects: ReadonlyArray<string>
  readonly rules: ReadonlyArray<RuleInfo>
  readonly graph: Graph
  readonly failOnWarnings: boolean
}): Report => ({
  violations: input.applied.kept,
  suppressed: input.applied.suppressed.length,
  stale: input.applied.stale,
  emptySubjects: input.emptySubjects,
  emptyObjects: input.emptyObjects,
  rules: input.rules,
  counts: {
    error: count(input.applied.kept, "error"),
    warning: count(input.applied.kept, "warning"),
    info: count(input.applied.kept, "info"),
  },
  stats: {
    files: input.graph.files.length,
    dependencies: input.graph.files.reduce((total, file) => total + file.dependencies.length, 0),
  },
  verdict: fails(input.failOnWarnings, input.applied.kept) ? "fail" : "pass",
})
