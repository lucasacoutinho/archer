import { NodeServices } from "@effect/platform-node"
import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import type { Graph } from "../../src/core/model.ts"
import { agent } from "../../src/report/agent.ts"
import { dot } from "../../src/report/dot.ts"
import { github } from "../../src/report/github.ts"
import { json } from "../../src/report/json.ts"
import { pretty } from "../../src/report/pretty.ts"
import { Format, render } from "../../src/report/render.ts"
import { sarif } from "../../src/report/sarif.ts"
import { fileTarget, filePath, fullReport } from "./fixtures.ts"

const graph: Graph = {
  files: [
    {
      path: filePath("src/a.ts"),
      dependencies: [{ target: fileTarget("src/b.ts"), kind: "static", specifier: "./b", location: { line: 1, column: 1 } }],
      declarations: [],
      exports: [],
      uses: [],
      lines: 1,
    },
    { path: filePath("src/b.ts"), dependencies: [], declarations: [], exports: [], uses: [], lines: 1 },
  ],
}

describe("Format", () => {
  it("accepts the six formats and nothing else", () => {
    for (const name of ["pretty", "agent", "json", "sarif", "github", "dot"]) {
      expect(Schema.is(Format)(name)).toBe(true)
    }
    expect(Schema.is(Format)("xml")).toBe(false)
    expect(Schema.is(Format)("llm")).toBe(false)
    expect(Schema.is(Format)("")).toBe(false)
  })
})

layer(NodeServices.layer)("render", (it) => {
  it.effect("renders each format with its reporter", () =>
    Effect.gen(function* () {
      const options = { root: "/nonexistent-archer-root" }
      expect(yield* render("agent", fullReport, graph, options)).toBe(agent(fullReport))
      expect(yield* render("json", fullReport, graph, options)).toBe(json(fullReport))
      expect(yield* render("sarif", fullReport, graph, options)).toBe(sarif(fullReport))
      expect(yield* render("github", fullReport, graph, options)).toBe(github(fullReport))
      expect(yield* render("dot", fullReport, graph, options)).toBe(dot(graph))
      expect(yield* render("pretty", fullReport, graph, options)).toBe(yield* pretty(fullReport, options))
    }),
  )

  it.effect("gives each format its own shape", () =>
    Effect.gen(function* () {
      const options = { root: "/nonexistent-archer-root" }
      expect(yield* render("dot", fullReport, graph, options)).toBe(
        ["digraph archer {", "  rankdir=LR;", "  node [shape=box];", '  "src/a.ts";', '  "src/b.ts";', '  "src/a.ts" -> "src/b.ts";', "}"].join(
          "\n",
        ),
      )
      expect((yield* render("agent", fullReport, graph, options)).startsWith("finding id=")).toBe(true)
      expect((yield* render("github", fullReport, graph, options)).startsWith("::error file=")).toBe(true)
      expect(JSON.parse(yield* render("sarif", fullReport, graph, options)).version).toBe("2.1.0")
      expect(JSON.parse(yield* render("json", fullReport, graph, options)).verdict).toBe("fail")
      expect((yield* render("pretty", fullReport, graph, options)).startsWith("src/domain/order.ts\n")).toBe(true)
    }),
  )

  it.effect("passes the color option to pretty only", () =>
    Effect.gen(function* () {
      const options = { root: "/nonexistent-archer-root", color: true }
      expect(yield* render("pretty", fullReport, graph, options)).toContain("\u001b[31m")
      for (const format of ["agent", "json", "sarif", "github", "dot"] as const) {
        expect(yield* render(format, fullReport, graph, options)).not.toContain("\u001b")
      }
    }),
  )
})
