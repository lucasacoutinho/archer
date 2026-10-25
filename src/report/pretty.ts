import { Effect, FileSystem, Match, Path } from "effect"
import type { Severity, Violation } from "../core/rule.ts"
import { type Description, describe, pathText } from "./message.ts"
import type { Report } from "./report.ts"

export interface PrettyOptions {
  readonly root: string
  readonly color?: boolean
}

interface Finding {
  readonly violation: Violation
  readonly description: Description
}

interface Styles {
  readonly bold: (text: string) => string
  readonly dim: (text: string) => string
  readonly error: (text: string) => string
  readonly warning: (text: string) => string
  readonly info: (text: string) => string
  readonly pass: (text: string) => string
  readonly fail: (text: string) => string
}

const styles = (color: boolean): Styles => {
  const wrap = (code: string): ((text: string) => string) => (text: string): string => (color ? `\u001b[${code}m${text}\u001b[0m` : text)
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    error: wrap("31"),
    warning: wrap("33"),
    info: wrap("36"),
    pass: wrap("32"),
    fail: wrap("31"),
  }
}

const severityStyle = (style: Styles, severity: Severity): (text: string) => string =>
  Match.value(severity).pipe(
    Match.when("error", () => style.error),
    Match.when("warning", () => style.warning),
    Match.when("info", () => style.info),
    Match.exhaustive,
  )

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

const lineBreaks = (text: string): Array<string> => text.replaceAll("\r\n", "\n").split("\n")

const indent: string = "    "

const snippet = (style: Styles, severity: Severity, line: number, column: number, source: string): Array<string> => {
  const number = String(line)
  const text = source.replaceAll("\t", " ").trimEnd()
  const gutter = style.dim(`${" ".repeat(number.length)} |`)
  const caret = severityStyle(style, severity)("^")
  return [
    `${indent}${style.dim(`${number} |`)} ${text}`,
    `${indent}${gutter} ${" ".repeat(Math.max(0, column - 1))}${caret}`,
  ]
}

type Sources = ReadonlyMap<string, ReadonlyArray<string>>

const entry = (style: Styles, { violation, description }: Finding, sources: Sources): Array<string> => {
  const { location, reason } = description
  const [first = "", ...rest] = lineBreaks(description.message)
  const place =
    location === undefined
      ? []
      : [
          location.path === pathText(violation.subject)
            ? `${location.line}:${location.column}`
            : `${location.path}:${location.line}:${location.column}`,
        ]
  const source = location === undefined ? undefined : sources.get(location.path)?.[location.line - 1]
  const severity = severityStyle(style, violation.severity)(violation.severity)
  return [
    `  ${[...place, severity, style.dim(violation.ruleId), first].join("  ")}`,
    ...rest.map((line) => `${indent}${line}`),
    ...(location === undefined || source === undefined
      ? []
      : snippet(style, violation.severity, location.line, location.column, source)),
    ...(reason === undefined ? [] : [`${indent}reason: ${reason}`]),
  ]
}

/** Groups by subject in order of first appearance; findings keep their check order inside each group. */
const grouped = (findings: ReadonlyArray<Finding>): Array<readonly [string, Array<Finding>]> => {
  const groups = new Map<string, Array<Finding>>()
  for (const finding of findings) {
    const subject = pathText(finding.violation.subject)
    groups.set(subject, [...(groups.get(subject) ?? []), finding])
  }
  return Array.from(groups)
}

const summary = (style: Styles, report: Report): string => {
  const { error, warning, info } = report.counts
  const total = report.violations.length
  const files = count(report.stats.files, "file", "files")
  const dependencies = count(report.stats.dependencies, "dependency", "dependencies")
  const verdict = Match.value(report.verdict).pipe(
    Match.when("pass", () => style.pass("pass")),
    Match.when("fail", () => style.fail("fail")),
    Match.exhaustive,
  )
  const breakdown = `${count(error, "error", "errors")}, ${count(warning, "warning", "warnings")}, ${info} info`
  const findings = total === 0 ? "No findings" : `${count(total, "finding", "findings")} (${breakdown})`
  return `${style.bold("Archer")}: ${verdict}. ${findings} in ${files} and ${dependencies}.`
}

const notes = (style: Styles, report: Report): Array<string> => [
  ...report.emptySubjects.map((id) => `${style.info("info")}  rule ${id} selects no source files`),
  ...report.emptyObjects.map((id) => `${style.info("info")}  rule ${id} names files that do not exist`),
  ...(report.suppressed === 0 ? [] : [`${count(report.suppressed, "finding", "findings")} accepted by the baseline`]),
  ...(report.stale.length === 0
    ? []
    : [`${count(report.stale.length, "stale baseline entry matches", "stale baseline entries match")} no finding`]),
]

export const pretty: (
  report: Report,
  options: PrettyOptions,
) => Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> = Effect.fn("archer.pretty")(function* (report: Report, options: PrettyOptions) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const style = styles(options.color ?? false)
  const findings = report.violations.map(
    (violation): Finding => ({ violation, description: describe(violation, report.rules) }),
  )
  const locations = Array.from(new Set(findings.flatMap(({ description }) => description.location?.path ?? [])))
  const read = yield* Effect.forEach(
    locations,
    (location) =>
      fileSystem.readFileString(path.join(options.root, location)).pipe(
        Effect.map((text): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => [[location, lineBreaks(text)]]),
        Effect.orElseSucceed((): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => []),
      ),
    { concurrency: 8 },
  )
  const sources = new Map(read.flat())
  const groups = grouped(findings).map(([subject, members]) =>
    [style.bold(subject), ...members.flatMap((finding) => entry(style, finding, sources))].join("\n"),
  )
  const footer = [...notes(style, report), summary(style, report)].join("\n")
  return [...groups, footer].join("\n\n")
})
