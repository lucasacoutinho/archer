import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ArchitectureResult, ArchitectureViolation } from '../core/types.js'

export interface BaselineEntry {
  readonly file?: string
  readonly fingerprint: string
  readonly message: string
  readonly rule: string
}

export interface ArchitectureBaseline {
  readonly generatedAt: string
  readonly version: 1
  readonly violations: readonly BaselineEntry[]
}

export function violationFingerprint(violation: ArchitectureViolation): string {
  const stableDetail = violation.dependency ?? violation.sourceLine
  const identity = [
    violation.ruleId ?? violation.rule,
    violation.file ?? '',
    stableDetail ?? (violation.ruleId === undefined ? violation.message : ''),
  ].join('\0')
  return createHash('sha256').update(identity).digest('hex').slice(0, 20)
}

export function createBaseline(result: ArchitectureResult): ArchitectureBaseline {
  return {
    generatedAt: new Date().toISOString(),
    version: 1,
    violations: result.violations.map((violation) => ({
      ...(violation.file === undefined ? {} : { file: violation.file }),
      fingerprint: violationFingerprint(violation),
      message: violation.message,
      rule: violation.ruleId ?? violation.rule,
    })),
  }
}

export async function readBaseline(fileName: string): Promise<ArchitectureBaseline> {
  const parsed: unknown = JSON.parse(await readFile(fileName, 'utf8'))
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('violations' in parsed) ||
    !Array.isArray(parsed.violations) ||
    parsed.violations.some(
      (entry: unknown) =>
        typeof entry !== 'object' ||
        entry === null ||
        !('fingerprint' in entry) ||
        typeof entry.fingerprint !== 'string',
    )
  ) {
    throw new TypeError(`Unsupported Archer baseline '${fileName}'.`)
  }
  return parsed as unknown as ArchitectureBaseline
}

export async function writeBaseline(
  fileName: string,
  baseline: ArchitectureBaseline,
): Promise<void> {
  await mkdir(path.dirname(fileName), { recursive: true })
  await writeFile(fileName, `${JSON.stringify(baseline, undefined, 2)}\n`, 'utf8')
}

export function applyBaseline(
  result: ArchitectureResult,
  baseline: ArchitectureBaseline,
): ArchitectureResult {
  const known = new Set(baseline.violations.map((entry) => entry.fingerprint))
  const violations = result.violations.filter(
    (violation) => !known.has(violationFingerprint(violation)),
  )
  const errors = violations.filter((violation) => violation.severity === 'error').length
  const warnings = violations.filter((violation) => violation.severity === 'warning').length
  const infos = violations.filter((violation) => violation.severity === 'info').length
  return {
    ...result,
    errors,
    infos,
    ok: errors === 0,
    violations,
    warnings,
  }
}
