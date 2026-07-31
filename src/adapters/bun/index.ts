import { test } from 'bun:test'

import type { ArcherOptions } from '../../core/types.js'
import { ArchitectureSuite } from '../../engine/suite.js'
import { ArchitectureError } from '../../reporting/format.js'

export interface BunArchTestOptions extends ArcherOptions {
  /** Per-test timeout in milliseconds. */
  readonly timeout?: number
}

/**
 * Registers an architecture test in Bun and returns its rule builder.
 */
export function arch(name: string, options: BunArchTestOptions = {}): ArchitectureSuite {
  const { timeout, ...archerOptions } = options
  const suite = new ArchitectureSuite(archerOptions)
  const check = async (): Promise<void> => {
    const result = await suite.check()
    if (!result.ok) {
      throw new ArchitectureError(result)
    }
  }

  if (timeout === undefined) {
    test(name, check)
  } else {
    test(name, check, timeout)
  }

  return suite
}

export type { ArcherOptions, Selector } from '../../core/types.js'
