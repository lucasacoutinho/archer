import { test } from '@jest/globals'

import { ArchitectureError } from './format.js'
import { ArchitectureSuite } from './suite.js'
import type { ArcherOptions } from './types.js'

export interface JestArchTestOptions extends ArcherOptions {
  /** Per-test timeout in milliseconds. */
  readonly timeout?: number
}

/**
 * Registers an architecture test in Jest and returns its rule builder.
 */
export function arch(name: string, options: JestArchTestOptions = {}): ArchitectureSuite {
  const { timeout, ...archerOptions } = options
  const suite = new ArchitectureSuite(archerOptions)

  test(name, async () => {
    const result = await suite.check()
    if (!result.ok) {
      throw new ArchitectureError(result)
    }
  }, timeout)

  return suite
}

export type { ArcherOptions, Selector } from './types.js'
