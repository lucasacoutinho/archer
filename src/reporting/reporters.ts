import type {
  ArchitectureGraph,
  ArchitectureResult,
  ArchitectureViolation,
  RuleSeverity,
} from '../core/types.js'
import { formatResult } from './format.js'

export type ReporterName = 'agent' | 'dot' | 'github' | 'json' | 'llm' | 'pretty' | 'sarif'

function singleLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim()
}

function agent(result: ArchitectureResult): string {
  const status =
    result.errors > 0 ? 'fail' : result.warnings > 0 ? 'warn' : result.infos > 0 ? 'info' : 'ok'
  const summary = [
    `archer: ${status}`,
    `files=${result.filesAnalyzed}`,
    `dependencies=${result.dependenciesAnalyzed}`,
    `errors=${result.errors}`,
    `warnings=${result.warnings}`,
    `infos=${result.infos}`,
  ].join(' ')
  const findings = result.violations.map((violation) => {
    const location =
      violation.file === undefined
        ? 'architecture'
        : `${violation.file}:${violation.line ?? 1}:${violation.column ?? 1}`
    const fields = [
      `${location}: ${violation.severity} ${singleLine(ruleKey(violation))}: ${singleLine(violation.message)}`,
      `rule=${JSON.stringify(singleLine(violation.rule))}`,
      ...(violation.reason === undefined
        ? []
        : [`reason=${JSON.stringify(singleLine(violation.reason))}`]),
      ...(violation.dependency === undefined
        ? []
        : [`dependency=${JSON.stringify(violation.dependency)}`]),
      ...(violation.sourceLine === undefined
        ? []
        : [`source=${JSON.stringify(singleLine(violation.sourceLine))}`]),
      ...(violation.importChain === undefined
        ? []
        : [`import_chain=${JSON.stringify(violation.importChain)}`]),
    ]
    return fields.join(' | ')
  })
  return [summary, ...findings].join('\n')
}

function sarifLevel(severity: RuleSeverity): 'error' | 'note' | 'warning' {
  return severity === 'info' ? 'note' : severity
}

function ruleKey(violation: ArchitectureViolation): string {
  return violation.ruleId ?? violation.rule
}

function sarif(result: ArchitectureResult): string {
  const rules = [
    ...new Map(
      result.violations.map((violation) => [
        ruleKey(violation),
        {
          id: ruleKey(violation),
          shortDescription: { text: violation.rule },
        },
      ]),
    ).values(),
  ]
  const results = result.violations.map((violation) => ({
    level: sarifLevel(violation.severity),
    message: { text: violation.message },
    ...(violation.file === undefined
      ? {}
      : {
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: violation.file },
                ...(violation.line === undefined
                  ? {}
                  : {
                      region: {
                        startColumn: violation.column ?? 1,
                        startLine: violation.line,
                      },
                    }),
              },
            },
          ],
        }),
    ruleId: ruleKey(violation),
  }))
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      runs: [{ results, tool: { driver: { name: 'Archer', rules } } }],
      version: '2.1.0',
    },
    undefined,
    2,
  )
}

function annotationValue(value: string): string {
  return value
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .replaceAll(':', '%3A')
    .replaceAll(',', '%2C')
}

function github(result: ArchitectureResult): string {
  if (result.violations.length === 0) {
    return formatResult(result)
  }
  return result.violations
    .map((violation) => {
      const level = violation.severity === 'info' ? 'notice' : violation.severity
      const attributes = [
        ...(violation.file === undefined ? [] : [`file=${annotationValue(violation.file)}`]),
        ...(violation.line === undefined ? [] : [`line=${violation.line}`]),
        ...(violation.column === undefined ? [] : [`col=${violation.column}`]),
        `title=${annotationValue(ruleKey(violation))}`,
      ]
      return `::${level} ${attributes.join(',')}::${annotationValue(violation.message)}`
    })
    .join('\n')
}

function dotEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function dot(graph: ArchitectureGraph): string {
  const lines = ['digraph archer {', '  rankdir=LR;']
  for (const sourceModule of graph.modules) {
    lines.push(`  "${dotEscape(sourceModule.path)}" [shape=box];`)
  }
  for (const dependency of graph.dependencies) {
    const style = dependency.kind === 'type' ? ',style=dashed' : ''
    lines.push(
      `  "${dotEscape(dependency.from)}" -> "${dotEscape(dependency.target)}" [label="${dependency.kind}"${style}];`,
    )
  }
  lines.push('}')
  return lines.join('\n')
}

export function report(
  name: ReporterName,
  result: ArchitectureResult,
  graph?: ArchitectureGraph,
): string {
  switch (name) {
    case 'agent':
    case 'llm':
      return agent(result)
    case 'pretty':
      return formatResult(result)
    case 'json':
      return JSON.stringify(result, undefined, 2)
    case 'sarif':
      return sarif(result)
    case 'github':
      return github(result)
    case 'dot':
      if (graph === undefined) {
        throw new TypeError('The DOT reporter needs an architecture graph.')
      }
      return dot(graph)
  }
}
