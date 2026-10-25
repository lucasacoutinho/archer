import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import type { PathToken, SegmentToken, Selector, Target } from "../../src/core/model.ts"
import { accepts, type Token } from "../../src/core/pattern.ts"
import { pathAccepts, segmentAccepts, selects } from "../../src/core/selector.ts"

const literal = (text: string): Array<SegmentToken> => Array.from(text, (char) => ({ _tag: "Literal", char }))
const star: SegmentToken = { _tag: "Star" }
const one: SegmentToken = { _tag: "One" }
const segment = (...tokens: ReadonlyArray<SegmentToken | ReadonlyArray<SegmentToken>>): PathToken => ({
  _tag: "Segment",
  tokens: tokens.flat(),
})
const globstar: PathToken = { _tag: "Globstar" }
const file = (path: string): Target => ({ _tag: "File", path: path.split("/") })

describe("segment patterns", () => {
  const tsFiles = [star, ...literal(".ts")]

  it("matches a suffix after any run of characters", () => {
    expect(segmentAccepts(tsFiles, "order.ts")).toBe(true)
    expect(segmentAccepts(tsFiles, "order.tsx")).toBe(false)
  })

  it("lets * match names that start with a dot", () => {
    expect(segmentAccepts(tsFiles, ".ts")).toBe(true)
  })

  it("matches exactly one code point with ?", () => {
    expect(segmentAccepts([one, ...literal(".ts")], "a.ts")).toBe(true)
    expect(segmentAccepts([one, ...literal(".ts")], "ab.ts")).toBe(false)
    expect(segmentAccepts([one], "😀")).toBe(true)
  })
})

describe("path patterns", () => {
  const domain = [segment(literal("src")), segment(literal("domain")), globstar]

  it("selects every file under a directory with **", () => {
    expect(pathAccepts(domain, ["src", "domain", "order.ts"])).toBe(true)
    expect(pathAccepts(domain, ["src", "domain", "model", "order.ts"])).toBe(true)
    expect(pathAccepts(domain, ["src", "application", "create.ts"])).toBe(false)
  })

  it("matches zero segments with **", () => {
    expect(pathAccepts(domain, ["src", "domain"])).toBe(true)
  })

  it("does not let a segment pattern cross a separator", () => {
    expect(pathAccepts([segment(literal("src")), segment(star)], ["src", "a", "b.ts"])).toBe(false)
  })
})

describe("selectors", () => {
  const react: Selector = { _tag: "Package", name: "react" }

  it("selects packages by name with any subpath", () => {
    expect(selects(react, { _tag: "Package", name: "react", subpath: ["jsx-runtime"] })).toBe(true)
    expect(selects(react, { _tag: "Package", name: "react-dom", subpath: [] })).toBe(false)
    expect(selects({ _tag: "Package" }, { _tag: "Package", name: "zod", subpath: [] })).toBe(true)
  })

  it("selects built-ins by runtime", () => {
    const fs: Target = { _tag: "Builtin", runtime: "node", name: "fs" }
    expect(selects({ _tag: "Builtin", runtime: "node" }, fs)).toBe(true)
    expect(selects({ _tag: "Builtin", runtime: "bun" }, fs)).toBe(false)
  })

  it("never selects a non-file target with a glob", () => {
    expect(selects({ _tag: "Glob", tokens: [globstar] }, { _tag: "Computed" })).toBe(false)
  })

  it("combines selectors as a boolean algebra", () => {
    const outsideGenerated: Selector = {
      _tag: "All",
      selectors: [
        { _tag: "Glob", tokens: [segment(literal("src")), globstar] },
        { _tag: "Not", selector: { _tag: "Glob", tokens: [segment(literal("src")), segment(literal("gen")), globstar] } },
      ],
    }
    expect(selects(outsideGenerated, file("src/app/main.ts"))).toBe(true)
    expect(selects(outsideGenerated, file("src/gen/client.ts"))).toBe(false)
    expect(selects({ _tag: "Any", selectors: [] }, file("a.ts"))).toBe(false)
    expect(selects({ _tag: "All", selectors: [] }, file("a.ts"))).toBe(true)
  })
})

describe("properties proved in Lean (Archer.Pattern)", () => {
  const Chars = Schema.Array(Schema.String.check(Schema.isBetweenCodePoints(1, 1)))
  const many: Token = { _tag: "Many" }
  const equals = (char: string): Token => ({ _tag: "Sat", test: (value) => value === char })

  it.prop("P2: a lone * accepts every list", [Chars], ([chars]) => accepts([many], chars))

  it.prop("P3: a pattern without * accepts only lists of its own length", [Chars, Chars], ([pattern, chars]) => {
    const tokens = pattern.map(equals)
    return !accepts(tokens, chars) || chars.length === tokens.length
  })

  it.prop("P4: appending * to a match accepts every extension", [Chars, Chars], ([prefix, rest]) =>
    accepts([...prefix.map(equals), many], [...prefix, ...rest]),
  )
})
