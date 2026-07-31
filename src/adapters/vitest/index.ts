import { test } from 'vitest'
import type { TestOptions } from 'vitest'

import type { ArcherOptions } from '../../core/types.js'
import { ArchitectureSuite } from '../../engine/suite.js'
import { ArchitectureError } from '../../reporting/format.js'

export interface ArchTestOptions extends ArcherOptions {
  readonly test?: TestOptions
}

/**
 * Registers an architecture test in Vitest and returns its rule builder.
 */
export function arch(name: string, options: ArchTestOptions = {}): ArchitectureSuite {
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
