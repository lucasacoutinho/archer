import { describe, expect, it } from "@effect/vitest"
import type { Binding, UseKind } from "../../src/core/model.ts"
import type { Violation } from "../../src/core/rule.ts"
import { describe as describeViolation, standalone, targetLabel } from "../../src/report/message.ts"
import {
  at,
  cycleViolation,
  declarationViolation,
  dependencyViolation,
  edge,
  exportViolation,
  fileTarget,
  filePath,
  linesViolation,
  missingViolation,
  nameViolation,
  rules,
  walkViolation,
} from "./fixtures.ts"

const violation = (subject: string, evidence: Violation["evidence"], ruleId = "r"): Violation => ({
  ruleId,
  severity: "error",
  subject: filePath(subject),
  evidence,
})

const describeOf = (v: Violation) => describeViolation(v, [])

describe("targetLabel", () => {
  it("labels every target form", () => {
    expect(targetLabel(fileTarget("src/a.ts"))).toBe("src/a.ts")
    expect(targetLabel({ _tag: "Package", name: "react", subpath: [] })).toBe("npm:react")
    expect(targetLabel({ _tag: "Package", name: "react", subpath: ["jsx"] })).toBe("npm:react/jsx")
    expect(targetLabel({ _tag: "Package", name: "@scope/pkg", subpath: ["a", "b"] })).toBe("npm:@scope/pkg/a/b")
    expect(targetLabel({ _tag: "Builtin", runtime: "node", name: "fs" })).toBe("node:fs")
    expect(targetLabel({ _tag: "Builtin", runtime: "bun", name: "sqlite" })).toBe("bun:sqlite")
    expect(targetLabel({ _tag: "Unresolved", specifier: "./x" })).toBe("unresolved:./x")
    expect(targetLabel({ _tag: "Computed" })).toBe("computed:*")
  })
})

describe("describe", () => {
  it("describes a dependency at the import site", () => {
    expect(describeOf(dependencyViolation)).toEqual({
      message: "imports src/infra/db.ts ('../infra/db')",
      location: { path: "src/domain/order.ts", line: 3, column: 10 },
    })
  })

  it("names how each kind of dependency was written", () => {
    const kinds = [
      ["static", "imports src/x.ts ('./x')"],
      ["type", "imports the types of src/x.ts ('./x')"],
      ["require", "requires src/x.ts ('./x')"],
      ["dynamic", "dynamically imports src/x.ts ('./x')"],
    ] as const
    for (const [kind, message] of kinds) {
      const evidence = { _tag: "Dependency", edge: edge("src/a.ts", fileTarget("src/x.ts"), "./x", 1, 1, kind) } as const
      expect(describeOf(violation("src/a.ts", evidence)).message).toBe(message)
    }
  })

  it("describes dependencies on targets without a file", () => {
    const unresolved = edge("src/a.ts", { _tag: "Unresolved", specifier: "./gone" }, "./gone", 4, 2)
    expect(describeOf(violation("src/a.ts", { _tag: "Dependency", edge: unresolved }))).toEqual({
      message: "imports unresolved:./gone ('./gone')",
      location: { path: "src/a.ts", line: 4, column: 2 },
    })
    const computed = edge("src/a.ts", { _tag: "Computed" }, "", 9, 1, "dynamic")
    expect(describeOf(violation("src/a.ts", { _tag: "Dependency", edge: computed }))).toEqual({
      message: "dynamically imports computed:*",
      location: { path: "src/a.ts", line: 9, column: 1 },
    })
  })

  it("describes an incoming dependency from the subject's side, located in the importing file", () => {
    const incoming = edge("src/web/page.ts", fileTarget("src/domain/order.ts"), "../domain/order", 5, 3)
    expect(describeOf(violation("src/domain/order.ts", { _tag: "Dependency", edge: incoming }))).toEqual({
      message: "is imported by src/web/page.ts ('../domain/order')",
      location: { path: "src/web/page.ts", line: 5, column: 3 },
    })
    const required = edge("src/web/page.ts", fileTarget("src/domain/order.ts"), "../domain/order", 5, 3, "require")
    expect(describeOf(violation("src/domain/order.ts", { _tag: "Dependency", edge: required })).message).toBe(
      "is required by src/web/page.ts ('../domain/order')",
    )
  })

  it("describes a walk with its chain and the first edge's location", () => {
    expect(describeOf(walkViolation)).toEqual({
      message: "depends on npm:pg through src/web/page.ts → src/app/users.ts → src/infra/db.ts → npm:pg",
      location: { path: "src/web/page.ts", line: 1, column: 1 },
    })
  })

  it("describes an incoming walk from the subject's side", () => {
    const incoming = violation("src/domain/order.ts", {
      _tag: "Walk",
      target: fileTarget("src/web/page.ts"),
      edges: [
        edge("src/web/page.ts", fileTarget("src/app/users.ts"), "../app/users", 6, 2),
        edge("src/app/users.ts", fileTarget("src/domain/order.ts"), "../domain/order", 1),
      ],
    })
    expect(describeOf(incoming)).toEqual({
      message: "is depended on by src/web/page.ts through src/web/page.ts → src/app/users.ts → src/domain/order.ts",
      location: { path: "src/web/page.ts", line: 6, column: 2 },
    })
  })

  it("describes a walk to a computed import or a built-in", () => {
    const toComputed = violation("src/a.ts", {
      _tag: "Walk",
      target: { _tag: "Computed" },
      edges: [edge("src/a.ts", { _tag: "Computed" }, "", 2, 7, "dynamic")],
    })
    expect(describeOf(toComputed).message).toBe("depends on computed:* through src/a.ts → computed:*")
    const toBuiltin = violation("src/a.ts", {
      _tag: "Walk",
      target: { _tag: "Builtin", runtime: "node", name: "fs" },
      edges: [
        edge("src/a.ts", fileTarget("src/b.ts"), "./b", 1),
        edge("src/b.ts", { _tag: "Builtin", runtime: "node", name: "fs" }, "node:fs", 1),
      ],
    })
    expect(describeOf(toBuiltin).message).toBe("depends on node:fs through src/a.ts → src/b.ts → node:fs")
  })

  it("describes a walk without edges without a chain or a location", () => {
    const bare = violation("src/a.ts", { _tag: "Walk", target: { _tag: "Package", name: "pg", subpath: [] }, edges: [] })
    expect(describeOf(bare)).toEqual({ message: "depends on npm:pg" })
  })

  it("describes a cycle with its chain and the first edge's location", () => {
    expect(describeOf(cycleViolation)).toEqual({
      message: "is part of a dependency cycle: src/a.ts → src/b.ts → src/a.ts",
      location: { path: "src/a.ts", line: 2, column: 1 },
    })
    expect(describeOf(violation("src/a.ts", { _tag: "Cycle", edges: [] }))).toEqual({
      message: "is part of a dependency cycle",
    })
  })

  it("describes the evidence kinds that carry no dependency", () => {
    expect(describeOf(missingViolation)).toEqual({ message: "does not satisfy the rule's requirement" })
    expect(describeOf(exportViolation)).toEqual({ message: "exports internal, which the rule does not allow" })
    expect(describeOf(nameViolation)).toEqual({ message: "has the file name Order.ts, which breaks the naming rule" })
    expect(describeOf(linesViolation)).toEqual({ message: "has 900 lines, more than the rule allows" })
    expect(describeOf(violation("src/a.ts", { _tag: "Custom", message: "first\nsecond" }))).toEqual({
      message: "first\nsecond",
    })
  })

  it("locates a declaration in the subject file", () => {
    expect(describeOf(declarationViolation)).toEqual({
      message: "declares formatPrice, which the rule does not allow",
      location: { path: "src/domain/helpers.ts", line: 7, column: 17 },
    })
  })

  it("describes uses by binding", () => {
    const use = (kind: UseKind, name: string, binding: Binding) =>
      violation("src/a.ts", { _tag: "Use", use: { kind, name, binding, location: at(12, 5) } })
    expect(describeOf(use("call", "eval", { _tag: "Global" }))).toEqual({
      message: "calls eval",
      location: { path: "src/a.ts", line: 12, column: 5 },
    })
    expect(describeOf(use("call", "helper", { _tag: "Local" })).message).toBe("calls helper")
    expect(
      describeOf(use("call", "q", { _tag: "Imported", name: { source: "./db", name: "query" } })).message,
    ).toBe("calls q (query from './db')")
    expect(describeOf(use("looseEquality", "==", { _tag: "Local" })).message).toBe("uses loose equality (==)")
  })

  it("adds the reason of the rule that produced the violation", () => {
    expect(describeViolation(dependencyViolation, rules)).toEqual({
      message: "imports src/infra/db.ts ('../infra/db')",
      reason: "Domain code must not know about persistence.",
      location: { path: "src/domain/order.ts", line: 3, column: 10 },
    })
    expect(describeViolation(cycleViolation, rules).reason).toBeUndefined()
    expect(describeViolation(dependencyViolation, [{ id: "other", severity: "error", reason: "x" }]).reason).toBeUndefined()
  })
})

describe("standalone", () => {
  it("leaves a message in the subject's own file alone", () => {
    expect(standalone(dependencyViolation, describeOf(dependencyViolation))).toBe("imports src/infra/db.ts ('../infra/db')")
    expect(standalone(linesViolation, describeOf(linesViolation))).toBe("has 900 lines, more than the rule allows")
  })

  it("puts the subject in front when the location is in another file", () => {
    const incoming = violation("src/domain/order.ts", {
      _tag: "Dependency",
      edge: edge("src/web/page.ts", fileTarget("src/domain/order.ts"), "../domain/order", 5, 3),
    })
    expect(standalone(incoming, describeOf(incoming))).toBe(
      "src/domain/order.ts is imported by src/web/page.ts ('../domain/order')",
    )
  })
})
