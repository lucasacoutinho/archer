import { Match } from "effect"
import type { Severity } from "../core/rule.ts"
import { describe, pathText, standalone } from "./message.ts"
import type { Report } from "./report.ts"

// GitHub workflow commands: % \r \n are escaped everywhere, and properties also escape : and ,
const data = (text: string): string => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")

const property = (text: string): string => data(text).replaceAll(":", "%3A").replaceAll(",", "%2C")

const command = (severity: Severity): string =>
  Match.value(severity).pipe(
    Match.when("error", () => "error"),
    Match.when("warning", () => "warning"),
    Match.when("info", () => "notice"),
    Match.exhaustive,
  )

export const github = (report: Report): string =>
  report.violations
    .map((violation) => {
      const description = describe(violation, report.rules)
      const { location } = description
      const properties =
        location === undefined
          ? [`file=${property(pathText(violation.subject))}`]
          : [`file=${property(location.path)}`, `line=${location.line}`, `col=${location.column}`]
      const attributes = [...properties, `title=${property(violation.ruleId)}`].join(",")
      return `::${command(violation.severity)} ${attributes}::${data(standalone(violation, description))}`
    })
    .join("\n")
