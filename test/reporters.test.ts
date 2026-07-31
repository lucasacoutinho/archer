import { describe, expect, test } from 'vitest'

import {
  applyBaseline,
  createBaseline,
  report,
  type ArchitectureGraph,
  type ArchitectureResult,
} from '../src/index.js'

const result: ArchitectureResult = {
  dependenciesAnalyzed: 1,
  errors: 1,
  filesAnalyzed: 1,
  infos: 0,
  ok: false,
  violations: [
    {
      column: 3,
      file: 'src/a.ts',
      line: 2,
      message: 'Imports a forbidden module.',
      rule: 'a must not depend on b',
      ruleId: 'boundaries/a',
      severity: 'error',
    },
  ],
  warnings: 0,
}

const graph: ArchitectureGraph = {
  dependencies: [],
  modules: [],
  projects: [],
  root: '/project',
}

describe('reporting and baselines', () => {
  test('emits agent, JSON, SARIF, GitHub annotation, and DOT output', () => {
    expect(report('agent', result)).toBe(
      [
        'archer: fail files=1 dependencies=1 errors=1 warnings=0 infos=0',
        'src/a.ts:2:3: error boundaries/a: Imports a forbidden module. | rule="a must not depend on b"',
      ].join('\n'),
    )
    expect(report('llm', result)).toBe(report('agent', result))
    expect(JSON.parse(report('json', result))).toEqual(result)
    expect(JSON.parse(report('sarif', result))).toEqual(
      expect.objectContaining({ version: '2.1.0' }),
    )
    expect(report('github', result)).toContain(
      '::error file=src/a.ts,line=2,col=3,title=boundaries/a::',
    )
    expect(report('dot', result, graph)).toContain('digraph archer')
  })

  test('suppresses known violations with a stable baseline', () => {
    const filtered = applyBaseline(result, createBaseline(result))
    expect(filtered).toEqual(expect.objectContaining({ errors: 0, ok: true, violations: [] }))
  })

  test('includes warning details in pretty output', () => {
    const warning = {
      ...result,
      errors: 0,
      ok: true,
      violations: [{ ...result.violations[0]!, severity: 'warning' as const }],
      warnings: 1,
    }
    expect(report('pretty', warning)).toContain('WARNING')
    expect(report('pretty', warning)).toContain('Imports a forbidden module.')
    expect(report('agent', warning)).toContain('archer: warn')
  })
})
