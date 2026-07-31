import type { ArchitectureResult, ArchitectureViolation } from './types.js'

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
  if (result.ok) {
    return `Archer checked ${result.filesAnalyzed} files and ${result.dependenciesAnalyzed} dependencies.`
  }

  const violations = result.violations.map((violation) => {
    const location = formatLocation(violation)
    const prefix = location.length > 0 ? `  ${location}\n` : '  '
    return `${prefix}  ${violation.message}\n  Rule: ${violation.rule}`
  })

  return `${result.violations.length} architecture violation${result.violations.length === 1 ? '' : 's'}:\n\n${violations.join('\n\n')}`
}

export class ArchitectureError extends Error {
  readonly result: ArchitectureResult

  constructor(result: ArchitectureResult) {
    super(formatResult(result))
    this.name = 'ArchitectureError'
    this.result = result
  }
}
