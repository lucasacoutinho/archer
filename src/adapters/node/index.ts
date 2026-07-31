import { createRequire } from 'node:module'
import path from 'node:path'
import type { TestOptions } from 'node:test'

import type { ArcherOptions } from '../../core/types.js'
import { ArchitectureSuite } from '../../engine/suite.js'
import { ArchitectureError } from '../../reporting/format.js'

const { test } = createRequire(path.join(process.cwd(), '__archer.cjs'))(
  'node:test',
) as typeof import('node:test')

export interface NodeArchTestOptions extends ArcherOptions {
  readonly test?: TestOptions
}

/**
 * Registers an architecture test in node:test and returns its rule builder.
 */
export function arch(name: string, options: NodeArchTestOptions = {}): ArchitectureSuite {
  const { test: testOptions, ...archerOptions } = options
  const suite = new ArchitectureSuite(archerOptions)

  test(name, testOptions ?? {}, async () => {
    const result = await suite.check()
    if (!result.ok) {
      throw new ArchitectureError(result)
    }
  })

  return suite
}

export type { ArcherOptions, Selector } from '../../core/types.js'
