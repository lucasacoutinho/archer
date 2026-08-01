import { test } from 'vitest'
import type { TestOptions } from 'vitest'

import { checkArchitecture, type ArchitectureCheckOptions } from '../../application/check.js'
import type { ArcherOptions } from '../../core/types.js'
import { ArchitectureSuite } from '../../engine/suite.js'
import { ArchitectureError } from '../../reporting/format.js'

export interface ArchTestOptions extends ArcherOptions {
  readonly test?: TestOptions
}

export interface ArcherVitestOptions extends Omit<
  ArchitectureCheckOptions,
  'cwd' | 'updateBaseline'
> {}

export interface ArcherVitestPlugin {
  readonly enforce: 'pre'
  readonly name: 'archer:architecture-check'
  readonly configResolved: (config: { readonly root: string }) => Promise<void>
}

class ArcherVitestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArcherVitestError'
  }
}

/**
 * Runs Archer once while Vitest resolves its Vite configuration.
 */
export function archer(options: ArcherVitestOptions = {}): ArcherVitestPlugin {
  let execution: Promise<void> | undefined
  return {
    enforce: 'pre',
    name: 'archer:architecture-check',
    configResolved(config) {
      execution ??= checkArchitecture({ ...options, cwd: config.root }).then((result) => {
        if (result.code !== 0) throw new ArcherVitestError(result.content)
        if (result.outputPath === undefined) process.stdout.write(`${result.content}\n`)
      })
      return execution
    },
  }
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
