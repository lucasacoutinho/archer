import { describe, expect, it } from "vitest"
import { check } from "../../src/core/check.ts"
import type { EdgeFilter, FilePath, Graph, SourceFile } from "../../src/core/model.ts"
import type { Rule } from "../../src/core/rule.ts"
import { glob } from "./builders.ts"

/** One strongly connected tangle: the worst case for cycle and incoming rules. */
const tangle = (size: number): Graph => {
  let seed = 7
  const next = (bound: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % bound
  }
  const paths: Array<FilePath> = Array.from({ length: size }, (_, index): FilePath => ["src", `m${index % 20}`, `f${index}.ts`])
  return {
    files: paths.map(
      (path, index): SourceFile => ({
        path,
        dependencies: Array.from({ length: 4 }, (_, line) => ({
          target: { _tag: "File", path: paths[(index + 1 + next(size - 1)) % size] ?? path },
          kind: "static",
          specifier: "./x.ts",
          location: { line: line + 1, column: 1 },
        })),
        declarations: [],
        exports: [],
        uses: [],
        lines: 10,
      }),
    ),
  }
}

const transitive: EdgeFilter = { kinds: ["static"], localOnly: false, transitive: true }

const rules: Array<Rule> = [
  { id: "acyclic", severity: "error", subject: glob("src", "**"), assertion: { _tag: "Acyclic", edges: transitive } },
  {
    id: "only-used-by",
    severity: "error",
    subject: glob("src", "m1", "**"),
    assertion: { _tag: "Reach", direction: "incoming", relation: "forbid", object: glob("src", "m2", "**"), edges: transitive },
  },
  {
    id: "direct",
    severity: "error",
    subject: glob("src", "m1", "**"),
    assertion: { _tag: "Reach", direction: "incoming", relation: "forbid", object: glob("src", "**"), edges: { ...transitive, transitive: false } },
  },
]

describe("check at scale", () => {
  it("checks a 2,000-file tangle without superlinear blow-up", () => {
    const started = performance.now()
    const violations = check(() => [], rules, tangle(2000))
    expect(violations.some((violation) => violation.ruleId === "acyclic")).toBe(true)
    expect(performance.now() - started).toBeLessThan(15_000)
  }, 60_000)
})
