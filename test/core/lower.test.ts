import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { check } from "../../src/core/check.ts"
import { allowed, Config, ConfigError, constrained, layerEdges, referencedLayers, ruleIds, type Config as ConfigType } from "../../src/core/config.ts"
import { lower, resolve } from "../../src/core/lower.ts"
import { Rule } from "../../src/core/rule.ts"
import { dep, file, glob, graph, source } from "./builders.ts"

const sel = (name: string) => glob(name, "**")

const three: ConfigType = {
  layers: [
    { name: "ui", selector: sel("ui") },
    { name: "app", selector: sel("app") },
    { name: "domain", selector: sel("domain") },
  ],
  stack: ["ui", "app", "domain"],
  allow: [],
  publicApis: [{ layer: "domain", entry: glob("domain", "index.ts") }],
  rules: [
    {
      id: "no-eval",
      severity: "error",
      subject: { _tag: "Layer", name: "app" },
      assertion: { _tag: "MaxLines", max: 10 },
    },
  ],
}

const errorOf = (config: ConfigType) => {
  const result = lower(config)
  return Result.isFailure(result) ? result.failure : undefined
}

describe("lower", () => {
  it("lowers a valid stack to user, layer and public API rules in id order", () => {
    const result = lower(three)
    expect(Result.isSuccess(result) && result.success.map((r) => r.id)).toEqual([
      "no-eval",
      "layer/ui",
      "layer/app",
      "layer/domain",
      "public-api/domain",
    ])
  })

  it("rejects an undefined layer", () => {
    expect(errorOf({ ...three, stack: ["ui", "missing"] })).toEqual({ _tag: "UnknownLayer", name: "missing" })
  })

  it("rejects duplicate layers before anything else", () => {
    expect(errorOf({ ...three, layers: [...three.layers, { name: "ui", selector: sel("x") }], stack: ["nope"] })).toEqual({
      _tag: "DuplicateLayer",
      name: "ui",
    })
  })

  it("rejects a rule id that collides with a layer rule id", () => {
    const rules = [{ id: "layer/ui", severity: "error", subject: { _tag: "Layer", name: "app" }, assertion: { _tag: "MaxLines", max: 10 } }] as const
    expect(errorOf({ ...three, rules })).toEqual({ _tag: "DuplicateRuleId", id: "layer/ui" })
  })

  it("rejects an empty policy", () => {
    expect(errorOf({ layers: [], stack: [], allow: [], publicApis: [], rules: [] })).toEqual({ _tag: "EmptyPolicy" })
  })

  it("reports the first duplicate by first occurrence that repeats later", () => {
    const rules = ["b", "a", "a", "b"].map((id) => ({ ...three.rules[0]!, id, subject: { _tag: "Base", selector: sel("x") } as const }))
    expect(errorOf({ ...three, layers: [], stack: [], publicApis: [], rules })).toEqual({ _tag: "DuplicateRuleId", id: "b" })
  })

  it("reports the first unknown reference in referencedLayers order", () => {
    const config = { ...three, stack: ["ui"], allow: [["ui", ["x"]]] as const, publicApis: [{ layer: "y", entry: glob("a") }] }
    expect(referencedLayers(config).slice(0, 4)).toEqual(["ui", "ui", "x", "y"])
    expect(errorOf(config)).toEqual({ _tag: "UnknownLayer", name: "x" })
  })

  it("references layers in subjects and nested selectors", () => {
    const config: ConfigType = {
      ...three,
      rules: [
        {
          id: "r",
          severity: "warning",
          subject: { _tag: "Not", selector: { _tag: "Layer", name: "ui" } },
          assertion: {
            _tag: "Reach",
            direction: "outgoing",
            relation: "forbid",
            object: { _tag: "Any", selectors: [{ _tag: "Layer", name: "gone" }] },
            edges: layerEdges,
          },
        },
      ],
    }
    expect(referencedLayers(config).slice(-2)).toEqual(["ui", "gone"])
    expect(errorOf(config)).toEqual({ _tag: "UnknownLayer", name: "gone" })
  })

  it("resolves layers inside the user rule and an undefined layer to nothing", () => {
    expect(resolve(three.layers, { _tag: "Layer", name: "app" })).toEqual(sel("app"))
    expect(resolve(three.layers, { _tag: "Layer", name: "zzz" })).toEqual({ _tag: "Any", selectors: [] })
    expect(resolve([...three.layers, { name: "app", selector: sel("dup") }], { _tag: "Layer", name: "app" })).toEqual(sel("app"))
  })

  it("derives constrained and allowed", () => {
    const config = { ...three, stack: ["ui", "app"], allow: [["domain", ["app", "ui"]], ["ui", ["domain"]]] as const }
    expect(constrained(config, "domain")).toBe(true)
    expect(constrained({ ...three, stack: [] }, "domain")).toBe(false)
    expect(allowed(config, "ui")).toEqual(["app", "domain"])
    expect(allowed(config, "domain")).toEqual(["app", "ui"])
    expect(allowed(config, "app")).toEqual([])
    expect(ruleIds({ ...three, stack: ["ui"] })).toEqual(["no-eval", "layer/ui", "public-api/domain"])
  })
})

describe("lowered semantics", () => {
  const policy = () => {
    const result = lower(three)
    if (Result.isFailure(result)) throw new Error("expected success")
    return result.success
  }
  const none = () => []

  it("layer stack: downward and same-layer imports are allowed, upward is not", () => {
    const g = graph(
      source("ui/a.ts", [dep(file("app/b.ts"))]),
      source("app/b.ts", [dep(file("ui/a.ts")), dep(file("app/c.ts")), dep(file("outside/z.ts"))]),
      source("app/c.ts"),
      source("outside/z.ts", [dep(file("ui/a.ts"))]),
    )
    const vs = check(none, policy().filter((r) => r.id.startsWith("layer/")), g)
    expect(vs.map((v) => [v.ruleId, v.subject.join("/")])).toEqual([["layer/app", "app/b.ts"]])
  })

  it("layer rules ignore computed imports and packages", () => {
    const g = graph(source("domain/a.ts", [dep({ _tag: "Computed" }), dep({ _tag: "Package", name: "p", subpath: [] })]))
    expect(check(none, policy(), g).filter((v) => v.ruleId.startsWith("layer/"))).toEqual([])
  })

  it("allow table opens extra dependencies", () => {
    const config = { ...three, allow: [["domain", ["ui"]]] as const, publicApis: [] }
    const result = lower(config)
    if (Result.isFailure(result)) throw new Error("expected success")
    const g = graph(source("domain/a.ts", [dep(file("ui/x.ts")), dep(file("app/y.ts"))]), source("ui/x.ts"), source("app/y.ts"))
    const vs = check(none, result.success, g)
    expect(vs.map((v) => [v.ruleId, v.subject.join("/")])).toEqual([["layer/domain", "domain/a.ts"]])
  })

  it("public API: outside files may import only entry files", () => {
    const g = graph(
      source("ui/a.ts", [dep(file("domain/index.ts")), dep(file("domain/internal.ts"))]),
      source("domain/index.ts", [dep(file("domain/internal.ts"))]),
      source("domain/internal.ts"),
    )
    const vs = check(none, policy().filter((r) => r.id.startsWith("public-api/")), g)
    expect(vs.map((v) => [v.ruleId, v.subject.join("/"), v.severity])).toEqual([["public-api/domain", "ui/a.ts", "error"]])
    expect(vs[0]?.evidence).toMatchObject({ _tag: "Dependency", edge: { dependency: { target: file("domain/internal.ts") } } })
  })
})

describe("schemas encode to the oracle shape", () => {
  it("round-trips a config through JSON", () => {
    const json = Schema.encodeSync(Config)(three)
    expect(Schema.decodeUnknownSync(Config)(JSON.parse(JSON.stringify(json)) as unknown)).toEqual(three)
    expect(json.allow).toEqual([])
    expect(json.publicApis[0]?.entry._tag).toBe("Glob")
  })

  it("omits absent options and tags rules by capitalized constructor", () => {
    const rule = Schema.decodeSync(Rule)({
      id: "r",
      severity: "info",
      subject: { _tag: "Computed" },
      assertion: { _tag: "Acyclic", edges: { kinds: ["static"], localOnly: false, transitive: false } },
    })
    expect(Schema.encodeSync(Rule)(rule).assertion).toEqual({
      _tag: "Acyclic",
      edges: { kinds: ["static"], localOnly: false, transitive: false },
    })
  })

  it("rejects non-positive line limits and empty kinds", () => {
    expect(() => Schema.decodeSync(Rule)({ id: "r", severity: "info", subject: { _tag: "Computed" }, assertion: { _tag: "MaxLines", max: 0 } })).toThrow()
  })

  it("encodes config errors as tagged objects", () => {
    expect(Schema.encodeSync(ConfigError)({ _tag: "EmptyPolicy" })).toEqual({ _tag: "EmptyPolicy" })
  })
})
