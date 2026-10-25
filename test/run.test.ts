import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Result } from "effect"
import { Analyzer } from "../src/analyzer/Analyzer.ts"
import { type ArcherConfig, decodeConfiguration } from "../src/config/input.ts"
import { p, r, use } from "../src/config/rules.ts"
import type { Graph, SourceFile } from "../src/core/model.ts"
import { checkGraph, run } from "../src/run.ts"

const fixture = fileURLToPath(new URL("fixtures/project", import.meta.url))

const layered: ArcherConfig = {
  layers: {
    application: "src/application",
    domain: "src/domain",
    infrastructure: "src/infrastructure",
  },
  stack: ["application", "domain"],
  allow: { infrastructure: ["domain"] },
  baseline: false,
}

const file = (path: string, imports: ReadonlyArray<string> = []): SourceFile => ({
  path: path.split("/"),
  dependencies: imports.map((target, index) => ({
    target: { _tag: "File", path: target.split("/") },
    kind: "static",
    specifier: `./${target}`,
    location: { line: index + 1, column: 1 },
  })),
  declarations: [],
  exports: [],
  uses: [],
  lines: 3,
})

describe("configuration decoding", () => {
  it("accepts the default layered configuration", () => {
    const decoded = decodeConfiguration(layered)
    expect(Result.isSuccess(decoded) && decoded.success.config.layers.map((layer) => layer.name)).toEqual([
      "application",
      "domain",
      "infrastructure",
    ])
  })

  it("collects every issue with its path", () => {
    const decoded = decodeConfiguration({
      layers: { app: "src//app", domain: "layer:app" },
      rules: [r.forbid("x", "src/**", "npm:"), { ...r.custom("c", "src/**", () => []), check: undefined }],
    })
    expect(Result.isFailure(decoded) && decoded.failure.issues).toEqual([
      "layers.app: 'src//app' is not a selector (InvalidSegment)",
      "layers.domain: 'layer:app' cannot be used to define a layer",
      "rules[0].assertion: 'npm:' is not a selector (InvalidName)",
      "rules[1]: a custom rule needs a check function",
    ])
  })

  it("rejects layer names that look like array indexes", () => {
    expect(Result.isFailure(decodeConfiguration({ layers: { "0": "src" } }))).toBe(true)
  })

  it("turns a crashing or malformed custom check into one message", () => {
    const decoded = decodeConfiguration({
      rules: [
        r.custom("throws", "src/**", () => {
          throw new Error("boom")
        }),
        r.custom("malformed", "src/**", () => [1] as unknown as ReadonlyArray<string>),
      ],
    })
    const custom = Result.isSuccess(decoded) ? decoded.success.custom : new Map()
    const graph: Graph = { files: [] }
    expect(custom.get("throws")?.({ graph, subject: "src/a.ts" })).toEqual(["custom rule crashed: boom"])
    expect(custom.get("malformed")?.({ graph, subject: "src/a.ts" })).toEqual([
      "custom rule returned something other than a list of messages",
    ])
  })
})

describe("checkGraph", () => {
  const graph: Graph = {
    files: [file("src/application/a.ts", ["src/infrastructure/db.ts"]), file("src/domain/d.ts"), file("src/infrastructure/db.ts")],
  }

  it("reports a layer violation per import site, with the layer rule's id", () => {
    const report = Result.getOrThrow(checkGraph(layered, graph))
    expect(report.violations.map((violation) => [violation.ruleId, violation.subject.join("/")])).toEqual([
      ["layer/application", "src/application/a.ts"],
    ])
    expect(report.verdict).toBe("fail")
  })

  it("lists rules whose subject is empty apart from the violations", () => {
    const report = Result.getOrThrow(
      checkGraph({ ...layered, rules: [r.maxLines("typo", "src/domian", 10), r.declares("kinds", "src/domain", p.kind("class"))] }, graph),
    )
    expect(report.emptySubjects).toEqual(["typo"])
  })

  it("lists dependency rules whose file target names nothing, but not absent packages", () => {
    const report = Result.getOrThrow(
      checkGraph(
        {
          rules: [
            r.forbid("typo", "src/application", "src/infrastucture"),
            r.forbid("absent-package", "src/application", "npm:lodash"),
            r.forbid("real", "src/application", "src/infrastructure"),
          ],
          baseline: false,
        },
        graph,
      ),
    )
    expect(report.emptyObjects).toEqual(["typo"])
  })

  it("rejects a configuration that lowering rejects", () => {
    const rejected = checkGraph({ stack: ["ghost"] }, graph)
    expect(Result.isFailure(rejected) && rejected.failure._tag).toBe("ConfigRejected")
  })

  it("passes warnings unless failOnWarnings", () => {
    const warning = { rules: [r.forbidUse("eq", "src/**", use.looseEquality), r.maxLines("short", "src/**", 1, { severity: "warning" })] }
    expect(Result.getOrThrow(checkGraph(warning, graph)).verdict).toBe("pass")
    expect(Result.getOrThrow(checkGraph({ ...warning, failOnWarnings: true }, graph)).verdict).toBe("fail")
  })
})

layer(Analyzer.typescript.pipe(Layer.provideMerge(NodeServices.layer)))("run", (it) => {
  it.effect("analyzes the workspace and reports the layer violation", () =>
    Effect.gen(function* () {
      const { report } = yield* run({ config: layered, cwd: fixture })
      expect(report.violations.map((violation) => violation.subject.join("/"))).toEqual(["src/application/create-order.ts"])
      expect(report.stats.files).toBeGreaterThan(5)
    }),
  )

  it.effect("records, applies, and prunes a baseline", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "archer-run-" })
      const config: ArcherConfig = { ...layered, baseline: path.join(directory, "baseline") }
      const recorded = yield* run({ config, cwd: fixture, baseline: "record" })
      expect([recorded.report.violations.length, recorded.report.suppressed]).toEqual([0, 1])
      const applied = yield* run({ config, cwd: fixture })
      expect([applied.report.verdict, applied.report.suppressed, applied.report.stale]).toEqual(["pass", 1, []])
      const fixed: ArcherConfig = { ...config, allow: { infrastructure: ["domain"], application: ["infrastructure"] } }
      const stale = yield* run({ config: fixed, cwd: fixture })
      expect(stale.report.stale.length).toBe(1)
      yield* run({ config: fixed, cwd: fixture, baseline: "prune" })
      expect((yield* fs.readFileString(path.join(directory, "baseline"))).trim()).toBe("archer-baseline 1")
    }).pipe(Effect.scoped),
  )

  it.effect("fails with ConfigNotFound when no configuration file exists", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run({ cwd: fixture }))
      expect(error._tag).toBe("ConfigNotFound")
    }),
  )
})
