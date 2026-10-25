import { Match } from "effect"
import { encode, fingerprint } from "../core/fingerprint.ts"
import type { Edge, Severity } from "../core/rule.ts"
import { describe, importText, pathText, standalone } from "./message.ts"
import type { Report } from "./report.ts"

const level = (severity: Severity): string =>
  Match.value(severity).pipe(
    Match.when("error", () => "error"),
    Match.when("warning", () => "warning"),
    Match.when("info", () => "note"),
    Match.exhaustive,
  )

interface PhysicalLocation {
  readonly artifactLocation: { readonly uri: string; readonly uriBaseId: string }
  readonly region?: { readonly startLine: number; readonly startColumn: number }
}

interface CodeFlow {
  readonly threadFlows: ReadonlyArray<{
    readonly locations: ReadonlyArray<{
      readonly location: {
        readonly physicalLocation: PhysicalLocation
        readonly message: { readonly text: string }
      }
    }>
  }>
}

const physicalLocation = (path: string, region?: { readonly line: number; readonly column: number }): PhysicalLocation => ({
  artifactLocation: { uri: path, uriBaseId: "%SRCROOT%" },
  ...(region === undefined ? {} : { region: { startLine: region.line, startColumn: region.column } }),
})

const codeFlows = (edges: ReadonlyArray<Edge>): Array<CodeFlow> =>
  edges.length === 0
    ? []
    : [
        {
          threadFlows: [
            {
              locations: edges.map((edge) => ({
                location: {
                  physicalLocation: physicalLocation(pathText(edge.source), edge.dependency.location),
                  message: { text: importText(edge) },
                },
              })),
            },
          ],
        },
      ]

export const sarif = (report: Report): string => {
  const results = report.violations.map((violation) => {
    const description = describe(violation, report.rules)
    const { location } = description
    const ruleIndex = report.rules.findIndex((rule) => rule.id === violation.ruleId)
    const flows = Match.value(violation.evidence).pipe(
      Match.tag("Walk", "Cycle", ({ edges }) => codeFlows(edges)),
      Match.orElse(() => []),
    )
    return {
      ruleId: violation.ruleId,
      ...(ruleIndex < 0 ? {} : { ruleIndex }),
      level: level(violation.severity),
      message: { text: standalone(violation, description) },
      locations: [
        {
          physicalLocation:
            location === undefined
              ? physicalLocation(pathText(violation.subject))
              : physicalLocation(location.path, location),
        },
      ],
      partialFingerprints: { archer: encode(fingerprint(violation)) },
      ...(flows.length === 0 ? {} : { codeFlows: flows }),
    }
  })
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "Archer",
              informationUri: "https://github.com/lucasacoutinho/archer",
              rules: report.rules.map((rule) => ({
                id: rule.id,
                shortDescription: { text: rule.reason ?? rule.id },
                defaultConfiguration: { level: level(rule.severity) },
              })),
            },
          },
          results,
        },
      ],
    },
    undefined,
    2,
  )
}
