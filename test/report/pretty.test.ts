import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import type { Violation } from "../../src/core/rule.ts"
import { pretty } from "../../src/report/pretty.ts"
import type { Report } from "../../src/report/report.ts"
import {
  cleanReport,
  dependencyViolation,
  edge,
  fileTarget,
  filePath,
  fullReport,
  linesViolation,
  rules,
  useViolation,
  walkViolation,
} from "./fixtures.ts"

/** Runs `use` with a temporary project root. A file whose text is `directory` becomes a directory, which cannot be read as text. */
const inProject = <A>(
  files: Readonly<Record<string, string>>,
  use: (root: string) => Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "archer-pretty-" })
      for (const [name, text] of Object.entries(files)) {
        const target = path.join(root, name)
        yield* fileSystem.makeDirectory(text === "directory" ? target : path.dirname(target), { recursive: true })
        if (text !== "directory") yield* fileSystem.writeFileString(target, text)
      }
      return yield* use(root)
    }),
  ).pipe(Effect.orDie)

const custom = (subject: string, message: string): Violation => ({
  ruleId: "r",
  severity: "info",
  subject: filePath(subject),
  evidence: { _tag: "Custom", message },
})

/** A report whose findings are all info, so that its counts are the number of violations. */
const reportOf = (violations: ReadonlyArray<Violation>): Report => ({
  ...cleanReport,
  violations: violations.map((violation): Violation => ({ ...violation, severity: "info" })),
  rules: [],
  counts: { error: 0, warning: 0, info: violations.length },
  verdict: "fail",
})

const colorCodes = ["\u001b[0m", "\u001b[1m", "\u001b[2m", "\u001b[31m", "\u001b[32m", "\u001b[33m", "\u001b[36m"]

const withoutColor = (text: string): string => colorCodes.reduce((result, code) => result.replaceAll(code, ""), text)

layer(NodeServices.layer)("pretty", (it) => {
  it.effect("shows every kind of finding, with source lines where the file is readable", () =>
    inProject(
      {
        "src/domain/order.ts": 'import { a } from "./a"\n\nimport { db } from "../infra/db"\n',
        "src/web/page.ts": 'import { users } from "../app/users"\r\nexport const page = 1\r\n',
        "src/legacy/run.ts": "directory",
      },
      (root) =>
        pretty(fullReport, { root }).pipe(
          Effect.map((output) =>
            expect(output).toBe(
              [
                "src/domain/order.ts",
                "  3:10  error  no-infra  imports src/infra/db.ts ('../infra/db')",
                '    3 | import { db } from "../infra/db"',
                "      |          ^",
                "    reason: Domain code must not know about persistence.",
                "",
                "src/web/page.ts",
                "  1:1  error  web/no-db  depends on npm:pg through src/web/page.ts → src/app/users.ts → src/infra/db.ts → npm:pg",
                '    1 | import { users } from "../app/users"',
                "      | ^",
                "    reason: Web code reaches the database through app only.",
                "",
                "src/a.ts",
                "  2:1  warning  no-cycles  is part of a dependency cycle: src/a.ts → src/b.ts → src/a.ts",
                "",
                "src/app/users.ts",
                "  error  needs-adapter  does not satisfy the rule's requirement",
                "",
                "src/domain/helpers.ts",
                "  7:17  error  only-classes  declares formatPrice, which the rule does not allow",
                "",
                "src/lib/index.ts",
                "  error  public-api  exports internal, which the rule does not allow",
                "",
                "src/legacy/run.ts",
                "  12:5  error  no-eval  calls eval",
                "    reason: eval defeats static analysis.",
                "",
                "src/domain/Order.ts",
                "  warning  file-naming  has the file name Order.ts, which breaks the naming rule",
                "",
                "src/big.ts",
                "  warning  max-lines  has 900 lines, more than the rule allows",
                "",
                "src/features/a.ts",
                "  info  features/one-entrypoint  exports 3 names",
                "",
                "info  rule unused-rule selects no source files",
                "2 findings accepted by the baseline",
                "1 stale baseline entry matches no finding",
                "Archer: fail. 10 findings (6 errors, 3 warnings, 1 info) in 12 files and 40 dependencies.",
              ].join("\n"),
            ),
          ),
        ),
    ),
  )

  it.effect("prints only the summary for a clean report", () =>
    inProject({}, (root) =>
      pretty(cleanReport, { root }).pipe(
        Effect.map((output) => expect(output).toBe("Archer: pass. No findings in 12 files and 40 dependencies.")),
      ),
    ),
  )

  it.effect("counts singular and plural forms", () =>
    inProject({}, (root) =>
      pretty(
        {
          ...cleanReport,
          violations: [linesViolation],
          suppressed: 1,
          stale: [{ ruleId: "old", subject: ["a"], key: { _tag: "Missing" } }, { ruleId: "older", subject: ["a"], key: { _tag: "Missing" } }],
          counts: { error: 0, warning: 1, info: 0 },
          stats: { files: 1, dependencies: 1 },
        },
        { root },
      ).pipe(
        Effect.map((output) =>
          expect(output).toBe(
            [
              "src/big.ts",
              "  warning  max-lines  has 900 lines, more than the rule allows",
              "",
              "1 finding accepted by the baseline",
              "2 stale baseline entries match no finding",
              "Archer: pass. 1 finding (0 errors, 1 warning, 0 info) in 1 file and 1 dependency.",
            ].join("\n"),
          ),
        ),
      ),
    ),
  )

  it.effect("groups by file in order of first appearance without reordering the report", () =>
    inProject({}, (root) => {
      const violations = [custom("src/a.ts", "first"), custom("src/b.ts", "second"), custom("src/a.ts", "third")]
      const report = reportOf(violations)
      return pretty(report, { root }).pipe(
        Effect.map((output) => {
          expect(output).toBe(
            [
              "src/a.ts",
              "  info  r  first",
              "  info  r  third",
              "",
              "src/b.ts",
              "  info  r  second",
              "",
              "Archer: fail. 3 findings (0 errors, 0 warnings, 3 info) in 12 files and 40 dependencies.",
            ].join("\n"),
          )
          expect(report.violations).toEqual(violations)
        }),
      )
    }),
  )

  it.effect("reads an incoming dependency's line from the importing file and shows its place", () =>
    inProject({ "src/web/page.ts": 'import { order } from "../domain/order"\n' }, (root) =>
      pretty(
        reportOf([
          {
            ruleId: "r",
            severity: "info",
            subject: filePath("src/domain/order.ts"),
            evidence: {
              _tag: "Dependency",
              edge: edge("src/web/page.ts", fileTarget("src/domain/order.ts"), "../domain/order", 1, 1),
            },
          },
        ]),
        { root },
      ).pipe(
        Effect.map((output) =>
          expect(output).toBe(
            [
              "src/domain/order.ts",
              "  src/web/page.ts:1:1  info  r  is imported by src/web/page.ts ('../domain/order')",
              '    1 | import { order } from "../domain/order"',
              "      | ^",
              "",
              "Archer: fail. 1 finding (0 errors, 0 warnings, 1 info) in 12 files and 40 dependencies.",
            ].join("\n"),
          ),
        ),
      ),
    ),
  )

  it.effect("omits the line when the file is missing, a directory, or shorter than the location", () =>
    inProject({ "src/domain/order.ts": "one line only\n", "src/web/page.ts": "directory" }, (root) =>
      pretty(
        reportOf([dependencyViolation, walkViolation, { ...useViolation, subject: filePath("src/nowhere.ts") }]),
        { root },
      ).pipe(
        Effect.map((output) =>
          expect(output).toBe(
            [
              "src/domain/order.ts",
              "  3:10  info  no-infra  imports src/infra/db.ts ('../infra/db')",
              "",
              "src/web/page.ts",
              "  1:1  info  web/no-db  depends on npm:pg through src/web/page.ts → src/app/users.ts → src/infra/db.ts → npm:pg",
              "",
              "src/nowhere.ts",
              "  12:5  info  no-eval  calls eval",
              "",
              "Archer: fail. 3 findings (0 errors, 0 warnings, 3 info) in 12 files and 40 dependencies.",
            ].join("\n"),
          ),
        ),
      ),
    ),
  )

  it.effect("prints no reason line for a rule without a reason", () =>
    inProject({}, (root) =>
      pretty({ ...cleanReport, violations: [dependencyViolation], rules: [{ id: "no-infra", severity: "error" }] }, { root }).pipe(
        Effect.map((output) => expect(output).not.toContain("reason:")),
      ),
    ),
  )

  it.effect("turns tabs into spaces and aligns the caret with wide line numbers", () =>
    inProject({ "src/legacy/run.ts": `${"\n".repeat(11)}\tconst x = eval(y)   \n` }, (root) =>
      pretty(reportOf([useViolation]), { root }).pipe(
        Effect.map((output) =>
          expect(output).toBe(
            [
              "src/legacy/run.ts",
              "  12:5  info  no-eval  calls eval",
              "    12 |  const x = eval(y)",
              "       |     ^",
              "",
              "Archer: fail. 1 finding (0 errors, 0 warnings, 1 info) in 12 files and 40 dependencies.",
            ].join("\n"),
          ),
        ),
      ),
    ),
  )

  it.effect("indents the continuation lines of a multi-line message", () =>
    inProject({}, (root) =>
      pretty(reportOf([custom("src/a.ts", "first\r\nsecond\nthird")]), { root }).pipe(
        Effect.map((output) =>
          expect(output).toBe(
            [
              "src/a.ts",
              "  info  r  first",
              "    second",
              "    third",
              "",
              "Archer: fail. 1 finding (0 errors, 0 warnings, 1 info) in 12 files and 40 dependencies.",
            ].join("\n"),
          ),
        ),
      ),
    ),
  )

  it.effect("resolves locations against the root", () =>
    inProject({ "pkg/src/domain/order.ts": "\n\nimport { db } from '../infra/db'\n" }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const output = yield* pretty(reportOf([dependencyViolation]), { root: path.join(root, "pkg") })
        expect(output).toContain("    3 | import { db } from '../infra/db'")
      }),
    ),
  )

  it.effect("uses no color codes unless asked", () =>
    inProject({ "src/domain/order.ts": "\n\nimport { db } from '../infra/db'\n" }, (root) =>
      Effect.gen(function* () {
        expect(yield* pretty(fullReport, { root })).not.toContain("\u001b")
        expect(yield* pretty(fullReport, { root, color: false })).not.toContain("\u001b")
      }),
    ),
  )

  it.effect("colors severity, rule, file header, gutter and verdict, and otherwise matches the plain output", () =>
    inProject({ "src/domain/order.ts": "\n\nimport { db } from '../infra/db'\n" }, (root) =>
      Effect.gen(function* () {
        const colored = yield* pretty(fullReport, { root, color: true })
        expect(colored).toContain("\u001b[1msrc/domain/order.ts\u001b[0m\n")
        expect(colored).toContain("  3:10  \u001b[31merror\u001b[0m  \u001b[2mno-infra\u001b[0m  imports")
        expect(colored).toContain("\u001b[33mwarning\u001b[0m")
        expect(colored).toContain("\u001b[36minfo\u001b[0m")
        expect(colored).toContain("\u001b[2m3 |\u001b[0m import { db }")
        expect(withoutColor(colored)).toBe(yield* pretty(fullReport, { root }))
      }),
    ),
  )

  it.effect("colors a passing verdict green", () =>
    inProject({}, (root) =>
      pretty(cleanReport, { root, color: true }).pipe(
        Effect.map((output) =>
          expect(output).toBe(
            "\u001b[1mArcher\u001b[0m: \u001b[32mpass\u001b[0m. No findings in 12 files and 40 dependencies.",
          ),
        ),
      ),
    ),
  )

  it.effect("shows several findings of one file, each with its own line", () =>
    inProject({ "src/a.ts": "line one\nline two\n" }, (root) =>
      pretty(
        reportOf([
          { ...custom("src/a.ts", "x"), evidence: { _tag: "Declaration", name: "one", location: { line: 1, column: 1 } } },
          { ...custom("src/a.ts", "x"), evidence: { _tag: "Declaration", name: "two", location: { line: 2, column: 6 } } },
        ]),
        { root },
      ).pipe(
        Effect.map((output) =>
          expect(output).toBe(
            [
              "src/a.ts",
              "  1:1  info  r  declares one, which the rule does not allow",
              "    1 | line one",
              "      | ^",
              "  2:6  info  r  declares two, which the rule does not allow",
              "    2 | line two",
              "      |      ^",
              "",
              "Archer: fail. 2 findings (0 errors, 0 warnings, 2 info) in 12 files and 40 dependencies.",
            ].join("\n"),
          ),
        ),
      ),
    ),
  )

  it.effect("prints the reason of the finding's rule", () =>
    inProject({}, (root) =>
      pretty({ ...cleanReport, violations: [dependencyViolation], rules }, { root }).pipe(
        Effect.map((output) => expect(output).toContain("reason: Domain code must not know about persistence.")),
      ),
    ),
  )
})
