import { describe, expect, it } from "@effect/vitest"
import { Option, Result } from "effect"
import { apply, record } from "../../src/core/baseline.ts"
import { check, emptyObjects, emptySubjects } from "../../src/core/check.ts"
import type { ConfigSelector } from "../../src/core/config.ts"
import { decode, encode, fingerprint } from "../../src/core/fingerprint.ts"
import { lower } from "../../src/core/lower.ts"
import type { FilePath, Graph, PathToken, Selector } from "../../src/core/model.ts"
import { reach } from "../../src/core/reach.ts"
import type { CustomRules, Rule } from "../../src/core/rule.ts"
import { pathAccepts, selects } from "../../src/core/selector.ts"
import { structuralEquals, structuralKey } from "../../src/core/structural.ts"
import { type ParseError, parse, print } from "../../src/core/text.ts"
import * as Generate from "./generate.ts"
import { askOracle, type Request } from "./oracle.ts"

interface Case {
  readonly request: Request
  readonly actual: unknown
}

const customFrom =
  (results: ReadonlyArray<Generate.CustomResult>): CustomRules =>
  (name, _graph, subject: FilePath) =>
    results.find((result) => result.name === name && structuralEquals(result.subject, subject))?.messages ?? []

const casesFor = (seed: number): Array<Case> => {
  const rng = Generate.random(seed)
  const graph: Graph = Generate.graph(rng)
  const cases: Array<Case> = []
  const add = (request: Request, actual: unknown) => cases.push({ request, actual })

  for (const file of graph.files) {
    const edges = Generate.edgeFilter(rng)
    add({ op: "reach", graph, edges, source: file.path }, reach(graph, edges, file.path))
    const selector = Generate.selector(rng)
    const target = { _tag: "File" as const, path: file.path }
    add({ op: "selects", selector, target }, selects(selector, target))
    if (selector._tag === "Glob") {
      add({ op: "pathAccepts", tokens: selector.tokens, path: file.path }, pathAccepts(selector.tokens, file.path))
    }
  }

  const policy = Generate.policy(rng)
  const custom = Generate.customResults(rng, graph)
  const violations = check(customFrom(custom), policy, graph)
  add({ op: "check", policy, graph, custom }, violations)
  const everything: Selector = { _tag: "Glob", tokens: [{ _tag: "Globstar" }] }
  const walks: Array<Rule> = [
    ...[undefined, 0, 1, 2].map((folderDepth, index): Rule => ({
      id: `cycles-${index}`,
      severity: "error",
      subject: everything,
      assertion: { _tag: "Acyclic", edges: Generate.edgeFilter(rng), ...(folderDepth === undefined ? {} : { folderDepth }) },
    })),
    ...(["forbid", "require"] as const).flatMap((relation) =>
      (["outgoing", "incoming"] as const).map((direction): Rule => ({
        id: `walk-${direction}-${relation}`,
        severity: "error",
        subject: Generate.selector(rng),
        assertion: { _tag: "Reach", direction, relation, object: Generate.selector(rng), edges: { ...Generate.edgeFilter(rng), transitive: true } },
      })),
    ),
  ]
  add({ op: "check", policy: walks, graph, custom: [] }, check(() => [], walks, graph))
  add({ op: "emptySubjects", policy, graph }, emptySubjects(policy, graph))
  add({ op: "emptyObjects", policy, graph }, emptyObjects(policy, graph))
  add({ op: "record", violations }, record(violations))
  const baseline = [...record(violations).filter(() => rng.chance(0.5)), Generate.awkwardFingerprint(rng)]
  add({ op: "apply", baseline, violations }, apply(baseline, violations))
  for (const violation of violations) {
    add({ op: "fingerprint", violation }, fingerprint(violation))
  }

  const config = Generate.config(rng)
  add(
    { op: "lower", config },
    Result.match(lower(config), { onSuccess: (ok) => ({ ok }), onFailure: (error) => ({ error }) }),
  )

  for (const fp of [...record(violations), Generate.awkwardFingerprint(rng)]) {
    const line = encode(fp)
    add({ op: "encode", fingerprint: fp }, line)
    add({ op: "decode", line }, Option.getOrNull(decode(line)))
  }
  const codePoints = Array.from(encode(Generate.awkwardFingerprint(rng)))
  const corrupted = codePoints.slice(0, codePoints.length - 1 - rng.int(3)).join("")
  add({ op: "decode", line: corrupted }, Option.getOrNull(decode(corrupted)))
  return cases
}

const layer = (name: string): ConfigSelector => ({ _tag: "Layer", name })
const base = (selector: Selector): ConfigSelector => ({ _tag: "Base", selector })
const literal = (char: string): PathToken => ({ _tag: "Segment", tokens: [{ _tag: "Literal", char }] })

/** Selectors that `print` refuses or renders unusually, which parse alone does not produce. */
const unusualSelectors: ReadonlyArray<ConfigSelector> = [
  { _tag: "Any", selectors: [] },
  { _tag: "Any", selectors: [layer("a")] },
  { _tag: "Any", selectors: [layer("a"), layer("b")] },
  { _tag: "Any", selectors: [layer("a"), { _tag: "Any", selectors: [layer("b"), layer("c")] }] },
  { _tag: "Any", selectors: [layer("a"), { _tag: "Not", selector: layer("b") }] },
  { _tag: "Any", selectors: [layer("a"), base({ _tag: "Not", selector: { _tag: "Computed" } })] },
  { _tag: "All", selectors: [layer("a"), layer("b")] },
  { _tag: "Not", selector: layer("a") },
  base({ _tag: "Any", selectors: [{ _tag: "Computed" }, { _tag: "Unresolved" }] }),
  base({ _tag: "Glob", tokens: [] }),
  base({ _tag: "Glob", tokens: [{ _tag: "Segment", tokens: [] }] }),
  base({ _tag: "Glob", tokens: [literal("."), literal("/")] }),
  base({ _tag: "Glob", tokens: [literal("."), { _tag: "Globstar" }] }),
  base({ _tag: "Glob", tokens: [literal("l"), { _tag: "Segment", tokens: [{ _tag: "Star" }, { _tag: "One" }] }] }),
  base({ _tag: "Package", name: "@s/x" }),
  base({ _tag: "Builtin", runtime: "bun", name: "test" }),
  base({ _tag: "Builtin", runtime: "bun" }),
  layer(""),
]

/** Selector strings use their own stream, so the cases above keep their values. */
const textCasesFor = (seed: number): Array<Case> => {
  const rng = Generate.random(seed + 0x5e1ec7)
  const cases: Array<Case> = []
  const add = (request: Request, actual: unknown) => cases.push({ request, actual })
  const addPrint = (selector: ConfigSelector) =>
    add({ op: "print", selector }, Option.getOrNull(print(selector)))

  for (const text of Array.from({ length: 12 }, () => Generate.selectorText(rng))) {
    const parsed = parse(text)
    add({ op: "parse", text }, Result.match(parsed, { onSuccess: (ok) => ({ ok }), onFailure: (error) => ({ error }) }))
    if (Result.isSuccess(parsed)) addPrint(parsed.success)
  }
  for (const selector of Array.from({ length: 3 }, () => Generate.configSelector(rng))) addPrint(selector)
  return cases
}

describe("TypeScript core against the Lean oracle (evidence for T1)", () => {
  const seeds = Array.from({ length: 400 }, (_, index) => index + 1)
  const cases = [
    ...seeds.map((seed) => ({ seed, cases: [...casesFor(seed), ...textCasesFor(seed)] })),
    {
      seed: 0,
      cases: unusualSelectors.map((selector): Case => ({ request: { op: "print", selector }, actual: Option.getOrNull(print(selector)) })),
    },
  ]
  const expected = askOracle(cases.flatMap(({ cases }) => cases.map((item) => item.request)))

  it("answers every request", () => {
    expect(expected.filter((answer) => typeof answer === "object" && answer !== null && "invalid" in answer)).toEqual([])
  })

  it("agrees on every request, byte for byte", () => {
    let index = 0
    const mismatches: Array<{ seed: number; op: string; expected: string; actual: string }> = []
    for (const { seed, cases: seedCases } of cases) {
      for (const { request, actual } of seedCases) {
        const answer = expected[index++]
        if (structuralKey(answer) !== structuralKey(actual)) {
          mismatches.push({ seed, op: request.op, expected: structuralKey(answer), actual: structuralKey(actual) })
        }
      }
    }
    expect({ count: mismatches.length, first: mismatches.slice(0, 3) }).toEqual({ count: 0, first: [] })
    expect(index).toBeGreaterThan(seeds.length * 10)
  })

  it("exercises violations of every evidence kind", () => {
    const tags = new Set(
      cases.flatMap(({ cases }) =>
        cases.flatMap(({ request, actual }) =>
          request.op === "check" ? (actual as ReturnType<typeof check>).map((violation) => violation.evidence._tag) : [],
        ),
      ),
    )
    expect([...tags].sort()).toEqual(
      ["Custom", "Cycle", "Declaration", "Dependency", "Export", "Lines", "Missing", "Name", "Use", "Walk"].sort(),
    )
  })

  it("exercises every parse outcome and print rule", () => {
    const requests = cases.flatMap(({ cases }) => cases)
    const parsed = requests.flatMap(({ request, actual }) =>
      request.op === "parse" ? [actual as { ok: ConfigSelector } | { error: ParseError }] : [],
    )
    const outcomes = parsed.map((outcome) =>
      "error" in outcome
        ? outcome.error._tag
        : outcome.ok._tag === "Base"
          ? outcome.ok.selector._tag
          : outcome.ok._tag,
    )
    expect([...new Set(outcomes)].sort()).toEqual(
      [
        "Any", "Builtin", "Computed", "Empty", "Glob", "InvalidName", "InvalidSegment", "Layer", "Package",
        "UnbalancedBraces", "Unresolved", "Unsupported",
      ].sort(),
    )
    expect(outcomes.filter((outcome) => outcome === "Glob").length).toBeGreaterThan(100)

    const printed = requests.flatMap(({ request, actual }) => (request.op === "print" ? [actual as string | null] : []))
    expect(printed.some((text) => text === null)).toBe(true)
    expect(printed.some((text) => text?.startsWith("./"))).toBe(true)
    expect(printed.some((text) => text?.startsWith("{"))).toBe(true)
    expect(printed.some((text) => text === "")).toBe(true)
  })
})
