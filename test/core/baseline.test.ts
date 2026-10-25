import { describe, expect, it } from "@effect/vitest"
import { Option, Schema } from "effect"
import { apply, record } from "../../src/core/baseline.ts"
import { decode, encode, Fingerprint, fingerprint } from "../../src/core/fingerprint.ts"
import type { Violation } from "../../src/core/rule.ts"
import { dep, edge, file, loc } from "./builders.ts"

const order = ["src", "domain", "order.ts"]

const forbidden = (line: number): Violation => {
  const dependency = { ...dep(file("src/infra/db.ts"), "static", "../infra/db"), location: { line, column: 1 } }
  return {
    ruleId: "no-infra",
    severity: "error",
    subject: order,
    evidence: { _tag: "Dependency", edge: { source: order, dependency } },
  }
}

const tooLong: Violation = { ruleId: "max-lines", severity: "warning", subject: ["src", "big.ts"], evidence: { _tag: "Lines", count: 900 } }

const awkward: Fingerprint = { ruleId: "a|b", subject: ["x/y", "\\"], key: { _tag: "Custom", message: "one\ntwo" } }

describe("fingerprint", () => {
  it("ignores locations", () => {
    expect(fingerprint(forbidden(3))).toEqual(fingerprint(forbidden(9)))
  })

  it("ignores witness edges", () => {
    const base = { ruleId: "r", severity: "error", subject: ["a"] } as const
    const a: Violation = { ...base, evidence: { _tag: "Walk", target: file("x"), edges: [edge("a", dep(file("x")))] } }
    const b: Violation = { ...base, evidence: { _tag: "Walk", target: file("x"), edges: [] } }
    expect(fingerprint(a)).toEqual(fingerprint(b))
  })

  it("drops the use location but keeps kind, name and binding", () => {
    const use = { kind: "call", name: "eval", binding: { _tag: "Global" }, location: loc } as const
    expect(fingerprint({ ruleId: "r", severity: "error", subject: ["a"], evidence: { _tag: "Use", use } }).key).toEqual({
      _tag: "Use",
      kind: "call",
      name: "eval",
      binding: { _tag: "Global" },
    })
  })
})

describe("encode and decode", () => {
  it("matches the Lean examples byte for byte", () => {
    expect(encode(fingerprint(forbidden(3)))).toBe("no-infra|/src/domain/order.ts|dependency|static|../infra/db|file|/src/infra/db.ts")
    expect(encode(fingerprint(tooLong))).toBe("max-lines|/src/big.ts|lines")
    expect(encode(awkward)).toBe("a\\pb|/x\\\\sy/\\\\\\\\|custom|one\\ntwo")
    expect(encode({ ruleId: "no-eval", subject: ["src", "a.ts"], key: { _tag: "Use", kind: "call", name: "eval", binding: { _tag: "Global" } } })).toBe(
      "no-eval|/src/a.ts|use|call|eval|global",
    )
    expect(
      encode({
        ruleId: "npm-only",
        subject: ["src", "a.ts"],
        key: { _tag: "Dependency", target: { _tag: "Package", name: "@scope/pkg", subpath: ["sub"] }, specifier: "@scope/pkg/sub", kind: "type" },
      }),
    ).toBe("npm-only|/src/a.ts|dependency|type|@scope/pkg/sub|package|@scope/pkg|/sub")
    expect(encode({ ruleId: "r", subject: [], key: { _tag: "Missing" } })).toBe("r||missing")
  })

  it("decodes the Lean examples", () => {
    expect(decode("r||missing")).toEqual(Option.some({ ruleId: "r", subject: [], key: { _tag: "Missing" } }))
    expect(decode("max-lines|/src/big.ts|lines")).toEqual(Option.some(fingerprint(tooLong)))
    expect(decode("max-lines|/src/big.ts|nothing")).toEqual(Option.none())
    expect(decode("a\\")).toEqual(Option.none())
  })

  it("round-trips awkward characters at both levels", () => {
    const keys: Array<Fingerprint["key"]> = [
      { _tag: "Custom", message: "line\r\nbreak \\ | / \\n \\p" },
      { _tag: "Target", target: { _tag: "Package", name: "a|b", subpath: ["/", "\\s", ""] } },
      { _tag: "Target", target: { _tag: "Builtin", runtime: "bun", name: "x" } },
      { _tag: "Target", target: { _tag: "Unresolved", specifier: "./a|b" } },
      { _tag: "Target", target: { _tag: "Computed" } },
      { _tag: "Use", kind: "looseEquality", name: "==", binding: { _tag: "Imported", name: { source: "s|", name: "n/" } } },
      { _tag: "Declaration", name: "D" },
      { _tag: "Export", name: "E" },
      { _tag: "Cycle" },
      { _tag: "Name" },
    ]
    for (const key of keys) {
      const x: Fingerprint = { ruleId: "a|b\\c\r", subject: ["x/y", "\\", "|", ""], key }
      const line = encode(x)
      expect(line).not.toContain("\n")
      expect(line).not.toContain("\r")
      expect(decode(line)).toEqual(Option.some(x))
    }
  })

  it("rejects malformed lines strictly", () => {
    for (const line of [
      "",
      "r",
      "r|/a",
      "r|a|missing",
      "r|/a|missing|extra",
      "r|/a|lines|x",
      "r|/a|target",
      "r|/a|target|file",
      "r|/a|target|file|/a|b",
      "r|/a|target|builtin|deno|x",
      "r|/a|dependency|node|s|computed",
      "r|/a|use|call|n|imported|s",
      "r|/a|custom|a\\x",
      "r|/a|custom|a\\",
      "r|/a|custom|a|b",
      "r|/a\\q|missing",
    ]) {
      expect(decode(line), line).toEqual(Option.none())
    }
  })

  it("encodes fingerprints in the oracle JSON shape", () => {
    expect(Schema.encodeSync(Fingerprint)(fingerprint(tooLong))).toEqual({
      ruleId: "max-lines",
      subject: ["src", "big.ts"],
      key: { _tag: "Lines" },
    })
  })
})

describe("baseline", () => {
  const current = [forbidden(3), forbidden(9), tooLong]
  const gone: Fingerprint = { ruleId: "gone", subject: ["src", "old.ts"], key: { _tag: "Cycle" } }

  it("records fingerprints once each in first-occurrence order", () => {
    expect(record(current)).toEqual([fingerprint(forbidden(3)), fingerprint(tooLong)])
  })

  it("keeps and suppresses in original order", () => {
    const baseline = [fingerprint(tooLong), gone]
    expect(apply(baseline, current).kept).toEqual([forbidden(3), forbidden(9)])
    expect(apply(baseline, current).suppressed).toEqual([tooLong])
  })

  it("lists stale entries once each", () => {
    expect(apply([fingerprint(tooLong), gone, gone], current).stale).toEqual([gone])
  })

  it("a recorded baseline suppresses everything and leaves nothing stale", () => {
    const applied = apply(record(current), current)
    expect(applied.kept).toEqual([])
    expect(applied.stale).toEqual([])
    expect(applied.suppressed).toEqual(current)
  })

  it("an empty baseline keeps everything", () => {
    expect(apply([], current)).toEqual({ kept: current, suppressed: [], stale: [] })
  })
})
