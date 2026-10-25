import { describe, expect, it } from "@effect/vitest"
import { Option, Result, Schema } from "effect"
import type { ConfigSelector } from "../../src/core/config.ts"
import type { PathToken, SegmentToken, Selector } from "../../src/core/model.ts"
import { structuralEquals } from "../../src/core/structural.ts"
import { ParseError, parse, print, SelectorText } from "../../src/core/text.ts"
import * as Generate from "../differential/generate.ts"

const lit = (text: string): Array<SegmentToken> => Array.from(text, (char) => ({ _tag: "Literal", char }))
const word = (text: string): PathToken => ({ _tag: "Segment", tokens: lit(text) })
const segment = (...tokens: ReadonlyArray<SegmentToken>): PathToken => ({ _tag: "Segment", tokens })
const globstar: PathToken = { _tag: "Globstar" }
const star: SegmentToken = { _tag: "Star" }
const one: SegmentToken = { _tag: "One" }

const base = (selector: Selector): ConfigSelector => ({ _tag: "Base", selector })
const glob = (...tokens: ReadonlyArray<PathToken>): ConfigSelector => base({ _tag: "Glob", tokens })
const layer = (name: string): ConfigSelector => ({ _tag: "Layer", name })
const any = (...selectors: ReadonlyArray<ConfigSelector>): ConfigSelector => ({ _tag: "Any", selectors })

/** The oracle's encoding: `{ok}` or `{error}`. */
const outcome = (text: string) =>
  Result.match(parse(text), { onSuccess: (ok) => ({ ok }), onFailure: (error) => ({ error }) })

const ok = (selector: ConfigSelector) => ({ ok: selector })
const fails = (error: ParseError) => ({ error })

const rendered = (text: string): string | undefined =>
  Option.getOrUndefined(Option.flatMap(Result.getSuccess(parse(text)), print))

describe("parse: path globs", () => {
  it("selects everything under a plain path with a final **", () => {
    expect(outcome("src/domain")).toEqual(ok(glob(word("src"), word("domain"), globstar)))
    expect(outcome("src")).toEqual(ok(glob(word("src"), globstar)))
  })

  it("drops one leading ./", () => {
    expect(outcome("./src/domain")).toEqual(outcome("src/domain"))
    expect(outcome("./*.ts")).toEqual(outcome("*.ts"))
  })

  it("means exactly its tokens when it has a wildcard", () => {
    expect(outcome("src/**/*.ts")).toEqual(ok(glob(word("src"), globstar, segment(star, ...lit(".ts")))))
    expect(outcome("src/*")).toEqual(ok(glob(word("src"), segment(star))))
    expect(outcome("src/?x")).toEqual(ok(glob(word("src"), segment(one, ...lit("x")))))
    expect(outcome("**")).toEqual(ok(glob(globstar)))
  })

  it("reads ** as a globstar only as a whole segment", () => {
    expect(outcome("a**")).toEqual(ok(glob(segment(...lit("a"), star, star))))
    expect(outcome("***")).toEqual(ok(glob(segment(star, star, star))))
    expect(outcome("**/**")).toEqual(ok(glob(globstar, globstar)))
  })

  it("accepts names that start with a dot", () => {
    expect(outcome(".hidden/x")).toEqual(ok(glob(word(".hidden"), word("x"), globstar)))
    expect(outcome("...")).toEqual(ok(glob(word("..."), globstar)))
  })

  it("works on code points", () => {
    expect(outcome("😀?")).toEqual(ok(glob(segment(...lit("😀"), one))))
    expect(lit("😀")).toHaveLength(1)
    expect(outcome("a\u{1F600}b/**")).toEqual(ok(glob(word("a\u{1F600}b"), globstar)))
  })

  it.each([
    ["src//a", ""],
    ["/src", ""],
    ["src/", ""],
    ["a/./b", "."],
    ["a/../b", ".."],
    [".", "."],
    ["..", ".."],
    ["./", ""],
    ["././a", "."],
    [".//a", ""],
  ])("rejects %j as an invalid segment %j", (text, segmentText) => {
    expect(outcome(text)).toEqual(fails({ _tag: "InvalidSegment", text: segmentText }))
  })

  it.each([
    ["a\\b", "\\"],
    ["[a]", "["],
    ["a]", "]"],
    ["src/[ab].ts", "["],
  ])("rejects %j for the unsupported character %j", (text, char) => {
    expect(outcome(text)).toEqual(fails({ _tag: "Unsupported", char }))
  })
})

describe("parse: prefixed forms", () => {
  it("reads the npm forms", () => {
    expect(outcome("npm:*")).toEqual(ok(base({ _tag: "Package" })))
    expect(outcome("npm:react")).toEqual(ok(base({ _tag: "Package", name: "react" })))
    expect(outcome("npm:@scope/name")).toEqual(ok(base({ _tag: "Package", name: "@scope/name" })))
  })

  it("accepts @scope as an unscoped package", () => {
    expect(outcome("npm:@scope")).toEqual(ok(base({ _tag: "Package", name: "@scope" })))
    expect(outcome("npm:@")).toEqual(ok(base({ _tag: "Package", name: "@" })))
  })

  it("takes a name that only contains * as a name", () => {
    expect(outcome("npm:**")).toEqual(ok(base({ _tag: "Package", name: "**" })))
    expect(outcome("npm:a*")).toEqual(ok(base({ _tag: "Package", name: "a*" })))
  })

  it.each(["", "a/b", "/a", "a/", "@/x", "@s/", "@s/x/y", "@s//x"])("rejects the npm name %j", (name) => {
    expect(outcome(`npm:${name}`)).toEqual(fails({ _tag: "InvalidName", kind: "npm", name }))
  })

  it("reads the built-in forms", () => {
    expect(outcome("node:*")).toEqual(ok(base({ _tag: "Builtin", runtime: "node" })))
    expect(outcome("bun:*")).toEqual(ok(base({ _tag: "Builtin", runtime: "bun" })))
    expect(outcome("node:fs")).toEqual(ok(base({ _tag: "Builtin", runtime: "node", name: "fs" })))
    expect(outcome("node:fs/promises")).toEqual(ok(base({ _tag: "Builtin", runtime: "node", name: "fs/promises" })))
    expect(outcome("bun:test")).toEqual(ok(base({ _tag: "Builtin", runtime: "bun", name: "test" })))
    expect(outcome("node:**")).toEqual(ok(base({ _tag: "Builtin", runtime: "node", name: "**" })))
  })

  it("rejects a built-in without a name", () => {
    expect(outcome("node:")).toEqual(fails({ _tag: "InvalidName", kind: "node", name: "" }))
    expect(outcome("bun:")).toEqual(fails({ _tag: "InvalidName", kind: "bun", name: "" }))
  })

  it("reads layers, with * as a layer name", () => {
    expect(outcome("layer:app")).toEqual(ok(layer("app")))
    expect(outcome("layer:*")).toEqual(ok(layer("*")))
    expect(outcome("layer:a/b")).toEqual(ok(layer("a/b")))
    expect(outcome("layer:")).toEqual(fails({ _tag: "InvalidName", kind: "layer", name: "" }))
  })

  it("reads the unresolved and computed forms", () => {
    expect(outcome("unresolved:*")).toEqual(ok(base({ _tag: "Unresolved" })))
    expect(outcome("computed:*")).toEqual(ok(base({ _tag: "Computed" })))
  })

  it.each(["unresolved", "computed"])("rejects any name but * after %s:", (kind) => {
    expect(outcome(`${kind}:x`)).toEqual(fails({ _tag: "InvalidName", kind, name: "x" }))
    expect(outcome(`${kind}:`)).toEqual(fails({ _tag: "InvalidName", kind, name: "" }))
    expect(outcome(`${kind}:**`)).toEqual(fails({ _tag: "InvalidName", kind, name: "**" }))
  })

  it("never reads a prefixed form as a path", () => {
    expect(outcome("npm:a/b\\c")).toEqual(fails({ _tag: "InvalidName", kind: "npm", name: "a/b\\c" }))
    expect(outcome("layer:[x]")).toEqual(ok(layer("[x]")))
    expect(outcome("node:a//b")).toEqual(ok(base({ _tag: "Builtin", runtime: "node", name: "a//b" })))
  })

  it("reads a prefix after ./ as a path", () => {
    expect(outcome("./npm:x")).toEqual(ok(glob(word("npm:x"), globstar)))
    expect(outcome("./node:*")).toEqual(ok(glob(segment(...lit("node:"), star))))
  })

  it("needs the colon", () => {
    expect(outcome("npm")).toEqual(ok(glob(word("npm"), globstar)))
    expect(outcome("npmx:a")).toEqual(ok(glob(word("npmx:a"), globstar)))
  })
})

describe("parse: braces", () => {
  it("expands alternatives into any", () => {
    expect(outcome("{src/a,src/b}")).toEqual(
      ok(any(glob(word("src"), word("a"), globstar), glob(word("src"), word("b"), globstar))),
    )
  })

  it("expands alternatives that span segments and mix forms", () => {
    expect(outcome("src/{a,b/c}/**")).toEqual(
      ok(any(glob(word("src"), word("a"), globstar), glob(word("src"), word("b"), word("c"), globstar))),
    )
    expect(outcome("{src/**,npm:react}")).toEqual(
      ok(any(glob(word("src"), globstar), base({ _tag: "Package", name: "react" }))),
    )
    expect(outcome("npm:{react,zod}")).toEqual(
      ok(any(base({ _tag: "Package", name: "react" }), base({ _tag: "Package", name: "zod" }))),
    )
  })

  it("flattens nested braces in left-major order", () => {
    expect(outcome("{a,b}{c,d}")).toEqual(
      ok(any(...["ac", "ad", "bc", "bd"].map((name) => glob(word(name), globstar)))),
    )
    expect(outcome("{a,{b,c}}")).toEqual(ok(any(...["a", "b", "c"].map((name) => glob(word(name), globstar)))))
    expect(outcome("x{a,b{c,d}}y")).toEqual(
      ok(any(...["xay", "xbcy", "xbdy"].map((name) => glob(word(name), globstar)))),
    )
  })

  it("keeps a single alternative as itself", () => {
    expect(outcome("{a}")).toEqual(outcome("a"))
    expect(outcome("a{}b")).toEqual(outcome("ab"))
    expect(outcome("{{a}}")).toEqual(outcome("a"))
  })

  it("keeps repeated alternatives", () => {
    expect(outcome("{a,a}")).toEqual(ok(any(glob(word("a"), globstar), glob(word("a"), globstar))))
  })

  it("makes an empty alternative an empty segment", () => {
    expect(outcome("{}")).toEqual(fails({ _tag: "InvalidSegment", text: "" }))
    expect(outcome("{,}")).toEqual(fails({ _tag: "InvalidSegment", text: "" }))
    expect(outcome("{a,}")).toEqual(fails({ _tag: "InvalidSegment", text: "" }))
  })

  it.each(["{a", "a}", "a,b", "}{", "{a,b", "{{a,b}", "{a,b}}", ",", "{a},b", "npm:a,b", "{a,b}}{c"])(
    "rejects %j as unbalanced",
    (text) => {
      expect(outcome(text)).toEqual(fails({ _tag: "UnbalancedBraces" }))
    },
  )
})

describe("parse: error order", () => {
  it("rejects the empty string first", () => {
    expect(outcome("")).toEqual(fails({ _tag: "Empty" }))
  })

  it("checks braces before any alternative", () => {
    expect(outcome("a//b,c")).toEqual(fails({ _tag: "UnbalancedBraces" }))
    expect(outcome("{a\\b")).toEqual(fails({ _tag: "UnbalancedBraces" }))
    expect(outcome("npm:a/b,")).toEqual(fails({ _tag: "UnbalancedBraces" }))
  })

  it("lets the first failing alternative decide", () => {
    expect(outcome("{a//b,c\\d}")).toEqual(fails({ _tag: "InvalidSegment", text: "" }))
    expect(outcome("{c\\d,a//b}")).toEqual(fails({ _tag: "Unsupported", char: "\\" }))
    expect(outcome("{npm:,a//b}")).toEqual(fails({ _tag: "InvalidName", kind: "npm", name: "" }))
  })

  it("checks unsupported characters before segments", () => {
    expect(outcome("a//b[")).toEqual(fails({ _tag: "Unsupported", char: "[" }))
    expect(outcome("a\\b]")).toEqual(fails({ _tag: "Unsupported", char: "\\" }))
    expect(outcome("]x[")).toEqual(fails({ _tag: "Unsupported", char: "]" }))
  })

  it("reports the first invalid segment", () => {
    expect(outcome("a/../b//c")).toEqual(fails({ _tag: "InvalidSegment", text: ".." }))
  })
})

describe("print", () => {
  it("writes a plain path with an explicit **", () => {
    expect(rendered("src/domain")).toBe("src/domain/**")
  })

  it("writes wildcard globs as parsed", () => {
    expect(rendered("src/**/*.ts")).toBe("src/**/*.ts")
    expect(rendered("a?/***")).toBe("a?/***")
  })

  it("writes any as braces", () => {
    expect(rendered("{src/a,src/b}/**")).toBe("{src/a/**,src/b/**}")
    expect(rendered("npm:{react,zod}")).toBe("{npm:react,npm:zod}")
    expect(rendered("{src/**,npm:react,layer:app}")).toBe("{src/**,npm:react,layer:app}")
  })

  it("writes the prefixed forms", () => {
    for (const text of ["npm:*", "npm:@scope/x", "node:*", "node:fs/promises", "bun:*", "bun:test", "layer:app", "layer:*", "unresolved:*", "computed:*"]) {
      expect(rendered(text)).toBe(text)
    }
  })

  it("starts a glob with ./ when it would read as a prefixed form", () => {
    expect(rendered("./npm:x")).toBe("./npm:x/**")
    expect(rendered("./layer:x/y")).toBe("./layer:x/y/**")
    expect(rendered("{./node:*,a}")).toBe("{./node:*,a/**}")
    expect(rendered("a/npm:x")).toBe("a/npm:x/**")
  })

  it("starts a glob with ./ when it begins with ./", () => {
    expect(print(glob(word("."), word("x")))).toEqual(Option.some("././x"))
    expect(print(glob(word("."), globstar))).toEqual(Option.some("././**"))
    expect(print(glob(word("."), word("/")))).toEqual(Option.some("././/"))
  })

  it("writes a glob without tokens as the empty string", () => {
    expect(print(glob())).toEqual(Option.some(""))
  })

  it("has no text for selectors that parse never produces", () => {
    const unresolved = base({ _tag: "Unresolved" })
    expect(print({ _tag: "Not", selector: layer("a") })).toEqual(Option.none())
    expect(print({ _tag: "All", selectors: [layer("a"), layer("b")] })).toEqual(Option.none())
    expect(print(base({ _tag: "Not", selector: { _tag: "Computed" } }))).toEqual(Option.none())
    expect(print(base({ _tag: "Any", selectors: [{ _tag: "Computed" }, { _tag: "Unresolved" }] }))).toEqual(Option.none())
    expect(print(any())).toEqual(Option.none())
    expect(print(any(layer("a")))).toEqual(Option.none())
    expect(print(any(layer("a"), any(layer("b"), layer("c"))))).toEqual(Option.none())
    expect(print(any(unresolved, { _tag: "Not", selector: unresolved }))).toEqual(Option.none())
  })
})

describe("round trip (S1)", () => {
  const texts = Array.from({ length: 3000 }, (_, index) => Generate.selectorText(Generate.random(index + 1)))
  const parsed = texts.flatMap((text) => Option.toArray(Result.getSuccess(parse(text))))

  it("has parsed inputs of every shape to work with", () => {
    const shapes = new Set(parsed.map((selector) => (selector._tag === "Base" ? selector.selector._tag : selector._tag)))
    expect([...shapes].sort()).toEqual(["Any", "Builtin", "Computed", "Glob", "Layer", "Package", "Unresolved"])
    expect(parsed.length).toBeGreaterThan(texts.length / 3)
    expect(parsed.length).toBeLessThan(texts.length)
  })

  it("prints every parsed selector, and the text parses back to the same selector", () => {
    for (const selector of parsed) {
      const text = print(selector)
      expect(Option.isSome(text)).toBe(true)
      const again = Option.flatMap(text, (printed) => Result.getSuccess(parse(printed)))
      expect(Option.map(again, (value) => structuralEquals(value, selector))).toEqual(Option.some(true))
    }
  })

  it("prints the same text again after a round trip", () => {
    for (const selector of parsed) {
      const text = print(selector)
      const again = Option.flatMap(text, (printed) => Option.flatMap(Result.getSuccess(parse(printed)), print))
      expect(again).toEqual(text)
    }
  })
})

describe("ParseError", () => {
  it("has the oracle's encoding", () => {
    const decode = Schema.decodeSync(ParseError)
    expect(decode({ _tag: "Empty" })).toEqual({ _tag: "Empty" })
    expect(decode({ _tag: "InvalidName", kind: "npm", name: "" })).toEqual({ _tag: "InvalidName", kind: "npm", name: "" })
    expect(decode({ _tag: "InvalidSegment", text: ".." })).toEqual({ _tag: "InvalidSegment", text: ".." })
    expect(decode({ _tag: "Unsupported", char: "\\" })).toEqual({ _tag: "Unsupported", char: "\\" })
    expect(decode({ _tag: "UnbalancedBraces" })).toEqual({ _tag: "UnbalancedBraces" })
  })

  it("holds exactly one code point as the unsupported character", () => {
    expect(() => Schema.decodeSync(ParseError)({ _tag: "Unsupported", char: "" })).toThrow()
    expect(() => Schema.decodeSync(ParseError)({ _tag: "Unsupported", char: "ab" })).toThrow()
  })
})

describe("SelectorText", () => {
  const decode = Schema.decodeUnknownResult(SelectorText)
  const encode = Schema.encodeUnknownResult(SelectorText)

  it("decodes by parsing", () => {
    expect(decode("src/{a,b}")).toEqual(parse("src/{a,b}"))
    expect(decode("npm:react")).toEqual(Result.succeed(base({ _tag: "Package", name: "react" })))
  })

  it("encodes by printing", () => {
    expect(encode(any(glob(word("src"), globstar), layer("app")))).toEqual(Result.succeed("{src/**,layer:app}"))
    expect(encode(glob(word("."), word("x")))).toEqual(Result.succeed("././x"))
  })

  it.each([
    ["", "Empty"],
    ["{a", "UnbalancedBraces"],
    ["a//b", "InvalidSegment"],
    ["a\\b", "Unsupported"],
    ["npm:", "InvalidName"],
  ])("fails to decode %j with a message that names %s", (text, tag) => {
    const result = decode(text)
    expect(Result.isFailure(result) && result.failure.message).toContain(`${tag}:`)
  })

  it("puts the offending text of the error in the message", () => {
    const result = decode("npm:a/b")
    expect(Result.isFailure(result) && result.failure.message).toContain('"a/b"')
  })

  it("fails to encode selectors without text", () => {
    for (const selector of [{ _tag: "Not", selector: layer("a") }, any(layer("a")), any(), base({ _tag: "Any", selectors: [] })] as const) {
      const result = encode(selector)
      expect(Result.isFailure(result) && result.failure.message).toContain("no text form")
    }
  })

  it("rejects values that are not selectors", () => {
    expect(Result.isFailure(decode(1))).toBe(true)
    expect(Result.isFailure(encode({ _tag: "Nope" }))).toBe(true)
  })
})
