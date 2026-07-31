import type { ArchitectureResult, ArchitectureViolation } from '../core/types.js'

function formatLocation(violation: ArchitectureViolation): string {
  if (violation.file === undefined) {
    return ''
  }

  if (violation.line === undefined) {
    return violation.file
  }

  return `${violation.file}:${violation.line}:${violation.column ?? 1}`
}

export function formatResult(result: ArchitectureResult): string {
  if (result.violations.length === 0) {
    return `Archer checked ${result.filesAnalyzed} files and ${result.dependenciesAnalyzed} dependencies.`
  }

  const violations = result.violations.map((violation) => {
    const location = formatLocation(violation)
    const prefix = location.length > 0 ? `  ${location}\n` : '  '
    const source =
      violation.sourceLine === undefined
        ? ''
        : `\n    ${violation.sourceLine.trim()}\n    ${' '.repeat(Math.max(0, (violation.column ?? 1) - 1))}^`
    const chain =
      violation.importChain === undefined || violation.importChain.length < 3
        ? ''
        : `\n  Import chain: ${violation.importChain.join(' -> ')}`
    const reason = violation.reason === undefined ? '' : `\n  Because: ${violation.reason}`
    const id = violation.ruleId === undefined ? '' : ` [${violation.ruleId}]`
    return `${prefix}  ${violation.severity.toUpperCase()}${id}: ${violation.message}${source}\n  Rule: ${violation.rule}${reason}${chain}`
  })

  return `${result.violations.length} architecture finding${result.violations.length === 1 ? '' : 's'}:\n\n${violations.join('\n\n')}`
}

export class ArchitectureError extends Error {
  readonly result: ArchitectureResult

  constructor(result: ArchitectureResult) {
    super(formatResult(result))
    this.name = 'ArchitectureError'
    this.result = result
  }
}
