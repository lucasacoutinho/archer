import type { Dependency, DependencyKind, Target } from "../../src/core/model.ts"
import type { Edge, Violation } from "../../src/core/rule.ts"
import type { Report, RuleInfo } from "../../src/report/report.ts"

export const at = (line: number, column: number) => ({ line, column })

export const filePath = (text: string): Array<string> => text.split("/")

export const fileTarget = (text: string): Target => ({ _tag: "File", path: filePath(text) })

export const edge = (
  source: string,
  target: Target,
  specifier: string,
  line: number,
  column = 1,
  kind: DependencyKind = "static",
): Edge => {
  const dependency: Dependency = { target, kind, specifier, location: at(line, column) }
  return { source: filePath(source), dependency }
}

export const rules: ReadonlyArray<RuleInfo> = [
  { id: "no-infra", severity: "error", reason: "Domain code must not know about persistence." },
  { id: "web/no-db", severity: "error", reason: "Web code reaches the database through app only." },
  { id: "no-cycles", severity: "warning" },
  { id: "needs-adapter", severity: "error" },
  { id: "only-classes", severity: "error" },
  { id: "public-api", severity: "error" },
  { id: "no-eval", severity: "error", reason: "eval defeats static analysis." },
  { id: "file-naming", severity: "warning" },
  { id: "max-lines", severity: "warning" },
  { id: "features/one-entrypoint", severity: "info" },
  { id: "unused-rule", severity: "info" },
]

export const dependencyViolation: Violation = {
  ruleId: "no-infra",
  severity: "error",
  subject: filePath("src/domain/order.ts"),
  evidence: { _tag: "Dependency", edge: edge("src/domain/order.ts", fileTarget("src/infra/db.ts"), "../infra/db", 3, 10) },
}

export const walkViolation: Violation = {
  ruleId: "web/no-db",
  severity: "error",
  subject: filePath("src/web/page.ts"),
  evidence: {
    _tag: "Walk",
    target: { _tag: "Package", name: "pg", subpath: [] },
    edges: [
      edge("src/web/page.ts", fileTarget("src/app/users.ts"), "../app/users", 1),
      edge("src/app/users.ts", fileTarget("src/infra/db.ts"), "../infra/db", 2),
      edge("src/infra/db.ts", { _tag: "Package", name: "pg", subpath: [] }, "pg", 1),
    ],
  },
}

export const cycleViolation: Violation = {
  ruleId: "no-cycles",
  severity: "warning",
  subject: filePath("src/a.ts"),
  evidence: {
    _tag: "Cycle",
    edges: [edge("src/a.ts", fileTarget("src/b.ts"), "./b", 2), edge("src/b.ts", fileTarget("src/a.ts"), "./a", 3, 5)],
  },
}

export const missingViolation: Violation = {
  ruleId: "needs-adapter",
  severity: "error",
  subject: filePath("src/app/users.ts"),
  evidence: { _tag: "Missing" },
}

export const declarationViolation: Violation = {
  ruleId: "only-classes",
  severity: "error",
  subject: filePath("src/domain/helpers.ts"),
  evidence: { _tag: "Declaration", name: "formatPrice", location: at(7, 17) },
}

export const exportViolation: Violation = {
  ruleId: "public-api",
  severity: "error",
  subject: filePath("src/lib/index.ts"),
  evidence: { _tag: "Export", name: "internal" },
}

export const useViolation: Violation = {
  ruleId: "no-eval",
  severity: "error",
  subject: filePath("src/legacy/run.ts"),
  evidence: { _tag: "Use", use: { kind: "call", name: "eval", binding: { _tag: "Global" }, location: at(12, 5) } },
}

export const nameViolation: Violation = {
  ruleId: "file-naming",
  severity: "warning",
  subject: filePath("src/domain/Order.ts"),
  evidence: { _tag: "Name", basename: "Order.ts" },
}

export const linesViolation: Violation = {
  ruleId: "max-lines",
  severity: "warning",
  subject: filePath("src/big.ts"),
  evidence: { _tag: "Lines", count: 900 },
}

export const customViolation: Violation = {
  ruleId: "features/one-entrypoint",
  severity: "info",
  subject: filePath("src/features/a.ts"),
  evidence: { _tag: "Custom", message: "exports 3 names" },
}

/** One violation of every evidence kind: 6 errors, 3 warnings, 1 info. */
export const everyKind: ReadonlyArray<Violation> = [
  dependencyViolation,
  walkViolation,
  cycleViolation,
  missingViolation,
  declarationViolation,
  exportViolation,
  useViolation,
  nameViolation,
  linesViolation,
  customViolation,
]

export const fullReport: Report = {
  violations: everyKind,
  suppressed: 2,
  stale: [{ ruleId: "old-rule", subject: filePath("src/gone.ts"), key: { _tag: "Missing" } }],
  emptySubjects: ["unused-rule"],
  emptyObjects: [],
  rules,
  counts: { error: 6, warning: 3, info: 1 },
  stats: { files: 12, dependencies: 40 },
  verdict: "fail",
}

export const cleanReport: Report = {
  violations: [],
  suppressed: 0,
  stale: [],
  emptySubjects: [],
  emptyObjects: [],
  rules,
  counts: { error: 0, warning: 0, info: 0 },
  stats: { files: 12, dependencies: 40 },
  verdict: "pass",
}
