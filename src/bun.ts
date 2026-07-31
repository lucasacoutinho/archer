import { test } from 'bun:test'

import { ArchitectureError } from './format.js'
import { ArchitectureSuite } from './suite.js'
import type { ArcherOptions } from './types.js'

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

export type { ArcherOptions, Selector } from './types.js'
