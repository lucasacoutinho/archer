import { describe, expect, it } from "@effect/vitest"
import { reach } from "../../src/core/reach.ts"
import { dep, edge, file, filter, graph, source } from "./builders.ts"

describe("reach", () => {
  it("reports a chain with shortest witnesses", () => {
    const g = graph(source("a", [dep(file("b"))]), source("b", [dep(file("c"))]), source("c"))
    expect(reach(g, filter(true), ["a"])).toEqual([
      [file("b"), [edge("a", dep(file("b")))]],
      [file("c"), [edge("a", dep(file("b"))), edge("b", dep(file("c")))]],
    ])
  })

  it("reports the source itself when it lies on a cycle", () => {
    const g = graph(source("a", [dep(file("b"))]), source("b", [dep(file("a"))]))
    expect(reach(g, filter(true), ["a"])).toEqual([
      [file("b"), [edge("a", dep(file("b")))]],
      [file("a"), [edge("a", dep(file("b"))), edge("b", dep(file("a")))]],
    ])
  })

  it("stops after the first round when not transitive", () => {
    const g = graph(source("a", [dep(file("b"))]), source("b", [dep(file("c"))]), source("c"))
    expect(reach(g, filter(false), ["a"])).toEqual([[file("b"), [edge("a", dep(file("b")))]]])
  })

  it("treats computed imports as leaves and prefers the shorter route", () => {
    const g = graph(
      source("a", [dep(file("b")), dep({ _tag: "Computed" }), dep(file("c"))]),
      source("b", [dep(file("c"))]),
      source("c"),
    )
    expect(reach(g, filter(true), ["a"])).toEqual([
      [file("b"), [edge("a", dep(file("b")))]],
      [{ _tag: "Computed" }, [edge("a", dep({ _tag: "Computed" }))]],
      [file("c"), [edge("a", dep(file("c")))]],
    ])
  })

  it("breaks ties between equal-length witnesses by discovery order", () => {
    const g = graph(
      source("a", [dep(file("b")), dep(file("c"))]),
      source("b", [dep(file("d"))]),
      source("c", [dep(file("d"))]),
      source("d"),
    )
    const found = reach(g, filter(true), ["a"])
    expect(found.map(([target]) => target)).toEqual([file("b"), file("c"), file("d")])
    expect(found[2]?.[1]).toEqual([edge("a", dep(file("b"))), edge("b", dep(file("d")))])
  })

  it("skips edges the filter does not admit, including non-local ones", () => {
    const g = graph(source("a", [dep(file("b"), "type"), dep({ _tag: "Unresolved", specifier: "x" }), dep(file("c"))]), source("b"), source("c"))
    expect(reach(g, { kinds: ["static"], localOnly: true, transitive: true }, ["a"])).toEqual([
      [file("c"), [edge("a", dep(file("c")))]],
    ])
  })

  it("returns nothing for an unknown source", () => {
    expect(reach(graph(source("a")), filter(true), ["zzz"])).toEqual([])
  })
})
