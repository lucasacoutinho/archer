import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { ArchitectureError, assertArchitecture, check, defineConfig, dispose, graphOf, r, run } from "../src/index.ts"

const fixture = fileURLToPath(new URL("fixtures/project", import.meta.url))

const config = defineConfig({
  layers: { application: "src/application", domain: "src/domain", infrastructure: "src/infrastructure" },
  stack: ["application", "domain"],
  baseline: false,
})

afterAll(dispose)

describe("the Promise surface", () => {
  it("checks a policy against an in-memory graph without TypeScript", () => {
    const report = check(config, graphOf({ "src/domain/order.ts": ["src/application/use.ts"], "src/application/use.ts": [] }))
    expect(report.violations.map((violation) => violation.ruleId)).toEqual(["layer/domain"])
  })

  it("throws a tagged error for an invalid configuration", () => {
    expect(() => check({ rules: [r.forbid("x", "src//a", "npm:*")] }, graphOf({}))).toThrow(
      expect.objectContaining({ _tag: "ConfigInvalid" }),
    )
  })

  it("rejects with ArchitectureError carrying the report and the pretty text", async () => {
    const failure: unknown = await assertArchitecture({ config, cwd: fixture }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ArchitectureError)
    const error = failure as ArchitectureError
    expect(error.report.verdict).toBe("fail")
    expect(error.message).toContain("layer/application")
  })

  it("rejects with the run's tagged error", async () => {
    await expect(run({ cwd: fixture })).rejects.toMatchObject({ _tag: "ConfigNotFound" })
  })
})
