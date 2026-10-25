import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import type { Graph } from "../../src/core/model.ts"
import type { Violation } from "../../src/core/rule.ts"
import { agent } from "../../src/report/agent.ts"
import { dot } from "../../src/report/dot.ts"
import { github } from "../../src/report/github.ts"
import { json } from "../../src/report/json.ts"
import { Report } from "../../src/report/report.ts"
import { sarif } from "../../src/report/sarif.ts"
import {
  cleanReport,
  customViolation,
  cycleViolation,
  dependencyViolation,
  edge,
  fileTarget,
  filePath,
  fullReport,
  linesViolation,
  missingViolation,
  rules,
  walkViolation,
} from "./fixtures.ts"

const custom = (subject: string, message: string, ruleId = "r"): Violation => ({
  ruleId,
  severity: "error",
  subject: filePath(subject),
  evidence: { _tag: "Custom", message },
})

const awkwardPieces = Schema.Array(
  Schema.Literals(["a", " ", "\n", "\r", "\u0085", "\u2028", "\u2029", "%", ":", ",", "|", "/", "\\", '"', "\u001b"]),
)

const withViolations = (violations: ReadonlyArray<Violation>): Report => ({ ...cleanReport, violations })

const incomingDependency: Violation = {
  ruleId: "no-infra",
  severity: "error",
  subject: filePath("src/domain/order.ts"),
  evidence: {
    _tag: "Dependency",
    edge: edge("src/web/page.ts", fileTarget("src/domain/order.ts"), "../domain/order", 5, 3),
  },
}

describe("agent", () => {
  it("writes one record per finding in check order, then the summary", () => {
    expect(agent(fullReport).split("\n")).toEqual([
      `finding id="no-infra|/src/domain/order.ts|dependency|static|../infra/db|file|/src/infra/db.ts" severity=error rule="no-infra" subject="src/domain/order.ts" at="src/domain/order.ts:3:10" message="imports src/infra/db.ts ('../infra/db')" reason="Domain code must not know about persistence."`,
      `finding id="web/no-db|/src/web/page.ts|target|package|pg|" severity=error rule="web/no-db" subject="src/web/page.ts" at="src/web/page.ts:1:1" message="depends on npm:pg through src/web/page.ts → src/app/users.ts → src/infra/db.ts → npm:pg" reason="Web code reaches the database through app only."`,
      `finding id="no-cycles|/src/a.ts|cycle" severity=warning rule="no-cycles" subject="src/a.ts" at="src/a.ts:2:1" message="is part of a dependency cycle: src/a.ts → src/b.ts → src/a.ts"`,
      `finding id="needs-adapter|/src/app/users.ts|missing" severity=error rule="needs-adapter" subject="src/app/users.ts" message="does not satisfy the rule's requirement"`,
      `finding id="only-classes|/src/domain/helpers.ts|declaration|formatPrice" severity=error rule="only-classes" subject="src/domain/helpers.ts" at="src/domain/helpers.ts:7:17" message="declares formatPrice, which the rule does not allow"`,
      `finding id="public-api|/src/lib/index.ts|export|internal" severity=error rule="public-api" subject="src/lib/index.ts" message="exports internal, which the rule does not allow"`,
      `finding id="no-eval|/src/legacy/run.ts|use|call|eval|global" severity=error rule="no-eval" subject="src/legacy/run.ts" at="src/legacy/run.ts:12:5" message="calls eval" reason="eval defeats static analysis."`,
      `finding id="file-naming|/src/domain/Order.ts|name" severity=warning rule="file-naming" subject="src/domain/Order.ts" message="has the file name Order.ts, which breaks the naming rule"`,
      `finding id="max-lines|/src/big.ts|lines" severity=warning rule="max-lines" subject="src/big.ts" message="has 900 lines, more than the rule allows"`,
      `finding id="features/one-entrypoint|/src/features/a.ts|custom|exports 3 names" severity=info rule="features/one-entrypoint" subject="src/features/a.ts" message="exports 3 names"`,
      `summary verdict=fail errors=6 warnings=3 infos=1 suppressed=2 stale=1 files=12 dependencies=40 emptySubjects=["unused-rule"] emptyObjects=[]`,
    ])
  })

  it("writes only the summary for a clean report", () => {
    expect(agent(cleanReport)).toBe(
      "summary verdict=pass errors=0 warnings=0 infos=0 suppressed=0 stale=0 files=12 dependencies=40 emptySubjects=[] emptyObjects=[]",
    )
  })

  it("keeps a record on one line whatever the message holds", () => {
    const awkward = custom("src/a.ts", 'say "hi"\nthen\r\nleave now ok\u0085 \\ done')
    const lines = agent(withViolations([awkward])).split("\n")
    expect(lines).toHaveLength(2)
    const id = String.raw`id="r|/src/a.ts|custom|say \"hi\"\\nthen\\r\\nleave\u2028now\u2029ok\u0085 \\\\ done"`
    const message = String.raw`message="say \"hi\"\nthen\r\nleave\u2028now\u2029ok\u0085 \\ done"`
    expect(lines[0]).toBe(`finding ${id} severity=error rule="r" subject="src/a.ts" ${message}`)
  })

  it("never emits color codes", () => {
    expect(agent(fullReport)).not.toContain("\u001b")
  })

  it.prop("writes one line per finding and the summary for any custom message", [awkwardPieces], ([pieces]) => {
    const message = pieces.join("")
    const output = agent(withViolations([custom("src/a.ts", message), custom("src/b.ts", message)]))
    const lines = output.split("\n")
    expect(lines).toHaveLength(3)
    expect(lines.slice(0, 2).every((line) => line.startsWith("finding "))).toBe(true)
    expect(lines[2]?.startsWith("summary ")).toBe(true)
    for (const separator of ["\r", "\u0085", "\u2028", "\u2029"]) expect(output.includes(separator)).toBe(false)
  })
})

describe("json", () => {
  it("encodes the report with field order and two-space indentation", () => {
    const report: Report = {
      violations: [linesViolation],
      suppressed: 1,
      stale: [],
      emptySubjects: ["x"],
      emptyObjects: [],
      rules: [{ id: "max-lines", severity: "warning", reason: "Keep files small." }],
      counts: { error: 0, warning: 1, info: 0 },
      stats: { files: 3, dependencies: 4 },
      verdict: "pass",
    }
    expect(json(report)).toBe(
      [
        "{",
        '  "violations": [',
        "    {",
        '      "ruleId": "max-lines",',
        '      "severity": "warning",',
        '      "subject": [',
        '        "src",',
        '        "big.ts"',
        "      ],",
        '      "evidence": {',
        '        "_tag": "Lines",',
        '        "count": 900',
        "      }",
        "    }",
        "  ],",
        '  "suppressed": 1,',
        '  "stale": [],',
        '  "emptySubjects": [',
        '    "x"',
        "  ],",
        '  "emptyObjects": [],',
        '  "rules": [',
        "    {",
        '      "id": "max-lines",',
        '      "severity": "warning",',
        '      "reason": "Keep files small."',
        "    }",
        "  ],",
        '  "counts": {',
        '    "error": 0,',
        '    "warning": 1,',
        '    "info": 0',
        "  },",
        '  "stats": {',
        '    "files": 3,',
        '    "dependencies": 4',
        "  },",
        '  "verdict": "pass"',
        "}",
      ].join("\n"),
    )
  })

  it("decodes back to the same report, with every evidence kind", () => {
    expect(Schema.decodeUnknownSync(Report)(JSON.parse(json(fullReport)))).toEqual(fullReport)
  })

  it("keeps the order of the violations", () => {
    const order = [custom("src/a.ts", "1"), custom("src/b.ts", "2"), custom("src/a.ts", "3")]
    const decoded = Schema.decodeUnknownSync(Report)(JSON.parse(json(withViolations(order))))
    expect(decoded.violations).toEqual(order)
  })
})

describe("github", () => {
  it("writes one annotation per finding in check order", () => {
    expect(github(fullReport).split("\n")).toEqual([
      "::error file=src/domain/order.ts,line=3,col=10,title=no-infra::imports src/infra/db.ts ('../infra/db')",
      "::error file=src/web/page.ts,line=1,col=1,title=web/no-db::depends on npm:pg through src/web/page.ts → src/app/users.ts → src/infra/db.ts → npm:pg",
      "::warning file=src/a.ts,line=2,col=1,title=no-cycles::is part of a dependency cycle: src/a.ts → src/b.ts → src/a.ts",
      "::error file=src/app/users.ts,title=needs-adapter::does not satisfy the rule's requirement",
      "::error file=src/domain/helpers.ts,line=7,col=17,title=only-classes::declares formatPrice, which the rule does not allow",
      "::error file=src/lib/index.ts,title=public-api::exports internal, which the rule does not allow",
      "::error file=src/legacy/run.ts,line=12,col=5,title=no-eval::calls eval",
      "::warning file=src/domain/Order.ts,title=file-naming::has the file name Order.ts, which breaks the naming rule",
      "::warning file=src/big.ts,title=max-lines::has 900 lines, more than the rule allows",
      "::notice file=src/features/a.ts,title=features/one-entrypoint::exports 3 names",
    ])
  })

  it("writes nothing for a clean report", () => {
    expect(github(cleanReport)).toBe("")
  })

  it("escapes %, CR and LF in messages, and also : and , in properties", () => {
    const awkward = custom("src/we,ird:file.ts", "100%\r\nnext: x, y", "a:b,c")
    expect(github(withViolations([awkward]))).toBe(
      "::error file=src/we%2Cird%3Afile.ts,title=a%3Ab%2Cc::100%25%0D%0Anext: x, y",
    )
  })

  it("escapes the percent sign before the other characters", () => {
    expect(github(withViolations([custom("src/a.ts", "%0A\n")]))).toBe("::error file=src/a.ts,title=r::%250A%0A")
  })

  it("annotates the importing file and names the subject in the message", () => {
    expect(github(withViolations([incomingDependency]))).toBe(
      "::error file=src/web/page.ts,line=5,col=3,title=no-infra::src/domain/order.ts is imported by src/web/page.ts ('../domain/order')",
    )
  })

  it.prop("writes one line per finding for any custom message", [awkwardPieces], ([pieces]) => {
    const message = pieces.join("")
    const output = github(withViolations([custom("src/a.ts", message), custom("src/b.ts", message)]))
    expect(output.split("\n")).toHaveLength(2)
    expect(output.includes("\r")).toBe(false)
  })
})

const at = (path: string, line: number, column: number) => ({
  artifactLocation: { uri: path, uriBaseId: "%SRCROOT%" },
  region: { startLine: line, startColumn: column },
})

describe("sarif", () => {
  it("writes a SARIF document with rules, results, locations, fingerprints and code flows", () => {
    const report: Report = {
      ...cleanReport,
      violations: [dependencyViolation, walkViolation],
      rules: [
        { id: "no-infra", severity: "error", reason: "Domain code must not know about persistence." },
        { id: "web/no-db", severity: "error", reason: "Web code reaches the database through app only." },
        { id: "no-cycles", severity: "warning" },
        { id: "unused-rule", severity: "info" },
      ],
    }
    expect(JSON.parse(sarif(report))).toEqual({
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "Archer",
              informationUri: "https://github.com/lucasacoutinho/archer",
              rules: [
                {
                  id: "no-infra",
                  shortDescription: { text: "Domain code must not know about persistence." },
                  defaultConfiguration: { level: "error" },
                },
                {
                  id: "web/no-db",
                  shortDescription: { text: "Web code reaches the database through app only." },
                  defaultConfiguration: { level: "error" },
                },
                { id: "no-cycles", shortDescription: { text: "no-cycles" }, defaultConfiguration: { level: "warning" } },
                { id: "unused-rule", shortDescription: { text: "unused-rule" }, defaultConfiguration: { level: "note" } },
              ],
            },
          },
          results: [
            {
              ruleId: "no-infra",
              ruleIndex: 0,
              level: "error",
              message: { text: "imports src/infra/db.ts ('../infra/db')" },
              locations: [{ physicalLocation: at("src/domain/order.ts", 3, 10) }],
              partialFingerprints: {
                archer: "no-infra|/src/domain/order.ts|dependency|static|../infra/db|file|/src/infra/db.ts",
              },
            },
            {
              ruleId: "web/no-db",
              ruleIndex: 1,
              level: "error",
              message: {
                text: "depends on npm:pg through src/web/page.ts → src/app/users.ts → src/infra/db.ts → npm:pg",
              },
              locations: [{ physicalLocation: at("src/web/page.ts", 1, 1) }],
              partialFingerprints: { archer: "web/no-db|/src/web/page.ts|target|package|pg|" },
              codeFlows: [
                {
                  threadFlows: [
                    {
                      locations: [
                        {
                          location: {
                            physicalLocation: at("src/web/page.ts", 1, 1),
                            message: { text: "imports src/app/users.ts ('../app/users')" },
                          },
                        },
                        {
                          location: {
                            physicalLocation: at("src/app/users.ts", 2, 1),
                            message: { text: "imports src/infra/db.ts ('../infra/db')" },
                          },
                        },
                        {
                          location: {
                            physicalLocation: at("src/infra/db.ts", 1, 1),
                            message: { text: "imports npm:pg ('pg')" },
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
  })

  it("maps severities to SARIF levels", () => {
    const results = JSON.parse(sarif(fullReport)).runs[0].results
    expect(results.map((result: { level: string }) => result.level)).toEqual([
      "error",
      "error",
      "warning",
      "error",
      "error",
      "error",
      "error",
      "warning",
      "warning",
      "note",
    ])
  })

  it("gives every finding of every evidence kind the fingerprint the baseline would record", () => {
    const results = JSON.parse(sarif(fullReport)).runs[0].results
    expect(results.map((result: { partialFingerprints: { archer: string } }) => result.partialFingerprints.archer)).toEqual([
      "no-infra|/src/domain/order.ts|dependency|static|../infra/db|file|/src/infra/db.ts",
      "web/no-db|/src/web/page.ts|target|package|pg|",
      "no-cycles|/src/a.ts|cycle",
      "needs-adapter|/src/app/users.ts|missing",
      "only-classes|/src/domain/helpers.ts|declaration|formatPrice",
      "public-api|/src/lib/index.ts|export|internal",
      "no-eval|/src/legacy/run.ts|use|call|eval|global",
      "file-naming|/src/domain/Order.ts|name",
      "max-lines|/src/big.ts|lines",
      "features/one-entrypoint|/src/features/a.ts|custom|exports 3 names",
    ])
  })

  it("keeps the fingerprint when only the line moves", () => {
    const moved: Violation = {
      ...dependencyViolation,
      evidence: {
        _tag: "Dependency",
        edge: edge("src/domain/order.ts", fileTarget("src/infra/db.ts"), "../infra/db", 40, 2),
      },
    }
    const fingerprint = (violation: Violation) =>
      JSON.parse(sarif(withViolations([violation]))).runs[0].results[0].partialFingerprints
    expect(fingerprint(moved)).toEqual(fingerprint(dependencyViolation))
  })

  it("adds a code flow to a cycle and to nothing else but walks", () => {
    const results = JSON.parse(sarif(fullReport)).runs[0].results
    const flows = results.map((result: { codeFlows?: Array<{ threadFlows: Array<{ locations: Array<unknown> }> }> }) =>
      result.codeFlows?.[0]?.threadFlows[0]?.locations.length,
    )
    expect(flows).toEqual([undefined, 3, 2, undefined, undefined, undefined, undefined, undefined, undefined, undefined])
  })

  it("points a finding without a location at its subject file", () => {
    const [result] = JSON.parse(sarif(withViolations([missingViolation]))).runs[0].results
    expect(result.locations).toEqual([
      { physicalLocation: { artifactLocation: { uri: "src/app/users.ts", uriBaseId: "%SRCROOT%" } } },
    ])
  })

  it("omits the code flow of a walk without edges and the index of an unknown rule", () => {
    const bare: Violation = {
      ruleId: "ghost",
      severity: "error",
      subject: filePath("src/a.ts"),
      evidence: { _tag: "Walk", target: { _tag: "Computed" }, edges: [] },
    }
    const [result] = JSON.parse(sarif(withViolations([bare]))).runs[0].results
    expect(result.codeFlows).toBeUndefined()
    expect(result.ruleIndex).toBeUndefined()
  })

  it("annotates the importing file and names the subject in the message", () => {
    const [result] = JSON.parse(sarif({ ...cleanReport, violations: [incomingDependency], rules })).runs[0].results
    expect(result.message.text).toBe("src/domain/order.ts is imported by src/web/page.ts ('../domain/order')")
    expect(result.locations).toEqual([{ physicalLocation: at("src/web/page.ts", 5, 3) }])
  })

  it("lists every rule even when it has no findings", () => {
    const ids = JSON.parse(sarif(cleanReport)).runs[0].tool.driver.rules.map((rule: { id: string }) => rule.id)
    expect(ids).toEqual(rules.map((rule) => rule.id))
    expect(JSON.parse(sarif(cleanReport)).runs[0].results).toEqual([])
  })

  it("keeps the order of the findings", () => {
    const order = [custom("src/a.ts", "1"), custom("src/b.ts", "2"), custom("src/a.ts", "3")]
    const messages = JSON.parse(sarif(withViolations(order))).runs[0].results.map(
      (result: { message: { text: string } }) => result.message.text,
    )
    expect(messages).toEqual(["1", "2", "3"])
  })
})

describe("dot", () => {
  const file = (path: string, ...dependencies: Graph["files"][number]["dependencies"]): Graph["files"][number] => ({
    path: filePath(path),
    dependencies,
    declarations: [],
    exports: [],
    uses: [],
    lines: 1,
  })
  const to = (path: string, kind: Graph["files"][number]["dependencies"][number]["kind"] = "static") => ({
    target: fileTarget(path),
    kind,
    specifier: "",
    location: { line: 1, column: 1 },
  })

  const graph: Graph = {
    files: [
      file("src/b.ts", to("src/a.ts", "type"), to("src/a.ts", "static"), to("src/a.ts", "static")),
      file(
        "src/a.ts",
        to("src/c.ts", "dynamic"),
        { target: { _tag: "Package", name: "react", subpath: [] }, kind: "static", specifier: "react", location: { line: 2, column: 1 } },
        { target: { _tag: "Unresolved", specifier: "./gone" }, kind: "static", specifier: "./gone", location: { line: 3, column: 1 } },
        to("src/b.ts", "require"),
      ),
      file('src/we"ird.ts', to("src/a.ts")),
      file("src/c.ts"),
    ],
  }

  const expected = [
    "digraph archer {",
    "  rankdir=LR;",
    "  node [shape=box];",
    '  "src/a.ts";',
    '  "src/b.ts";',
    '  "src/c.ts";',
    '  "src/we\\"ird.ts";',
    '  "src/a.ts" -> "src/b.ts" [label="require"];',
    '  "src/a.ts" -> "src/c.ts" [label="dynamic", style=dotted];',
    '  "src/b.ts" -> "src/a.ts" [label="type", style=dashed];',
    '  "src/b.ts" -> "src/a.ts";',
    '  "src/we\\"ird.ts" -> "src/a.ts";',
    "}",
  ].join("\n")

  it("draws source files and the edges between them in sorted order, once each", () => {
    expect(dot(graph)).toBe(expected)
  })

  it("does not depend on the order of the files", () => {
    expect(dot({ files: [...graph.files].reverse() })).toBe(expected)
  })

  it("draws an empty graph", () => {
    expect(dot({ files: [] })).toBe(["digraph archer {", "  rankdir=LR;", "  node [shape=box];", "}"].join("\n"))
  })
})

describe("missing and cycle violations", () => {
  it("are reported by every format without throwing", () => {
    const report = withViolations([missingViolation, cycleViolation, customViolation])
    expect(agent(report).split("\n")).toHaveLength(4)
    expect(github(report).split("\n")).toHaveLength(3)
    expect(JSON.parse(sarif(report)).runs[0].results).toHaveLength(3)
    expect(JSON.parse(json(report)).violations).toHaveLength(3)
  })
})
