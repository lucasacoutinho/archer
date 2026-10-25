import { encode, fingerprint } from "../core/fingerprint.ts"
import { describe, pathText, type Position } from "./message.ts"
import type { Report } from "./report.ts"

/** JSON escapes control characters but not the Unicode line separators that line splitters honour. */
const quote = (text: string): string =>
  JSON.stringify(text).replaceAll("\u0085", "\\u0085").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029")

const at = ({ path, line, column }: Position): string => `${path}:${line}:${column}`

export const agent = (report: Report): string => {
  const findings = report.violations.map((violation) => {
    const { message, reason, location } = describe(violation, report.rules)
    return [
      "finding",
      `id=${quote(encode(fingerprint(violation)))}`,
      `severity=${violation.severity}`,
      `rule=${quote(violation.ruleId)}`,
      `subject=${quote(pathText(violation.subject))}`,
      ...(location === undefined ? [] : [`at=${quote(at(location))}`]),
      `message=${quote(message)}`,
      ...(reason === undefined ? [] : [`reason=${quote(reason)}`]),
    ].join(" ")
  })
  const summary = [
    "summary",
    `verdict=${report.verdict}`,
    `errors=${report.counts.error}`,
    `warnings=${report.counts.warning}`,
    `infos=${report.counts.info}`,
    `suppressed=${report.suppressed}`,
    `stale=${report.stale.length}`,
    `files=${report.stats.files}`,
    `dependencies=${report.stats.dependencies}`,
    `emptySubjects=[${report.emptySubjects.map(quote).join(",")}]`,
    `emptyObjects=[${report.emptyObjects.map(quote).join(",")}]`,
  ].join(" ")
  return [...findings, summary].join("\n")
}
