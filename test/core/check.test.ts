import { describe, expect, it } from "@effect/vitest"
import { check, checkWith, dedupByKey } from "../../src/core/check.ts"
import { admits, type Graph } from "../../src/core/model.ts"
import type { ReachFn } from "../../src/core/reach.ts"
import { basename, collapse, folderOf, restrict, type CustomRules, type Violation } from "../../src/core/rule.ts"
import { dep, edge, file, filter, glob, graph, loc, path, rule, source } from "./builders.ts"

const none: CustomRules = () => []

describe("Lean examples with direct-only reachability", () => {
  const toB = dep(file("b.ts"), "static", "./b.js")
  const toC = dep(file("c.ts"), "static", "./c.js")
  const g = graph(
    source("a.ts", [toB, toC, toB], { lines: 1 }),
    source("b.ts", [toC], { lines: 1 }),
    source("c.ts", [], { lines: 1 }),
  )
  const direct = { kinds: ["static"], localOnly: false, transitive: false } as const
  const directReach: ReachFn = (graph, ef, s) => {
    const f = graph.files.find((x) => x.path.join("/") === s.join("/"))
    return f === undefined
      ? []
      : f.dependencies.filter((d) => admits(ef, d)).map((d) => [d.target, [{ source: s, dependency: d }]] as const)
  }
  const run = checkWith(directReach)
  const forbidB = rule("forbid-b", glob("a*"), {
    _tag: "Reach",
    direction: "outgoing",
    relation: "forbid",
    object: glob("b*"),
    edges: direct,
  })

  it("collapses identical import sites", () => {
    expect(run(none, [forbidB], g)).toEqual([
      { ruleId: "forbid-b", severity: "error", subject: ["a.ts"], evidence: { _tag: "Dependency", edge: edge("a.ts", toB) } },
    ])
  })

  it("runs rules in policy order, then subjects, then imports", () => {
    const r2 = rule(
      "r2",
      glob("a*"),
      { _tag: "Reach", direction: "outgoing", relation: "forbid", object: glob("c*"), edges: direct },
      "warning",
    )
    expect(run(none, [r2, forbidB], g).map((v) => [v.ruleId, v.evidence])).toEqual([
      ["r2", { _tag: "Dependency", edge: edge("a.ts", toC) }],
      ["forbid-b", { _tag: "Dependency", edge: edge("a.ts", toB) }],
    ])
  })

  it("reports missing for an unmet require", () => {
    const needsA = rule("needs-a", glob("c*"), {
      _tag: "Reach",
      direction: "outgoing",
      relation: "require",
      object: glob("a*"),
      edges: direct,
    })
    expect(run(none, [needsA], g)).toEqual([
      { ruleId: "needs-a", severity: "error", subject: ["c.ts"], evidence: { _tag: "Missing" } },
    ])
  })

  it("collapses identical custom messages", () => {
    expect(run(() => ["m", "m"], [rule("c", glob("b*"), { _tag: "Custom", name: "x" }, "info")], g)).toEqual([
      { ruleId: "c", severity: "info", subject: ["b.ts"], evidence: { _tag: "Custom", message: "m" } },
    ])
  })
})

describe("outgoing forbid", () => {
  const g = graph(
    source("src/app/a.ts", [dep(file("src/domain/b.ts"))]),
    source("src/domain/b.ts", [dep(file("src/infra/c.ts"))]),
    source("src/infra/c.ts", [dep({ _tag: "Package", name: "pg", subpath: [] })]),
  )
  const forbid = (transitive: boolean) =>
    rule("no-infra", glob("src", "app", "**"), {
      _tag: "Reach",
      direction: "outgoing",
      relation: "forbid",
      object: glob("src", "infra", "**"),
      edges: filter(transitive),
    })

  it("does not see indirect dependencies when direct", () => {
    expect(check(none, [forbid(false)], g)).toEqual([])
  })

  it("reports one walk per forbidden target when transitive", () => {
    const [v, ...rest] = check(none, [forbid(true)], g)
    expect(rest).toEqual([])
    expect(v?.subject).toEqual(path("src/app/a.ts"))
    expect(v?.evidence).toEqual({
      _tag: "Walk",
      target: file("src/infra/c.ts"),
      edges: [edge("src/app/a.ts", dep(file("src/domain/b.ts"))), edge("src/domain/b.ts", dep(file("src/infra/c.ts")))],
    })
  })

  it("fails closed on computed imports", () => {
    const computed = graph(source("src/app/a.ts", [dep({ _tag: "Computed" })]))
    expect(check(none, [forbid(false)], computed)).toHaveLength(1)
  })
})

describe("require", () => {
  const g = graph(source("a", [dep({ _tag: "Computed" })]), source("b", [dep(file("c"))]), source("c"))
  const requireC = (direction: "outgoing" | "incoming", subject: ReturnType<typeof glob>, object: ReturnType<typeof glob>) =>
    rule("req", subject, { _tag: "Reach", direction, relation: "require", object, edges: filter(true) })

  it("outgoing: a computed import never satisfies", () => {
    const anything = { _tag: "Not", selector: { _tag: "Any", selectors: [] } } as const
    expect(check(none, [requireC("outgoing", glob("a"), anything)], g).map((v) => v.subject)).toEqual([["a"]])
    expect(check(none, [requireC("outgoing", glob("b"), glob("c"))], g)).toEqual([])
  })

  it("incoming: needs a dependent", () => {
    expect(check(none, [requireC("incoming", glob("c"), glob("b"))], g)).toEqual([])
    expect(check(none, [requireC("incoming", glob("b"), glob("c"))], g)).toHaveLength(1)
  })
})

describe("incoming forbid", () => {
  const g = graph(source("a", [dep(file("b"))]), source("b", [dep(file("c"))]), source("c", [dep(file("c"))]))
  const forbid = (transitive: boolean, subject: string) =>
    rule("in", glob(subject), {
      _tag: "Reach",
      direction: "incoming",
      relation: "forbid",
      object: glob("*"),
      edges: filter(transitive),
    })

  it("direct: reports the dependent's import site", () => {
    expect(check(none, [forbid(false, "b")], g).map((v) => v.evidence)).toEqual([
      { _tag: "Dependency", edge: edge("a", dep(file("b"))) },
    ])
  })

  it("transitive: reports each dependent with its walk", () => {
    expect(check(none, [forbid(true, "c")], g).map((v) => v.evidence)).toEqual([
      { _tag: "Walk", target: file("a"), edges: [edge("a", dep(file("b"))), edge("b", dep(file("c")))] },
      { _tag: "Walk", target: file("b"), edges: [edge("b", dep(file("c")))] },
    ])
  })

  it("excludes the subject itself as a dependent", () => {
    expect(check(none, [forbid(false, "c")], g).map((v) => v.evidence)).toEqual([
      { _tag: "Dependency", edge: edge("b", dep(file("c"))) },
    ])
  })
})

describe("acyclic", () => {
  const g = graph(
    source("src/a/x.ts", [dep(file("src/b/y.ts"))]),
    source("src/b/y.ts", [dep(file("src/a/z.ts"))]),
    source("src/a/z.ts"),
    source("other/o.ts", [dep(file("src/a/x.ts"))]),
  )
  const acyclic = (folderDepth?: number) =>
    rule("acyclic", glob("src", "**"), {
      _tag: "Acyclic",
      edges: filter(false),
      ...(folderDepth === undefined ? {} : { folderDepth }),
    })

  it("finds no file cycle", () => {
    expect(check(none, [acyclic()], g)).toEqual([])
  })

  it("finds a folder cycle after collapsing, once per folder, with a folder subject", () => {
    const violations = check(none, [acyclic(2)], g)
    expect(violations.map((v) => v.subject)).toEqual([["src", "a"], ["src", "b"]])
    expect(violations.map((v) => v.evidence._tag)).toEqual(["Cycle", "Cycle"])
  })

  it("reports a file cycle through the subject", () => {
    const cyc = graph(source("a", [dep(file("b"))]), source("b", [dep(file("a"))]))
    expect(check(none, [rule("c", glob("*"), { _tag: "Acyclic", edges: filter(false) })], cyc).map((v) => v.subject)).toEqual([["a"], ["b"]])
  })
})

describe("resolvable", () => {
  const g = graph(source("a", [dep({ _tag: "Unresolved", specifier: "./x" }), dep({ _tag: "Computed" }), dep(file("a"))]))
  const resolvable = (allowComputed: boolean) => rule("res", glob("a"), { _tag: "Resolvable", allowComputed })

  it("rejects unresolved and, unless allowed, computed", () => {
    expect(check(none, [resolvable(false)], g)).toHaveLength(2)
    expect(check(none, [resolvable(true)], g)).toHaveLength(1)
  })
})

describe("declares", () => {
  const decl = (name: string, over: object = {}) => ({
    name,
    kind: "class" as const,
    exported: true,
    abstract: false,
    extended: [],
    implemented: [],
    decorators: [],
    methods: [],
    readonlyProperties: false,
    location: loc,
    ...over,
  })

  it("every: holds vacuously for a file without declarations", () => {
    const g = graph(source("a"))
    expect(check(none, [rule("d", glob("a"), { _tag: "Declares", quantifier: "every", predicate: { _tag: "Abstract" } })], g)).toEqual([])
  })

  it("every reports failing declarations, none reports matching ones", () => {
    const g = graph(source("a", [], { declarations: [decl("A", { abstract: true }), decl("B")] }))
    const run = (quantifier: "every" | "none") =>
      check(none, [rule("d", glob("a"), { _tag: "Declares", quantifier, predicate: { _tag: "Abstract" } })], g).map((v) =>
        v.evidence._tag === "Declaration" ? v.evidence.name : "",
      )
    expect(run("every")).toEqual(["B"])
    expect(run("none")).toEqual(["A"])
  })

  it("hasMethods with visibility, onlyPublicMethods and all", () => {
    const g = graph(
      source("a", [], {
        declarations: [decl("A", { methods: [{ name: "run", visibility: "private", isStatic: false }] })],
      }),
    )
    const names = (predicate: Parameters<typeof rule>[2] extends infer R ? (R extends { predicate: infer P } ? P : never) : never) =>
      check(none, [rule("d", glob("a"), { _tag: "Declares", quantifier: "none", predicate })], g).length
    expect(names({ _tag: "HasMethods", names: ["run"] })).toBe(1)
    expect(names({ _tag: "HasMethods", names: ["run"], visibility: "public" })).toBe(0)
    expect(names({ _tag: "OnlyPublicMethods" })).toBe(0)
    expect(names({ _tag: "All", predicates: [{ _tag: "Exported" }, { _tag: "Kind", kinds: ["class"] }] })).toBe(1)
    expect(names({ _tag: "All", predicates: [] })).toBe(1)
  })
})

describe("exportsOnly, uses, named, maxLines", () => {
  it("exportsOnly reports exports outside the list in order", () => {
    const g = graph(source("a", [], { exports: ["x", "z", "y"] }))
    const vs = check(none, [rule("e", glob("a"), { _tag: "ExportsOnly", names: ["y"] })], g)
    expect(vs.map((v) => v.evidence)).toEqual([{ _tag: "Export", name: "x" }, { _tag: "Export", name: "z" }])
  })

  const evalGlobal = { kind: "call" as const, name: "eval", binding: { _tag: "Global" as const }, location: loc }
  const evalLocal = { ...evalGlobal, binding: { _tag: "Local" as const } }
  const g = graph(source("a", [], { uses: [evalGlobal, evalLocal] }), source("b"))

  it("uses forbid: Global matches, Local does not", () => {
    const vs = check(none, [rule("u", glob("*"), { _tag: "Uses", relation: "forbid", use: { _tag: "Globals", names: ["eval"] } })], g)
    expect(vs).toHaveLength(1)
    expect(vs[0]?.evidence).toEqual({ _tag: "Use", use: evalGlobal })
  })

  it("uses require: missing where nothing matches", () => {
    const vs = check(none, [rule("u", glob("*"), { _tag: "Uses", relation: "require", use: { _tag: "Globals", names: ["eval"] } })], g)
    expect(vs.map((v) => v.subject)).toEqual([["b"]])
  })

  it("imported uses match source and name", () => {
    const imported = { kind: "call" as const, name: "f", binding: { _tag: "Imported" as const, name: { source: "m", name: "f" } }, location: loc }
    const gi = graph(source("a", [], { uses: [imported] }))
    const run = (source: string) =>
      check(none, [rule("u", glob("a"), { _tag: "Uses", relation: "forbid", use: { _tag: "Imported", source, names: ["f"] } })], gi).length
    expect(run("m")).toBe(1)
    expect(run("n")).toBe(0)
  })

  it("named prefix and suffix, forbid and require", () => {
    const gn = graph(source("src/UserService.ts"), source("src/user.ts"))
    const run = (relation: "forbid" | "require", affix: "prefix" | "suffix", value: string) =>
      check(none, [rule("n", glob("src", "*"), { _tag: "Named", relation, affix, value })], gn).map((v) => v.evidence)
    expect(run("require", "suffix", "Service.ts")).toEqual([{ _tag: "Name", basename: "user.ts" }])
    expect(run("forbid", "prefix", "User")).toEqual([{ _tag: "Name", basename: "UserService.ts" }])
    expect(run("forbid", "suffix", "")).toHaveLength(2)
  })

  it("affixes compare code points", () => {
    const gn = graph(source("😀a.ts"))
    const run = (value: string) =>
      check(none, [rule("n", glob("*"), { _tag: "Named", relation: "forbid", affix: "prefix", value })], gn).length
    expect(run("😀")).toBe(1)
    expect(run("\ud83d")).toBe(0)
  })

  it("maxLines is strict", () => {
    const gl = graph(source("a", [], { lines: 10 }), source("b", [], { lines: 11 }))
    const vs = check(none, [rule("l", glob("*"), { _tag: "MaxLines", max: 10 })], gl)
    expect(vs.map((v) => [v.subject, v.evidence])).toEqual([[["b"], { _tag: "Lines", count: 11 }]])
  })
})

describe("custom and dedup", () => {
  it("passes name, graph and subject to the closure", () => {
    const g = graph(source("a"), source("b"))
    const seen: Array<string> = []
    const vs = check(
      (name, graphArg, subject) => {
        seen.push(`${name}:${graphArg.files.length}:${subject.join("/")}`)
        return [`m-${subject.join("/")}`]
      },
      [rule("c", glob("*"), { _tag: "Custom", name: "x" })],
      g,
    )
    expect(seen).toEqual(["x:2:a", "x:2:b"])
    expect(vs.map((v) => v.evidence)).toEqual([{ _tag: "Custom", message: "m-a" }, { _tag: "Custom", message: "m-b" }])
  })

  it("dedupByKey keeps the first witness of a walk key", () => {
    const base = { ruleId: "r", severity: "error", subject: ["a"] } as const
    const first: Violation = { ...base, evidence: { _tag: "Walk", target: file("x"), edges: [edge("a", dep(file("x")))] } }
    const second: Violation = { ...base, evidence: { _tag: "Walk", target: file("x"), edges: [] } }
    expect(dedupByKey([first, second])).toEqual([first])
  })

  it("keys distinguish import sites that differ in location", () => {
    const d1 = dep(file("b"))
    const d2 = { ...d1, location: { line: 2, column: 1 } }
    const g = graph(source("a", [d1, d2]), source("b"))
    expect(check(none, [rule("r", glob("a"), { _tag: "Resolvable", allowComputed: false })], g)).toEqual([])
    const forbid = rule("f", glob("a"), { _tag: "Reach", direction: "outgoing", relation: "forbid", object: glob("b"), edges: filter(false) })
    expect(check(none, [forbid], g)).toHaveLength(2)
  })
})

describe("graph transformations", () => {
  it("basename of the empty path is empty", () => {
    expect(basename([])).toBe("")
    expect(basename(["a", "b.ts"])).toBe("b.ts")
  })

  it("folderOf drops the file and takes depth segments", () => {
    expect(folderOf(2, ["src", "a", "b", "c.ts"])).toEqual(["src", "a"])
    expect(folderOf(5, ["src", "a", "c.ts"])).toEqual(["src", "a"])
    expect(folderOf(0, ["src", "c.ts"])).toEqual([])
    expect(folderOf(1, ["c.ts"])).toEqual([])
  })

  it("restrict keeps only inner file dependencies", () => {
    const g = graph(source("a", [dep(file("b")), dep(file("c")), dep({ _tag: "Computed" })]), source("b"), source("c"))
    const r: Graph = restrict(g, (p) => p[0] !== "c")
    expect(r.files.map((f) => f.path)).toEqual([["a"], ["b"]])
    expect(r.files[0]?.dependencies).toEqual([dep(file("b"))])
  })

  it("collapse orders folders by first occurrence and drops intra-folder edges", () => {
    const g = graph(
      source("z/a.ts", [dep(file("y/b.ts")), dep(file("z/c.ts"))]),
      source("y/b.ts", [dep(file("z/a.ts"), "type", "s")]),
      source("z/c.ts"),
    )
    const c = collapse(g, 1)
    expect(c.files.map((f) => f.path)).toEqual([["z"], ["y"]])
    expect(c.files[0]?.dependencies).toEqual([dep(file("y"))])
    expect(c.files[1]?.dependencies).toEqual([dep(file("z"), "type", "s")])
    expect(c.files[0]?.lines).toBe(0)
  })
})
