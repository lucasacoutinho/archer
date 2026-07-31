import type { ArcherOptions } from '../core/types.js'
import type { ArchitectureSuite } from '../engine/suite.js'
import type { ReporterName } from '../reporting/reporters.js'

export interface ArcherConfig extends ArcherOptions {
  /** Existing violations to suppress while preventing new violations. */
  readonly baseline?: string
  /** Default report file. Standard output is used when omitted. */
  readonly output?: string
  /** Configure the architecture suite. */
  readonly rules: (suite: ArchitectureSuite) => Promise<void> | void
  /** Default CLI reporter. */
  readonly reporter?: ReporterName
}

export function defineConfig<const T extends ArcherConfig>(config: T): T {
  return config
}
